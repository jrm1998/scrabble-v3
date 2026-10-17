'use strict';
/*
 * Real-time voice chat: a WebRTC mesh (one RTCPeerConnection per other player in the room),
 * with Socket.IO as the signaling channel. Audio never passes through the server.
 * Uses globals from app.js: G (game state), me, socket, send, api, toast, h.
 *
 * Joining rule: the player who joins the voice chat makes the offers to everyone already in it,
 * so two players never offer to each other at the same time.
 */
const Voice = (() => {
  const el = (id) => document.getElementById(id);
  const st = { on: false, joining: false, noMic: false, muted: false, note: '', stream: null, ice: [], peers: new Map(), ctx: null, speaking: new Set(), stopLocal: null };
  const SPEAK_LEVEL = 12;   // 0-128 amplitude that counts as "speaking"

  function micError(e) {
    switch (e && e.name) {
      case 'NotAllowedError': case 'PermissionDeniedError': return 'Microphone permission was denied. Allow it in your browser settings to talk. You can still listen.';
      case 'NotFoundError': case 'DevicesNotFoundError': return 'No microphone was found. You can still listen.';
      case 'NotReadableError': case 'TrackStartError': return 'Your microphone is being used by another app or is unavailable. You can still listen.';
      case 'OverconstrainedError': return 'Your microphone does not support the requested audio settings. You can still listen.';
      case 'SecurityError': return 'Browsers only allow microphones on secure pages (HTTPS or localhost). You can still listen.';
      default: return 'Could not start the microphone. You can still listen.';
    }
  }

  // ---------- UI ----------
  function ui() {
    const inGame = !!(G && G.you);
    el('voiceCard').hidden = !inGame;
    const toggle = el('voiceToggle');
    toggle.checked = st.on || st.joining; toggle.disabled = st.joining;
    const mic = el('micBtn');
    mic.disabled = !st.on || st.noMic;
    mic.textContent = !st.on ? '🎙️ Mic off' : st.noMic ? '🚫 No mic' : st.muted ? '🔇 Unmute' : '🎙️ Mute';
    mic.setAttribute('aria-pressed', String(st.on && !st.noMic && st.muted));
    mic.classList.toggle('muted-on', st.on && !st.noMic && st.muted);

    const others = inGame ? G.players.filter(p => !p.isAI && p.uid !== me.uid) : [];
    const inVoice = others.filter(p => G.voice && G.voice[p.uid]);
    const linked = inVoice.filter(p => (st.peers.get(p.uid) || {}).state === 'connected').length;
    const broken = inVoice.some(p => ['failed', 'closed'].includes((st.peers.get(p.uid) || {}).state));
    let text, kind = 'muted';
    if (st.joining) { text = 'Connecting…'; kind = 'warn'; }
    else if (!st.on) text = 'Voice chat is off. Turn it on to talk with the other players in this room.';
    else {
      text = st.noMic ? 'Listening only (no microphone).' : st.muted ? 'You are muted: nobody can hear you.' : 'Your microphone is live: the others can hear you.';
      if (!inVoice.length) text += ' Waiting for other players to turn voice chat on.';
      else { text += ` Connected to ${linked} of ${inVoice.length} player${inVoice.length > 1 ? 's' : ''}.`; kind = broken ? 'err' : linked === inVoice.length ? 'ok' : 'warn'; }
    }
    if (st.note) { text += ' ' + st.note; if (kind !== 'err') kind = 'warn'; }
    const s = el('voiceStatus'); s.textContent = text; s.className = 'vstatus ' + kind;

    const list = el('voicePeers'); list.replaceChildren();
    for (const p of others) {
      const vs = (G.voice && G.voice[p.uid]) || 'off';
      const link = (st.peers.get(p.uid) || {}).state;
      const linkText = !st.on || vs === 'off' ? '' : link === 'connected' ? 'connected' : link === 'failed' || link === 'closed' ? 'connection problem' : link === 'disconnected' ? 'reconnecting…' : 'connecting…';
      list.append(h('li', {},
        h('span', { class: 'mic ' + vs, title: vs === 'off' ? 'Voice chat disabled' : vs === 'muted' ? 'Muted' : 'Microphone on' }, vs === 'live' ? '🎙️' : vs === 'muted' ? '🔇' : '🚫'),
        h('span', {}, p.name),
        h('span', { class: 'link' }, linkText ? [h('i', { class: 'dot ' + (link === 'connected' ? 'connected' : link === 'failed' || link === 'closed' ? 'failed' : 'connecting') }), ' ' + linkText] : (vs === 'off' ? 'voice off' : ''))));
    }
    if (!others.length && inGame) list.append(h('li', { class: 'muted' }, 'No other human players in this room.'));
  }
  function applySpeaking() {
    document.querySelectorAll('#players li[data-uid]').forEach(li => li.classList.toggle('speaking', st.speaking.has(li.dataset.uid)));
  }
  const mark = (uid, on) => { on ? st.speaking.add(uid) : st.speaking.delete(uid); applySpeaking(); };

  // Voice-activity detector: highlights whoever is talking (analysis only, never routed to the speakers).
  function watch(stream, uid) {
    try {
      st.ctx = st.ctx || new (window.AudioContext || window.webkitAudioContext)();
      if (st.ctx.state === 'suspended') st.ctx.resume().catch(() => {});
      const src = st.ctx.createMediaStreamSource(stream), an = st.ctx.createAnalyser();
      an.fftSize = 512; src.connect(an);
      const buf = new Uint8Array(an.fftSize);
      let on = false;
      const id = setInterval(() => {
        an.getByteTimeDomainData(buf);
        let max = 0; for (const x of buf) max = Math.max(max, Math.abs(x - 128));
        const speaking = max > SPEAK_LEVEL;
        if (speaking !== on) { on = speaking; mark(uid, on); }
      }, 150);
      return () => { clearInterval(id); try { src.disconnect(); } catch (_) { /* already gone */ } mark(uid, false); };
    } catch (_) { return () => {}; }
  }

  // ---------- peers ----------
  const sig = (to, data) => { if (socket) socket.emit('voice:signal', { to, data }); };

  function closePeer(uid) {
    const p = st.peers.get(uid);
    if (!p) return;
    st.peers.delete(uid);
    p.pc.onicecandidate = p.pc.ontrack = p.pc.onconnectionstatechange = null;
    try { p.pc.close(); } catch (_) { /* ignore */ }
    if (p.stopWatch) p.stopWatch();
    if (p.audio) { p.audio.srcObject = null; p.audio.remove(); }
  }
  const closeAllPeers = () => { for (const uid of [...st.peers.keys()]) closePeer(uid); };

  function resumeAudio() {
    st.note = '';
    for (const p of st.peers.values()) if (p.audio) p.audio.play().catch(() => {});
    ui();
  }

  function makePeer(uid, initiator) {
    closePeer(uid);
    const pc = new RTCPeerConnection({ iceServers: st.ice });
    const peer = { uid, pc, state: 'connecting', pending: [], chain: Promise.resolve(), audio: null, stopWatch: null };
    st.peers.set(uid, peer);
    if (st.stream) st.stream.getAudioTracks().forEach(t => pc.addTrack(t, st.stream));
    else pc.addTransceiver('audio', { direction: 'recvonly' });          // listen-only
    pc.onicecandidate = (e) => { if (e.candidate) sig(uid, { type: 'candidate', candidate: e.candidate.toJSON() }); };
    pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      if (!peer.audio) { peer.audio = document.createElement('audio'); peer.audio.autoplay = true; peer.audio.playsInline = true; el('voiceAudio').append(peer.audio); }
      peer.audio.srcObject = stream;
      peer.audio.play().catch(() => { st.note = 'Click anywhere on the page to start the audio.'; ui(); document.addEventListener('click', resumeAudio, { once: true }); });
      if (peer.stopWatch) peer.stopWatch();
      peer.stopWatch = watch(stream, uid);
    };
    pc.onconnectionstatechange = () => { peer.state = pc.connectionState; ui(); };
    if (initiator) {
      peer.chain = peer.chain.then(async () => {
        await pc.setLocalDescription(await pc.createOffer());
        sig(uid, { type: 'offer', sdp: pc.localDescription.sdp });
      }).catch(() => { peer.state = 'failed'; ui(); });
    }
    return peer;
  }

  function onSignal({ from, data }) {
    if (!st.on || !data || typeof from !== 'string') return;
    let peer = st.peers.get(from);
    if (data.type === 'offer') peer = makePeer(from, false);             // a (re)joining player always starts a fresh connection
    if (!peer) return;
    peer.chain = peer.chain.then(async () => {
      const pc = peer.pc;
      const flush = async () => { for (const c of peer.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {}); };
      if (data.type === 'offer') {
        await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
        await flush();
        await pc.setLocalDescription(await pc.createAnswer());
        sig(from, { type: 'answer', sdp: pc.localDescription.sdp });
      } else if (data.type === 'answer') {
        await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
        await flush();
      } else if (data.type === 'candidate' && data.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
        else peer.pending.push(data.candidate);
      }
    }).catch((e) => { console.warn('voice signaling error:', e); peer.state = 'failed'; ui(); });
  }

  // ---------- session control ----------
  function cleanup() {
    st.on = false; st.joining = false;
    closeAllPeers();
    if (st.stream) st.stream.getTracks().forEach(t => t.stop());
    if (st.stopLocal) st.stopLocal();
    st.stream = null; st.stopLocal = null; st.noMic = false; st.muted = false; st.note = '';
    st.speaking.clear(); applySpeaking();
    ui();
  }

  async function enable() {
    if (st.on || st.joining) return;
    if (!G || !G.you) { toast('Join a game room first'); return ui(); }
    if (!window.RTCPeerConnection) { toast('Your browser does not support voice chat.'); return ui(); }
    st.joining = true; st.note = ''; ui();
    try {
      try { st.ice = (await api('/api/voice/config')).iceServers || []; } catch (e) { throw new Error('Could not load voice settings: ' + e.message); }
      st.noMic = false; st.stream = null;
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { const e = new Error('insecure'); e.name = 'SecurityError'; throw e; }
        st.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
        st.stopLocal = watch(st.stream, me.uid);
      } catch (e) { st.noMic = true; st.note = micError(e); toast(st.note); }
      st.muted = st.noMic;
      const res = await send('voice:join', { muted: st.muted });
      if (!res.ok) throw new Error(res.error);
      st.on = true;
      for (const p of res.peers) makePeer(p.uid, true);
    } catch (e) { cleanup(); toast(e.message); return; }
    finally { st.joining = false; }
    ui();
  }

  async function rejoin() {                       // after a socket reconnect the server has dropped our session
    if (!st.on || st.joining) return;
    st.joining = true; ui();
    try {
      closeAllPeers();
      const res = await send('voice:join', { muted: st.muted });
      if (!res.ok) throw new Error(res.error);
      for (const p of res.peers) makePeer(p.uid, true);
    } catch (e) { cleanup(); toast('Voice chat disconnected: ' + e.message); }
    finally { st.joining = false; ui(); }
  }

  function disable() {
    const was = st.on || st.joining;
    cleanup();
    if (was && socket && socket.connected) socket.emit('voice:leave', {});
  }

  async function toggleMute() {
    if (!st.on || st.noMic || !st.stream) return;
    st.muted = !st.muted;
    st.stream.getAudioTracks().forEach(t => { t.enabled = !st.muted; });
    ui();
    const r = await send('voice:mute', { muted: st.muted });
    if (!r.ok) toast(r.error);
  }

  // ---------- hooks used by app.js ----------
  function attach(sock) {
    sock.on('voice:signal', onSignal);
    sock.on('voice:peer-left', ({ uid }) => { closePeer(uid); ui(); });
    sock.on('voice:kicked', ({ reason }) => { cleanup(); toast(reason || 'Voice chat ended'); });
    sock.on('connect', () => { if (st.on) rejoin(); });
  }
  function onState() {
    if (st.on && !st.joining && (!G || !G.you || (G.voice && !G.voice[me.uid]))) { cleanup(); toast('Voice chat ended'); return; }
    ui(); applySpeaking();
  }

  el('voiceToggle').addEventListener('change', (e) => (e.target.checked ? enable() : disable()));
  el('micBtn').addEventListener('click', toggleMute);
  document.addEventListener('keydown', (e) => {   // M = mute / unmute
    if (e.key.toLowerCase() !== 'm' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName)) return;
    toggleMute();
  });
  window.addEventListener('pagehide', () => { if (st.on && socket) socket.emit('voice:leave', {}); });

  return { attach, onState, reset: cleanup, _st: st };
})();
window.Voice = Voice;
