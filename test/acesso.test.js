// Testes do modelo de acesso: o que um visitante EXTERNO (vindo pelo tunel)
// pode e nao pode fazer, e protecoes contra sites maliciosos/DNS rebinding.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_IP_FAILURES, isExternal } from '../src/server.js';
import { SettingsStore } from '../src/settings.js';
import { IceProvider } from '../src/turn.js';
import { startApp, createRoom, wsClient, rawGet } from './helpers.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Como a Cloudflare entrega um visitante externo ao servidor local:
const EXTERNO = (ip = '203.0.113.7') => ({
  Host: 'verde-gato-azul.trycloudflare.com',
  'cf-connecting-ip': ip,
  'cf-ray': '8f0000000000-GRU',
  'x-forwarded-for': ip,
});

let app;
let tunnelInfo = { status: 'on', url: 'https://verde-gato-azul.trycloudflare.com', error: null };
before(async () => { app = await startApp({ getTunnelInfo: () => tunnelInfo }); });
after(() => app.close());

describe('Visitante externo (pelo tunel)', () => {
  test('NAO abre o painel nem cria sala nem le /api/info', async () => {
    for (const path of ['/', '/host', '/host.html', '/api/info']) {
      const r = await rawGet(app.port, path, { headers: EXTERNO() });
      assert.equal(r.status, 403, path);
    }
    const r = await rawGet(app.port, '/api/create-room', { method: 'POST', headers: EXTERNO() });
    assert.equal(r.status, 403);
    assert.equal(app.rooms.size, 0, 'nenhuma sala pode ter sido criada');
  });

  test('pagina 403 explica o que fazer', async () => {
    const r = await rawGet(app.port, '/', { headers: EXTERNO() });
    assert.match(r.body, /view\?room=/);
  });

  test('PODE abrir a pagina de espectador, o script e a config de ICE', async () => {
    for (const path of ['/view?room=abc', '/viewer.html', '/viewer.js', '/crypto.js', '/relay.js', '/api/ice', '/health']) {
      const r = await rawGet(app.port, path, { headers: EXTERNO() });
      assert.equal(r.status, 200, path);
    }
  });

  test('NAO consegue virar host de uma sala pelo WebSocket', async () => {
    const room = await createRoom(app);
    const ws = wsClient(app.ws, EXTERNO());
    await ws.opened;
    ws.json({ type: 'host-join', roomId: room.roomId });
    assert.equal((await ws.next()).reason, 'proibido');
    ws.close();
  });

  test('PODE entrar como espectador com o PIN e trocar sinalizacao', async () => {
    const room = await createRoom(app);
    const host = wsClient(app.ws); await host.opened;
    host.json({ type: 'host-join', roomId: room.roomId }); await host.next();

    const v = wsClient(app.ws, { ...EXTERNO(), origin: 'https://verde-gato-azul.trycloudflare.com' });
    await v.opened;
    v.json({ type: 'viewer-join', roomId: room.roomId, pin: room.pin });
    const { viewerId } = await v.next();
    assert.equal((await host.next()).viewerId, viewerId);
    host.json({ type: 'signal', viewerId, data: { sdp: { type: 'offer' } } });
    assert.equal((await v.next()).data.sdp.type, 'offer');
    host.close(); v.close();
  });

  test(`um IP que erra o PIN ${MAX_IP_FAILURES}x e bloqueado em TODAS as salas; outros IPs nao`, async () => {
    const atacante = EXTERNO('198.51.100.66');
    const rooms = await Promise.all(Array.from({ length: 4 }, () => createRoom(app)));
    const ws = wsClient(app.ws, atacante); await ws.opened;
    // Espalha as tentativas por varias salas (para nao cair no limite por sala).
    for (let i = 0; i < MAX_IP_FAILURES; i++) {
      const r = rooms[i % rooms.length];
      ws.json({ type: 'viewer-join', roomId: r.roomId, pin: r.pin === '000001' ? '000002' : '000001' });
      assert.equal((await ws.next()).reason, 'pin-invalido', `tentativa ${i + 1}`);
    }
    ws.json({ type: 'viewer-join', roomId: rooms[0].roomId, pin: rooms[0].pin });
    assert.equal((await ws.next()).reason, 'bloqueado', 'atacante entrou mesmo com o PIN certo');
    ws.close();

    const honesto = wsClient(app.ws, EXTERNO('192.0.2.10')); await honesto.opened;
    honesto.json({ type: 'viewer-join', roomId: rooms[1].roomId, pin: rooms[1].pin });
    assert.equal((await honesto.next()).type, 'viewer-accepted');
    honesto.close();
  });

  test('chutar IDs de sala tambem conta como tentativa (nao da para varrer salas)', async () => {
    const ws = wsClient(app.ws, EXTERNO('198.51.100.77')); await ws.opened;
    for (let i = 0; i < MAX_IP_FAILURES; i++) {
      ws.json({ type: 'viewer-join', roomId: `chute-${i}`, pin: '123456' });
      assert.equal((await ws.next()).reason, 'sala-inexistente');
    }
    ws.json({ type: 'viewer-join', roomId: 'mais-um', pin: '123456' });
    assert.equal((await ws.next()).reason, 'bloqueado');
    ws.close();
  });
});

describe('Protecoes do painel local', () => {
  test('DNS rebinding: Host desconhecido apontando para 127.0.0.1 e recusado', async () => {
    const r = await rawGet(app.port, '/', { headers: { Host: 'site-do-atacante.com' } });
    assert.equal(r.status, 403);
    const p = await rawGet(app.port, '/api/create-room', { method: 'POST', headers: { Host: 'site-do-atacante.com:8080' } });
    assert.equal(p.status, 403);
  });

  test('site malicioso aberto no seu navegador nao cria sala (Origin estranho)', async () => {
    const r = await rawGet(app.port, '/api/create-room', {
      method: 'POST', headers: { Host: `localhost:${app.port}`, Origin: 'https://site-malicioso.example' },
    });
    assert.equal(r.status, 403);
    const ok = await rawGet(app.port, '/api/create-room', {
      method: 'POST', headers: { Host: `localhost:${app.port}`, Origin: `http://localhost:${app.port}` },
    });
    assert.equal(ok.status, 200);
  });

  test('WebSocket com Origin de outro site e recusado no handshake', async () => {
    const ws = wsClient(app.ws, { origin: 'https://site-malicioso.example' });
    await assert.rejects(ws.opened);
  });

  test('/api/info entrega o link publico so para o painel local', async () => {
    const r = await fetch(`${app.base}/api/info`);
    assert.deepEqual((await r.json()).tunnel, tunnelInfo);
  });

  test('isExternal: cabecalhos de proxy marcam a requisicao como externa', () => {
    const req = (headers, remoteAddress = '127.0.0.1') => ({ headers, socket: { remoteAddress } });
    assert.equal(isExternal(req({})), false);
    assert.equal(isExternal(req({ 'cf-connecting-ip': '1.2.3.4' })), true);
    assert.equal(isExternal(req({ 'x-forwarded-for': '1.2.3.4' })), true);
    assert.equal(isExternal(req({}, '192.168.0.20')), true, 'outro PC da rede tambem e externo');
  });
});

describe('Credenciais TURN e tela de configuracoes', () => {
  let app2, dir;
  const SECRET = 'segredo-super-secreto-do-coturn';
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tl-'));
    const settings = new SettingsStore({ dir }).load();
    settings.update({ turn: { provider: 'coturn', coturn: { urls: 'turns:turn.exemplo.com:443?transport=tcp', secret: SECRET } } });
    app2 = await startApp({ settings, iceProvider: new IceProvider({ settings }) });
  });
  after(async () => { await app2.close(); rmSync(dir, { recursive: true, force: true }); });

  test('rota publica /api/ice so entrega STUN (nada de credencial TURN)', async () => {
    const body = await (await rawGet(app2.port, '/api/ice', { headers: EXTERNO() })).body;
    assert.match(body, /stun:/);
    assert.doesNotMatch(body, /turns?:|credential|username/);
  });

  test('credencial TURN temporaria so e entregue a quem acertou o PIN', async () => {
    const room = await createRoom(app2);
    const host = wsClient(app2.ws); await host.opened;
    host.json({ type: 'host-join', roomId: room.roomId });
    assert.ok((await host.next()).iceServers.some((s) => s.credential), 'host recebe TURN');

    const v = wsClient(app2.ws, EXTERNO('192.0.2.44')); await v.opened;
    v.json({ type: 'viewer-join', roomId: room.roomId, pin: room.pin === '111111' ? '222222' : '111111' });
    const wrong = await v.next();
    assert.equal(wrong.reason, 'pin-invalido');
    assert.equal(wrong.iceServers, undefined, 'PIN errado nao pode receber credencial');

    v.json({ type: 'viewer-join', roomId: room.roomId, pin: room.pin });
    const ok = await v.next();
    const turn = ok.iceServers.find((s) => s.credential);
    assert.ok(turn, 'PIN certo recebe TURN');
    const [expiry] = turn.username.split(':');
    const ttl = Number(expiry) - Date.now() / 1000;
    assert.ok(ttl > 3 * 3600 && ttl <= 4 * 3600 + 5, `validade deveria ser ~4h (foi ${ttl}s)`);
    assert.ok(!JSON.stringify(ok).includes(SECRET), 'o segredo do coturn nunca pode sair do PC');
    host.close(); v.close();
  });

  test('configuracoes: externo nao le nem altera', async () => {
    assert.equal((await rawGet(app2.port, '/api/settings', { headers: EXTERNO() })).status, 403);
    assert.equal((await rawGet(app2.port, '/config', { headers: EXTERNO() })).status, 403);
    const put = await rawGet(app2.port, '/api/settings', { method: 'PUT', headers: { ...EXTERNO(), 'content-type': 'application/json' } });
    assert.equal(put.status, 403);
  });

  test('configuracoes: o painel local ve o segredo apenas mascarado', async () => {
    const view = await (await fetch(`${app2.base}/api/settings`)).json();
    assert.equal(view.turn.provider, 'coturn');
    assert.match(view.turn.coturn.secret, /^••••••.{4}$/);
    assert.ok(!JSON.stringify(view).includes(SECRET));
  });

  test('configuracoes: alteracao exige JSON e mesma origem (anti-CSRF)', async () => {
    const form = await fetch(`${app2.base}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=b' });
    assert.equal(form.status, 415);
    const evil = await rawGet(app2.port, '/api/settings', { method: 'PUT', headers: { Host: `localhost:${app2.port}`, Origin: 'https://site-malicioso.example', 'content-type': 'application/json' } });
    assert.equal(evil.status, 403);
  });

  test('configuracoes: dados invalidos sao recusados com mensagem clara', async () => {
    for (const bad of [{ turn: { provider: 'hacker' } }, { capGB: -5 }, { defaultMode: 'x' },
      { turn: { provider: 'static', static: { urls: 'http://nao-e-turn.com', username: 'u' } } }]) {
      const r = await fetch(`${app2.base}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bad) });
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.ok((await r.json()).error);
    }
  });

  test('configuracoes: corpo gigante e recusado', async () => {
    const r = await fetch(`${app2.base}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: 'a'.repeat(50_000) }) }).catch(() => null);
    assert.ok(!r || r.status === 413);
  });
});
