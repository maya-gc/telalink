// =============================================================================
//  Protecoes adicionadas na auditoria de seguranca da versao 2.4:
//  IP confiavel por provedor de tunel, pausa do PIN (sem travar a sala para
//  sempre), aviso ao host e troca de PIN, conexoes sem sala desconectadas,
//  limite por IP, limite de mensagens, "ping" de vida e entradas aleatorias.
// =============================================================================
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { startApp, createRoom, wsClient } from './helpers.js';
import { clientIp, MAX_IP_FAILURES } from '../src/server.js';
import { parseFrame } from '../src/ws-lite.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const closed = (ws, ms = 3000) => new Promise((res) => {
  if (ws.readyState === 3) return res(true);
  const t = setTimeout(() => res(false), ms);
  ws.addEventListener('close', () => { clearTimeout(t); res(true); });
});
const ext = (ip, extra = {}) => ({ Host: 'abc.lhr.life', 'x-forwarded-for': ip, ...extra });

describe('IP de quem chega pelo tunel', () => {
  const req = (headers, external = true) => ({ headers, socket: { remoteAddress: '127.0.0.1', __telalinkExternal: external } });

  test('so confia no CF-Connecting-IP quando o tunel ativo e o da Cloudflare', () => {
    const r = req({ 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '9.9.9.9' });
    assert.equal(clientIp(r, 'cloudflare'), '1.1.1.1');
    assert.equal(clientIp(r, 'ssh'), '9.9.9.9', 'pelo SSH, o visitante poderia inventar o CF-Connecting-IP');
  });

  test('usa o ULTIMO item do X-Forwarded-For (o que o proxy acrescentou)', () => {
    assert.equal(clientIp(req({ 'x-forwarded-for': '6.6.6.6, 5.5.5.5, 203.0.113.9' }), 'ssh'), '203.0.113.9');
    assert.equal(clientIp(req({}), 'ssh'), '127.0.0.1');
    assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }), '127.0.0.1', 'conexao local: endereco real');
  });
});

describe('Ataques pela rede (servidor real)', async () => {
  const app = await startApp({
    getTunnelInfo: () => ({ status: 'on', url: 'https://abc.lhr.life', provider: 'ssh' }),
    limits: { pinLockMs: 400, unauthTimeoutMs: 400, maxWsPerIp: 3, messageRate: { perSec: 5, burst: 10 }, heartbeatMs: 100, idleMs: 400 },
  });
  after(() => app.close());

  test('inventar o comeco do X-Forwarded-For nao escapa do limite por IP', async () => {
    const rooms = await Promise.all(Array.from({ length: 4 }, () => createRoom(app)));
    for (let i = 0; i < MAX_IP_FAILURES; i++) {
      const ws = wsClient(app.extWs, ext(`10.0.${i}.1, 198.51.100.88`)); await ws.opened;
      const r = rooms[i % rooms.length];
      ws.json({ type: 'viewer-join', roomId: r.roomId, pin: r.pin === '000001' ? '000002' : '000001' });
      assert.equal((await ws.next()).reason, 'pin-invalido', `tentativa ${i + 1}`);
      ws.close();
    }
    const ws = wsClient(app.extWs, ext('10.99.99.99, 198.51.100.88')); await ws.opened;
    ws.json({ type: 'viewer-join', roomId: rooms[0].roomId, pin: rooms[0].pin });
    assert.equal((await ws.next()).reason, 'bloqueado');
    ws.close();
  });

  test('erros de PIN: pausa curta (a sala nao trava para sempre), host e avisado e pode trocar o PIN', async () => {
    const room = await createRoom(app);
    const host = wsClient(app.ws); await host.opened;
    host.json({ type: 'host-join', roomId: room.roomId }); await host.next();
    const wrong = room.pin === '111111' ? '222222' : '111111';
    for (let i = 0; i < 10; i++) {
      const v = wsClient(app.extWs, ext(`192.0.2.${i + 1}`)); await v.opened;
      v.json({ type: 'viewer-join', roomId: room.roomId, pin: wrong });
      await v.next(); v.close();
    }
    let note; do { note = await host.next(); } while (note.count < 10);
    assert.equal(note.type, 'pin-failures');
    assert.ok(note.lockedUntil > Date.now(), 'host sabe que a sala esta em pausa');
    const early = wsClient(app.extWs, ext('192.0.2.50')); await early.opened;
    early.json({ type: 'viewer-join', roomId: room.roomId, pin: room.pin });
    assert.equal((await early.next()).reason, 'bloqueado', 'durante a pausa nem o PIN certo entra');
    early.close();
    await wait(450);
    const v = wsClient(app.extWs, ext('192.0.2.51')); await v.opened;
    v.json({ type: 'viewer-join', roomId: room.roomId, pin: room.pin });
    assert.equal((await v.next()).type, 'viewer-accepted', 'depois da pausa, quem tem o PIN entra');
    await host.next(); // viewer-joined
    // Troca de PIN: o antigo deixa de valer; quem ja assiste continua.
    host.json({ type: 'new-pin' });
    const { type, pin } = await host.next();
    assert.equal(type, 'pin'); assert.match(pin, /^\d{6}$/);
    const old = wsClient(app.extWs, ext('192.0.2.60')); await old.opened;
    old.json({ type: 'viewer-join', roomId: room.roomId, pin: pin === room.pin ? wrong : room.pin });
    assert.equal((await old.next()).reason, 'pin-invalido');
    old.json({ type: 'viewer-join', roomId: room.roomId, pin });
    assert.equal((await old.next()).type, 'viewer-accepted');
    assert.equal(v.readyState, 1, 'quem ja assistia continua');
    // Espectador nao pode trocar o PIN.
    v.json({ type: 'new-pin' });
    await assert.rejects(v.next(300));
    for (const c of [v, old, host]) c.close();
  });

  test('conexao que nao entra em nenhuma sala e desconectada', async () => {
    const ws = wsClient(app.extWs, ext('192.0.2.70')); await ws.opened;
    assert.ok(await closed(ws, 2000));
  });

  test('limite de conexoes simultaneas por IP (o PC local nao tem limite)', async () => {
    const list = [];
    for (let i = 0; i < 4; i++) { const w = wsClient(app.extWs, ext('192.0.2.80')); await w.opened.catch(() => {}); list.push(w); }
    assert.ok(await closed(list[3], 1000), 'a 4a conexao do mesmo IP e recusada');
    assert.equal(list[0].readyState, 1);
    const locals = [];
    for (let i = 0; i < 5; i++) { const w = wsClient(app.ws); await w.opened; locals.push(w); }
    await wait(100);
    assert.ok(locals.every((w) => w.readyState === 1));
    for (const w of [...list, ...locals]) w.close();
  });

  test('quem inunda o servidor de mensagens e desconectado', async () => {
    const ws = wsClient(app.extWs, ext('192.0.2.90')); await ws.opened;
    for (let i = 0; i < 60; i++) ws.send(JSON.stringify({ type: 'relay-need-key' }));
    assert.ok(await closed(ws, 2000));
  });

  test('"ping" de vida: navegador que responde fica; conexao morta e derrubada', async () => {
    const room = await createRoom(app);
    const host = wsClient(app.ws); await host.opened;
    host.json({ type: 'host-join', roomId: room.roomId }); await host.next();
    await wait(800);
    assert.equal(host.readyState, 1, 'cliente que responde ao ping continua conectado (mesmo parado)');
    host.close();
    // Cliente "morto": faz o aperto de mao e nunca mais responde.
    const sock = net.connect(app.port, '127.0.0.1');
    await new Promise((r) => sock.once('connect', r));
    sock.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    sock.on('data', () => {}); sock.on('error', () => {});
    const gone = await new Promise((r) => { const t = setTimeout(() => r(false), 3000); sock.once('close', () => { clearTimeout(t); r(true); }); });
    assert.ok(gone, 'conexao que nao responde e encerrada');
  });
});

test('WebSocket: 20 mil quadros aleatorios nunca derrubam o leitor', () => {
  for (let i = 0; i < 20_000; i++) {
    const buf = randomBytes(1 + (i % 64));
    if (i % 3 === 0) buf[0] = 0x81;
    if (i % 5 === 0) buf[1] = 0xff;
    const r = parseFrame(buf);
    assert.ok(r === null || typeof r === 'object');
  }
});

test('cabecalhos de seguranca em todas as respostas (pagina de quem assiste pelo tunel)', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const r = await fetch(`${app.extBase}/view?room=x`);
  const h = Object.fromEntries(r.headers);
  assert.match(h['content-security-policy'], /script-src 'self'/);
  assert.match(h['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(h['permissions-policy'], /camera=\(\)/);
  assert.match(h['permissions-policy'], /usb=\(\)/);
  for (const k of ['x-content-type-options', 'x-frame-options', 'referrer-policy', 'cross-origin-opener-policy', 'cross-origin-resource-policy']) assert.ok(h[k], k);
  const panel = await fetch(`${app.extBase}/`);
  assert.equal(panel.status, 403, 'painel nunca abre pela porta do tunel');
});
