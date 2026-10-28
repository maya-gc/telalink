// =============================================================================
//  viewer.js — pagina de quem assiste.
//  Ordem de tentativa: conexao direta (WebRTC) -> TURN (se configurado) ->
//  retransmissao pelo link. Tudo cifrado com a chave do "#" do link.
// =============================================================================
import { $, show, openSocket, describeTransport, TRANSPORT_LABEL, supportsWebCodecs } from './common.js';
import { keyFromHash, deriveKeys, SecureChannel } from './crypto.js';
import { RelayReceiver } from './relay.js';

const P2P_TIMEOUT_MS = 12_000;   // limite absoluto para a conexao direta/TURN
const NO_RESPONSE_MS = 4_000;    // sem NENHUMA resposta nesse tempo = rede bloqueando
const roomId = new URLSearchParams(location.search).get('room');
const sessionKey = keyFromHash(location.hash);

let ws, pc, channel, keys, viewerId, receiver, audioCtx, p2pTimer;
let iceServers = [];
let transport = 'conectando';

// Diagnostico de conexao (sem segredos): tipos de candidatos e estados.
const diag = { local: [], remote: [], states: [], pairs: null };
window.__telalink = {
  get transport() { return transport; },
  get stats() { return receiver ? { ...receiver.stats } : null; },
  get diag() { return diag; },
};
const candType = (c) => (/ typ (\w+)/.exec(c?.candidate || '') || [])[1] || '?';

// Resumo dos pares de candidatos testados (para entender por que nao conectou).
async function snapshotPairs(conn) {
  try {
    const st = await conn.getStats();
    const out = [];
    st.forEach((s) => {
      if (s.type !== 'candidate-pair') return;
      const l = st.get(s.localCandidateId); const r = st.get(s.remoteCandidateId);
      out.push(`${l?.candidateType}->${r?.candidateType} ${s.state} req=${s.requestsSent ?? 0} resp=${s.responsesReceived ?? 0}`);
    });
    diag.pairs = out;
  } catch {}
}

if (!roomId) fatal('Link inválido: falta o identificador da sala.');
else if (!sessionKey) fatal('Link incompleto: falta a chave de segurança (a parte depois do “#”). Peça o link completo para quem está transmitindo.');

function fatal(msg) { show($('gateMsg'), 'err', msg); $('btnJoin').disabled = true; }

const pinEl = $('pin');
pinEl.addEventListener('input', () => { pinEl.value = pinEl.value.replace(/\D/g, '').slice(0, 6); });
pinEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
$('btnJoin').onclick = join;

function setTransport(t) {
  transport = t;
  $('transportTxt').textContent = TRANSPORT_LABEL[t] || t;
}

async function join() {
  const pin = pinEl.value;
  if (pin.length !== 6) return show($('gateMsg'), 'err', 'Digite os 6 dígitos do PIN.');
  $('btnJoin').disabled = true;
  show($('gateMsg'), '', '');
  // AudioContext precisa nascer de um clique (regra dos navegadores).
  try { audioCtx = new AudioContext({ latencyHint: 'interactive' }); } catch { audioCtx = null; }
  keys = await deriveKeys(sessionKey, roomId);

  ws = openSocket({
    onJson: onMessage,
    onBinary: (bytes) => receiver?.handle(bytes),
    onClose: () => { if (transport === 'conectando') $('btnJoin').disabled = false; },
  });
  await ws.opened.catch(() => {});
  ws.json({ type: 'viewer-join', roomId, pin });
}

async function onMessage(m) {
  if (m.type === 'error') {
    $('btnJoin').disabled = false;
    const txt = { 'pin-invalido': 'PIN incorreto.', 'sala-inexistente': 'Transmissão não encontrada ou já encerrada.',
      bloqueado: 'Tentativas demais. Peça um novo link a quem está transmitindo.', 'sala-cheia': 'A transmissão atingiu o limite de espectadores.',
      'sala-trancada': 'A sala foi trancada por quem está transmitindo: novas pessoas não podem entrar agora.' }[m.reason];
    return show($('gateMsg'), 'err', txt || 'Não foi possível entrar.');
  }
  if (m.type === 'viewer-accepted') {
    viewerId = m.viewerId;
    iceServers = m.iceServers || [];
    channel = new SecureChannel(keys.sig, `${roomId}|${viewerId}`);
    return show($('gateMsg'), 'ok', 'Conectando à transmissão...');
  }
  if (m.type === 'signal' && m.from === 'host') {
    let p;
    try { p = await channel.open('h2v', m.data); }
    catch { return show($('gateMsg'), 'err', 'Não foi possível validar a transmissão: confira se o link está completo (com a parte depois do “#”).'); }
    return onHostSignal(p);
  }
  if (m.type === 'kicked') {
    cleanup();
    $('stage').classList.remove('on');
    $('gate').style.display = '';
    $('btnJoin').disabled = true;
    return show($('gateMsg'), 'err', 'Você foi removido da transmissão por quem está transmitindo.');
  }
  if (m.type === 'host-left') {
    cleanup();
    $('stage').classList.remove('on');
    $('gate').style.display = '';
    $('btnJoin').disabled = true;
    show($('gateMsg'), 'err', 'A transmissão foi encerrada.');
  }
}

const sendSig = async (payload) => ws.json({ type: 'signal', data: await channel.seal('v2h', payload) });

async function onHostSignal(p) {
  if (p.kind === 'hello') {
    if (p.policy === 'relay' || typeof RTCPeerConnection !== 'function') return startRelay();
    p2pTimer = setTimeout(() => { if (transport === 'conectando') fallbackToRelay(); }, P2P_TIMEOUT_MS);
    watchNoResponse(Date.now());
    return;
  }
  if (p.kind === 'sdp') {
    if (transport === 'retransmissao') return;
    if (!pc) createPeer();
    await pc.setRemoteDescription(p.sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    return sendSig({ kind: 'sdp', sdp: pc.localDescription.toJSON() });
  }
  if (p.kind === 'ice' && pc) { diag.remote.push(candType(p.candidate)); await pc.addIceCandidate(p.candidate).catch((e) => diag.states.push('addIce-erro:' + e.name)); }
}

function createPeer() {
  pc = new RTCPeerConnection({ iceServers });
  let localCandidates = 0;
  pc.ontrack = (e) => {
    const v = $('remote');
    if (v.srcObject !== e.streams[0]) v.srcObject = e.streams[0];
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) { localCandidates++; diag.local.push(candType(e.candidate)); sendSig({ kind: 'ice', candidate: e.candidate.toJSON() }); }
  };
  // Nenhum caminho de rede disponivel (VPN/extensao que desliga WebRTC):
  // nao adianta esperar o tempo-limite, troca ja para a retransmissao.
  pc.onicegatheringstatechange = () => {
    if (pc?.iceGatheringState === 'complete' && localCandidates === 0) fallbackToRelay();
  };
  pc.oniceconnectionstatechange = () => diag.states.push(`ice:${pc?.iceConnectionState}`);
  pc.onconnectionstatechange = async () => {
    diag.states.push(`pc:${pc?.connectionState}`);
    if (pc.connectionState === 'connected') {
      clearTimeout(p2pTimer);
      setTransport(await describeTransport(pc));
      sendSig({ kind: 'transport', mode: transport });
      showStage('video');
    } else if (pc.connectionState === 'failed') {
      fallbackToRelay();
    }
  };
}

// Se as tentativas de conexao direta nao recebem NENHUMA resposta (firewall de
// empresa, NAT de operadora), troca cedo em vez de esperar o limite inteiro.
function watchNoResponse(start) {
  const tick = async () => {
    if (transport !== 'conectando') return;
    if (pc && Date.now() - start >= NO_RESPONSE_MS) {
      let sent = 0, answered = 0;
      try {
        (await pc.getStats()).forEach((s) => {
          if (s.type === 'candidate-pair') { sent += s.requestsSent || 0; answered += (s.responsesReceived || 0) + (s.requestsReceived || 0); }
        });
      } catch {}
      if (sent > 0 && answered === 0) { diag.states.push('sem-resposta'); return fallbackToRelay(); }
    }
    setTimeout(tick, 1000);
  };
  setTimeout(tick, 1000);
}

async function fallbackToRelay() {
  if (transport === 'retransmissao') return;
  clearTimeout(p2pTimer);
  if (pc) { await snapshotPairs(pc); pc.close(); pc = null; }
  await sendSig({ kind: 'bye-p2p' });
  startRelay();
}

function startRelay() {
  if (!supportsWebCodecs()) {
    return show($('gateMsg'), 'err', 'Sua rede bloqueia a conexão direta e este navegador não suporta a retransmissão. Use Chrome, Edge ou Firefox atualizados.');
  }
  receiver = new RelayReceiver({ mediaKey: keys.media, canvas: $('relayCanvas'), ws, audioCtx, volume: view.muted ? 0 : view.volume / 100, onError: (e) => console.warn('[telalink relay]', e) });
  setTransport('retransmissao');
  ws.json({ type: 'relay-subscribe' });
  sendSig({ kind: 'transport', mode: 'retransmissao' });
  showStage('canvas');
}

function showStage(kind) {
  $('gate').style.display = 'none';
  $('stage').classList.add('on');
  $('remote').classList.toggle('hidden', kind !== 'video');
  $('relayCanvas').classList.toggle('hidden', kind !== 'canvas');
  $('btnPip').classList.toggle('hidden', kind !== 'video' || !document.pictureInPictureEnabled);
  flashBar();
  applyVolume();
  if (kind === 'video') {
    // Navegadores bloqueiam som automatico sem clique: comeca mudo e avisa.
    $('remote').play().catch(() => { view.muted = true; applyVolume(); $('remote').play().catch(() => {}); flashBar(8000); });
  }
}

function cleanup() {
  clearTimeout(p2pTimer);
  pc?.close(); pc = null;
  receiver?.close(); receiver = null;
  setTransport('conectando');
}

// ------------------------------------------------------------ controles
const store = { get(k, d) { try { const v = localStorage.getItem('telalink.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('telalink.' + k, JSON.stringify(v)); } catch {} } };
const FITS = [['contain', '⤢ Caber'], ['cover', '⤡ Preencher'], ['real', '1:1 Tamanho real']];
const view = { volume: store.get('volume', 100), muted: false, fit: store.get('fit', 'contain') };
window.__telalink.view = view;

function applyVolume() {
  const v = view.muted ? 0 : view.volume / 100;
  $('remote').muted = view.muted || view.volume === 0;
  $('remote').volume = Math.min(1, view.volume / 100);
  receiver?.setVolume(v);
  if (audioCtx?.state === 'suspended' && !view.muted) audioCtx.resume().catch(() => {});
  $('btnMute').textContent = view.muted || view.volume === 0 ? '🔇' : '🔊';
  $('volume').value = view.volume;
}
function applyFit() {
  $('stage').classList.toggle('fit-cover', view.fit === 'cover');
  $('stage').classList.toggle('fit-real', view.fit === 'real');
  $('btnFit').textContent = FITS.find((f) => f[0] === view.fit)[1];
}
function flashBar(ms = 3000) {
  $('bar').classList.add('show');
  clearTimeout(flashBar.t); flashBar.t = setTimeout(() => $('bar').classList.remove('show'), ms);
}

$('btnMute').onclick = () => { view.muted = !(view.muted || view.volume === 0); if (!view.muted && view.volume === 0) view.volume = 50; applyVolume(); };
$('volume').oninput = () => { view.volume = Number($('volume').value); view.muted = false; store.set('volume', view.volume); applyVolume(); };
$('btnFit').onclick = () => {
  const i = FITS.findIndex((f) => f[0] === view.fit);
  view.fit = FITS[(i + 1) % FITS.length][0];
  store.set('fit', view.fit);
  applyFit();
};
$('btnPip').onclick = async () => {
  try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await $('remote').requestPictureInPicture(); } catch {}
};
$('btnFull').onclick = () => {
  if (!document.fullscreenElement) $('stage').requestFullscreen?.();
  else document.exitFullscreen?.();
};
$('stage').addEventListener('mousemove', () => flashBar());
$('stage').addEventListener('dblclick', () => $('btnFull').click());
document.addEventListener('keydown', (e) => {
  if (!$('stage').classList.contains('on') || e.target.tagName === 'INPUT') return;
  if (e.key === 'f' || e.key === 'F') $('btnFull').click();
  else if (e.key === 'm' || e.key === 'M') $('btnMute').click();
  else if (e.key === 'a' || e.key === 'A') $('btnFit').click();
});
applyFit();
