// =============================================================================
//  Servidor TURN minimo PARA TESTES (RFC 5766/8656, so a parte de "alocacao").
//  Implementa a autenticacao real do TURN (desafio 401 + MESSAGE-INTEGRITY com
//  chave MD5(usuario:realm:senha)), para o navegador de verdade aceitar ou
//  recusar credenciais. Nao repassa midia: serve para testar o cadastro e o
//  botao "Testar conexao" da tela de configuracoes.
//
//  Modos de autenticacao:
//    { username, password }  -> usuario/senha fixos
//    { secret }              -> credenciais temporarias (padrao coturn
//                               use-auth-secret: senha = base64(HMAC-SHA1(segredo, usuario)))
// =============================================================================
import dgram from 'node:dgram';
import { createHash, createHmac, randomBytes } from 'node:crypto';

const MAGIC = 0x2112a442;
const REALM = 'telalink-teste';
const A = { USERNAME: 0x0006, MI: 0x0008, ERROR: 0x0009, LIFETIME: 0x000d, XOR_PEER: 0x0012, REALM: 0x0014, NONCE: 0x0015,
  XOR_RELAYED: 0x0016, REQ_TRANSPORT: 0x0019, XOR_MAPPED: 0x0020, FINGERPRINT: 0x8028 };

function parse(buf) {
  if (buf.length < 20 || buf.readUInt32BE(4) !== MAGIC) return null;
  const type = buf.readUInt16BE(0);
  const len = buf.readUInt16BE(2);
  const attrs = [];
  let off = 20;
  while (off + 4 <= 20 + len && off + 4 <= buf.length) {
    const t = buf.readUInt16BE(off); const l = buf.readUInt16BE(off + 2);
    attrs.push({ type: t, value: buf.subarray(off + 4, off + 4 + l), offset: off });
    off += 4 + Math.ceil(l / 4) * 4;
  }
  return { type, method: type & 0x3eef, tid: buf.subarray(8, 20), attrs, buf };
}

const get = (msg, t) => msg.attrs.find((a) => a.type === t);

function xorAddr(type, ip, port) {
  const v = Buffer.alloc(8);
  v.writeUInt8(0, 0); v.writeUInt8(1, 1);
  v.writeUInt16BE(port ^ (MAGIC >>> 16), 2);
  const n = ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
  v.writeUInt32BE((n ^ MAGIC) >>> 0, 4);
  return { type, value: v };
}

function build(type, tid, attrs, key) {
  const parts = [];
  for (const a of attrs) {
    const h = Buffer.alloc(4); h.writeUInt16BE(a.type, 0); h.writeUInt16BE(a.value.length, 2);
    const pad = Buffer.alloc((4 - (a.value.length % 4)) % 4);
    parts.push(h, a.value, pad);
  }
  let body = Buffer.concat(parts);
  const header = (extra) => {
    const h = Buffer.alloc(20);
    h.writeUInt16BE(type, 0); h.writeUInt16BE(body.length + extra, 2); h.writeUInt32BE(MAGIC, 4); tid.copy(h, 8);
    return h;
  };
  if (key) {
    const mac = createHmac('sha1', key).update(Buffer.concat([header(24), body])).digest();
    const h = Buffer.alloc(4); h.writeUInt16BE(A.MI, 0); h.writeUInt16BE(20, 2);
    body = Buffer.concat([body, h, mac]);
  }
  return Buffer.concat([header(0), body]);
}

// Confere o MESSAGE-INTEGRITY do pedido com a chave esperada.
function integrityOk(msg, key) {
  const mi = get(msg, A.MI);
  if (!mi) return false;
  const upTo = Buffer.from(msg.buf.subarray(0, mi.offset));
  upTo.writeUInt16BE(mi.offset + 24 - 20, 2); // tamanho como se a mensagem terminasse no MI
  const mac = createHmac('sha1', key).update(upTo).digest();
  return mac.equals(mi.value);
}

export function startFakeTurn({ username, password, secret, host = '127.0.0.1', port = 0 } = {}) {
  const sock = dgram.createSocket('udp4');
  const nonce = randomBytes(8).toString('hex');
  const stats = { allocations: 0, rejected: 0 };
  let relayPort = 49152;

  const passwordFor = (user) => {
    if (secret) {
      const [expiry] = user.split(':');
      if (!(Number(expiry) > Date.now() / 1000)) return null;           // credencial vencida
      return createHmac('sha1', secret).update(user).digest('base64');
    }
    return user === username ? password : null;
  };

  sock.on('message', (buf, rinfo) => {
    const msg = parse(buf);
    if (!msg) return;
    const reply = (b) => sock.send(b, rinfo.port, rinfo.address);
    const mapped = xorAddr(A.XOR_MAPPED, rinfo.address, rinfo.port);

    if (msg.method === 0x0001) return reply(build(0x0101, msg.tid, [mapped]));   // Binding (STUN)

    const userAttr = get(msg, A.USERNAME);
    const challenge = () => reply(build(msg.method | 0x0110, msg.tid, [
      { type: A.ERROR, value: Buffer.concat([Buffer.from([0, 0, 4, 1]), Buffer.from('Unauthorized')]) },
      { type: A.REALM, value: Buffer.from(REALM) },
      { type: A.NONCE, value: Buffer.from(nonce) },
    ]));
    if (!userAttr) return challenge();
    const user = userAttr.value.toString();
    const pass = passwordFor(user);
    const key = pass == null ? null : createHash('md5').update(`${user}:${REALM}:${pass}`).digest();
    if (!key || !integrityOk(msg, key)) { stats.rejected++; return challenge(); }

    if (msg.method === 0x0003) {                                                // Allocate
      stats.allocations++;
      return reply(build(0x0103, msg.tid, [
        xorAddr(A.XOR_RELAYED, host === '0.0.0.0' ? '127.0.0.1' : host, relayPort++),
        mapped,
        { type: A.LIFETIME, value: Buffer.from([0, 0, 0x02, 0x58]) },          // 600 s
      ], key));
    }
    // Refresh, CreatePermission, ChannelBind: so confirma.
    return reply(build(msg.method | 0x0100, msg.tid, [], key));
  });

  return new Promise((resolve) => sock.bind(port, host, () => resolve({
    port: sock.address().port, stats, close: () => sock.close(),
  })));
}
