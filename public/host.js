// =============================================================================
//  host.js — painel de quem transmite.
//  Caminho rapido: "Minha tela" -> escolher -> convite ja copiado (3 cliques).
//  Tudo o mais (qualidade, audio, conexao) fica em Configuracoes.
// =============================================================================
import { $, show, openSocket, describeTransport, turnBytesSent, TRANSPORT_LABEL, supportsWebCodecs } from './common.js';
import { generateSessionKey, deriveKeys, toB64url, SecureChannel } from './crypto.js';
import { BlackScreenDetector, QUALITY, qualityPreset, captureConstraints, senderEncoding, inviteText } from './media-util.js';
import { RelaySender } from './relay.js';
import { Output, loadImageFiles } from './output.js';

// ------------------------------------------------------------ estado
let tunnel = { status: 'off', url: null, error: null };
let conexao = null;
let prefs = { quality: 'auto', fps: 30, hint: 'motion', audio: true, volume: 100 };
let policy = 'auto';
let ws, roomId, pin, sessionKey, keys;
let iceServers = [];
let relay = null;
let locked = false;
let output = null;
let usageTimer = null;
const viewers = new Map(); // viewerId -> { channel, pc, transport, turnReported, joinedAt }
const relayViewers = new Set();

window.__telalink = {
  get viewers() { return [...viewers.entries()].map(([id, v]) => ({ id, transport: v.transport })); },
  get relay() { return relay ? { ...relay.stats } : null; },
  // Parametros de envio aplicados a cada espectador (altura efetiva e banda).
  async sending() {
    const out = [];
    for (const v of viewers.values()) {
      for (const s of v.pc?.getSenders() || []) {
        if (s.track?.kind !== 'video') continue;
        const e = s.getParameters().encodings?.[0] || {};
        const h = s.track.getSettings().height || 0;
        out.push({ trackHeight: h, scale: e.scaleResolutionDownBy || 1, height: Math.round(h / (e.scaleResolutionDownBy || 1)), maxBitrate: e.maxBitrate || null });
      }
    }
    return out;
  },
  get state() {
    return output ? { source: output.source, paused: output.paused, muted: output.muted, volume: output.volume,
      quality: prefs.quality, fps: prefs.fps, locked, policy } : null;
  },
};

// ------------------------------------------------------------ inicio
const PROVIDER_LABEL = { none: 'Nenhum (usa a retransmissão pelo link)', cloudflare: 'Cloudflare TURN', coturn: 'TURN próprio (coturn)', static: 'Usuário e senha fixos' };
const qualityOptions = (sel, value) => {
  sel.textContent = '';
  for (const [k, q] of Object.entries(QUALITY)) {
    const o = document.createElement('option'); o.value = k; o.textContent = q.label; sel.appendChild(o);
  }
  sel.value = value;
};

function renderSummary() {
  const q = qualityPreset(prefs.quality).label.toLowerCase();
  $('summary').textContent = `Qualidade ${q} · ${prefs.fps} quadros/s · Som ${prefs.audio ? 'ligado' : 'desligado'} · ` +
    `${policy === 'relay' ? 'Máxima segurança' : 'Segurança padrão'} — ajuste em ⚙ Configurações`;
}

function renderTunnel() {
  const el = $('tunnelStatus');
  if (tunnel.status === 'on') { el.className = 'pill on'; el.textContent = '● Link externo pronto'; el.title = tunnel.providerName ? `via ${tunnel.providerName}` : ''; }
  else if (tunnel.status === 'starting') { el.className = 'pill wait'; el.textContent = '◌ Preparando link…'; }
  else { el.className = 'pill off'; el.textContent = '○ Só neste computador'; el.title = tunnel.error || ''; }
  if (roomId) $('shareLink').value = linkFor();
  const t = $('sumTunnel');
  if (t) t.textContent = tunnel.status === 'on' ? `Pronto via ${tunnel.providerName || 'túnel'}` : tunnel.status === 'starting' ? 'Preparando…' : (tunnel.error || 'Desligado');
}

function renderConn() {
  if (!conexao) return;
  $('sumMode').textContent = conexao.defaultMode === 'relay' ? 'Máxima segurança' : 'Padrão';
  $('sumTurn').textContent = PROVIDER_LABEL[conexao.provider] + (conexao.turnError ? ` — erro: ${conexao.turnError}` : '');
  $('sumUsage').textContent = conexao.provider === 'none' ? '—'
    : `${conexao.usageGB} GB${conexao.capGB ? ` de ${conexao.capGB} GB` : ' (sem limite)'}${conexao.overCap ? ' — limite atingido, TURN pausado' : ''}`;
}

let firstInfo = true;
async function pollInfo() {
  try {
    const info = await (await fetch('/api/info')).json();
    tunnel = info.tunnel;
    conexao = info.conexao;
    if (firstInfo) {
      firstInfo = false;
      if (info.prefs) prefs = { ...prefs, ...info.prefs };
      policy = info.defaultMode || 'auto';
      renderSummary();
    }
  } catch {}
  renderTunnel();
  renderConn();
  setTimeout(pollInfo, tunnel.status === 'on' ? 10000 : 2000);
}
pollInfo();
renderSummary();

// ------------------------------------------------------------ configuracoes
function openSettings() {
  qualityOptions($('optQuality'), prefs.quality);
  $('optFps').value = String(prefs.fps);
  document.querySelector(`input[name=hint][value=${prefs.hint}]`).checked = true;
  $('optAudio').checked = prefs.audio;
  $('optVolume').value = prefs.volume; $('optVolumeTxt').textContent = `${prefs.volume}%`;
  document.querySelector(`input[name=policy][value=${policy}]`).checked = true;
  $('optTunnel').value = conexao?.tunnel || 'auto';
  $('settingsMsg').textContent = '';
  renderTunnel(); renderConn();
  $('settings').showModal();
}
const closeSettings = () => $('settings').close();
$('btnSettings').onclick = openSettings;
$('btnCloseSettings').onclick = closeSettings;
$('btnCancelSettings').onclick = closeSettings;
$('optVolume').oninput = () => { $('optVolumeTxt').textContent = `${$('optVolume').value}%`; };

$('btnSaveSettings').onclick = async () => {
  const next = {
    quality: $('optQuality').value, fps: Number($('optFps').value),
    hint: document.querySelector('input[name=hint]:checked').value,
    audio: $('optAudio').checked, volume: Number($('optVolume').value),
  };
  const nextPolicy = document.querySelector('input[name=policy]:checked').value;
  const nextTunnel = $('optTunnel').value;
  // Vale na hora para esta sessao...
  prefs = next; policy = nextPolicy;
  renderSummary();
  if (output) applyQuality();
  closeSettings();                     // fecha na hora; salvar segue em segundo plano
  // ...e fica salvo neste PC para as proximas.
  try {
    const r = await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prefs: next, defaultMode: nextPolicy, tunnel: nextTunnel }) });
    if (r.ok) { const s = await r.json(); conexao = { ...(conexao || {}), tunnel: s.tunnel, defaultMode: s.defaultMode }; }
    else if (r.status !== 404) toast('Não foi possível salvar as configurações neste computador.');
  } catch {}
};

// ------------------------------------------------------------ comecar (2o clique)
function captureOptions() {
  return {
    video: { ...captureConstraints(prefs.quality, prefs.fps) },
    audio: prefs.audio ? { suppressLocalAudioPlayback: false } : false,
    systemAudio: prefs.audio ? 'include' : 'exclude',
    surfaceSwitching: 'include',
    selfBrowserSurface: 'exclude',
    monitorTypeSurfaces: 'include',
  };
}

async function pickScreen() {
  const stream = await navigator.mediaDevices.getDisplayMedia(captureOptions());
  const v = stream.getVideoTracks()[0];
  try { v.contentHint = prefs.hint; } catch {}
  v.addEventListener('ended', () => { if (output?.screen === stream) stopAll(); });
  return stream;
}

$('btnScreen').onclick = async () => {
  if (!checkPolicy()) return;
  ensureOutput();
  let stream;
  try { stream = await pickScreen(); }
  catch { return show($('homeMsg'), 'err', 'Captura cancelada ou não permitida pelo navegador.'); }
  output.useScreen(stream);
  if (prefs.audio && !stream.getAudioTracks().length) {
    show($('shareMsg'), 'warn', 'Sem som: na janela de escolha, use “Aba” ou “Tela inteira” e marque “Compartilhar áudio”.');
  }
  await goLive();
};

$('btnImages').onclick = () => { if (!checkPolicy()) return; ensureOutput(); $('fileImages').click(); };
$('fileImages').onchange = async () => {
  const imgs = await loadImageFiles($('fileImages').files);
  $('fileImages').value = '';
  if (!imgs.length) return show(roomId ? $('shareMsg') : $('homeMsg'), 'err', 'Nenhuma imagem válida escolhida.');
  ensureOutput();
  if (output.source === 'images' && $('fileImages').dataset.mode === 'add') output.addImages(imgs);
  else output.useImages(imgs);
  $('fileImages').dataset.mode = '';
  if (!roomId) await goLive();
};

function checkPolicy() {
  if (policy === 'relay' && !supportsWebCodecs()) {
    show($('homeMsg'), 'err', 'Este navegador não suporta o modo Máxima segurança. Use Chrome ou Edge atualizados.');
    return false;
  }
  return true;
}

function ensureOutput() {
  if (output) return;
  output = new Output({ onVideoTrack: (track) => onVideoTrackChanged(track), onChange: renderLive });
  output.init();
  output.setVolume(prefs.volume);
}

// ------------------------------------------------------------ ao vivo
const shareBase = () => tunnel.url || location.origin;
const linkFor = () => `${shareBase()}/view?room=${roomId}#k=${toB64url(sessionKey)}`;

async function goLive() {
  const res = await fetch('/api/create-room', { method: 'POST' });
  ({ roomId, pin } = await res.json());
  sessionKey = generateSessionKey();
  keys = await deriveKeys(sessionKey, roomId);

  $('pinView').textContent = pin;
  $('preview').srcObject = output.stream;
  qualityOptions($('liveQuality'), prefs.quality);
  $('home').classList.add('hidden');
  $('live').classList.remove('hidden');
  renderTunnel();
  renderLive();
  connect();
  watchBlackScreen();
  usageTimer = setInterval(reportTurnUsage, 30_000);
  // 3o clique ja foi o da janela de escolha: o convite vai sozinho para a area de transferencia.
  copyInvite(true);
}

async function copyInvite(auto = false) {
  try {
    await navigator.clipboard.writeText(inviteText($('shareLink').value, pin));
    toast(auto ? '✅ Convite copiado! Cole no WhatsApp ou e-mail.' : '✅ Convite copiado!');
  } catch {
    if (!auto) toast('Não foi possível copiar automaticamente. Selecione o link e copie.');
  }
}
function toast(text) {
  const t = $('toast');
  t.textContent = text; t.classList.remove('hidden');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.add('hidden'), 4000);
}
$('btnCopyInvite').onclick = () => copyInvite();
$('btnCopyLink').onclick = async () => { try { await navigator.clipboard.writeText($('shareLink').value); toast('✅ Link copiado!'); } catch {} };

function renderLive() {
  if (!output || !roomId) return;
  $('btnPause').textContent = output.paused ? '▶ Retomar' : '⏸ Pausar';
  $('btnPause').classList.toggle('active', output.paused);
  $('btnMute').textContent = output.muted ? '🔇 Sem som' : '🔊 Som ligado';
  $('btnMute').classList.toggle('active', output.muted);
  $('volume').value = output.volume;
  $('volumeTxt').textContent = `${output.volume}%`;
  $('liveTxt').textContent = output.paused ? 'Pausado' : 'Ao vivo';
  $('liveDot').classList.toggle('live', !output.paused);
  $('btnLock').textContent = locked ? '🔒 Sala trancada' : '🔓 Sala aberta';
  $('btnLock').setAttribute('aria-pressed', String(locked));
  $('btnLock').classList.toggle('active', locked);
  const img = output.source === 'images';
  $('imgControls').classList.toggle('hidden', !img);
  if (img) $('imgPos').textContent = `${output.imageIndex + 1} de ${output.images.length}`;
}

$('btnPause').onclick = () => output.setPaused(!output.paused);
$('btnMute').onclick = () => output.setMuted(!output.muted);
$('volume').oninput = () => output.setVolume(Number($('volume').value));
$('liveQuality').onchange = () => { prefs.quality = $('liveQuality').value; applyQuality(); renderSummary(); };
$('btnLock').onclick = () => ws.json({ type: 'lock', locked: !locked });
$('btnSwitch').onclick = () => $('switchMenu').classList.toggle('hidden');
$('swScreen').onclick = async () => {
  $('switchMenu').classList.add('hidden');
  try { output.useScreen(await pickScreen()); applyQuality(); }
  catch { show($('shareMsg'), 'warn', 'Troca cancelada: continua mostrando o mesmo conteúdo.'); }
};
$('swImages').onclick = () => { $('switchMenu').classList.add('hidden'); $('fileImages').dataset.mode = ''; $('fileImages').click(); };
$('imgPrev').onclick = () => output.showImage(-1);
$('imgNext').onclick = () => output.showImage(1);
$('imgAdd').onclick = () => { $('fileImages').dataset.mode = 'add'; $('fileImages').click(); };
document.addEventListener('keydown', (e) => {
  if (output?.source !== 'images' || $('settings').open || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === 'ArrowRight') output.showImage(1);
  if (e.key === 'ArrowLeft') output.showImage(-1);
});

// Aplica qualidade/quadros em todos os caminhos (captura, WebRTC, retransmissao).
function applyQuality() {
  const q = qualityPreset(prefs.quality);
  output.screenTrack?.applyConstraints(captureConstraints(prefs.quality, prefs.fps)).catch(() => {});
  for (const v of viewers.values()) setSenderQuality(v.pc);
  relay?.setQuality({ maxH: q.maxH, bitrate: q.bitrate || 2_500_000, fps: prefs.fps });
}
function setSenderQuality(pc) {
  if (!pc) return;
  for (const sender of pc.getSenders()) {
    if (sender.track?.kind !== 'video') continue;
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    const enc = senderEncoding(prefs.quality, prefs.fps, output.sourceHeight);
    params.encodings[0].maxFramerate = enc.maxFramerate;
    params.encodings[0].scaleResolutionDownBy = enc.scaleResolutionDownBy;
    if (enc.maxBitrate) params.encodings[0].maxBitrate = enc.maxBitrate; else delete params.encodings[0].maxBitrate;
    params.degradationPreference = prefs.hint === 'detail' ? 'maintain-resolution' : 'maintain-framerate';
    sender.setParameters(params).catch(() => {});
  }
}

// Fonte de video mudou (tela/imagem/pausa): troca em quem ja esta assistindo.
function onVideoTrackChanged(track) {
  for (const v of viewers.values()) {
    if (v.pc && v.videoSender) v.videoSender.replaceTrack(track).then(() => setSenderQuality(v.pc)).catch(() => {});
  }
  relay?.replaceVideoTrack(track);
}

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
      else if (m.type === 'locked') { locked = m.locked; renderLive(); toast(locked ? '🔒 Sala trancada: ninguém novo entra.' : '🔓 Sala aberta para novas pessoas.'); }
      else if (m.type === 'error') show($('shareMsg'), 'err', 'Erro na sala: ' + m.reason);
      renderViewers();
    },
    onClose: () => { if (output) show($('shareMsg'), 'err', 'Conexão com o servidor caiu. Recarregue para reabrir a sala.'); },
  });
  ws.opened.then(() => ws.json({ type: 'host-join', roomId }));
}

async function sendSig(viewerId, payload) {
  const v = viewers.get(viewerId);
  if (!v) return;
  ws.json({ type: 'signal', viewerId, data: await v.channel.seal('h2v', payload) });
}

async function onViewerJoined(viewerId) {
  viewers.set(viewerId, { channel: new SecureChannel(keys.sig, `${roomId}|${viewerId}`), pc: null, transport: 'conectando', turnReported: 0, joinedAt: Date.now() });
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
  for (const track of output.stream.getTracks()) {
    const sender = pc.addTrack(track, output.stream);
    if (track.kind === 'video') v.videoSender = sender;
  }
  setSenderQuality(pc);
  pc.onicecandidate = (e) => { if (e.candidate) sendSig(viewerId, { kind: 'ice', candidate: e.candidate.toJSON() }); };
  pc.onconnectionstatechange = async () => {
    if (pc.connectionState === 'connected') { v.transport = await describeTransport(pc); setSenderQuality(pc); renderViewers(); }
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
    const q = qualityPreset(prefs.quality);
    relay = new RelaySender({
      stream: output.stream, mediaKey: keys.media, ws, previewVideo: $('preview'),
      bitrate: q.bitrate || (prefs.hint === 'detail' ? 3_000_000 : 2_500_000), maxH: q.maxH, fps: prefs.fps,
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
  if (!viewers.size) {
    const li = document.createElement('li'); li.className = 'hint'; li.textContent = 'Ninguém ainda. Envie o convite.';
    list.appendChild(li);
  }
  let i = 0;
  for (const [id, v] of viewers) {
    i++;
    if (v.transport !== 'conectando') n++;
    const li = document.createElement('li');
    const name = document.createElement('span'); name.textContent = `Pessoa ${i}`;
    const right = document.createElement('span'); right.className = 'row';
    const how = document.createElement('span'); how.className = 'stat'; how.textContent = TRANSPORT_LABEL[v.transport] || v.transport;
    const kick = document.createElement('button'); kick.className = 'ghost small'; kick.textContent = 'Remover';
    kick.dataset.viewer = id;
    kick.onclick = () => ws.json({ type: 'kick', viewerId: id });
    right.append(how, kick);
    li.append(name, right);
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
  if (delta > 0) ws.json({ type: 'turn-usage', bytes: delta * 2 }); // x2: estimativa conservadora
}

// ------------------------------------------------------------ tela preta
function watchBlackScreen() {
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 36;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const det = new BlackScreenDetector({ samples: 4 });
  const timer = setInterval(() => {
    if (!output) return clearInterval(timer);
    const video = $('preview');
    if (output.source !== 'screen' || output.paused || video.readyState < 2) { det.count = 0; $('blackWarning').classList.add('hidden'); return; }
    ctx.drawImage(video, 0, 0, 64, 36);
    const change = det.push(ctx.getImageData(0, 0, 64, 36).data);
    if (change === true) {
      const surface = output.screenTrack?.getSettings().displaySurface;
      const tip = surface === 'browser'
        ? 'A aba compartilhada está preta. Se for um filme pago/protegido (DRM), o próprio site bloqueia a captura e isso não pode ser contornado.'
        : 'A imagem está saindo preta. Vídeos (YouTube etc.) numa “Janela” podem sair pretos por causa da aceleração de hardware: use 🔄 Trocar e escolha a “Aba” do vídeo, ou desligue “Usar aceleração de hardware” no navegador. Filmes protegidos (DRM) sempre saem pretos.';
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
  clearInterval(usageTimer);
  output?.stop(); output = null;
  ws?.close();
  $('liveDot').classList.remove('live');
  $('liveTxt').textContent = 'Encerrado';
  for (const id of ['btnPause', 'btnMute', 'volume', 'liveQuality', 'btnSwitch', 'btnLock', 'btnStop']) $(id).disabled = true;
  show($('shareMsg'), 'ok', 'Transmissão encerrada. Recarregue a página para começar de novo.');
}
$('btnStop').onclick = stopAll;
