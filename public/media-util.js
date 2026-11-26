// =============================================================================
//  media-util.js — formato dos pacotes da retransmissao e utilitarios de midia.
//  Compartilhado entre navegador e Node (testes).
// -----------------------------------------------------------------------------
//  Pacote binario (host -> servidor -> espectadores):
//
//    byte 0      tipo   (1 = video, 2 = audio)            } em claro: o servidor
//    byte 1      flags  (bit 0 = quadro-chave)            } precisa para a fila
//    bytes 2..   AES-256-GCM( conteudo ), AAD = bytes 0..1  (tampa adulteracao)
//
//    conteudo:  seq u32 | timestamp i64 (us) | duracao u32 | metaLen u16 |
//               meta (JSON) | dados codificados (VP8 / Opus)
//
//  O servidor so ve tipo e "e quadro-chave?"; imagem e som ficam cifrados.
// =============================================================================
import { sealBytes, openBytes } from './crypto.js';

export const KIND_VIDEO = 1;
export const KIND_AUDIO = 2;
export const FLAG_KEY = 1;
const HEADER = 2;
const FIXED = 4 + 8 + 4 + 2;

const enc = new TextEncoder();
const dec = new TextDecoder();

export function encodePlain({ seq, timestamp, duration = 0, meta = null, data }) {
  const metaBytes = meta ? enc.encode(JSON.stringify(meta)) : new Uint8Array(0);
  if (metaBytes.length > 0xffff) throw new Error('meta grande demais');
  const out = new Uint8Array(FIXED + metaBytes.length + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, seq >>> 0);
  dv.setBigInt64(4, BigInt(Math.round(timestamp)));
  dv.setUint32(12, Math.max(0, Math.round(duration)) >>> 0);
  dv.setUint16(16, metaBytes.length);
  out.set(metaBytes, FIXED);
  out.set(data, FIXED + metaBytes.length);
  return out;
}

export function decodePlain(bytes) {
  if (bytes.length < FIXED) throw new Error('conteudo curto demais');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metaLen = dv.getUint16(16);
  if (FIXED + metaLen > bytes.length) throw new Error('meta truncada');
  return {
    seq: dv.getUint32(0),
    timestamp: Number(dv.getBigInt64(4)),
    duration: dv.getUint32(12),
    meta: metaLen ? JSON.parse(dec.decode(bytes.subarray(FIXED, FIXED + metaLen))) : null,
    data: bytes.subarray(FIXED + metaLen),
  };
}

export async function packPacket(key, { kind, isKey = false, ...content }) {
  const header = Uint8Array.of(kind, isKey ? FLAG_KEY : 0);
  const sealed = await sealBytes(key, encodePlain(content), header);
  const out = new Uint8Array(HEADER + sealed.length);
  out.set(header, 0); out.set(sealed, HEADER);
  return out;
}

export async function unpackPacket(key, bytes) {
  if (bytes.length < HEADER + 28) throw new Error('pacote curto demais');
  const header = bytes.subarray(0, HEADER);
  const kind = header[0];
  if (kind !== KIND_VIDEO && kind !== KIND_AUDIO) throw new Error('tipo de pacote desconhecido');
  const plain = await openBytes(key, bytes.subarray(HEADER), header);
  return { kind, isKey: (header[1] & FLAG_KEY) !== 0, ...decodePlain(plain) };
}

// ------------------------------------------------------------- tela preta
// Brilho medio (0..255) de pixels RGBA (ITU-R BT.601).
export function meanLuma(rgba) {
  let sum = 0;
  const n = rgba.length / 4;
  if (!n) return 0;
  for (let i = 0; i < rgba.length; i += 4) sum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
  return sum / n;
}

// Tela "apagada": quase tudo preto E sem variacao (um filme escuro tem detalhes).
export function isBlackFrame(rgba, { maxMean = 6, maxSpread = 10 } = {}) {
  let min = 255, max = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const y = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    if (y < min) min = y;
    if (y > max) max = y;
  }
  return meanLuma(rgba) <= maxMean && max - min <= maxSpread;
}

// Detector com "paciencia": so acusa depois de N amostras pretas seguidas.
export class BlackScreenDetector {
  constructor({ samples = 4 } = {}) { this.samples = samples; this.count = 0; this.black = false; }
  push(rgba) {
    this.count = isBlackFrame(rgba) ? this.count + 1 : 0;
    const was = this.black;
    this.black = this.count >= this.samples;
    return this.black !== was ? this.black : null; // retorna mudanca de estado ou null
  }
}

// ------------------------------------------------------------- qualidade
// Predefinicoes simples para o usuario final. bitrate 0 = o navegador decide.
// -----------------------------------------------------------------------------
//  Qualidade. maxH = altura maxima; maxKbps = teto de banda; startKbps = banda
//  com que a transmissao COMECA (sem isso o navegador comeca em ~0,3 Mbps e
//  fica em 360p por varios segundos); keepRes = manter resolucao (reduz quadros
//  por segundo antes de reduzir nitidez).
// -----------------------------------------------------------------------------
export const QUALITY = {
  auto:      { label: 'Automática (até 1080p)',      maxH: 1080, maxKbps: 8000,  startKbps: 4000, keepRes: false },
  original:  { label: 'Máxima (original, até 4K)',   maxH: 2160, maxKbps: 25000, startKbps: 8000, keepRes: true },
  qhd:       { label: 'Muito alta (1440p)',          maxH: 1440, maxKbps: 14000, startKbps: 6000, keepRes: true },
  alta:      { label: 'Alta (1080p)',                maxH: 1080, maxKbps: 8000,  startKbps: 4000, keepRes: true },
  media:     { label: 'Média (720p)',                maxH: 720,  maxKbps: 4000,  startKbps: 2500, keepRes: true },
  economica: { label: 'Econômica (480p)',            maxH: 480,  maxKbps: 1500,  startKbps: 1000, keepRes: true },
};
export const FPS_OPTIONS = [15, 30, 60];
// Limite de banda escolhido pelo usuario, em Mbps (0 = o da qualidade).
export const BITRATE_OPTIONS = [0, 2, 4, 8, 12, 20, 30];

export function qualityPreset(name) { return QUALITY[name] || QUALITY.auto; }

// Teto de banda efetivo (kbps): o limite do usuario, se houver, senao o da qualidade.
// 60 quadros/s precisam de mais banda para a mesma nitidez.
export function maxKbpsFor(name, { fps = 30, limitMbps = 0 } = {}) {
  if (BITRATE_OPTIONS.includes(limitMbps) && limitMbps > 0) return limitMbps * 1000;
  const q = qualityPreset(name);
  return fps >= 60 ? Math.round(q.maxKbps * 1.5) : q.maxKbps;
}

// Restricoes de captura para a tela (limita resolucao e quadros por segundo).
// So a ALTURA e limitada: a largura acompanha a proporcao da tela (16:9,
// ultralarga, retrato), sem cortar nem distorcer.
export function captureConstraints(name, fps = 30) {
  const q = qualityPreset(name);
  const f = FPS_OPTIONS.includes(fps) ? fps : 30;
  return { height: { max: q.maxH }, frameRate: { ideal: f, max: f } };
}

// Parametros do envio WebRTC: teto de banda, quadros e reducao de escala.
export function senderEncoding(name, fps = 30, sourceHeight = 0, { limitMbps = 0 } = {}) {
  const q = qualityPreset(name);
  const f = FPS_OPTIONS.includes(fps) ? fps : 30;
  return {
    maxFramerate: f,
    maxBitrate: maxKbpsFor(name, { fps: f, limitMbps }) * 1000,
    scaleResolutionDownBy: sourceHeight > q.maxH ? Number((sourceHeight / q.maxH).toFixed(3)) : 1,
  };
}

// O que o navegador corta primeiro quando falta internet/processador.
// Texto/detalhe: mantem a nitidez (corta quadros).
// Movimento (filme, jogo, video): manter o ritmo dos quadros. Cortar quadros e
// o que se via como "travadinhas"; baixar a resolucao por alguns segundos quase
// nao se nota. Com resolucao escolhida a mao, um meio-termo ('balanced').
export function degradationFor(name, hint) {
  if (hint === 'detail') return 'maintain-resolution';
  return qualityPreset(name).keepRes ? 'balanced' : 'maintain-framerate';
}

// Acrescenta ao SDP a banda inicial e maxima para cada codec de video
// (x-google-start-bitrate / x-google-max-bitrate, em kbps). Ignora codecs
// auxiliares (rtx, red, ulpfec, flexfec).
export function withBitrateHints(sdp, { startKbps, maxKbps }) {
  const lines = sdp.split('\r\n');
  const out = [];
  let inVideo = false;
  const fmtpSeen = new Set();
  const videoPts = new Map();
  for (const l of lines) {
    if (l.startsWith('m=')) inVideo = l.startsWith('m=video');
    const m = inVideo && /^a=rtpmap:(\d+) ([^/]+)\//.exec(l);
    if (m && !/^(rtx|red|ulpfec|flexfec-03)$/i.test(m[2])) videoPts.set(m[1], true);
  }
  const hint = `x-google-start-bitrate=${Math.round(startKbps)};x-google-max-bitrate=${Math.round(maxKbps)}`;
  inVideo = false;
  for (const l of lines) {
    if (l.startsWith('m=')) inVideo = l.startsWith('m=video');
    const f = inVideo && /^a=fmtp:(\d+) (.*)$/.exec(l);
    if (f && videoPts.has(f[1])) {
      fmtpSeen.add(f[1]);
      const rest = f[2].split(';').filter((x) => x && !/^x-google-(start|max)-bitrate=/.test(x.trim())).join(';');
      out.push(`a=fmtp:${f[1]} ${rest ? `${rest};` : ''}${hint}`);
      continue;
    }
    out.push(l);
    const r = inVideo && /^a=rtpmap:(\d+) /.exec(l);
    // Codec sem linha fmtp (ex.: VP8): cria uma logo apos o rtpmap.
    if (r && videoPts.has(r[1]) && !lines.some((x) => x.startsWith(`a=fmtp:${r[1]} `))) out.push(`a=fmtp:${r[1]} ${hint}`);
  }
  return out.join('\r\n');
}

// Ordem de preferencia dos codecs WebRTC: o que o PC codifica por HARDWARE
// primeiro (menos processador = menos queda de resolucao); depois VP9 (melhor
// imagem por bit), H.264 e VP8. `hw` = conjunto de tipos com hardware.
// priority: 'desempenho' (menos processador: H.264 > VP8 > VP9 sem placa de video)
//           'qualidade'  (mais nitidez por Mbps: VP9 > H.264 > VP8).
// Medido (1080p, 1 pessoa, sem placa de video): H.264 0,41 nucleo; VP9 0,51; VP8 0,56.
export const SOFTWARE_ORDER = {
  desempenho: { 'video/h264': 1, 'video/vp8': 2, 'video/vp9': 3, 'video/av1': 4 },
  qualidade: { 'video/vp9': 1, 'video/h264': 2, 'video/vp8': 3, 'video/av1': 4 },
};
export function orderCodecs(codecs, hw = new Set(), priority = 'desempenho') {
  const order = SOFTWARE_ORDER[priority] || SOFTWARE_ORDER.desempenho;
  const rank = (c) => {
    const t = c.mimeType.toLowerCase();
    const base = order[t];
    if (base === undefined) return 100;               // rtx, red, ulpfec ficam no fim
    const highProfile = t === 'video/h264' && /profile-level-id=(64|4d)/i.test(c.sdpFmtpLine || '') ? -0.5 : 0;
    return (hw.has(t) ? 0 : 10) + base + highProfile;
  };
  return [...codecs].sort((a, b) => rank(a) - rank(b));
}

// Retransmissao: altura adequada para a banda disponivel (no modo automatico).
export function relayHeightFor(bps) {
  if (bps >= 12_000_000) return 2160;
  if (bps >= 6_000_000) return 1440;
  if (bps >= 2_500_000) return 1080;
  if (bps >= 1_200_000) return 720;
  return 480;
}

// Controle de banda da retransmissao (aumenta devagar, reduz rapido),
// guiado pela fila de envio do WebSocket. Retorna a nova banda (bps).
// Banda da retransmissao: reduz rapido, aumenta devagar. Sinais:
// - buffered: fila de envio de quem transmite (so enche se o PC/servidor atrasa);
// - queueDelayMs: atraso de fila que QUEM ASSISTE mede (pior pessoa). E o sinal
//   que enxerga o tunel/internet lenta; sem ele a banda nunca baixava e a fila
//   enchia no tunel ate travar e "correr".
export function adaptBitrate(current, { buffered = 0, queueDelayMs = 0, maxBps, minBps = 500_000 }) {
  if (buffered > 1_000_000 || queueDelayMs > 600) return Math.max(minBps, Math.round(current * 0.7));
  if (buffered > 400_000 || queueDelayMs > 250) return Math.max(minBps, Math.round(current * 0.85));
  if (buffered < 150_000 && queueDelayMs < 80) return Math.min(maxBps, Math.round(current * 1.08));   // >= 7%: o sender so reconfigura acima disso
  return current;
}

// ---------------------------------------------------------------------------
// Relogio de reproducao (jitter buffer) da retransmissao.
// Cada pacote tem o horario em que foi capturado (timestamp, us). Quem assiste
// mapeia esse horario para o relogio local e exibe com um atraso-alvo (delay):
//   exibir_em = timestamp/1000 + offset + delay
// offset = menor "transito" recente (pacote que chegou sem fila); delay cresce
// na hora quando chega pacote atrasado (absorve a rajada no ritmo normal, em vez
// de congelar e depois acelerar) e diminui devagar quando a rede fica estavel.
export class PlayoutClock {
  constructor({ minDelay = 80, maxDelay = 1200, startDelay = 150, decayPerSec = 15, windowMs = 10_000 } = {}) {
    Object.assign(this, { minDelay, maxDelay, decayPerSec, windowMs });
    this.delay = startDelay;
    this.offset = null;                  // ms: chegada - timestamp do pacote mais rapido
    this.samples = [];                   // [chegada, transito] para o minimo deslizante
    this.lastDecay = null;
    this.queueDelay = 0;                 // atraso de fila do ultimo pacote (ms)
  }
  // Registra a chegada de um pacote; devolve quando exibi-lo (relogio local, ms).
  arrive(tsUs, now) {
    const transit = now - tsUs / 1000;
    // Salto nos horarios (fonte trocada, codec novo, relogio reiniciado): o horario
    // andou para tras, ou para frente muito mais que o tempo real. Recomeca o
    // mapeamento em vez de achar que a rede atrasou (ou adiantou) segundos.
    if (this.lastTs !== undefined && (tsUs < this.lastTs - 1000 || (tsUs - this.lastTs) / 1000 > now - this.lastArrival + 3000)) { this.samples = []; this.offset = null; }
    this.lastTs = tsUs; this.lastArrival = now;
    this.samples.push([now, transit]);
    while (this.samples.length && now - this.samples[0][0] > this.windowMs) this.samples.shift();
    let min = Infinity;
    for (const [, t] of this.samples) if (t < min) min = t;
    // O minimo so sobe quando a janela esquece o antigo: evita "pular" para tras.
    if (this.offset === null || min < this.offset) this.offset = min;
    else if (this.samples.length > 20 && min > this.offset + 2) this.offset += Math.min(min - this.offset, 5);
    this.queueDelay = Math.max(0, transit - this.offset);
    // Chegou tarde para o atraso atual: aumenta o atraso (com folga), ate o teto.
    if (this.queueDelay + 20 > this.delay) this.delay = Math.min(this.maxDelay, this.queueDelay * 1.25 + 30);
    this._decay(now);
    return this.due(tsUs);
  }
  due(tsUs) { return tsUs / 1000 + (this.offset ?? 0) + this.delay; }
  _decay(now) {
    if (this.lastDecay === null) { this.lastDecay = now; return; }
    const dt = (now - this.lastDecay) / 1000;
    this.lastDecay = now;
    // Reduz devagar (no maximo ~1,5% de velocidade): imperceptivel.
    if (this.delay > this.minDelay && this.queueDelay * 1.25 + 30 < this.delay) this.delay = Math.max(this.minDelay, this.delay - this.decayPerSec * dt);
  }
}

// Suavidade da imagem a partir dos horarios em que cada quadro apareceu (ms).
//  - freezes: pausas acima de 200 ms (e o tempo total congelado);
//  - bursts: quadros que apareceram "colados" no anterior logo depois de uma
//    pausa, ou seja, a imagem correndo para alcancar;
//  - jitterMs: desvio do intervalo entre quadros.
export function smoothness(times, { freezeMs = 200 } = {}) {
  const gaps = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
  if (!gaps.length) return { frames: times.length, fps: 0, freezes: 0, frozenMs: 0, maxGapMs: 0, bursts: 0, jitterMs: 0 };
  const sorted = [...gaps].sort((a, b) => a - b);
  const typical = sorted[Math.floor(sorted.length / 2)] || 1;
  let freezes = 0, frozenMs = 0, bursts = 0, afterFreeze = 0;
  for (const g of gaps) {
    if (g > freezeMs) { freezes++; frozenMs += g - typical; afterFreeze = 10; continue; }
    if (afterFreeze > 0) { afterFreeze--; if (g < typical * 0.35) bursts++; }
  }
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const jitterMs = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
  const span = times[times.length - 1] - times[0];
  return { frames: times.length, fps: span > 0 ? ((times.length - 1) * 1000) / span : 0, freezes, frozenMs: Math.round(frozenMs), maxGapMs: Math.round(sorted[sorted.length - 1]), bursts, jitterMs: Math.round(jitterMs * 10) / 10 };
}

// Texto curto de qualidade: "1080p · 30 qps · 6,2 Mbps".
export function qualityText({ height, fps, bps } = {}) {
  const parts = [];
  if (height) parts.push(`${height}p`);
  if (fps) parts.push(`${Math.round(fps)} qps`);
  if (bps) parts.push(`${(bps / 1e6).toFixed(1).replace('.', ',')} Mbps`);
  return parts.join(' · ');
}

// Volume em % (0..200) -> ganho linear, ja considerando mudo e pausa.
export function gainFor({ volume = 100, muted = false, paused = false } = {}) {
  if (muted || paused) return 0;
  return Math.max(0, Math.min(200, Number(volume) || 0)) / 100;
}

// Encaixa uma imagem (w x h) numa area (W x H) sem distorcer. Retorna x, y, w, h.
export function fitRect(w, h, W, H) {
  const s = Math.min(W / w, H / h);
  const dw = Math.round(w * s), dh = Math.round(h * s);
  return { x: Math.round((W - dw) / 2), y: Math.round((H - dh) / 2), w: dw, h: dh };
}

// Texto do convite que o usuario cola no WhatsApp/e-mail.
export function inviteText(link, pin) {
  return `Assista minha tela pelo TelaLink:\n${link}\nPIN: ${pin}`;
}
