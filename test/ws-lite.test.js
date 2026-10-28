// Testes unitarios do protocolo WebSocket (ws-lite.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { acceptKey, parseFrame, encodeFrame, MAX_PAYLOAD } from '../src/ws-lite.js';
import { startApp } from './helpers.js';

// Monta um frame cliente->servidor (com mascara, como o navegador faz).
function clientFrame(text, opcode = 0x1, mask = [1, 2, 3, 4]) {
  const payload = Buffer.from(text);
  const enc = encodeFrame(payload, opcode);
  const headerLen = enc.length - payload.length;
  const header = Buffer.from(enc.subarray(0, headerLen));
  header[1] |= 0x80;
  const masked = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]));
  return Buffer.concat([header, Buffer.from(mask), masked]);
}

test('acceptKey bate com o exemplo oficial da RFC 6455', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('parseFrame decodifica frame mascarado', () => {
  const f = parseFrame(clientFrame('ola'));
  assert.equal(f.opcode, 0x1);
  assert.equal(f.payload.toString(), 'ola');
});

test('parseFrame devolve null para frame incompleto', () => {
  const full = clientFrame('mensagem completa');
  for (let cut = 0; cut < full.length; cut++) {
    assert.equal(parseFrame(full.subarray(0, cut)), null, `cortado em ${cut} bytes`);
  }
});

test('parseFrame suporta tamanho estendido de 16 bits (126)', () => {
  const big = 'x'.repeat(5000);
  const f = parseFrame(clientFrame(big));
  assert.equal(f.payload.length, 5000);
});

test('encodeFrame + parseFrame: ida e volta para varios tamanhos', () => {
  for (const n of [0, 1, 125, 126, 127, 65535, 65536, 100000]) {
    const p = Buffer.alloc(n, 97);
    const f = parseFrame(encodeFrame(p));
    assert.equal(f.payload.length, n, `tamanho ${n}`);
  }
});

test('parseFrame rejeita frames acima do limite', () => {
  const h = Buffer.alloc(10);
  h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(MAX_PAYLOAD + 1), 2);
  assert.deepEqual(parseFrame(h), { error: 'too-large' });
});

test('dois frames colados no mesmo pacote sao lidos em sequencia', () => {
  const buf = Buffer.concat([clientFrame('um'), clientFrame('dois')]);
  const a = parseFrame(buf);
  const b = parseFrame(buf.subarray(a.total));
  assert.equal(a.payload.toString(), 'um');
  assert.equal(b.payload.toString(), 'dois');
});

test('cliente que some sem se despedir nao deixa conexao presa no servidor', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const socks = await Promise.all(Array.from({ length: 5 }, () => new Promise((resolve) => {
    const s = net.connect(app.port, '127.0.0.1', () => {
      s.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
              'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    s.once('data', () => resolve(s));
  })));
  assert.equal(app.wss.clients.size, 5);
  socks.forEach((s) => s.end()); // so FIN, sem frame de close
  const deadline = Date.now() + 2000;
  while (app.wss.clients.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.equal(app.wss.clients.size, 0, 'conexoes ficaram presas');
});

test('servidor responde ping com pong e rejeita upgrade invalido', async (t) => {
  const app = await startApp();
  t.after(() => app.close());

  const pong = await new Promise((resolve, reject) => {
    const s = net.connect(app.port, '127.0.0.1', () => {
      s.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
              'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    let buf = Buffer.alloc(0); let upgraded = false;
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!upgraded) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        assert.match(buf.subarray(0, i).toString(), /101 Switching Protocols/);
        buf = buf.subarray(i + 4); upgraded = true;
        s.write(clientFrame('ping!', 0x9));
      }
      const f = parseFrame(buf);
      if (f) { s.destroy(); resolve(f); }
    });
    s.on('error', reject);
  });
  assert.equal(pong.opcode, 0xA);
  assert.equal(pong.payload.toString(), 'ping!');

  // Upgrade sem a chave obrigatoria: conexao derrubada.
  const closed = await new Promise((resolve) => {
    const s = net.connect(app.port, '127.0.0.1', () => {
      s.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    });
    let got = '';
    s.on('data', (d) => (got += d));
    s.on('close', () => resolve(got));
  });
  assert.doesNotMatch(closed, /101/);
});

test('mensagens fragmentadas (texto e binario) sao remontadas; fragmento solto derruba', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const got = [];
  app.wss.on('connection', (c) => { c.on('message', (m) => got.push(['t', m])); c.on('binary', (b) => got.push(['b', b.length])); });
  const frag = (payload, opcode, fin) => {
    const f = clientFrame(payload, opcode);
    if (!fin) f[0] &= 0x7f;            // FIN = 0
    return f;
  };
  const connect = () => new Promise((resolve) => {
    const sock = net.connect(app.port, '127.0.0.1', () => {
      sock.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
                 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    sock.fechou = new Promise((r) => sock.on('close', r)); // registrado desde o inicio
    sock.once('data', () => resolve(sock));
  });

  const a = await connect();
  a.write(Buffer.concat([frag('ola ', 0x1, false), frag('mun', 0x0, false), frag('do', 0x0, true)]));
  a.write(Buffer.concat([frag('x'.repeat(10), 0x2, false), frag('y'.repeat(5), 0x0, true)]));
  const end = Date.now() + 2000;
  while (got.length < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(got, [['t', 'ola mundo'], ['b', 15]]);
  await a.fechou; // binario de quem nao e host: o servidor derruba (correto)

  const b = await connect();
  b.write(frag('solto', 0x0, true));    // continuacao sem inicio
  await b.fechou;
});
