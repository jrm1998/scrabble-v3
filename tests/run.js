'use strict';
const assert = require('assert');
const path = require('path');
const E = require('../src/engine');
const Dictionary = require('../src/dictionary');
const { generateMoves } = require('../src/ai');
const { Game } = require('../src/game');
const { eloDelta } = require('../src/elo');
const WordChecker = require('../src/wordcheck');
const { buildTrivia } = require('../src/trivia');

const dict = new Dictionary(path.join(__dirname, '../data/words.txt'));
const P = (word, r, c, dr, dc) => [...word].map((l, i) => ({ r: r + dr * i, c: c + dc * i, l, b: false }));
let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('  ok  ' + name); };

t('bag has 100 tiles', () => {
  const bag = E.makeBag();
  assert.strictEqual(bag.length, 100);
  assert.strictEqual(bag.filter(x => x === '*').length, 2);
});
t('premium layout counts', () => {
  const c = {};
  for (const row of E.PREMIUM) for (const p of row) c[p] = (c[p] || 0) + 1;
  assert.deepStrictEqual([c.TW, c.DW, c.TL, c.DL], [8, 17, 12, 24]);
});
t('first word CAT scores 10 (DW on center)', () => {
  const ev = E.evaluateMove(E.newBoard(), P('CAT', 7, 6, 0, 1), dict);
  assert.ok(ev.ok); assert.strictEqual(ev.score, 10);
});
t('first word must cover center / be 2+ tiles', () => {
  assert.ok(!E.evaluateMove(E.newBoard(), P('CAT', 0, 0, 0, 1), dict).ok);
  assert.ok(!E.evaluateMove(E.newBoard(), P('A', 7, 7, 0, 1), dict).ok);
});
t('rejects gaps, diagonals, occupied squares, bad words', () => {
  const b = E.newBoard();
  assert.ok(!E.evaluateMove(b, [{ r: 7, c: 6, l: 'C' }, { r: 7, c: 8, l: 'T' }], dict).ok);
  assert.ok(!E.evaluateMove(b, [{ r: 7, c: 7, l: 'C' }, { r: 8, c: 8, l: 'A' }], dict).ok);
  assert.ok(!E.evaluateMove(b, P('XQZ', 7, 6, 0, 1), dict).ok);
  assert.ok(!E.evaluateMove(b, [{ r: -1, c: 0, l: 'A' }, { r: 0, c: 0, l: 'A' }], dict).ok);
});
t('cross words, premiums only on new tiles, blank scores 0', () => {
  const b = E.newBoard();
  for (const p of P('CAT', 7, 6, 0, 1)) b[p.r][p.c] = { l: p.l, b: false };
  // "AT" down from A(7,7)? -> vertical word through A: place T at (8,7) => "AT"
  const ev = E.evaluateMove(b, [{ r: 8, c: 7, l: 'T', b: false }], dict);
  assert.ok(ev.ok); assert.strictEqual(ev.words[0].word, 'AT');
  const blank = E.evaluateMove(b, [{ r: 8, c: 7, l: 'T', b: true }], dict);
  assert.strictEqual(blank.score, 1); // A=1 + blank 0
  assert.ok(!E.evaluateMove(b, [{ r: 0, c: 0, l: 'A' }, { r: 0, c: 1, l: 'B' }], dict).ok); // not connected
});
t('bingo bonus', () => {
  const ev = E.evaluateMove(E.newBoard(), P('TEACHER', 7, 1, 0, 1), dict);
  assert.ok(ev.ok && ev.bingo);
  assert.ok(ev.score >= 50);
});
t('elo is symmetric-ish and sane', () => {
  assert.strictEqual(eloDelta(1200, 1200, 1), 16);
  assert.strictEqual(eloDelta(1200, 1200, 0.5), 0);
  assert.ok(eloDelta(1000, 1400, 1) > 16);
});

// ---- brute-force cross-check of the AI move generator ----
function bruteForce(board, rack) {
  const counts = {}; for (const l of rack) counts[l] = (counts[l] || 0) + 1;
  const keys = new Set();
  const empty = E.isEmptyBoard(board);
  for (const word of dict.words) {
    for (const horizontal of [true, false]) {
      for (let line = 0; line < 15; line++) for (let start = 0; start + word.length <= 15; start++) {
        const cell = (i) => horizontal ? board[line][start + i] : board[start + i][line];
        const before = start > 0 ? (horizontal ? board[line][start - 1] : board[start - 1][line]) : null;
        const end = start + word.length;
        const after = end < 15 ? (horizontal ? board[line][end] : board[end][line]) : null;
        if (before || after) continue;
        const need = {}; let ok = true; const placements = [];
        for (let i = 0; i < word.length && ok; i++) {
          const t0 = cell(i);
          if (t0) { if (t0.l !== word[i]) ok = false; }
          else { need[word[i]] = (need[word[i]] || 0) + 1; if (need[word[i]] > (counts[word[i]] || 0)) ok = false;
            placements.push(horizontal ? { r: line, c: start + i, l: word[i], b: false } : { r: start + i, c: line, l: word[i], b: false }); }
        }
        if (!ok || !placements.length) continue;
        const ev = E.evaluateMove(board, placements, dict);
        if (ev.ok) keys.add(placements.map(p => `${p.r},${p.c},${p.l}`).sort().join('|') + '#' + ev.score);
      }
    }
  }
  return keys;
}
const keyOf = (m) => m.placements.map(p => `${p.r},${p.c},${p.l}`).sort().join('|') + '#' + m.score;

t('AI generator == brute force (empty board)', () => {
  const rack = [...'CATSDOG'];
  const gen = new Set(generateMoves(E.newBoard(), rack, dict).map(keyOf));
  const bf = bruteForce(E.newBoard(), rack);
  assert.ok(bf.size > 0);
  assert.deepStrictEqual([...gen].sort(), [...bf].sort());
});
t('AI generator == brute force (mid-game boards)', () => {
  for (let trial = 0; trial < 4; trial++) {
    const g = new Game({ code: 'T', mode: 'ai', dict, aiDelay: 99999, timerSec: 9999 });
    g.addPlayer({ uid: 'ai:1', name: 'A', isAI: true, level: 'hard' });
    g.addPlayer({ uid: 'ai:2', name: 'B', isAI: true, level: 'medium' });
    g.start(); clearTimeout(g.aiTimer); clearTimeout(g.timer);
    for (let i = 0; i < 6 + trial && g.status === 'playing'; i++) { g._aiTurn(); }
    clearTimeout(g.aiTimer); clearTimeout(g.timer);
    const rack = g.current().rack.filter(l => l !== '*');
    const gen = new Set(generateMoves(g.board, rack, dict).map(keyOf));
    const bf = bruteForce(g.board, rack);
    assert.deepStrictEqual([...gen].sort(), [...bf].sort(), `trial ${trial}`);
    g.destroy();
  }
});

// ---- full AI-vs-AI games: tile conservation and scoring invariants ----
const total = (g) => g.board.flat().filter(Boolean).length + g.bag.length + g.players.reduce((s, p) => s + p.rack.length, 0);
(async () => {
  for (const levels of [['hard', 'medium'], ['easy', 'hard', 'medium'], ['easy', 'easy']]) {
    await new Promise((resolve, reject) => {
      const g = new Game({ code: 'S', mode: 'ai', dict, aiDelay: 0, timerSec: 9999, maxPlayers: levels.length,
        emit: (type, gm) => {
          try {
            if (type === 'update') assert.strictEqual(total(gm) + gm.players.filter(p => !p.active).reduce((s, p) => s + 0, 0), 100);
            if (type === 'finished') {
              assert.ok(gm.result.winners.length >= 1);
              assert.ok(gm.history.length > 3);
              console.log(`  ok  sim ${levels.join('/')}: ${gm.history.length} turns, scores ${gm.players.map(p => p.score).join('-')} (${gm.result.reason})`);
              gm.destroy(); resolve();
            }
          } catch (e) { reject(e); }
        } });
      levels.forEach((lv, i) => g.addPlayer({ uid: 'ai:' + i, name: 'AI' + i, isAI: true, level: lv }));
      g.maxPlayers = levels.length;
      g.start();
      setTimeout(() => reject(new Error('sim timeout')), 120000).unref();
    });
    passed++;
  }
  // human-flow: resign, wrong turn, bad rack
  const g = new Game({ code: 'H', mode: 'private', dict, aiDelay: 99999, timerSec: 9999 });
  g.addPlayer({ uid: 'u:1', name: 'A' }); g.addPlayer({ uid: 'u:2', name: 'B' });
  g.start();
  const other = g.current().uid === 'u:1' ? 'u:2' : 'u:1';
  assert.throws(() => g.pass(other), /not your turn/);
  await assert.rejects(() => g.play(g.current().uid, [{ r: 7, c: 7, l: 'Z' }, { r: 7, c: 8, l: 'Z' }]), /(tiles|dictionary)/);
  g.resign(other);
  assert.strictEqual(g.status, 'finished'); assert.deepStrictEqual(g.result.winners, [g.players.find(p => p.uid !== other).uid]);
  g.destroy(); passed++; console.log('  ok  resign / turn enforcement');

  // ---- word checker API (stubbed fetch) ----
  const calls = [];
  const stub = (status, delay = 0) => async (url) => { calls.push(url); if (delay) await new Promise(r => setTimeout(r, delay)); if (status === 'throw') throw new Error('network down'); return { status }; };
  let wc = new WordChecker({ local: dict, fetchImpl: stub(200) });
  assert.deepStrictEqual(await wc.check('cat'), { valid: true, source: 'local' }); assert.strictEqual(calls.length, 0);
  assert.deepStrictEqual(await wc.check('qzxjvk'), { valid: true, source: 'api' }); assert.ok(calls[0].endsWith('/qzxjvk'));
  assert.strictEqual((await wc.check('QZXJVK')).source, 'cache'); assert.strictEqual(calls.length, 1);
  wc = new WordChecker({ local: dict, fetchImpl: stub(404) });
  assert.strictEqual((await wc.check('zzxq')).valid, false);
  assert.strictEqual((await wc.check('a1')).valid, false);
  calls.length = 0; wc = new WordChecker({ local: dict, fetchImpl: stub(200, 20) });
  await Promise.all([wc.check('qzxjvk'), wc.check('qzxjvk'), wc.check('qzxjvk')]); assert.strictEqual(calls.length, 1, 'in-flight dedupe');
  for (const bad of [500, 429, 'throw']) {
    const w = new WordChecker({ local: dict, fetchImpl: stub(bad) });
    assert.deepStrictEqual(await w.check('zzxq'), { valid: false, source: 'offline' });
    assert.strictEqual(w.cache.size, 0, 'failures are not cached');
  }
  wc = new WordChecker({ local: dict, mode: 'api', fetchImpl: stub(404) });
  assert.strictEqual((await wc.check('cat')).valid, false, 'api mode ignores local list');
  assert.throws(() => new WordChecker({ urlTemplate: 'https://x/y' }), /\{word\}/);

  // a human move whose word is NOT in the local list is accepted/rejected by the API
  for (const [status, ok] of [[200, true], [404, false]]) {
    const gg = new Game({ code: 'W', mode: 'private', dict, aiDelay: 99999, timerSec: 9999, checker: new WordChecker({ local: dict, fetchImpl: stub(status) }) });
    gg.addPlayer({ uid: 'u:1', name: 'A' }); gg.addPlayer({ uid: 'u:2', name: 'B' }); gg.start();
    const cur = gg.current(); cur.rack = [...'QZXJVK']; 
    const mv = [...'QZXJVK'].map((l, i) => ({ r: 7, c: 4 + i, l }));
    if (ok) { const ev = await gg.play(cur.uid, mv); assert.strictEqual(ev.words[0].word, 'QZXJVK'); assert.ok(cur.score > 0); }
    else { await assert.rejects(() => gg.play(cur.uid, mv), /Not a valid word: QZXJVK/); assert.strictEqual(gg.current(), cur, 'turn kept'); assert.strictEqual(cur.checking, false); }
    gg.destroy();
  }
  // turn changes while the API call is in flight -> move rejected, board untouched
  const slow = new Game({ code: 'X', mode: 'private', dict, aiDelay: 99999, timerSec: 9999, checker: new WordChecker({ local: dict, fetchImpl: stub(200, 50) }) });
  slow.addPlayer({ uid: 'u:1', name: 'A' }); slow.addPlayer({ uid: 'u:2', name: 'B' }); slow.start();
  const sc = slow.current(); sc.rack = [...'QZXJVK'];
  const pr = slow.play(sc.uid, [...'QZXJVK'].map((l, i) => ({ r: 7, c: 4 + i, l }))); 
  await assert.rejects(() => slow.play(sc.uid, []), /still being checked/);
  slow.pass(sc.uid);
  await assert.rejects(pr, /turn changed/); assert.ok(slow.board.flat().every(x => !x));
  slow.destroy(); passed++; console.log('  ok  word checker API: local fast path, cache, dedupe, fallback, game integration, race');

  // ---- trivia: API info, stem fallback, local facts ----
  const sample = [{ word: 'cat', phonetic: '/kat/', meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'A small domesticated feline.', example: 'The cat sat.' }], synonyms: ['feline'] }] }];
  const tcalls = [];
  const jsonStub = (map) => async (url) => { const w = decodeURIComponent(url.split('/').pop()); tcalls.push(w); return map[w] ? { status: 200, json: async () => map[w] } : { status: 404 }; };
  const jump = [{ word: 'jump', meanings: [{ partOfSpeech: 'verb', definitions: [{ definition: 'To leap.' }] }] }];
  wc = new WordChecker({ local: dict, fetchImpl: jsonStub({ cat: sample, jump }) });
  let info = await wc.info('cat');
  assert.ok(info.found && info.phonetic === '/kat/' && info.meanings[0].definition.startsWith('A small') && info.synonyms.includes('feline'));
  await wc.info('CAT'); assert.strictEqual(tcalls.length, 1, 'info cached');
  info = await wc.info('jumped'); assert.ok(info.found && info.formOf === 'JUMP', 'stem fallback');
  assert.ok(WordChecker.stems('CITIES').includes('CITY') && WordChecker.stems('MOVING').includes('MOVE') && WordChecker.stems('CAT').length === 0);
  tcalls.length = 0;
  info = await wc.info('qzxjvk'); assert.ok(info.found && info.generated && /Scrabble word list/.test(info.meanings[0].definition), 'placeholder when no source knows the word'); const n1 = tcalls.length; await wc.info('qzxjvk'); assert.strictEqual(tcalls.length, n1, 'negative result cached');
  assert.strictEqual(await new WordChecker({ local: dict, fetchImpl: stub('throw') }).info('cat'), null, 'API down -> null');
  tcalls.length = 0; wc = new WordChecker({ local: null, mode: 'api', fetchImpl: jsonStub({ cat: sample }) });
  await wc.check('cat'); await wc.info('cat'); assert.strictEqual(tcalls.length, 1, 'validation response reused for trivia');
  assert.strictEqual(WordChecker.summarize({}), null); assert.strictEqual(WordChecker.summarize([{ meanings: [] }]), null);

  let tv = buildTrivia('LEVEL', { dict, info: null, score: 7 });
  assert.ok(tv.facts.some(f => /palindrome/.test(f)) && !tv.found && tv.meanings.length === 0);
  assert.ok(buildTrivia('QI', { dict }).facts.some(f => /Q word without a U/.test(f)));
  assert.ok(buildTrivia('HM', { dict }).facts.some(f => /no vowels/.test(f)));
  assert.ok(buildTrivia('CAT', { dict }).facts.some(f => /Anagrams: .*ACT/.test(f)));
  tv = buildTrivia('CAT', { dict, info: await new WordChecker({ local: dict, fetchImpl: jsonStub({ cat: sample }) }).info('cat'), score: 5 });
  assert.ok(tv.found && tv.meanings[0].example === 'The cat sat.' && tv.facts.length <= 4);
  // every played word triggers a 'played' event with all words formed
  const played = [];
  const tg = new Game({ code: 'P', mode: 'private', dict, aiDelay: 99999, timerSec: 9999, emit: (type, gm, extra) => { if (type === 'played') played.push(extra); } });
  tg.addPlayer({ uid: 'u:1', name: 'A' }); tg.addPlayer({ uid: 'u:2', name: 'B' }); tg.start();
  const pc = tg.current(); pc.rack = [...'CATSDOG'];
  await tg.play(pc.uid, [...'CAT'].map((l, i) => ({ r: 7, c: 6 + i, l })));
  assert.strictEqual(played.length, 1); assert.strictEqual(played[0].words[0].word, 'CAT'); assert.strictEqual(played[0].name, pc.name);
  tg.destroy(); passed++; console.log('  ok  trivia: API info, stems, caching, local facts, played event');

  // ---- every valid word gets a definition: source chain ----
  const wik = { en: [{ partOfSpeech: 'Noun', language: 'English', definitions: [{ definition: '<a href="/wiki/plural">plural</a> of <i>cat</i> &amp; kin', examples: ['<b>Two</b> cats.'] }] }], fr: [{ partOfSpeech: 'Nom', definitions: [{ definition: 'chat' }] }] };
  const dm = [{ word: 'zyxo', score: 1, defs: ['n\ta test noun', 'v\ta test verb'] }];
  const route = (cfg) => async (url) => {
    const host = new URL(url).host; const kind = host.includes('dictionaryapi') ? 'dict' : host.includes('wiktionary') ? 'wik' : 'dm';
    const r = cfg[kind]; if (r === 'throw') throw new Error('down'); if (r === 500) return { status: 500 };
    return r ? { status: 200, json: async () => r } : { status: 404 };
  };
  info = await new WordChecker({ local: dict, fetchImpl: route({ dict: null, wik, dm: null }) }).info('cats');
  assert.ok(info.found && info.source === 'wiktionary' && info.meanings[0].definition === 'plural of cat & kin' && info.meanings[0].example === 'Two cats.' && info.meanings[0].pos === 'noun');
  info = await new WordChecker({ local: dict, fetchImpl: route({ dict: null, wik: null, dm }) }).info('zyxo');
  assert.ok(info.source === 'datamuse' && info.meanings[0].pos === 'noun' && info.meanings[1].definition === 'a test verb');
  info = await new WordChecker({ local: dict, fetchImpl: route({ dict: 500, wik, dm: null }) }).info('cats');
  assert.strictEqual(info.source, 'wiktionary', 'one failing source does not block the next');
  assert.strictEqual(await new WordChecker({ local: dict, fetchImpl: route({ dict: 'throw', wik: 500, dm: 'throw' }) }).info('cats'), null, 'all sources down -> null (retried later)');
  const partial = new WordChecker({ local: dict, fetchImpl: route({ dict: 500, wik: null, dm: null }) });
  assert.strictEqual(await partial.info('zzzq'), null, 'unreachable source + no entry elsewhere -> not declared undefined');
  assert.strictEqual(new WordChecker({ local: dict, sources: ['wiktionary'], fetchImpl: route({ dict, wik, dm }) }).sources.join(), 'wiktionary');
  assert.strictEqual(WordChecker.parseWiktionary({ en: [{ definitions: [{ definition: '<b></b>' }] }] }), null);
  assert.strictEqual(WordChecker.parseDatamuse([{ word: 'other', defs: ['n\tx'] }], 'zyxo'), null);
  // trivia record carries generated flag and source
  tv = buildTrivia('CATS', { dict, info: await new WordChecker({ local: dict, fetchImpl: route({ dict: null, wik: null, dm: null }) }).info('zzzq'), score: 1 });
  assert.ok(tv.found && tv.generated && tv.source === 'none', 'placeholder flows into the trivia record');
  passed++; console.log('  ok  definitions: Wiktionary/Datamuse fallbacks, partial outages, placeholder rules');
  console.log(`\n${passed} test groups passed`);
  process.exit(0);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
