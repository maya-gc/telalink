// =============================================================================
//  ws-lite.js — servidor WebSocket minimo (RFC 6455), ZERO dependencias.
//  Suporta: texto, binario, ping/pong, close; limite de tamanho por conexao;
//  leitura da fila de saida (para controle de congestionamento).
// =============================================================================
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const MAX_PAYLOAD = 256 * 1024;            // padrao (sinalizacao)
export const MAX_PAYLOAD_HARD = 4 * 1024 * 1024;  // teto absoluto (quadros de video)

export const acceptKey = (key) => createHash('sha1').update(key + GUID).digest('base64');

// Le um frame do inicio do buffer.
// Retorna null (incompleto), { error } (invalido) ou { fin, opcode, payload, total }.
export function parseFrame(buf, maxPayload = MAX_PAYLOAD) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2); offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const big = buf.readBigUInt64BE(2);
    if (big > BigInt(maxPayload)) return { error: 'too-large' };
    len = Number(big); offset = 10;
  }
  if (len > maxPayload) return { error: 'too-large' };
  let mask;
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.subarray(offset, offset + 4); offset += 4;
  }
  if (buf.length < offset + len) return null;
  let payload = buf.subarray(offset, offset + len);
  if (masked) payload = unmask(payload, mask);
  return { fin, opcode, payload, total: offset + len };
}

// Tamanho total do proximo frame (cabecalho + dados), ou 0 se o cabecalho ainda
// nao chegou inteiro. Permite juntar os pedacos UMA vez so, quando o frame completa.
export function frameLength(buf) {
  if (buf.length < 2) return 0;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f, offset = 2;
  if (len === 126) { if (buf.length < 4) return 0; len = buf.readUInt16BE(2); offset = 4; }
  else if (len === 127) { if (buf.length < 10) return 0; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
  return offset + (masked ? 4 : 0) + len;
}

// Remove a mascara do cliente de 4 em 4 bytes (palavras de 32 bits), numa copia
// alinhada; o resto (0-3 bytes) um a um.
export function unmask(payload, mask) {
  const len = payload.length;
  const out = Buffer.allocUnsafeSlow(len);         // ArrayBuffer proprio, alinhado
  payload.copy(out);
  const words = len >>> 2;
  if (words) {
    const w = new Uint32Array(out.buffer, out.byteOffset, words);
    const m = mask.readUInt32LE(0);
    for (let i = 0; i < words; i++) w[i] ^= m;
  }
  for (let i = words << 2; i < len; i++) out[i] ^= mask[i & 3];
  return out;
}

// Monta um frame servidor->cliente (sem mascara, FIN=1).
export function encodeFrame(payload, opcode = 0x1) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

class WSConn extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.readyState = 1; // OPEN
    this.maxPayload = MAX_PAYLOAD;
    this._chunks = []; this._len = 0; this._need = 0;   // pedacos recebidos ainda nao lidos
    this._frag = null; // { opcode, parts: [], size }
    this.lastSeen = Date.now();          // ultimo dado recebido (para o "ping" de vida)
    this.msgRate = null;                 // { perSec, burst } limita mensagens de texto
    this._tokens = 0; this._tokensAt = Date.now();
    socket.setNoDelay(true);
    socket.on('data', (d) => this._onData(d));
    // Cliente sumiu (FIN) sem frame de close: fecha do nosso lado tambem.
    socket.on('end', () => { try { socket.destroy(); } catch {} });
    socket.on('close', () => {
      if (this._closed) return;
      this._closed = true;
      this.readyState = 3;
      this.emit('close');
    });
    socket.on('error', () => { try { socket.destroy(); } catch {} });
  }

  // Bytes aguardando envio para este cliente (internet lenta = fila cresce).
  get bufferedAmount() { return this.socket.writableLength; }

  // Pedacos chegam da rede em tamanhos variados. Em vez de juntar tudo a cada
  // pedaco (um quadro-chave de 4 MB em pedacos de 64 KB seriam ~60 copias
  // crescentes), so junta quando o frame inteiro ja chegou.
  _onData(chunk) {
    this.lastSeen = Date.now();
    this._chunks.push(chunk); this._len += chunk.length;
    if (this._len > this.maxPayload + 14 + 1024 * 1024) { this.close(); return; }
    if (this._need && this._len < this._need) return;
    let buf = this._chunks.length === 1 ? this._chunks[0] : Buffer.concat(this._chunks, this._len);
    this._chunks = []; this._len = 0; this._need = 0;
    while (true) {
      const frame = parseFrame(buf, this.maxPayload);
      if (!frame) {
        if (buf.length) {
          this._chunks = [buf]; this._len = buf.length;
          this._need = frameLength(buf);
          if (this._need > this.maxPayload + 14) { this.close(); return; }
        }
        break;
      }
      if (frame.error) { this.close(); return; }
      buf = buf.subarray(frame.total);
      const { opcode, fin, payload } = frame;
      if (opcode === 0x8) { this.close(); return; }                   // close
      if (opcode === 0x9) { this._write(payload, 0xA); continue; }    // ping -> pong
      if (opcode === 0xA) continue;                                    // pong
      if (opcode === 0x1 || opcode === 0x2) {
        if (this._frag) { this.close(); return; }                      // fragmento fora de ordem
        if (fin) this._deliver(opcode, payload);
        else this._frag = { opcode, parts: [Buffer.from(payload)], size: payload.length };
      } else if (opcode === 0x0) {                                     // continuacao
        if (!this._frag) { this.close(); return; }
        this._frag.parts.push(Buffer.from(payload));
        this._frag.size += payload.length;
        if (this._frag.size > this.maxPayload) { this.close(); return; }
        if (fin) {
          const { opcode: op, parts } = this._frag;
          this._frag = null;
          this._deliver(op, Buffer.concat(parts));
        }
      } else { this.close(); return; }                                 // opcode desconhecido
    }
  }

  // Limite de mensagens de texto por conexao (balde de fichas): quem inunda e desconectado.
  _allowMessage() {
    if (!this.msgRate) return true;
    const now = Date.now();
    const { perSec, burst } = this.msgRate;
    this._tokens = Math.min(burst, this._tokens + ((now - this._tokensAt) / 1000) * perSec);
    this._tokensAt = now;
    if (this._tokens < 1) return false;
    this._tokens -= 1;
    return true;
  }

  _deliver(opcode, payload) {
    if (opcode === 0x1 && !this._allowMessage()) { this.emit('flood'); this.close(); return; }
    if (opcode === 0x1) this.emit('message', payload.toString('utf8'));
    else this.emit('binary', payload);
  }

  _write(payload, opcode) {
    if (this.readyState !== 1) return;
    try { this.socket.write(encodeFrame(payload, opcode)); } catch {}
  }

  send(text) { this._write(Buffer.from(String(text), 'utf8'), 0x1); }
  ping() { this._write(Buffer.alloc(0), 0x9); }
  sendBinary(buf) { this._write(Buffer.isBuffer(buf) ? buf : Buffer.from(buf), 0x2); }
  // Frame ja montado (encodeFrame): o mesmo Buffer vai para varios clientes sem copia.
  sendFrame(frame) { if (this.readyState === 1) try { this.socket.write(frame); } catch {} }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    try { this.socket.end(Buffer.from([0x88, 0x00])); } catch {}
    setTimeout(() => { try { this.socket.destroy(); } catch {} }, 2000).unref();
  }

  terminate() { try { this.socket.destroy(); } catch {} }
}

// Liga o "upgrade" HTTP ao WebSocket e emite 'connection' (conn, req).
//  heartbeatMs: envia "ping" periodico (navegadores respondem sozinhos). Mantem a
//               conexao viva nos tuneis (que derrubam conexoes paradas) e
//  idleMs:      desconecta quem nao manda nada ha muito tempo (conexao morta).
//  maxClients:  limite de conexoes simultaneas (protege a memoria).
export function attachWebSocket(httpServers, { heartbeatMs = 25_000, idleMs = 75_000, maxClients = 500, messageRate = null } = {}) {
  const list = Array.isArray(httpServers) ? httpServers : [httpServers];
  const emitter = new EventEmitter();
  emitter.clients = new Set();
  emitter.maxClients = maxClients;
  emitter.terminateAll = () => { clearInterval(emitter.heartbeat); for (const c of emitter.clients) c.terminate(); };
  emitter.heartbeat = setInterval(() => {
    const now = Date.now();
    for (const c of emitter.clients) {
      if (now - c.lastSeen > idleMs) c.terminate();
      else c.ping();
    }
  }, heartbeatMs);
  emitter.heartbeat.unref();
  emitter.on('connection', (c) => {
    emitter.clients.add(c);
    c.on('close', () => emitter.clients.delete(c));
  });
  const onUpgrade = (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      socket.destroy(); return;
    }
    if (emitter.clients.size >= emitter.maxClients) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return;
    }
    if (emitter.verify && !emitter.verify(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
    );
    const conn = new WSConn(socket);
    if (messageRate) conn.msgRate = messageRate, conn._tokens = messageRate.burst;
    emitter.emit('connection', conn, req);
  };
  for (const srv of list) srv.on('upgrade', onUpgrade);
  return emitter;
}
