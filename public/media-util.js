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
export const QUALITY = {
  auto:      { label: 'Automática',        maxH: 1080, bitrate: 0 },
  alta:      { label: 'Alta (1080p)',      maxH: 1080, bitrate: 4_000_000 },
  media:     { label: 'Média (720p)',      maxH: 720,  bitrate: 2_000_000 },
  economica: { label: 'Econômica (480p)',  maxH: 480,  bitrate: 800_000 },
};
export const FPS_OPTIONS = [15, 30, 60];

export function qualityPreset(name) { return QUALITY[name] || QUALITY.auto; }

// Restricoes de captura para a tela (limita resolucao e quadros por segundo).
export function captureConstraints(name, fps = 30) {
  const q = qualityPreset(name);
  const f = FPS_OPTIONS.includes(fps) ? fps : 30;
  return { width: { max: Math.round((q.maxH * 16) / 9) }, height: { max: q.maxH }, frameRate: { ideal: f, max: f } };
}

// Parametros do envio WebRTC: teto de banda, quadros e reducao de escala.
export function senderEncoding(name, fps = 30, sourceHeight = 0) {
  const q = qualityPreset(name);
  const enc = { maxFramerate: FPS_OPTIONS.includes(fps) ? fps : 30 };
  if (q.bitrate) enc.maxBitrate = q.bitrate;
  enc.scaleResolutionDownBy = sourceHeight > q.maxH ? Number((sourceHeight / q.maxH).toFixed(3)) : 1;
  return enc;
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
