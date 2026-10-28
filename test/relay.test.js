// Testes da retransmissao no servidor: quem pode enviar, para quem vai,
// controle de congestionamento e pedidos de quadro-chave.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, wsClient, roomWithViewer } from './helpers.js';

let app;
before(async () => { app = await startApp(); });
after(() => app.close());

// Pacote no formato do TelaLink (conteudo aleatorio: o servidor nao decifra).
const packet = (kind, isKey, size = 200) => {
  const p = new Uint8Array(size);
  crypto.getRandomValues(p.subarray(0, Math.min(size, 65536)));
  p[0] = kind; p[1] = isKey ? 1 : 0;
  return p;
};

async function relayRoom() {
  const r = await roomWithViewer(app);
  r.viewer.json({ type: 'relay-subscribe' });
  const want = await r.host.next();
  assert.deepEqual(want, { type: 'relay-want', viewerId: r.viewerId });
  assert.equal((await r.host.next()).type, 'relay-keyframe', 'novo espectador pede quadro-chave');
  return r;
}

test('so quem pediu retransmissao recebe; espera o quadro-chave antes do video', async () => {
  const { host, viewer, room } = await relayRoom();
  const outro = wsClient(app.ws); await outro.opened;
  outro.json({ type: 'viewer-join', roomId: room.roomId, pin: room.pin });
  await outro.next(); await host.next(); // aceito + viewer-joined (sem relay-subscribe)

  host.send(packet(1, false));          // delta antes do quadro-chave: descartado
  host.send(packet(2, true));           // audio: pode passar
  host.send(packet(1, true));           // quadro-chave
  host.send(packet(1, false));          // delta depois: passa
  const got = await viewer.waitBinaries(3);
  assert.deepEqual(got.map((b) => [b[0], b[1]]), [[2, 1], [1, 1], [1, 0]]);
  assert.equal(outro.binaries.length, 0, 'quem nao pediu nao recebe');
  host.close(); viewer.close(); outro.close();
});

test('pacote chega byte a byte identico (servidor nao mexe no conteudo)', async () => {
  const { host, viewer } = await relayRoom();
  const p = packet(1, true, 50_000);
  host.send(p);
  const [got] = await viewer.waitBinaries(1);
  assert.deepEqual(got, p);
  host.close(); viewer.close();
});

test('espectador NAO pode enviar midia (tentativa derruba a conexao dele)', async () => {
  const { host, viewer } = await relayRoom();
  viewer.send(packet(1, true));
  await viewer.closed;
  assert.equal((await host.next()).type, 'viewer-left');
  host.close();
});

test('host nao pode mandar lixo binario', async () => {
  const { host, viewer } = await relayRoom();
  host.send(packet(7, true));            // tipo invalido
  await host.closed;
  viewer.close();
});

test('pacote de video grande (ate 4 MB) passa para o host; espectador continua limitado', async () => {
  const { host, viewer } = await relayRoom();
  const big = packet(1, true, 1_000_000);
  host.send(big);
  const [got] = await viewer.waitBinaries(1, 5000);
  assert.equal(got.length, 1_000_000);
  viewer.send('x'.repeat(400 * 1024));    // texto gigante do espectador
  await viewer.closed;
  host.close();
});

test('espectador pede quadro-chave quando o decodificador falha (com limite de frequencia)', async () => {
  const { host, viewer } = await relayRoom();
  await new Promise((r) => setTimeout(r, 1100));
  viewer.json({ type: 'relay-need-key' });
  viewer.json({ type: 'relay-need-key' });
  viewer.json({ type: 'relay-need-key' });
  assert.equal((await host.next()).type, 'relay-keyframe');
  await host.nothing(300); // os outros 2 pedidos foram agrupados
  host.close(); viewer.close();
});

test('internet lenta: fila cheia faz descartar deltas e pedir quadro-chave (sem acumular atraso)', async () => {
  const { host, viewer, viewerId, room } = await relayRoom();
  host.send(packet(1, true)); await viewer.waitBinaries(1);
  // Simula um espectador com fila de saida enorme.
  const conn = [...app.wss.clients].find((c) => c.meta?.viewerId === viewerId);
  Object.defineProperty(conn, 'bufferedAmount', { get: () => 2 * 1024 * 1024, configurable: true });
  await new Promise((r) => setTimeout(r, 1100));
  host.send(packet(1, false));
  assert.equal((await host.next()).type, 'relay-keyframe');
  // Rede melhora: delta continua bloqueado ate chegar quadro-chave novo.
  Object.defineProperty(conn, 'bufferedAmount', { get: () => 0, configurable: true });
  host.send(packet(1, false));
  host.send(packet(1, true));
  const got = await viewer.waitBinaries(2);
  assert.deepEqual(got.slice(1).map((b) => b[1]), [1], 'so o quadro-chave novo chegou');
  host.close(); viewer.close();
});

test('espectador que sai e removido da retransmissao', async () => {
  const { host, viewer, room } = await relayRoom();
  viewer.close();
  await host.next(); // viewer-left
  assert.equal(app.rooms.get(room.roomId).relay.size, 0);
  host.close();
});
