// Utilitarios compartilhados pelos testes (nao e um arquivo de teste).
import net from 'node:net';
import { startServer } from '../src/server.js';

export async function startApp(opts = {}) {
  const app = await startServer({ port: 0, host: '127.0.0.1', log: () => {}, ...opts });
  app.base = `http://127.0.0.1:${app.port}`;
  app.ws = `ws://127.0.0.1:${app.port}`;
  return app;
}

export async function createRoom(app) {
  const r = await fetch(`${app.base}/api/create-room`, { method: 'POST' });
  return r.json();
}

// Cliente WebSocket com fila: next() devolve a proxima mensagem (com timeout).
export function wsClient(url, headers) {
  const ws = headers ? new WebSocket(url, { headers }) : new WebSocket(url);
  const queue = [];
  const waiters = [];
  ws.binaryType = 'arraybuffer';
  ws.binaries = [];
  ws.addEventListener('message', (e) => {
    if (typeof e.data !== 'string') { ws.binaries.push(new Uint8Array(e.data)); return; }
    const m = JSON.parse(e.data);
    if (waiters.length) waiters.shift()(m); else queue.push(m);
  });
  // Espera ate ter `n` mensagens binarias recebidas.
  ws.waitBinaries = async (n, ms = 3000) => {
    const end = Date.now() + ms;
    while (ws.binaries.length < n && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    return ws.binaries;
  };
  ws.closed = new Promise((res) => ws.addEventListener('close', res, { once: true }));
  ws.opened = new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  ws.json = (o) => ws.send(JSON.stringify(o));
  ws.next = (ms = 2000) => new Promise((res, rej) => {
    if (queue.length) return res(queue.shift());
    const t = setTimeout(() => rej(new Error('timeout esperando mensagem')), ms);
    waiters.push((m) => { clearTimeout(t); res(m); });
  });
  // Garante que NENHUMA mensagem chega em `ms` (para testar isolamento).
  ws.nothing = (ms = 300) => new Promise((res, rej) => {
    if (queue.length) return rej(new Error('mensagem inesperada: ' + JSON.stringify(queue[0])));
    const t = setTimeout(() => { waiters.splice(waiters.indexOf(fn), 1); res(); }, ms);
    const fn = (m) => { clearTimeout(t); rej(new Error('mensagem inesperada: ' + JSON.stringify(m))); };
    waiters.push(fn);
  });
  return ws;
}

// Abre sala com host + 1 viewer ja conectados.
export async function roomWithViewer(app) {
  const room = await createRoom(app);
  const host = wsClient(app.ws); await host.opened;
  host.json({ type: 'host-join', roomId: room.roomId });
  await host.next();
  const viewer = wsClient(app.ws); await viewer.opened;
  viewer.json({ type: 'viewer-join', roomId: room.roomId, pin: room.pin });
  const { viewerId } = await viewer.next();
  await host.next(); // viewer-joined
  return { room, host, viewer, viewerId };
}

// Requisicao HTTP "crua" (fetch normaliza ../ e esconderia o ataque).
export function rawGet(port, path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const extra = Object.entries({ Host: 'x', ...headers }).map(([k, v]) => `${k}: ${v}\r\n`).join('');
    const s = net.connect(port, '127.0.0.1', () => {
      s.write(`${method} ${path} HTTP/1.1\r\n${extra}Content-Length: 0\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    s.on('data', (d) => (data += d));
    s.on('end', () => resolve({ status: Number(data.split(' ')[1]), body: data }));
    s.on('error', reject);
  });
}
