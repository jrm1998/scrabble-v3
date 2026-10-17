'use strict';
/**
 * Word validation + word info through an online dictionary API, with a local word list as fast path/fallback.
 *
 *  mode "hybrid" (default): a word in the local list is accepted immediately; otherwise the API decides.
 *  mode "api":              the API decides every word (the local list is only used by the AI).
 *
 * Default API: https://api.dictionaryapi.dev  (HTTP 200 = word exists, 404 = it does not; the 200 body has definitions).
 * Any service that answers the same way works; set WORD_API_URL with a {word} placeholder.
 * If the API is unreachable (timeout, 429, 5xx) validation falls back to the local list, so the game never blocks.
 */
const clip = (s, n = 220) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : undefined);

/** Reduce an API response to the few fields the client shows. Returns null if there is nothing useful. */
function summarize(data) {
  if (!Array.isArray(data) || !data.length) return null;
  const first = data[0] || {};
  const meanings = [];
  const syn = new Set();
  for (const e of data) for (const m of (e && e.meanings) || []) {
    const defs = Array.isArray(m.definitions) ? m.definitions : [];
    const d = defs.find(x => x && x.definition);
    if (!d) continue;
    const ex = defs.find(x => x && x.example);
    if (meanings.length < 3) meanings.push({ pos: clip(m.partOfSpeech, 30), definition: clip(d.definition), example: clip(ex && ex.example) });
    for (const s of [...(m.synonyms || []), ...(d.synonyms || [])]) if (typeof s === 'string' && syn.size < 5) syn.add(clip(s, 30));
  }
  if (!meanings.length) return null;
  const phonetic = clip(first.phonetic || ((first.phonetics || []).find(p => p && p.text) || {}).text, 40);
  return { found: true, source: 'dictionaryapi', phonetic, origin: clip(first.origin), meanings, synonyms: [...syn] };
}

const stripHtml = (s) => (typeof s === 'string'
  ? s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
     .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
     .replace(/&amp;/g, '&')
  : '');

/** Wiktionary REST "definition" endpoint: {en:[{partOfSpeech, definitions:[{definition:<html>, examples:[<html>]}]}], ...}. Covers inflected forms too. */
function parseWiktionary(data) {
  const sections = data && Array.isArray(data.en) ? data.en : null;
  if (!sections) return null;
  const meanings = [];
  for (const sec of sections) {
    const defs = Array.isArray(sec.definitions) ? sec.definitions : [];
    const d = defs.find(x => x && stripHtml(x.definition).trim());
    if (!d) continue;
    const exRaw = (d.parsedExamples && d.parsedExamples[0] && d.parsedExamples[0].example) || (d.examples && d.examples[0]);
    meanings.push({ pos: clip(String(sec.partOfSpeech || '').toLowerCase(), 30), definition: clip(stripHtml(d.definition)), example: clip(stripHtml(exRaw)) || undefined });
    if (meanings.length >= 3) break;
  }
  return meanings.length ? { found: true, source: 'wiktionary', meanings, synonyms: [] } : null;
}

/** Datamuse (WordNet) with md=d: [{word, defs:["n\tdefinition", ...]}]. */
function parseDatamuse(data, word) {
  if (!Array.isArray(data)) return null;
  const hit = data.find(x => x && String(x.word).toLowerCase() === String(word).toLowerCase() && Array.isArray(x.defs) && x.defs.length);
  if (!hit) return null;
  const POS = { n: 'noun', v: 'verb', adj: 'adjective', adv: 'adverb' };
  const meanings = hit.defs.slice(0, 3).map(d => { const [p, ...rest] = String(d).split('\t'); return { pos: POS[p] || undefined, definition: clip(rest.join(' ')) }; }).filter(m => m.definition);
  return meanings.length ? { found: true, source: 'datamuse', meanings, synonyms: [] } : null;
}

/** Likely base forms of an inflected word, so "JUMPED" can show the entry for "JUMP". */
function stems(w) {
  if (w.length < 4) return [];
  const out = [];
  if (/IES$/.test(w) && w.length > 4) out.push(w.slice(0, -3) + 'Y');
  if (/ES$/.test(w)) out.push(w.slice(0, -2));
  if (/[^S]S$/.test(w)) out.push(w.slice(0, -1));
  if (/ED$/.test(w)) out.push(w.slice(0, -2), w.slice(0, -1));
  if (/ING$/.test(w) && w.length > 5) out.push(w.slice(0, -3), w.slice(0, -3) + 'E');
  return [...new Set(out)].filter(x => x.length >= 2).slice(0, 3);
}

class WordChecker {
  constructor({ local, mode = 'hybrid', urlTemplate, timeoutMs = 4000, fetchImpl, maxCache = 20000, maxConcurrent = 3, sources } = {}) {
    this.local = local || null;
    this.mode = mode === 'api' ? 'api' : 'hybrid';
    this.url = urlTemplate || 'https://api.dictionaryapi.dev/api/v2/entries/en/{word}';
    if (!this.url.includes('{word}')) throw new Error('WORD_API_URL must contain {word}');
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl || globalThis.fetch;
    if (typeof this.fetch !== 'function') throw new Error('fetch is not available (Node 18+ required)');
    const enc = (w) => encodeURIComponent(w.toLowerCase());
    // Definition sources, tried in order until one has the word. The first uses WORD_API_URL.
    this.sourceDefs = {
      dictionaryapi: { url: (w) => this.url.replace('{word}', enc(w)), parse: (d) => summarize(d) },
      wiktionary: { url: (w) => `https://en.wiktionary.org/api/rest_v1/page/definition/${enc(w)}`, parse: (d) => parseWiktionary(d) },
      datamuse: { url: (w) => `https://api.datamuse.com/words?sp=${enc(w)}&md=d&max=3`, parse: (d, w) => parseDatamuse(d, w) },
    };
    this.sources = (sources || ['dictionaryapi', 'wiktionary', 'datamuse']).filter(n => this.sourceDefs[n]);
    if (!this.sources.length) this.sources = ['dictionaryapi'];
    this.cache = new Map();         // WORD -> boolean (definitive API answers only)
    this.infoCache = new Map();     // WORD -> {found:...}
    this.inflight = new Map();
    this.infoInflight = new Map();
    this.maxCache = maxCache;
    this.maxConcurrent = maxConcurrent; this.active = 0; this.waiters = [];
  }

  _put(map, key, value) {
    if (map.size >= this.maxCache) map.delete(map.keys().next().value);
    map.set(key, value);
  }
  async _slot(fn) {   // polite to free APIs: at most `maxConcurrent` requests at once
    while (this.active >= this.maxConcurrent) await new Promise(r => this.waiters.push(r));
    this.active++;
    try { return await fn(); } finally { this.active--; const w = this.waiters.shift(); if (w) w(); }
  }
  _get(url) {
    return this._slot(async () => {
      try {
        const res = await this.fetch(url, {
          headers: { Accept: 'application/json', 'User-Agent': 'ScrabbleOnline/1.0 (educational game)' }, signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.status === 200) {
          let data = null;
          try { if (typeof res.json === 'function') data = await res.json(); } catch (_) { /* body not JSON */ }
          return { status: 200, data };
        }
        if (res.status === 404) return { status: 404 };
        return { error: 'HTTP ' + res.status };
      } catch (e) { return { error: e.message }; }
    });
  }

  /** @returns {Promise<{valid:boolean, source:'local'|'cache'|'api'|'offline'}>} */
  async check(rawWord) {
    const word = String(rawWord).toUpperCase();
    if (!/^[A-Z]{2,15}$/.test(word)) return { valid: false, source: 'local' };
    if (this.mode === 'hybrid' && this.local && this.local.has(word)) return { valid: true, source: 'local' };
    if (this.cache.has(word)) return { valid: this.cache.get(word), source: 'cache' };
    let p = this.inflight.get(word);
    if (!p) { p = this._ask(word).finally(() => this.inflight.delete(word)); this.inflight.set(word, p); }
    return p;
  }
  async _ask(word) {
    const r = await this._get(this.sourceDefs.dictionaryapi.url(word));
    if (r.error) {
      console.warn(`[wordcheck] API unavailable for "${word}" (${r.error}); using local list`);
      return { valid: !!(this.local && this.local.has(word)), source: 'offline' };   // not cached: retry next time
    }
    const valid = r.status === 200;
    this._put(this.cache, word, valid);
    if (valid) { const info = summarize(r.data); if (info) this._put(this.infoCache, word, info); }
    return { valid, source: 'api' };
  }

  /** Definition, example, origin... for a word. null = API unavailable; {found:false} = API has no entry. */
  async info(rawWord) {
    const word = String(rawWord).toUpperCase();
    if (!/^[A-Z]{2,15}$/.test(word)) return null;
    if (this.infoCache.has(word)) return this.infoCache.get(word);
    let p = this.infoInflight.get(word);
    if (!p) { p = this._lookupInfo(word).finally(() => this.infoInflight.delete(word)); this.infoInflight.set(word, p); }
    return p;
  }
  /**
   * Try every configured source for the word, then for its likely base forms (JUMPED -> JUMP).
   * One failing source does not stop the others. null = nothing found AND some source was unreachable (try again later).
   * If every source answered and none knows the word, a placeholder definition (generated: true) is returned, so the card is never empty.
   */
  async _lookupInfo(word) {
    let sawError = false;
    const tryForm = async (form, names) => {
      for (const name of names) {
        const src = this.sourceDefs[name];
        const r = await this._get(src.url(form));
        if (r.error) { sawError = true; console.warn(`[wordcheck] ${name} unavailable for "${form}" (${r.error})`); continue; }
        if (r.status === 200) { const info = src.parse(r.data, form); if (info) return info; }
      }
      return null;
    };
    let info = await tryForm(word, this.sources);
    if (!info) {
      for (const stem of stems(word)) {
        info = await tryForm(stem, this.sources.filter(n => n !== 'datamuse'));
        if (info) { info.formOf = stem; break; }
      }
    }
    if (info) { this._put(this.infoCache, word, info); return info; }
    if (sawError) return null;
    const placeholder = {
      found: true, generated: true, source: 'none', synonyms: [],
      meanings: [{ definition: `No online dictionary has an entry for ${word}, but it is accepted in the Scrabble word list.` }],
    };
    this._put(this.infoCache, word, placeholder);
    return placeholder;
  }
}
WordChecker.summarize = summarize;
WordChecker.stems = stems;
WordChecker.parseWiktionary = parseWiktionary;
WordChecker.parseDatamuse = parseDatamuse;
module.exports = WordChecker;
