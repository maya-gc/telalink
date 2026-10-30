// Utilitarios comuns das paginas do TelaLink (navegador).

export const $ = (id) => document.getElementById(id);

export function show(el, type, text) {
  if (!el) return;
  el.textContent = '';
  if (!text) return;
  const div = document.createElement('div');
  div.className = `msg ${type}`;
  div.textContent = text;          // textContent: nunca interpreta HTML
  el.appendChild(div);
}

export function wsURL() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}`;
}

// WebSocket com fila: processa UMA mensagem por vez, na ordem de chegada.
// Sem isso, um ICE candidate pode ser aplicado antes da oferta e ser perdido.
export function openSocket({ onJson, onBinary, onClose }) {
  const ws = new WebSocket(wsURL());
  ws.binaryType = 'arraybuffer';
  let chain = Promise.resolve();
  ws.onmessage = (ev) => {
    chain = chain.then(async () => {
      if (typeof ev.data === 'string') await onJson?.(JSON.parse(ev.data));
      else await onBinary?.(new Uint8Array(ev.data));
    }).catch((err) => console.error('[telalink]', err));
  };
  ws.onclose = () => onClose?.();
  ws.json = (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
  ws.opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  return ws;
}

// Qual caminho a conexao WebRTC esta usando: 'direta' ou 'turn'.
export async function describeTransport(pc) {
  try {
    const stats = await pc.getStats();
    let pair = null;
    stats.forEach((s) => {
      if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId);
    });
    // Firefox marca o par em uso com "selected"; os demais, com "nominated".
    if (!pair) stats.forEach((s) => { if (s.type === 'candidate-pair' && s.selected) pair = s; });
    if (!pair) stats.forEach((s) => { if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s; });
    if (!pair) return 'direta';
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    return (local?.candidateType === 'relay' || remote?.candidateType === 'relay') ? 'turn' : 'direta';
  } catch { return 'direta'; }
}

// Bytes enviados por conexoes que passam por TURN (para a trava de consumo).
export async function turnBytesSent(pc) {
  try {
    const stats = await pc.getStats();
    let total = 0;
    stats.forEach((s) => {
      if (s.type !== 'candidate-pair' || !s.bytesSent) return;
      const l = stats.get(s.localCandidateId);
      const r = stats.get(s.remoteCandidateId);
      if (l?.candidateType === 'relay' || r?.candidateType === 'relay') total += s.bytesSent;
    });
    return total;
  } catch { return 0; }
}

export const TRANSPORT_LABEL = {
  direta: 'Conexão direta',
  turn: 'Via TURN',
  retransmissao: 'Retransmissão pelo link',
  conectando: 'Conectando...',
};

export const supportsWebCodecs = () =>
  typeof globalThis.VideoEncoder === 'function' && typeof globalThis.VideoDecoder === 'function';

// ----------------------------------------------------------------- navegadores
// Nome do navegador (so para mensagens; o funcionamento usa deteccao de recurso).
export function browserName(ua = globalThis.navigator?.userAgent || '', nav = globalThis.navigator || {}) {
  if (nav.brave) return 'Brave';
  if (/Edg(e|A|iOS)?\//.test(ua)) return 'Edge';
  if (/OPR\/|Opera/.test(ua)) return 'Opera';
  if (/SamsungBrowser\//.test(ua)) return 'Samsung Internet';
  if (/Firefox\/|FxiOS\//.test(ua)) return 'Firefox';
  if (/Chrome\/|CriOS\/|Chromium\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'navegador';
}

// O que este navegador consegue fazer.
export function detectCaps(g = globalThis) {
  const nav = g.navigator || {};
  const ua = nav.userAgent || '';
  const name = browserName(ua, nav);
  const chromium = /Chrome\/|Chromium\//.test(ua) && !/Firefox\//.test(ua);
  const mobile = /Android|iPhone|iPad|iPod|Mobile/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints || 0) > 1);
  return {
    name, chromium, mobile,
    screenShare: typeof nav.mediaDevices?.getDisplayMedia === 'function' && !mobile,
    // So os navegadores Chromium (Chrome, Edge, Brave, Opera) capturam o SOM da tela/aba.
    screenAudio: chromium && !mobile,
    webrtc: typeof g.RTCPeerConnection === 'function',
    relayDecode: typeof g.VideoDecoder === 'function',
    relayAudio: typeof g.AudioDecoder === 'function',
    relayEncode: typeof g.VideoEncoder === 'function',
  };
}
export const caps = detectCaps();

// AudioContext (Safari antigo usa o nome com prefixo).
export function newAudioContext(opts) {
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return null;
  try { return new AC(opts); } catch { try { return new AC(); } catch { return null; } }
}

// Tela cheia em qualquer navegador (iPhone so permite no proprio <video>).
export function enterFullscreen(el, video) {
  if (el.requestFullscreen) return el.requestFullscreen().catch(() => pseudo(el));
  if (el.webkitRequestFullscreen) return el.webkitRequestFullscreen();
  if (video?.webkitEnterFullscreen && !video.classList.contains('hidden')) return video.webkitEnterFullscreen();
  return pseudo(el);
}
function pseudo(el) { el.classList.toggle('pseudo-full'); }
export function exitFullscreen(el) {
  if (document.fullscreenElement) return document.exitFullscreen?.();
  if (document.webkitFullscreenElement) return document.webkitExitFullscreen?.();
  el?.classList.remove('pseudo-full');
}
export const isFullscreen = (el) => !!(document.fullscreenElement || document.webkitFullscreenElement || el?.classList.contains('pseudo-full'));
