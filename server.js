'use strict';
require('dotenv').config();
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const webpush = require('web-push');

const db = require('./src/db');
const Dictionary = require('./src/dictionary');
const engine = require('./src/engine');
const { Game, GameError } = require('./src/game');
const { eloDelta } = require('./src/elo');
const WordChecker = require('./src/wordcheck');
const { buildTrivia } = require('./src/trivia');

const PORT = Number(process.env.PORT) || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 16) {
  console.error('JWT_SECRET is missing or too short. Copy .env.example to .env and set it.');
  process.exit(1);
}
const dict = new Dictionary(path.join(__dirname, 'data', 'words.txt'));
console.log(`Local word list loaded: ${dict.size} words`);
const checker = new WordChecker({
  local: dict,
  mode: process.env.WORD_CHECK_MODE,
  urlTemplate: process.env.WORD_API_URL || undefined,
  timeoutMs: Number(process.env.WORD_API_TIMEOUT_MS) || 4000,
  sources: process.env.DEFINITION_SOURCES ? process.env.DEFINITION_SOURCES.split(',').map(x => x.trim()) : undefined,
});
const RETRY_MS = (process.env.TRIVIA_RETRY_MS || '15000,45000').split(',').map(Number).filter(n => n > 0);
console.log(`Word checker: ${checker.mode} mode via ${checker.url}; definitions from: ${checker.sources.join(', ')}`);

const pushEnabled = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (pushEnabled) webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);

const AVATARS = ['🙂', '😎', '🤓', '🦊', '🐱', '🐼', '🦉', '🐙', '🚀', '🎩', '👑', '🔥'];
const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  });
  next();
});

// ---------- small helpers ----------
const hits = new Map();
const limiter = (max, windowMs) => (req, res, next) => {
  const key = req.ip + req.path, now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now); hits.set(key, arr);
  if (arr.length > max) return res.status(429).json({ error: 'Too many requests, slow down' });
  next();
};
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 60000)) hits.delete(k); }, 60000).unref();

const wrap = (fn) => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: 'Server error' }); });
const sign = (uid, name, guest) => jwt.sign({ sub: uid, name, guest: !!guest }, JWT_SECRET, { expiresIn: guest ? '12h' : '7d' });
const session = (uid, name, guest) => ({ token: sign(uid, name, guest), user: { uid, name, guest: !!guest } });
function auth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const p = jwt.verify(h.startsWith('Bearer ') ? h.slice(7) : '', JWT_SECRET);
    req.user = { uid: p.sub, name: p.name, guest: !!p.guest };
    next();
  } catch { res.status(401).json({ error: 'Please sign in again' }); }
}
const userIdOf = (uid) => (uid.startsWith('u:') ? Number(uid.slice(2)) : null);
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

// ---------- REST ----------
app.get('/api/config', (req, res) => res.json({ premium: engine.PREMIUM, values: engine.VALUES, avatars: AVATARS }));
// ---- voice chat: ICE (STUN/TURN) servers handed to authenticated players ----
function voiceIceServers(uid) {
  if (process.env.VOICE_ICE_SERVERS) {                      // full override, JSON array of RTCIceServer objects
    try { const a = JSON.parse(process.env.VOICE_ICE_SERVERS); if (Array.isArray(a)) return a; } catch (_) { console.error('VOICE_ICE_SERVERS is not valid JSON'); }
  }
  const list = [{ urls: (process.env.VOICE_STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302').split(',').map(s => s.trim()).filter(Boolean) }];
  if (process.env.VOICE_TURN_URLS && process.env.VOICE_TURN_SECRET) {   // coturn "use-auth-secret": short-lived credentials
    const username = `${Math.floor(Date.now() / 1000) + 3600}:${uid}`;
    list.push({ urls: process.env.VOICE_TURN_URLS.split(',').map(s => s.trim()).filter(Boolean), username,
      credential: crypto.createHmac('sha1', process.env.VOICE_TURN_SECRET).update(username).digest('base64') });
  }
  return list;
}
app.get('/api/voice/config', auth, (req, res) => res.json({ iceServers: voiceIceServers(req.user.uid) }));
app.get('/api/vapid', (req, res) => res.json({ key: pushEnabled ? process.env.VAPID_PUBLIC_KEY : null }));

app.post('/api/register', limiter(10, 60000), wrap(async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || !/^[A-Za-z0-9_]{3,16}$/.test(username)) return res.status(400).json({ error: 'Username must be 3-16 letters, numbers or _' });
  if (typeof password !== 'string' || password.length < 6 || password.length > 72) return res.status(400).json({ error: 'Password must be 6-72 characters' });
  try {
    const id = await db.createUser(username, await bcrypt.hash(password, 10));
    res.json(session('u:' + id, username, false));
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'That username is taken' });
    throw e;
  }
}));

app.post('/api/login', limiter(15, 60000), wrap(async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') return res.status(400).json({ error: 'Missing credentials' });
  const u = await db.findByUsername(username);
  const ok = await bcrypt.compare(password, u ? u.password_hash : DUMMY_HASH);
  if (!u || !ok) return res.status(401).json({ error: 'Wrong username or password' });
  res.json(session('u:' + u.id, u.username, false));
}));

app.post('/api/guest', limiter(20, 60000), (req, res) => {
  res.json(session('g:' + crypto.randomBytes(5).toString('hex'), 'Guest' + crypto.randomInt(1000, 10000), true));
});

app.get('/api/me', auth, wrap(async (req, res) => {
  if (req.user.guest) return res.json({ ...req.user });
  const u = await db.getUser(userIdOf(req.user.uid));
  if (!u) return res.status(401).json({ error: 'Account not found' });
  res.json({ uid: req.user.uid, name: u.username, guest: false, avatar: u.avatar, bio: u.bio, rating: u.rating, games: u.games_played,
    wins: u.wins, losses: u.losses, draws: u.draws, coins: u.coins, bestWord: u.best_word, bestWordScore: u.best_word_score });
}));

app.patch('/api/me', auth, wrap(async (req, res) => {
  if (req.user.guest) return res.status(403).json({ error: 'Guests have no profile' });
  const { avatar, bio } = req.body || {};
  if (!AVATARS.includes(avatar)) return res.status(400).json({ error: 'Invalid avatar' });
  if (typeof bio !== 'string' || bio.length > 160) return res.status(400).json({ error: 'Bio is too long (160 max)' });
  await db.updateProfile(userIdOf(req.user.uid), avatar, bio.replace(/[\u0000-\u001f]/g, ' ').trim());
  res.json({ ok: true });
}));

app.get('/api/profile/:username', auth, wrap(async (req, res) => {
  const p = await db.publicProfile(String(req.params.username).slice(0, 16));
  if (!p) return res.status(404).json({ error: 'Player not found' });
  const games = await db.recentGames(p.id, 10);
  delete p.id;
  res.json({ profile: p, games });
}));

app.get('/api/leaderboard', auth, wrap(async (req, res) => res.json(await db.leaderboard(50))));

app.get('/api/games/:id/replay', auth, wrap(async (req, res) => {
  const g = await db.replay(String(req.params.id).slice(0, 16));
  if (!g) return res.status(404).json({ error: 'Game not found' });
  res.json(g);
}));

app.post('/api/push/subscribe', auth, wrap(async (req, res) => {
  if (req.user.guest) return res.status(403).json({ error: 'Sign in to enable notifications' });
  const s = req.body || {};
  if (typeof s.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint) || s.endpoint.length > 1000 ||
      !s.keys || typeof s.keys.p256dh !== 'string' || typeof s.keys.auth !== 'string') return res.status(400).json({ error: 'Invalid subscription' });
  await db.addSub(userIdOf(req.user.uid), s);
  res.json({ ok: true });
}));

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, p) => { if (/sw\.js$|manifest\.json$/.test(p)) res.set('Cache-Control', 'no-cache'); },
}));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ---------- real-time ----------
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 20e3, pingInterval: 20000, pingTimeout: 20000 });

const games = new Map();      // id -> Game
const byCode = new Map();     // code -> Game
const userGame = new Map();   // uid -> Game
let queue = [];               // ranked matchmaking: {uid,name,rating,userId,since}

const online = (uid) => (io.sockets.adapter.rooms.get('user:' + uid)?.size || 0) > 0;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  for (;;) {
    let c = ''; for (let i = 0; i < 5; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!byCode.has(c)) return c;
  }
}
function broadcast(g) {
  for (const p of g.players) if (!p.isAI && userGame.get(p.uid) === g) io.to('user:' + p.uid).emit('game:state', g.view(p.uid));
  io.to('spec:' + g.id).emit('game:state', g.view(null));
}
function makeGame(opts) {
  const g = new Game({ ...opts, code: newCode(), dict, checker, emit: (type, gm, extra) => {
    if (type === 'update') broadcast(gm);
    else if (type === 'played') sendTrivia(gm, extra).catch(e => console.error('trivia failed:', e));
    else if (type === 'turn') notifyTurn(gm);
    else if (type === 'finished') onFinished(gm).catch(e => console.error('save game failed:', e));
  } });
  games.set(g.id, g); byCode.set(g.code, g);
  return g;
}
function removeGame(g) {
  for (const s of g.voice.values()) io.to(s.socketId).emit('voice:kicked', { reason: 'The room was closed' });
  g.voice.clear();
  g.destroy(); games.delete(g.id); byCode.delete(g.code);
  for (const p of g.players) if (userGame.get(p.uid) === g) userGame.delete(p.uid);
  io.to('spec:' + g.id).emit('room:left');
  io.in('spec:' + g.id).socketsLeave('spec:' + g.id);
}
async function ratingOf(user) {
  if (user.guest) return 1200;
  const u = await db.getUser(userIdOf(user.uid));
  return u ? u.rating : 1200;
}
const humanPlayer = async (user) => ({ uid: user.uid, name: user.name, userId: user.guest ? null : userIdOf(user.uid), rating: await ratingOf(user) });

// ---- voice chat sessions (one per player per room; signaling only, audio flows peer-to-peer) ----
function voiceLeave(g, uid, socketId) {
  const s = g.voice.get(uid);
  if (!s || (socketId && s.socketId !== socketId)) return;
  g.voice.delete(uid);
  for (const other of g.voice.values()) io.to(other.socketId).emit('voice:peer-left', { uid });
  broadcast(g);
}
const VOICE_MAX_SDP = 16000;   // below the 20 KB socket buffer limit; an audio-only SDP is ~2-4 KB
function cleanSignal(d) {      // forward only well-formed, size-capped fields
  if (!d || typeof d !== 'object') return null;
  if (d.type === 'offer' || d.type === 'answer') return typeof d.sdp === 'string' && d.sdp && d.sdp.length <= VOICE_MAX_SDP ? { type: d.type, sdp: d.sdp } : null;
  if (d.type === 'candidate') {
    const c = d.candidate;
    if (!c || typeof c !== 'object' || typeof c.candidate !== 'string' || c.candidate.length > 1000) return null;
    return { type: 'candidate', candidate: {
      candidate: c.candidate,
      sdpMid: typeof c.sdpMid === 'string' ? c.sdpMid.slice(0, 64) : null,
      sdpMLineIndex: Number.isInteger(c.sdpMLineIndex) ? c.sdpMLineIndex : null,
      usernameFragment: typeof c.usernameFragment === 'string' ? c.usernameFragment.slice(0, 64) : undefined,
    } };
  }
  return null;
}

function detach(uid) {  // leave any room the user is in (without side effects for running games)
  const g = userGame.get(uid);
  if (!g) return;
  voiceLeave(g, uid);
  if (g.status === 'waiting') {
    userGame.delete(uid);
    g.removePlayer(uid);
    if (!g.players.some(p => !p.isAI)) { removeGame(g); return; }
    broadcast(g);
  } else if (g.status === 'playing') {
    try { g.resign(uid); } catch (_) { /* already out */ }
  }
  userGame.delete(uid);
  if (g.status === 'finished' && !g.players.some(p => userGame.get(p.uid) === g)) setTimeout(() => games.has(g.id) && removeGame(g), 60000).unref();
}
function sendGameHistory(socket, g) {
  socket.emit('chat:history', { scope: 'game', messages: g.chat.slice(-50) });
  socket.emit('trivia:history', g.triviaLog.slice(-20));
}

// Trivia for every word a player (or the robot) plays: API definition + facts computed locally.
const withTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const hasDef = (info) => !!(info && info.found);
function emitTrivia(g, event, rec) {
  for (const p of g.players) if (!p.isAI && userGame.get(p.uid) === g) io.to('user:' + p.uid).emit(event, rec);
  io.to('spec:' + g.id).emit(event, rec);
}
async function sendTrivia(g, entry) {
  const seen = new Set();
  const words = entry.words.filter(w => !seen.has(w.word) && seen.add(w.word));
  const lookups = words.map(w => checker.info(w.word).catch(() => null));
  const first = await Promise.all(lookups.map(p => withTimeout(p, 5000)));
  const rec = { n: entry.n, uid: entry.uid, name: entry.name, words: words.map((w, i) => buildTrivia(w.word, { dict, info: first[i], score: w.score })) };
  g.triviaLog.push(rec);
  if (g.triviaLog.length > 60) g.triviaLog.shift();
  emitTrivia(g, 'trivia:new', rec);
  // A definition that was slow or temporarily unavailable is filled in afterwards ('trivia:update').
  words.forEach((w, i) => {
    if (hasDef(first[i])) return;
    (async () => {
      let info = await lookups[i];
      for (const delay of RETRY_MS) {
        if (hasDef(info) || !games.has(g.id)) break;
        await sleep(delay);
        info = await checker.info(w.word).catch(() => null);
      }
      if (!hasDef(info)) return;
      rec.words[i] = buildTrivia(w.word, { dict, info, score: w.score });
      emitTrivia(g, 'trivia:update', rec);
    })().catch(e => console.error('trivia retry failed:', e));
  });
}

async function notifyTurn(g) {
  const p = g.current();
  if (!pushEnabled || !p || p.isAI || !p.userId || online(p.uid)) return;
  try {
    for (const s of await db.getSubs(p.userId)) {
      webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ title: 'Your turn in Scrabble', body: `Room ${g.code} is waiting for your move`, url: '/' }), { TTL: 3600 })
        .catch(err => { if (err.statusCode === 404 || err.statusCode === 410) db.deleteSub(s.endpoint).catch(() => {}); });
    }
  } catch (e) { console.error('push failed:', e.message); }
}

async function onFinished(g) {
  const winners = g.result.winners;
  const outcome = (p) => (winners.includes(p.uid) ? (winners.length > 1 ? 'draw' : 'win') : 'loss');
  const humans = g.players.filter(p => !p.isAI);
  const ratedPair = g.ranked && g.players.length === 2 && humans.length === 2 && humans.every(h => h.userId);
  const rows = g.players.map(p => {
    const result = outcome(p);
    let best = { word: null, score: 0 };
    for (const h of g.history) if (h.uid === p.uid && h.type === 'play') for (const w of h.words) if (w.score > best.score) best = w;
    const row = { uid: p.uid, userId: p.userId, name: p.name, isAI: !!p.isAI, score: p.score, result,
      coins: p.isAI ? 0 : (result === 'win' ? 10 : 3) * (g.ranked ? 2 : 1), bestWord: best.word, bestScore: best.score };
    if (ratedPair) row.ratingBefore = p.rating;
    return row;
  });
  if (ratedPair) {
    const [a, b] = rows, sa = a.result === 'win' ? 1 : a.result === 'draw' ? 0.5 : 0;
    a.ratingAfter = Math.max(100, a.ratingBefore + eloDelta(a.ratingBefore, b.ratingBefore, sa));
    b.ratingAfter = Math.max(100, b.ratingBefore + eloDelta(b.ratingBefore, a.ratingBefore, 1 - sa));
  }
  await db.saveFinishedGame({
    game: { id: g.id, code: g.code, mode: g.mode, ranked: g.ranked, reason: g.result.reason, winnerUid: winners.length === 1 ? winners[0] : null,
      startedAt: g.startedAt, endedAt: g.endedAt, moves: g.history },
    players: rows,
  });
  for (const r of rows) if (r.ratingAfter !== undefined) io.to('user:' + r.uid).emit('toast', `Rating ${r.ratingBefore} → ${r.ratingAfter}`);
}

// ---- matchmaking (ranked) ----
setInterval(() => {
  if (queue.length < 2) return;
  try { matchmake(); } catch (e) { console.error('matchmaking error:', e); }
}, 2000).unref();
function matchmake() {
  const now = Date.now();
  queue.sort((a, b) => a.rating - b.rating);
  const used = new Set();
  for (let i = 0; i < queue.length - 1; i++) {
    const a = queue[i], b = queue[i + 1];
    if (used.has(a.uid) || used.has(b.uid)) continue;
    const waited = (now - Math.min(a.since, b.since)) / 1000;
    if (Math.abs(a.rating - b.rating) > 100 + waited * 20) continue;
    used.add(a.uid); used.add(b.uid);
    const g = makeGame({ mode: 'ranked', ranked: true, timerSec: 90, maxPlayers: 2, hostUid: a.uid });
    for (const q of [a, b]) { g.addPlayer({ uid: q.uid, name: q.name, userId: q.userId, rating: q.rating }); userGame.set(q.uid, g); }
    g.start();
    for (const q of [a, b]) io.to('user:' + q.uid).emit('queue:status', { searching: false });
  }
  queue = queue.filter(q => !used.has(q.uid));
}
const dequeue = (uid) => { queue = queue.filter(q => q.uid !== uid); };

// ---- housekeeping ----
setInterval(() => {
  const now = Date.now();
  for (const g of [...games.values()]) {
    const idle = now - g.lastActivity;
    if ((g.status === 'finished' && now - g.endedAt > 10 * 60000) || (g.status === 'waiting' && idle > 30 * 60000) || idle > 3 * 3600000) removeGame(g);
  }
}, 60000).unref();

// ---- sockets ----
io.use((socket, next) => {
  try {
    const p = jwt.verify(String(socket.handshake.auth?.token || ''), JWT_SECRET);
    socket.user = { uid: p.sub, name: p.name, guest: !!p.guest };
    next();
  } catch { next(new Error('unauthorized')); }
});

const cleanText = (t) => String(t || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300);

io.on('connection', (socket) => {
  const me = socket.user;
  socket.join('user:' + me.uid);
  socket.join('lobby');
  let lastChat = 0;

  db.recentLobbyMessages(30).then(m => socket.emit('chat:history', { scope: 'lobby', messages: m })).catch(() => {});
  const existing = userGame.get(me.uid);
  if (existing) { socket.emit('game:state', existing.view(me.uid)); sendGameHistory(socket, existing); }

  const handle = (event, fn) => socket.on(event, async (payload, cb) => {
    if (typeof payload === 'function') { cb = payload; payload = {}; }
    const ack = typeof cb === 'function' ? cb : () => {};
    try {
      const out = await fn(payload && typeof payload === 'object' ? payload : {});
      ack({ ok: true, ...(out || {}) });
    } catch (e) {
      if (!(e instanceof GameError)) console.error(`[${event}]`, e);
      ack({ ok: false, error: e instanceof GameError ? e.message : 'Something went wrong' });
    }
  });
  const myGame = () => { const g = userGame.get(me.uid); if (!g) throw new GameError('You are not in a game'); return g; };
  const freeUp = () => {
    const g = userGame.get(me.uid);
    if (g && g.status !== 'finished') throw new GameError('Finish or leave your current game first');
    if (g) detach(me.uid);
    if (queue.some(q => q.uid === me.uid)) throw new GameError('Leave the ranked queue first');
  };

  handle('room:create', async (o) => {
    freeUp();
    const host = await humanPlayer(me);
    const isAI = o.mode === 'ai';
    const level = ['easy', 'medium', 'hard'].includes(o.level) ? o.level : 'medium';
    const g = makeGame({
      mode: isAI ? 'ai' : 'private', ranked: false, hostUid: me.uid,
      timerSec: Math.min(300, Math.max(30, Number(o.timerSec) || 90)),
      maxPlayers: isAI ? 2 : Math.min(4, Math.max(2, Number(o.maxPlayers) || 2)),
    });
    g.addPlayer(host);
    userGame.set(me.uid, g);
    if (isAI) { g.addPlayer({ uid: 'ai:' + g.id, name: `Robot (${level})`, isAI: true, level, rating: 0 }); g.start(); }
    else broadcast(g);
    sendGameHistory(socket, g);
    return { code: g.code };
  });

  handle('room:join', async (o) => {
    const g = byCode.get(String(o.code || '').trim().toUpperCase());
    if (!g) throw new GameError('No room with that code');
    if (userGame.get(me.uid) === g) { socket.emit('game:state', g.view(me.uid)); return; }
    freeUp();
    if (g.status !== 'waiting') throw new GameError('That game has already started - you can watch it instead');
    g.addPlayer(await humanPlayer(me));
    userGame.set(me.uid, g);
    broadcast(g);
    sendGameHistory(socket, g);
  });

  handle('room:spectate', async (o) => {
    const g = byCode.get(String(o.code || '').trim().toUpperCase());
    if (!g) throw new GameError('No room with that code');
    if (g.players.some(p => p.uid === me.uid)) throw new GameError('You are a player in that game');
    socket.join('spec:' + g.id);
    socket.spectating = g.id;
    socket.emit('game:state', g.view(null));
    sendGameHistory(socket, g);
  });

  handle('room:start', async () => {
    const g = myGame();
    if (g.hostUid !== me.uid) throw new GameError('Only the host can start the game');
    g.start();
  });

  handle('room:leave', async () => {
    if (socket.spectating) { socket.leave('spec:' + socket.spectating); socket.spectating = null; }
    detach(me.uid);
    dequeue(me.uid);
    io.to('user:' + me.uid).emit('room:left');
  });

  handle('queue:join', async () => {
    if (me.guest) throw new GameError('Sign in to play ranked');
    freeUp();
    dequeue(me.uid);
    queue.push({ uid: me.uid, name: me.name, userId: userIdOf(me.uid), rating: await ratingOf(me), since: Date.now() });
    io.to('user:' + me.uid).emit('queue:status', { searching: true });
  });
  handle('queue:leave', async () => { dequeue(me.uid); io.to('user:' + me.uid).emit('queue:status', { searching: false }); });

  handle('game:move', async (o) => { const ev = await myGame().play(me.uid, o.placements); return { score: ev.score, words: ev.words, bingo: ev.bingo }; });
  handle('game:pass', async () => { myGame().pass(me.uid); });
  handle('game:exchange', async (o) => { myGame().exchange(me.uid, o.letters); });
  handle('game:resign', async () => { myGame().resign(me.uid); });
  handle('game:hint', async () => ({ moves: myGame().hint(me.uid) }));

  // ---- voice chat: membership is checked on EVERY event against the server-side room, never against client claims ----
  const sigTimes = [];
  const voiceSession = () => {
    const g = userGame.get(me.uid);
    if (!g || !g.players.some(p => p.uid === me.uid)) throw new GameError('Voice chat is only available to players in this room');
    return g;
  };
  const activeVoice = () => {
    const g = voiceSession(), s = g.voice.get(me.uid);
    if (!s || s.socketId !== socket.id) throw new GameError('You are not in the voice chat');
    return { g, s };
  };
  handle('voice:join', async (o) => {
    const g = voiceSession();
    const old = g.voice.get(me.uid);
    if (old && old.socketId !== socket.id) io.to(old.socketId).emit('voice:kicked', { reason: 'Voice chat was started from another tab' });
    voiceLeave(g, me.uid);                       // replaces any previous session of this player
    g.voice.set(me.uid, { socketId: socket.id, muted: !!o.muted });
    const peers = [...g.voice].filter(([uid]) => uid !== me.uid)
      .map(([uid, s]) => ({ uid, name: (g.players.find(p => p.uid === uid) || {}).name || '?', muted: s.muted }));
    broadcast(g);
    return { peers };
  });
  handle('voice:leave', async () => { const g = userGame.get(me.uid); if (g) voiceLeave(g, me.uid, socket.id); });
  handle('voice:mute', async (o) => { const { g, s } = activeVoice(); s.muted = !!o.muted; broadcast(g); });
  handle('voice:signal', async (o) => {
    const { g } = activeVoice();
    const now = Date.now();
    while (sigTimes.length && now - sigTimes[0] > 10000) sigTimes.shift();
    if (sigTimes.length >= 300) throw new GameError('Too many voice signals, slow down');
    sigTimes.push(now);
    const target = typeof o.to === 'string' && o.to !== me.uid ? g.voice.get(o.to) : null;
    if (!target) throw new GameError('That player is not in the voice chat');
    const data = cleanSignal(o.data);
    if (!data) throw new GameError('Invalid voice signal');
    io.to(target.socketId).emit('voice:signal', { from: me.uid, data });
  });

  handle('chat:send', async (o) => {
    const now = Date.now();
    if (now - lastChat < 500) throw new GameError('You are sending messages too fast');
    lastChat = now;
    const text = cleanText(o.text);
    if (!text) return;
    const msg = { uid: me.uid, name: me.name, text, ts: now };
    const g = userGame.get(me.uid) || (socket.spectating && games.get(socket.spectating));
    if (g) {
      g.chat.push(msg); if (g.chat.length > 100) g.chat.shift();
      for (const p of g.players) if (!p.isAI) io.to('user:' + p.uid).emit('chat:msg', { scope: 'game', ...msg });
      io.to('spec:' + g.id).emit('chat:msg', { scope: 'game', ...msg });
      db.saveMessage('game:' + g.id, me.uid, me.name, text).catch(() => {});
    } else {
      io.to('lobby').emit('chat:msg', { scope: 'lobby', ...msg });
      db.saveMessage('lobby', me.uid, me.name, text).catch(() => {});
    }
  });

  socket.on('disconnect', () => {
    const vg = userGame.get(me.uid);
    if (vg) voiceLeave(vg, me.uid, socket.id);   // only if THIS socket owned the voice session
    if (!online(me.uid)) dequeue(me.uid);  // games keep running; the turn timer handles absent players
  });
});

db.pool.query('SELECT 1').then(() => {
  server.listen(PORT, () => console.log(`Scrabble server running on http://localhost:${PORT}`));
}).catch(e => { console.error('Cannot reach MySQL:', e.message, '\nCheck .env and run "npm run db:init".'); process.exit(1); });

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('SIGINT', () => { console.log('\nShutting down'); process.exit(0); });
