'use strict';
const $ = (id) => document.getElementById(id);
const h = (tag, props, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return e;
};
const store = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (_) { /* storage unavailable */ } };
const load = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };

let token = null, me = null, socket = null, cfg = null, G = null, searching = false;
let trivia = [];
let selected = null, exchangeMode = false, timerEnd = 0, lastN = -1, lastGameId = null;
const exchangeSel = new Set();
const pending = new Map();   // r*15+c -> {r,c,l,b,idx}

// ---------- utilities ----------
let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (_) { /* no body */ }
  if (!res.ok) {
    if (res.status === 401 && token) logout();
    throw new Error(data.error || 'Request failed');
  }
  return data;
}
function send(ev, payload = {}) {
  return new Promise((resolve) => {
    if (!socket || !socket.connected) return resolve({ ok: false, error: 'Not connected to the server' });
    socket.timeout(8000).emit(ev, payload, (err, res) => resolve(err ? { ok: false, error: 'No response from the server' } : res));
  });
}
async function act(ev, payload) { const r = await send(ev, payload); if (!r.ok) toast(r.error); return r; }
function show(view) { for (const v of ['auth', 'lobby', 'game']) $(v).hidden = v !== view; }

// ---------- auth ----------
async function doAuth(path) {
  try {
    const s = await api(path, { method: 'POST', body: { username: $('authUser').value.trim(), password: $('authPass').value } });
    startSession(s);
  } catch (e) { toast(e.message); }
}
async function startSession(s) {
  token = s.token; store('scrabble_token', token);
  me = s.user;
  await boot();
}
function logout() {
  if (window.Voice) Voice.reset();
  token = null; me = null; G = null; store('scrabble_token', null);
  if (socket) { socket.disconnect(); socket = null; }
  $('whoami').textContent = ''; $('logoutBtn').hidden = true; $('pushBtn').hidden = true;
  show('auth');
}
async function boot() {
  try {
    if (!cfg) cfg = await api('/api/config');
    me = await api('/api/me');
  } catch (e) { if (token) toast(e.message); return; }
  $('whoami').textContent = `${me.avatar || ''} ${me.name}${me.guest ? ' (guest)' : ''}`;
  $('logoutBtn').hidden = false;
  $('pushBtn').hidden = me.guest || !('PushManager' in window);
  $('queueBtn').disabled = me.guest;
  $('queueBtn').title = me.guest ? 'Sign in to play ranked' : '';
  show('lobby');
  connectSocket();
  refreshLobby();
}

// ---------- lobby ----------
async function refreshLobby() {
  try {
    const rows = await api('/api/leaderboard');
    const tb = $('leaderboard').querySelector('tbody'); tb.replaceChildren();
    rows.forEach((r, i) => tb.append(h('tr', {}, h('td', {}, i + 1), h('td', {}, `${r.avatar} ${r.username}`), h('td', {}, r.rating), h('td', {}, `${r.wins}/${r.games_played}`))));
    if (!rows.length) tb.append(h('tr', {}, h('td', { colspan: 4, class: 'muted' }, 'No ranked players yet')));
  } catch (_) { /* offline */ }
  renderProfile();
}
async function renderProfile() {
  const box = $('profileBox'); box.replaceChildren();
  if (!me || me.guest) { box.textContent = 'Guests have no profile. Create an account to track your rating and stats.'; return; }
  const av = h('select', { id: 'avatarSel' }, (cfg.avatars || []).map(a => h('option', { value: a, ...(a === me.avatar ? { selected: '' } : {}) }, a)));
  const bio = h('input', { id: 'bioInput', maxlength: 160, placeholder: 'Your bio', value: me.bio || '' });
  box.append(
    h('p', {}, h('b', {}, `Rating ${me.rating}`), ` · ${me.games} games · ${me.wins}W ${me.losses}L ${me.draws}D · 🪙 ${me.coins}`),
    h('p', { class: 'muted' }, me.bestWord ? `Best word: ${me.bestWord} (${me.bestWordScore})` : 'No words played yet'),
    h('div', { class: 'row' }, av, bio, h('button', { class: 'small', onclick: async () => {
      try { await api('/api/me', { method: 'PATCH', body: { avatar: av.value, bio: bio.value } }); me.avatar = av.value; me.bio = bio.value; $('whoami').textContent = `${me.avatar} ${me.name}`; toast('Profile saved'); }
      catch (e) { toast(e.message); }
    } }, 'Save')));
  try {
    const { games } = await api('/api/profile/' + encodeURIComponent(me.name));
    if (games.length) box.append(h('h3', {}, 'Recent games'), h('ul', {}, games.map(g =>
      h('li', { class: 'muted' }, `${g.result.toUpperCase()} ${g.score} vs ${g.opponents || '—'}${g.ranked ? ` (${g.rating_before}→${g.rating_after})` : ''}`))));
  } catch (_) { /* ignore */ }
}
function renderQueue() { $('queueBtn').textContent = searching ? 'Cancel search' : 'Find ranked match'; $('queueMsg').textContent = searching ? 'Searching for an opponent…' : ''; }

// ---------- sockets ----------
function connectSocket() {
  if (socket) socket.disconnect();
  socket = io({ auth: { token } });
  socket.on('connect_error', (e) => { if (e.message === 'unauthorized') { toast('Session expired, please sign in again'); logout(); } });
  socket.on('game:state', onState);
  socket.on('room:left', () => { if (window.Voice) Voice.reset(); G = null; lastGameId = null; $('gameChat').replaceChildren(); trivia = []; renderTrivia(); resetInput(); show('lobby'); setTimeout(async () => { try { me = await api('/api/me'); } catch (_) {} refreshLobby(); }, 800); });
  socket.on('queue:status', (s) => { searching = s.searching; renderQueue(); });
  socket.on('chat:msg', (m) => addChat(m.scope, m));
  socket.on('chat:history', (d) => { const box = d.scope === 'lobby' ? $('lobbyChat') : $('gameChat'); box.replaceChildren(); d.messages.forEach(m => addChat(d.scope, m)); });
  socket.on('toast', toast);
  socket.on('trivia:new', (rec) => { trivia.unshift(rec); trivia.sort((a, b) => b.n - a.n); trivia = trivia.slice(0, 30); renderTrivia(); });
  socket.on('trivia:update', (rec) => { trivia = trivia.map(r => (r.n === rec.n ? rec : r)); renderTrivia(); });
  socket.on('trivia:history', (list) => { trivia = [...list].sort((a, b) => b.n - a.n); renderTrivia(); });
  if (window.Voice) Voice.attach(socket);
}
const SOURCE_LABEL = { dictionaryapi: 'Free Dictionary API', wiktionary: 'Wiktionary (CC BY-SA)', datamuse: 'Datamuse / WordNet' };
function triviaWord(t) {
  return h('div', { class: 'tw' },
    h('b', {}, t.word), ` +${t.score}`, t.phonetic ? ` ${t.phonetic}` : null,
    t.formOf ? h('div', { class: 'muted' }, `form of ${t.formOf}`) : null,
    (t.meanings || []).slice(0, 2).map(m => h('div', { class: t.generated ? 'muted' : '' }, m.pos ? h('i', {}, m.pos + ': ') : null, m.definition,
      m.example ? h('div', { class: 'muted' }, `\u201c${m.example}\u201d`) : null)),
    t.found ? null : h('div', { class: 'muted' }, 'Looking up the definition\u2026'),
    t.origin ? h('div', { class: 'muted' }, 'Origin: ' + t.origin) : null,
    SOURCE_LABEL[t.source] ? h('div', { class: 'muted' }, 'Source: ' + SOURCE_LABEL[t.source]) : null,
    t.synonyms && t.synonyms.length ? h('div', { class: 'muted' }, 'Similar: ' + t.synonyms.join(', ')) : null,
    t.facts.length ? h('ul', { class: 'facts' }, t.facts.map(f => h('li', {}, f))) : null);
}
function renderTrivia() {
  const box = $('trivia'); box.replaceChildren();
  if (!trivia.length) return void box.append(h('p', { class: 'muted' }, 'Play a word to see its definition and fun facts.'));
  for (const rec of trivia.slice(0, 15)) box.append(h('div', { class: 'trec' }, h('div', { class: 'muted' }, `Move ${rec.n} \u00b7 ${rec.name}`), rec.words.map(triviaWord)));
}
function addChat(scope, m) {
  const box = scope === 'lobby' ? $('lobbyChat') : $('gameChat');
  box.append(h('p', {}, h('b', {}, m.name + ': '), m.text));
  box.scrollTop = box.scrollHeight;
}

// ---------- game state ----------
function resetInput() { pending.clear(); selected = null; exchangeMode = false; exchangeSel.clear(); $('hintBox').replaceChildren(); }
function onState(s) {
  const n = s.history.length ? s.history[s.history.length - 1].n : 0;
  if (s.id !== lastGameId) { if (window.Voice) Voice.reset(); lastGameId = s.id; lastN = -1; $('gameChat').replaceChildren(); trivia = []; renderTrivia(); resetInput(); }
  if (n !== lastN) { lastN = n; resetInput(); }
  G = s;
  timerEnd = Date.now() + s.remainingMs;
  searching = false; renderQueue();
  show('game');
  render();
}
const MIC = { live: ['🎙️', 'Microphone on'], muted: ['🔇', 'Muted'], off: ['🚫', 'Voice chat disabled'] };
function micBadge(p) {
  if (p.isAI) return null;
  const s = (G.voice && G.voice[p.uid]) || 'off';
  return h('span', { class: 'mic ' + s, title: MIC[s][1], 'aria-label': MIC[s][1] }, MIC[s][0]);
}
const nameOf = (uid) => (G.players.find(p => p.uid === uid) || {}).name || '?';
const myTurn = () => G && G.status === 'playing' && G.turnUid === me.uid;

function buildBoard() {
  const b = $('board'); b.replaceChildren();
  const label = { TW: '3W', DW: '2W', TL: '3L', DL: '2L' };
  for (let r = 0; r < 15; r++) for (let c = 0; c < 15; c++) {
    const p = cfg.premium[r][c];
    b.append(h('div', { class: 'cell ' + p, 'data-r': r, 'data-c': c }, r === 7 && c === 7 ? '★' : label[p] || ''));
  }
}
function tileEl(letter, cls, blank) {
  const v = blank ? 0 : cfg.values[letter];
  return h('div', { class: 'tile ' + cls + (blank ? ' blank' : '') }, letter, h('small', {}, blank ? '' : v));
}
function render() {
  if (!$('board').firstChild) buildBoard();
  const isPlayer = !!G.you;
  $('roomCode').textContent = G.code;
  $('gameStatus').textContent = G.status === 'waiting' ? 'Waiting for players' : G.status === 'finished' ? 'Game over' : (isPlayer ? (myTurn() ? '🟢 Your turn' : `${nameOf(G.turnUid)}'s turn`) : `Watching · ${nameOf(G.turnUid)}'s turn`);
  $('waitCard').hidden = G.status !== 'waiting';
  $('waitCode').textContent = G.code;
  $('startBtn').hidden = G.hostUid !== me.uid;
  $('startBtn').disabled = G.players.length < 2;

  const last = new Set((G.lastPlay || []).map(p => p.r * 15 + p.c));
  $('board').childNodes.forEach((cell) => {
    cell.querySelector('.tile')?.remove();
    const r = +cell.dataset.r, c = +cell.dataset.c, k = r * 15 + c, t = G.board[r][c], pend = pending.get(k);
    if (t) cell.append(tileEl(t.toUpperCase(), last.has(k) ? 'last' : '', t !== t.toUpperCase()));
    else if (pend) cell.append(tileEl(pend.l, 'pending', pend.b));
  });

  const used = new Set([...pending.values()].map(p => p.idx));
  const rack = $('rack'); rack.replaceChildren();
  rack.hidden = !isPlayer || G.status !== 'playing';
  G.rack.forEach((l, i) => rack.append(h('div', {
    class: 'rtile' + (selected === i ? ' sel' : '') + (used.has(i) ? ' used' : '') + (exchangeSel.has(i) ? ' xch' : ''),
    onclick: () => onRackClick(i),
  }, l === '*' ? '?' : l, h('small', {}, cfg.values[l] || ''))));

  const playing = isPlayer && G.status === 'playing';
  $('controls').hidden = !playing;
  const t = myTurn();
  $('submitBtn').textContent = exchangeMode ? 'Confirm exchange' : 'Play';
  $('submitBtn').disabled = !t; $('recallBtn').disabled = !t; $('shuffleBtn').disabled = !t || pending.size > 0;
  $('exchangeBtn').disabled = !t; $('passBtn').disabled = !t;
  $('hintBtn').hidden = G.ranked; $('hintBtn').disabled = !t || G.hints <= 0; $('hintBtn').textContent = `Hint (${G.hints})`;
  $('resignBtn').disabled = false;
  $('bagCount').textContent = G.bagCount;

  const pl = $('players'); pl.replaceChildren();
  for (const p of G.players) pl.append(h('li', { 'data-uid': p.uid, class: (p.uid === G.turnUid ? 'turn ' : '') + (p.active ? '' : 'out') },
    h('span', {}, micBadge(p), ' ', `${p.isAI ? '🤖 ' : ''}${p.name}${p.uid === me.uid ? ' (you)' : ''}${p.rating && !p.isAI ? ' · ' + p.rating : ''}`),
    h('b', {}, p.score)));

  const mv = $('moves'); mv.replaceChildren();
  for (const m of [...G.history].reverse()) {
    const txt = m.type === 'play' ? `${m.words.map(w => w.word).join(', ')} (+${m.score})` : m.type === 'exchange' ? `exchanged ${m.count} tiles` : m.type === 'timeout' ? 'ran out of time' : m.type === 'resign' ? 'resigned' : 'passed';
    mv.append(h('li', { value: m.n }, `${nameOf(m.uid)}: ${txt}`));
  }

  const rc = $('resultCard'); rc.hidden = G.status !== 'finished'; rc.replaceChildren();
  if (G.status === 'finished') {
    const w = G.result.winners.map(nameOf);
    rc.append(h('h3', {}, w.length > 1 ? `Draw: ${w.join(' & ')}` : `🏆 ${w[0]} wins!`),
      h('p', { class: 'muted' }, G.result.reason === 'forfeit' ? 'Won by forfeit' : G.result.reason === 'stalemate' ? 'Game ended after consecutive passes' : 'Tiles ran out (leftover tiles subtracted)'),
      h('button', { onclick: () => act('room:leave') }, 'Back to lobby'));
  }
  if (window.Voice) Voice.onState();
}

function onRackClick(i) {
  if (!G || G.status !== 'playing' || !G.you) return;
  if (exchangeMode) { exchangeSel.has(i) ? exchangeSel.delete(i) : exchangeSel.add(i); }
  else {
    const entry = [...pending.entries()].find(([, p]) => p.idx === i);
    if (entry) pending.delete(entry[0]); else selected = selected === i ? null : i;
  }
  render();
}
$('board').addEventListener('click', (ev) => {
  const cell = ev.target.closest('.cell');
  if (!cell || !G || !myTurn() || exchangeMode) return;
  const r = +cell.dataset.r, c = +cell.dataset.c, k = r * 15 + c;
  if (pending.has(k)) { pending.delete(k); return render(); }
  if (G.board[r][c]) return;
  if (selected == null) return toast('Pick a tile from your rack first');
  let l = G.rack[selected], b = false;
  if (l === '*') {
    const x = (prompt('Which letter should the blank be? (A-Z)') || '').trim().toUpperCase();
    if (!/^[A-Z]$/.test(x)) return;
    l = x; b = true;
  }
  pending.set(k, { r, c, l, b, idx: selected });
  selected = null;
  render();
});

// ---------- controls ----------
$('submitBtn').onclick = async () => {
  if (exchangeMode) {
    if (!exchangeSel.size) return toast('Select tiles to exchange');
    return void await act('game:exchange', { letters: [...exchangeSel].map(i => G.rack[i]) });
  }
  if (!pending.size) return toast('Place some tiles first');
  const placements = [...pending.values()].map(({ r, c, l, b }) => ({ r, c, l, b }));
  $('submitBtn').disabled = true; toast('Checking words…');
  const res = await act('game:move', { placements });
  if (G) render();
  if (res.ok) toast(`+${res.score}: ${res.words.map(w => w.word).join(', ')}${res.bingo ? ' — BINGO!' : ''}`);
};
$('recallBtn').onclick = () => { resetInput(); render(); };
$('shuffleBtn').onclick = () => { for (let i = G.rack.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [G.rack[i], G.rack[j]] = [G.rack[j], G.rack[i]]; } selected = null; render(); };
$('exchangeBtn').onclick = () => {
  if (!exchangeMode && G.bagCount < 7) return toast('Not enough tiles left in the bag to exchange');
  pending.clear(); selected = null; exchangeMode = !exchangeMode; exchangeSel.clear(); render();
};
$('passBtn').onclick = () => { if (confirm('Pass your turn?')) act('game:pass'); };
$('resignBtn').onclick = () => { if (confirm('Resign this game?')) act('game:resign'); };
$('leaveBtn').onclick = () => {
  if (G && G.you && G.status === 'playing' && !confirm('Leaving counts as a resignation. Leave anyway?')) return;
  act('room:leave');
};
$('startBtn').onclick = () => act('room:start');
$('hintBtn').onclick = async () => {
  const res = await act('game:hint');
  if (!res.ok) return;
  const box = $('hintBox'); box.replaceChildren();
  if (!res.moves.length) return void box.append('No moves found - consider exchanging or passing.');
  box.append('Tap a hint to place it: ');
  for (const m of res.moves) box.append(h('a', { class: 'hint', onclick: () => {
    resetInput(); const used = new Set();
    for (const p of m.placements) {
      const need = p.b ? '*' : p.l;
      const idx = G.rack.findIndex((l, i) => l === need && !used.has(i));
      if (idx >= 0) { used.add(idx); pending.set(p.r * 15 + p.c, { r: p.r, c: p.c, l: p.l, b: p.b, idx }); }
    }
    render();
  } }, `${m.words[0].word} (+${m.score})`));
};

setInterval(() => {
  const t = $('timer');
  if (!G || G.status !== 'playing') { t.textContent = ''; return; }
  const s = Math.max(0, Math.ceil((timerEnd - Date.now()) / 1000));
  t.textContent = `⏱ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  t.classList.toggle('low', s <= 10 && myTurn());
}, 250);

// ---------- lobby buttons ----------
$('loginBtn').onclick = () => doAuth('/api/login');
$('registerBtn').onclick = () => doAuth('/api/register');
$('authPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doAuth('/api/login'); });
$('guestBtn').onclick = async () => { try { startSession(await api('/api/guest', { method: 'POST' })); } catch (e) { toast(e.message); } };
$('logoutBtn').onclick = logout;
$('aiBtn').onclick = () => act('room:create', { mode: 'ai', level: $('aiLevel').value });
$('createBtn').onclick = () => act('room:create', { mode: 'private', maxPlayers: +$('roomPlayers').value, timerSec: +$('roomTimer').value });
$('joinBtn').onclick = () => act('room:join', { code: $('joinCode').value });
$('watchBtn').onclick = () => act('room:spectate', { code: $('joinCode').value });
$('queueBtn').onclick = () => act(searching ? 'queue:leave' : 'queue:join');
for (const [form, input] of [['lobbyChatForm', 'lobbyChatInput'], ['gameChatForm', 'gameChatInput']]) {
  $(form).addEventListener('submit', async (e) => { e.preventDefault(); const v = $(input).value.trim(); if (!v) return; $(input).value = ''; await act('chat:send', { text: v }); });
}

// ---------- PWA: install, offline, push ----------
let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; $('installBtn').hidden = false; });
window.addEventListener('appinstalled', () => { $('installBtn').hidden = true; toast('App installed!'); });
$('installBtn').onclick = async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; $('installBtn').hidden = true; };
const setOffline = () => { $('offline').hidden = navigator.onLine; };
window.addEventListener('online', setOffline); window.addEventListener('offline', setOffline); setOffline();

const urlB64 = (s) => { const p = '='.repeat((4 - (s.length % 4)) % 4); const raw = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...raw].map(c => c.charCodeAt(0))); };
$('pushBtn').onclick = async () => {
  try {
    if (!('serviceWorker' in navigator)) return toast('Notifications are not supported here');
    const { key } = await api('/api/vapid');
    if (!key) return toast('Push is not configured on this server');
    if ((await Notification.requestPermission()) !== 'granted') return toast('Notifications were not allowed');
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(key) });
    await api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() });
    toast('Turn notifications are on');
  } catch (e) { toast(e.message || 'Could not enable notifications'); }
};
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));

renderTrivia();
// ---------- start ----------
(async () => {
  token = load('scrabble_token');
  if (!token) return show('auth');
  await boot();
  if (!me) show('auth');
})();
