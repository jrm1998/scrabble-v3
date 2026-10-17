'use strict';
const crypto = require('crypto');
const { newBoard, makeBag, evaluateMove, rackValue, isEmptyBoard, SIZE } = require('./engine');
const { generateMoves, chooseMove } = require('./ai');

class GameError extends Error {}

class Game {
  constructor(o) {
    this.id = crypto.randomBytes(6).toString('hex');
    this.code = o.code;
    this.mode = o.mode;                 // 'private' | 'ai' | 'ranked'
    this.ranked = !!o.ranked;
    this.timerSec = o.timerSec || 90;
    this.maxPlayers = o.maxPlayers || 2;
    this.hostUid = o.hostUid;
    this.dict = o.dict;
    this.checker = o.checker || null;   // optional WordChecker (online API)
    this.turnSeq = 0;
    this.emit = o.emit || (() => {});
    this.aiDelay = o.aiDelay === undefined ? 1200 : o.aiDelay;
    this.status = 'waiting';            // waiting | playing | finished
    this.board = newBoard();
    this.bag = [];
    this.players = [];
    this.turn = 0;
    this.scoreless = 0;
    this.history = [];
    this.chat = [];
    this.triviaLog = [];
    this.voice = new Map();   // uid -> {socketId, muted}; managed by the server (voice chat sessions)
    this.deadline = null;
    this.timer = null;
    this.aiTimer = null;
    this.result = null;
    this.createdAt = this.lastActivity = Date.now();
    this.endedAt = null;
  }

  // ---- lobby ----
  addPlayer(p) {
    if (this.status !== 'waiting') throw new GameError('Game already started');
    if (this.players.length >= this.maxPlayers) throw new GameError('Room is full');
    if (this.players.some(x => x.uid === p.uid)) throw new GameError('Already in this room');
    this.players.push({ rack: [], score: 0, active: true, timeouts: 0, hints: 3, ...p });
  }
  removePlayer(uid) {
    if (this.status !== 'waiting') return;
    this.players = this.players.filter(p => p.uid !== uid);
    if (this.hostUid === uid && this.players.length) this.hostUid = this.players.find(p => !p.isAI)?.uid || this.players[0].uid;
  }
  start() {
    if (this.status !== 'waiting') throw new GameError('Game already started');
    if (this.players.length < 2) throw new GameError('Need at least 2 players');
    this.bag = makeBag();
    for (const p of this.players) this._draw(p);
    this.turn = crypto.randomInt(this.players.length);
    this.status = 'playing';
    this.startedAt = Date.now();
    this._beginTurn();
    this.emit('update', this);
  }

  // ---- helpers ----
  current() { return this.players[this.turn]; }
  _draw(p) { while (p.rack.length < 7 && this.bag.length) p.rack.push(this.bag.pop()); }
  _activeCount() { return this.players.filter(p => p.active).length; }
  _log(p, type, extra = {}) {
    this.lastActivity = Date.now();
    this.history.push({ n: this.history.length + 1, uid: p.uid, type, ts: Date.now(), ...extra });
  }
  _assertTurn(uid) {
    if (this.status !== 'playing') throw new GameError('The game is not in progress');
    const p = this.current();
    if (p.uid !== uid) throw new GameError('It is not your turn');
    return p;
  }
  _beginTurn() {
    clearTimeout(this.timer); clearTimeout(this.aiTimer);
    if (this.status !== 'playing') return;
    this.turnSeq++;
    this.deadline = Date.now() + this.timerSec * 1000;
    this.timer = setTimeout(() => this._onTimeout(), this.timerSec * 1000 + 250);
    const p = this.current();
    if (p.isAI) this.aiTimer = setTimeout(() => this._aiTurn(), this.aiDelay);
    this.emit('turn', this);
  }
  _advance() {
    do { this.turn = (this.turn + 1) % this.players.length; } while (!this.current().active);
    this._beginTurn();
  }
  _scorelessCheck() {
    if (this.scoreless >= this._activeCount() * 2) { this._finish(null, null, 'stalemate'); return true; }
    return false;
  }

  // ---- actions ----
  _prepare(p, raw, dict) {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 7) throw new GameError('Place between 1 and 7 tiles');
    const placements = raw.map(x => ({ r: x && x.r, c: x && x.c, l: String((x && x.l) || '').toUpperCase(), b: !!(x && x.b) }));
    const rack = [...p.rack];
    for (const pl of placements) {
      const i = rack.indexOf(pl.b ? '*' : pl.l);
      if (i < 0) throw new GameError('You do not have those tiles');
      rack.splice(i, 1);
    }
    const ev = evaluateMove(this.board, placements, dict);
    if (!ev.ok) throw new GameError(ev.error);
    return { placements, rack, ev };
  }
  _commit(p, { placements, rack, ev }) {
    for (const pl of placements) this.board[pl.r][pl.c] = { l: pl.l, b: pl.b };
    p.rack = rack;
    p.score += ev.score;
    p.timeouts = 0;
    this.scoreless = 0;
    this._draw(p);
    this._log(p, 'play', { score: ev.score, words: ev.words, placements, bingo: ev.bingo });
    this.emit('played', this, { n: this.history.length, uid: p.uid, name: p.name, words: ev.words, score: ev.score });
    if (p.rack.length === 0 && this.bag.length === 0) this._finish(p, null, 'normal');
    else this._advance();
    this.emit('update', this);
    return ev;
  }
  /** Human move: placement rules are checked locally, then every word is validated by the word-checker API. */
  async play(uid, raw) {
    const p = this._assertTurn(uid);
    if (p.checking) throw new GameError('Your last move is still being checked');
    p.checking = true;
    try {
      const seq = this.turnSeq;
      const prep = this._prepare(p, raw, this.checker ? null : this.dict);
      if (this.checker) {
        const words = [...new Set(prep.ev.words.map(w => w.word))];
        const results = await Promise.all(words.map(w => this.checker.check(w)));
        const bad = words.filter((w, i) => !results[i].valid);
        if (bad.length) {
          const offline = results.some(r => r.source === 'offline') ? ' (the online word checker is unreachable, so only the built-in list was used)' : '';
          throw new GameError(`Not a valid word: ${bad.join(', ')}${offline}`);
        }
        if (seq !== this.turnSeq || this.status !== 'playing' || this.current() !== p) throw new GameError('The turn changed while your words were being checked');
      }
      return this._commit(p, prep);
    } finally { p.checking = false; }
  }
  /** Synchronous move validated against the local list only (used by the AI, whose moves come from that list). */
  playLocal(uid, raw) {
    const p = this._assertTurn(uid);
    return this._commit(p, this._prepare(p, raw, this.dict));
  }
  pass(uid) {
    const p = this._assertTurn(uid);
    p.timeouts = 0; this.scoreless++;
    this._log(p, 'pass');
    if (!this._scorelessCheck()) this._advance();
    this.emit('update', this);
  }
  exchange(uid, letters) {
    const p = this._assertTurn(uid);
    if (this.bag.length < 7) throw new GameError('Not enough tiles in the bag to exchange');
    if (!Array.isArray(letters) || !letters.length || letters.length > 7) throw new GameError('Choose tiles to exchange');
    const rack = [...p.rack], out = [];
    for (const l of letters) {
      const i = rack.indexOf(String(l).toUpperCase());
      if (i < 0) throw new GameError('You do not have those tiles');
      out.push(rack.splice(i, 1)[0]);
    }
    p.rack = rack; this._draw(p);
    this.bag.push(...out);
    this.bag = require('./engine').shuffle(this.bag);
    p.timeouts = 0; this.scoreless++;
    this._log(p, 'exchange', { count: out.length });
    if (!this._scorelessCheck()) this._advance();
    this.emit('update', this);
  }
  resign(uid) {
    const p = this.players.find(x => x.uid === uid);
    if (!p || !p.active || this.status !== 'playing') throw new GameError('Cannot resign now');
    const wasCurrent = this.current() === p;
    p.active = false;
    this.bag.push(...p.rack); p.rack = [];
    this.bag = require('./engine').shuffle(this.bag);
    this._log(p, 'resign');
    if (this._activeCount() <= 1) this._finish(null, this.players.find(x => x.active)?.uid, 'forfeit');
    else if (wasCurrent) this._advance();
    this.emit('update', this);
  }
  hint(uid) {
    const p = this._assertTurn(uid);
    if (this.ranked) throw new GameError('Hints are disabled in ranked games');
    if (p.hints <= 0) throw new GameError('No hints left');
    p.hints--;
    const moves = generateMoves(this.board, p.rack, this.dict).slice(0, 3);
    this.emit('update', this);
    return moves;
  }
  _onTimeout() {
    if (this.status !== 'playing') return;
    const p = this.current();
    p.timeouts++; this.scoreless++;
    this._log(p, 'timeout');
    if (p.timeouts >= 3) { this.scoreless = 0; this.resign(p.uid); return; }
    if (!this._scorelessCheck()) this._advance();
    this.emit('update', this);
  }
  _aiTurn() {
    const p = this.current();
    if (this.status !== 'playing' || !p || !p.isAI) return;
    try {
      const choice = chooseMove(generateMoves(this.board, p.rack, this.dict), p.level);
      if (choice) this.playLocal(p.uid, choice.placements);
      else if (this.bag.length >= 7) this.exchange(p.uid, p.rack.slice(0, Math.ceil(p.rack.length / 2)));
      else this.pass(p.uid);
    } catch (e) {
      try { this.pass(p.uid); } catch (_) { /* game ended */ }
    }
  }
  _finish(out, forcedWinner, reason) {
    clearTimeout(this.timer); clearTimeout(this.aiTimer);
    this.status = 'finished';
    this.endedAt = Date.now();
    const alive = this.players.filter(p => p.active);
    if (reason !== 'forfeit') {
      let others = 0;
      for (const p of alive) { const v = rackValue(p.rack); p.score -= v; if (p !== out) others += v; }
      if (out) out.score += others;
    }
    let winners;
    if (forcedWinner) winners = [forcedWinner];
    else {
      const best = Math.max(...alive.map(p => p.score));
      winners = alive.filter(p => p.score === best).map(p => p.uid);
    }
    this.result = { winners, reason };
    this.emit('finished', this);
    this.emit('update', this);
  }
  destroy() { clearTimeout(this.timer); clearTimeout(this.aiTimer); }

  // ---- state for clients ----
  view(uid) {
    const me = this.players.find(p => p.uid === uid);
    const cur = this.status === 'playing' ? this.current() : null;
    const showAll = this.status === 'finished';
    return {
      id: this.id, code: this.code, mode: this.mode, ranked: this.ranked, status: this.status,
      hostUid: this.hostUid, timerSec: this.timerSec, maxPlayers: this.maxPlayers,
      board: this.board.map(row => row.map(t => (t ? (t.b ? t.l.toLowerCase() : t.l) : ''))),
      bagCount: this.bag.length,
      players: this.players.map(p => ({
        uid: p.uid, name: p.name, score: p.score, rackCount: p.rack.length, isAI: !!p.isAI, level: p.level,
        active: p.active, rating: p.rating, rack: showAll ? p.rack : undefined,
      })),
      turnUid: cur ? cur.uid : null,
      remainingMs: cur ? Math.max(0, this.deadline - Date.now()) : 0,
      you: me ? me.uid : null,
      rack: me ? me.rack : [],
      hints: me ? me.hints : 0,
      history: this.history.slice(-60).map(h => ({ n: h.n, uid: h.uid, type: h.type, score: h.score, words: h.words, count: h.count })),
      lastPlay: [...this.history].reverse().find(h => h.type === 'play')?.placements || [],
      result: this.result,
      voice: Object.fromEntries([...this.voice].map(([u, s]) => [u, s.muted ? 'muted' : 'live'])),   // absent = voice disabled
    };
  }
}

module.exports = { Game, GameError, SIZE, isEmptyBoard };
