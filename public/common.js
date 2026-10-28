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
