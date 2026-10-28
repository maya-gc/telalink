// =============================================================================
//  crypto.js — criptografia de ponta a ponta do TelaLink.
//  Roda igual no navegador e no Node (Web Crypto API), por isso e testavel.
// -----------------------------------------------------------------------------
//  Modelo:
//    - Quem transmite gera uma chave aleatoria de 256 bits (K) por sessao.
//    - K vai no link, depois do "#": https://.../view?room=ID#k=<K>
//      O navegador NUNCA envia a parte depois do "#" para nenhum servidor,
//      entao nem o servidor do TelaLink nem a Cloudflare conhecem K.
//    - De K derivamos (HKDF-SHA-512) duas chaves AES-256-GCM:
//        "sinalizacao": protege SDP/ICE -> impede ataque man-in-the-middle no
//                       WebRTC (o servidor nao consegue trocar fingerprints).
//        "midia":       protege o video/audio na retransmissao pelo link.
//    - AES-256 e HKDF-SHA-512 sao simetricos: computadores quanticos so
//      reduzem a seguranca efetiva para ~128 bits (algoritmo de Grover), o que
//      continua fora de alcance. Nao ha troca de chaves por curva eliptica aqui.
// =============================================================================

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const KEY_BYTES = 32;
export const IV_BYTES = 12;
const VERSION = 1;

// ------------------------------------------------------------- base64url
export function toB64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str)) throw new Error('base64url invalido');
  const pad = str.length % 4 ? '='.repeat(4 - (str.length % 4)) : '';
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// ------------------------------------------------------------- chaves
export function generateSessionKey() {
  return globalThis.crypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

// Le a chave do fragmento do link ("#k=..."). Retorna Uint8Array ou null.
export function keyFromHash(hash) {
  const m = /(?:^#|&)k=([A-Za-z0-9_-]{43})(?:&|$)/.exec(hash || '');
  if (!m) return null;
  try {
    const k = fromB64url(m[1]);
    return k.length === KEY_BYTES ? k : null;
  } catch { return null; }
}

export async function deriveKeys(rawKey, roomId) {
  if (!(rawKey instanceof Uint8Array) || rawKey.length !== KEY_BYTES) throw new Error('chave de sessao invalida');
  const base = await subtle.importKey('raw', rawKey, 'HKDF', false, ['deriveKey']);
  const derive = (label) => subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-512', salt: enc.encode(`telalink:v${VERSION}:${roomId}`), info: enc.encode(label) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return { sig: await derive('sinalizacao'), media: await derive('midia') };
}

// ------------------------------------------------------------- bytes
// Saida: iv(12) | ciphertext+tag(16). `aad` autentica dados que viajam em claro.
export async function sealBytes(key, plaintext, aad = new Uint8Array(0)) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, plaintext));
  const out = new Uint8Array(IV_BYTES + ct.length);
  out.set(iv, 0); out.set(ct, IV_BYTES);
  return out;
}

export async function openBytes(key, sealed, aad = new Uint8Array(0)) {
  if (!(sealed instanceof Uint8Array) || sealed.length < IV_BYTES + 16) throw new Error('pacote curto demais');
  const iv = sealed.subarray(0, IV_BYTES);
  const ct = sealed.subarray(IV_BYTES);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, ct));
}

// ------------------------------------------------------------- mensagens
// Canal de sinalizacao cifrado e autenticado, com protecao contra replay.
// `context` amarra a mensagem a sala/direcao/espectador: uma mensagem do host
// para o espectador A nao serve se for reenviada para o espectador B.
export class SecureChannel {
  constructor(key, context) {
    this.key = key;
    this.context = context;
    this.sendCounter = 0;
    this.lastReceived = -1;
  }

  async seal(direction, payload) {
    const n = this.sendCounter++;
    const body = enc.encode(JSON.stringify({ n, p: payload }));
    const aad = enc.encode(`${this.context}|${direction}`);
    return { v: VERSION, c: toB64url(await sealBytes(this.key, body, aad)) };
  }

  async open(direction, envelope) {
    if (!envelope || envelope.v !== VERSION || typeof envelope.c !== 'string') throw new Error('envelope invalido');
    const aad = enc.encode(`${this.context}|${direction}`);
    const body = JSON.parse(dec.decode(await openBytes(this.key, fromB64url(envelope.c), aad)));
    if (!Number.isInteger(body.n) || body.n <= this.lastReceived) throw new Error('mensagem repetida (replay)');
    this.lastReceived = body.n;
    return body.p;
  }
}
