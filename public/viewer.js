// =============================================================================
//  viewer.js — pagina de quem assiste.
//  Ordem de tentativa: conexao direta (WebRTC) -> TURN (se configurado) ->
//  retransmissao pelo link. Tudo cifrado com a chave do "#" do link.
// =============================================================================
import { $, show, openSocket, describeTransport, TRANSPORT_LABEL, supportsWebCodecs } from './common.js';
import { keyFromHash, deriveKeys, SecureChannel } from './crypto.js';
import { RelayReceiver } from './relay.js';

const P2P_TIMEOUT_MS = 12_000;
const roomId = new URLSearchParams(location.search).get('room');
const sessionKey = keyFromHash(location.hash);

let ws, pc, channel, keys, viewerId, receiver, audioCtx, p2pTimer;
let iceServers = [];
let transport = 'conectando';

window.__telalink = {
  get transport() { return transport; },
  get stats() { return receiver ? { ...receiver.stats } : null; },
};

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
      bloqueado: 'Tentativas demais. Peça um novo link a quem está transmitindo.', 'sala-cheia': 'A transmissão atingiu o limite de espectadores.' }[m.reason];
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
  if (p.kind === 'ice' && pc) await pc.addIceCandidate(p.candidate).catch(() => {});
}

function createPeer() {
  pc = new RTCPeerConnection({ iceServers });
  let localCandidates = 0;
  pc.ontrack = (e) => {
    const v = $('remote');
    if (v.srcObject !== e.streams[0]) v.srcObject = e.streams[0];
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) { localCandidates++; sendSig({ kind: 'ice', candidate: e.candidate.toJSON() }); }
  };
  // Nenhum caminho de rede disponivel (VPN/extensao que desliga WebRTC):
  // nao adianta esperar o tempo-limite, troca ja para a retransmissao.
  pc.onicegatheringstatechange = () => {
    if (pc?.iceGatheringState === 'complete' && localCandidates === 0) fallbackToRelay();
  };
  pc.onconnectionstatechange = async () => {
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

async function fallbackToRelay() {
  if (transport === 'retransmissao') return;
  clearTimeout(p2pTimer);
  if (pc) { pc.close(); pc = null; }
  await sendSig({ kind: 'bye-p2p' });
  startRelay();
}

function startRelay() {
  if (!supportsWebCodecs()) {
    return show($('gateMsg'), 'err', 'Sua rede bloqueia a conexão direta e este navegador não suporta a retransmissão. Use Chrome, Edge ou Firefox atualizados.');
  }
  receiver = new RelayReceiver({ mediaKey: keys.media, canvas: $('relayCanvas'), ws, audioCtx, onError: (e) => console.warn('[telalink relay]', e) });
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
  $('bar').classList.add('show');
  setTimeout(() => $('bar').classList.remove('show'), 4000);
  if (kind === 'video') {
    $('remote').play().catch(() => { $('remote').muted = true; $('remote').play().catch(() => {}); $('btnSound').classList.remove('hidden'); });
  } else if (audioCtx?.state === 'suspended') {
    $('btnSound').classList.remove('hidden');
  }
}

function cleanup() {
  clearTimeout(p2pTimer);
  pc?.close(); pc = null;
  receiver?.close(); receiver = null;
  setTransport('conectando');
}

$('btnSound').onclick = () => {
  $('remote').muted = false;
  $('remote').play().catch(() => {});
  audioCtx?.resume();
  $('btnSound').classList.add('hidden');
};

$('btnFull').onclick = () => {
  if (!document.fullscreenElement) $('stage').requestFullscreen?.();
  else document.exitFullscreen?.();
};
