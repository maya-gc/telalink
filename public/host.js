// =============================================================================
//  host.js — painel de quem transmite.
// =============================================================================
import { $, show, openSocket, describeTransport, turnBytesSent, TRANSPORT_LABEL, supportsWebCodecs } from './common.js';
import { generateSessionKey, deriveKeys, toB64url, SecureChannel } from './crypto.js';
import { BlackScreenDetector } from './media-util.js';
import { RelaySender } from './relay.js';

let tunnel = { status: 'off', url: null, error: null };
let ws, roomId, pin, sessionKey, keys, stream, policy, contentHint;
let iceServers = [];
let relay = null;
const viewers = new Map(); // viewerId -> { channel, pc, transport, turnReported }
const relayViewers = new Set();

// Exposto para os testes automaticos (sem segredos).
window.__telalink = {
  get viewers() { return [...viewers.entries()].map(([id, v]) => ({ id, transport: v.transport })); },
  get relay() { return relay ? { ...relay.stats } : null; },
};

// ------------------------------------------------------------ link externo
const shareBase = () => tunnel.url || location.origin;
const linkFor = () => `${shareBase()}/view?room=${roomId}#k=${toB64url(sessionKey)}`;

function renderTunnel() {
  const el = $('tunnelStatus');
  if (tunnel.status === 'on') { el.className = 'banner on'; el.textContent = 'Link externo pronto: funciona de qualquer rede.'; }
  else if (tunnel.status === 'starting') { el.className = 'banner wait'; el.textContent = 'Preparando link externo... (alguns segundos)'; }
  else { el.className = 'banner off'; el.textContent = 'Sem link externo' + (tunnel.error ? ` (${tunnel.error})` : '') + ': o link só funciona neste computador.'; }
  if (roomId) $('shareLink').value = linkFor();
}

async function pollTunnel() {
  try {
    const info = await (await fetch('/api/info')).json();
    tunnel = info.tunnel;
    if (!roomId && info.defaultMode) {
      const r = document.querySelector(`input[name=policy][value=${info.defaultMode}]`);
      if (r && !pollTunnel.done) { r.checked = true; pollTunnel.done = true; }
    }
  } catch {}
  renderTunnel();
  setTimeout(pollTunnel, tunnel.status === 'on' ? 10000 : 2000);
}
pollTunnel();

// ------------------------------------------------------------ inicio
$('btnStart').onclick = async () => {
  $('btnStart').disabled = true;
  show($('setupMsg'), '', '');
  policy = document.querySelector('input[name=policy]:checked').value;
  contentHint = document.querySelector('input[name=hint]:checked').value;
  if (policy === 'relay' && !supportsWebCodecs()) {
    $('btnStart').disabled = false;
    return show($('setupMsg'), 'err', 'Este navegador não suporta o modo Máxima segurança. Use Chrome ou Edge atualizados.');
  }
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 60 }, width: { max: 1920 }, height: { max: 1080 } },
      audio: $('optAudio').checked ? { suppressLocalAudioPlayback: false } : false,
      systemAudio: 'include',
      surfaceSwitching: 'include',
      selfBrowserSurface: 'exclude',
      monitorTypeSurfaces: 'include',
    });
  } catch {
    $('btnStart').disabled = false;
    return show($('setupMsg'), 'err', 'Captura cancelada ou não permitida pelo navegador.');
  }
  const vtrack = stream.getVideoTracks()[0];
  try { vtrack.contentHint = contentHint; } catch {}
  vtrack.addEventListener('ended', stopAll);

  const res = await fetch('/api/create-room', { method: 'POST' });
  ({ roomId, pin } = await res.json());
  sessionKey = generateSessionKey();
  keys = await deriveKeys(sessionKey, roomId);

  $('pinView').textContent = pin;
  $('preview').srcObject = stream;
  $('policyTxt').textContent = policy === 'relay' ? 'Máxima segurança' : 'Padrão';
  $('setup').classList.add('hidden');
  $('share').classList.remove('hidden');
  renderTunnel();
  if (stream.getAudioTracks().length === 0 && $('optAudio').checked) {
    show($('shareMsg'), 'warn', 'Sem áudio: na janela de escolha, use “Aba” ou “Tela inteira” e marque “Compartilhar áudio”.');
  }
  connect();
  watchBlackScreen();
  setInterval(reportTurnUsage, 30_000);
};

// ------------------------------------------------------------ sinalizacao
function connect() {
  ws = openSocket({
    onJson: async (m) => {
      if (m.type === 'host-ready') iceServers = m.iceServers || [];
      else if (m.type === 'viewer-joined') await onViewerJoined(m.viewerId);
      else if (m.type === 'signal' && m.from === 'viewer') await onViewerSignal(m.viewerId, m.data);
      else if (m.type === 'viewer-left') closeViewer(m.viewerId);
      else if (m.type === 'relay-want') onRelayWant(m.viewerId);
      else if (m.type === 'relay-keyframe') relay?.requestKeyframe();
      else if (m.type === 'error') show($('shareMsg'), 'err', 'Erro na sala: ' + m.reason);
      renderViewers();
    },
    onClose: () => { if (stream) show($('shareMsg'), 'err', 'Conexão com o servidor caiu. Recarregue para reabrir a sala.'); },
  });
  ws.opened.then(() => ws.json({ type: 'host-join', roomId }));
}

async function sendSig(viewerId, payload) {
  const v = viewers.get(viewerId);
  if (!v) return;
  ws.json({ type: 'signal', viewerId, data: await v.channel.seal('h2v', payload) });
}

async function onViewerJoined(viewerId) {
  viewers.set(viewerId, { channel: new SecureChannel(keys.sig, `${roomId}|${viewerId}`), pc: null, transport: 'conectando', turnReported: 0 });
  await sendSig(viewerId, { kind: 'hello', policy });
  if (policy === 'auto') await createOffer(viewerId);
}

async function onViewerSignal(viewerId, envelope) {
  const v = viewers.get(viewerId);
  if (!v) return;
  let p;
  try { p = await v.channel.open('v2h', envelope); }
  catch { console.warn('[telalink] mensagem nao autenticada descartada'); return; }
  if (p.kind === 'sdp' && v.pc) await v.pc.setRemoteDescription(p.sdp);
  else if (p.kind === 'ice' && v.pc) await v.pc.addIceCandidate(p.candidate).catch(() => {});
  else if (p.kind === 'transport') v.transport = p.mode;
  else if (p.kind === 'bye-p2p') { v.pc?.close(); v.pc = null; }
}

async function createOffer(viewerId) {
  const v = viewers.get(viewerId);
  const pc = new RTCPeerConnection({ iceServers });
  v.pc = pc;
  for (const track of stream.getTracks()) {
    const sender = pc.addTrack(track, stream);
    if (track.kind === 'video') {
      const params = sender.getParameters();
      params.degradationPreference = contentHint === 'detail' ? 'maintain-resolution' : 'maintain-framerate';
      sender.setParameters(params).catch(() => {});
    }
  }
  pc.onicecandidate = (e) => { if (e.candidate) sendSig(viewerId, { kind: 'ice', candidate: e.candidate.toJSON() }); };
  pc.onconnectionstatechange = async () => {
    if (pc.connectionState === 'connected') { v.transport = await describeTransport(pc); renderViewers(); }
    else if (pc.connectionState === 'failed') { pc.close(); if (v.pc === pc) v.pc = null; }
  };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await sendSig(viewerId, { kind: 'sdp', sdp: pc.localDescription.toJSON() });
}

function onRelayWant(viewerId) {
  const v = viewers.get(viewerId);
  if (v) { v.transport = 'retransmissao'; v.pc?.close(); v.pc = null; }
  relayViewers.add(viewerId);
  if (!relay) {
    relay = new RelaySender({
      stream, mediaKey: keys.media, ws, previewVideo: $('preview'),
      bitrate: contentHint === 'detail' ? 3_000_000 : 2_500_000,
      onError: (e) => console.warn('[telalink relay]', e),
    });
  }
  relay.start();
  relay.requestKeyframe();
}

function closeViewer(viewerId) {
  const v = viewers.get(viewerId);
  v?.pc?.close();
  viewers.delete(viewerId);
  relayViewers.delete(viewerId);
  if (relay && relayViewers.size === 0) { relay.stop(); relay = null; }
}

function renderViewers() {
  const list = $('viewerList');
  list.textContent = '';
  let n = 0;
  for (const [id, v] of viewers) {
    if (v.transport !== 'conectando') n++;
    const li = document.createElement('li');
    const a = document.createElement('span'); a.textContent = `Espectador ${id.slice(0, 4)}`;
    const b = document.createElement('span'); b.className = 'stat'; b.textContent = TRANSPORT_LABEL[v.transport] || v.transport;
    li.append(a, b);
    list.appendChild(li);
  }
  $('viewerCount').textContent = n;
}

// ------------------------------------------------------------ consumo TURN
async function reportTurnUsage() {
  let delta = 0;
  for (const v of viewers.values()) {
    if (!v.pc) continue;
    const total = await turnBytesSent(v.pc);
    if (total > v.turnReported) { delta += total - v.turnReported; v.turnReported = total; }
  }
  // x2: estimativa conservadora (o TURN recebe e reenvia cada byte).
  if (delta > 0) ws.json({ type: 'turn-usage', bytes: delta * 2 });
}

// ------------------------------------------------------------ tela preta
function watchBlackScreen() {
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 36;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const det = new BlackScreenDetector({ samples: 4 });
  const timer = setInterval(() => {
    const video = $('preview');
    if (!stream || !stream.active) return clearInterval(timer);
    if (video.readyState < 2) return;
    ctx.drawImage(video, 0, 0, 64, 36);
    const change = det.push(ctx.getImageData(0, 0, 64, 36).data);
    if (change === true) {
      const surface = stream.getVideoTracks()[0].getSettings().displaySurface;
      const tip = surface === 'browser'
        ? 'A aba compartilhada está preta. Se for um filme pago/protegido (DRM), o próprio site bloqueia a captura e isso não pode ser contornado.'
        : 'A imagem está saindo preta. Vídeos (YouTube etc.) em uma “Janela” podem sair pretos por causa da aceleração de hardware: encerre e compartilhe a “Aba” do vídeo, ou desligue “Usar aceleração de hardware” nas configurações do navegador. Filmes protegidos (DRM) sempre saem pretos.';
      $('blackWarning').textContent = '⚠️ ' + tip;
      $('blackWarning').classList.remove('hidden');
    } else if (change === false) {
      $('blackWarning').classList.add('hidden');
    }
  }, 1000);
}

// ------------------------------------------------------------ fim
function stopAll() {
  for (const id of [...viewers.keys()]) closeViewer(id);
  relay?.stop(); relay = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  ws?.close();
  $('liveDot').classList.remove('live');
  $('liveTxt').textContent = 'Encerrado';
  show($('shareMsg'), 'ok', 'Transmissão encerrada. Recarregue a página para começar de novo.');
}

$('btnCopyLink').onclick = () => { navigator.clipboard.writeText($('shareLink').value); flash($('btnCopyLink')); };
$('btnCopyAll').onclick = () => { navigator.clipboard.writeText(`Link: ${$('shareLink').value}\nPIN: ${pin}`); flash($('btnCopyAll')); };
$('btnStop').onclick = stopAll;
function flash(btn) { const t = btn.textContent; btn.textContent = 'Copiado!'; setTimeout(() => (btn.textContent = t), 1200); }
