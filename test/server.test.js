// Testes de integracao do servidor: HTTP, seguranca e sinalizacao.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PIN_ATTEMPTS, pinMatches, generatePin } from '../src/server.js';
import { startApp, createRoom, wsClient, roomWithViewer, rawGet } from './helpers.js';

let app;
before(async () => { app = await startApp(); });
after(() => app.close());

describe('HTTP', () => {
  test('/health responde ok', async () => {
    const r = await fetch(`${app.base}/health`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).ok, true);
  });

  test('paginas e script carregam com o tipo certo', async () => {
    for (const [path, type] of [['/', 'text/html'], ['/view', 'text/html'], ['/config', 'text/html'],
      ['/viewer.js', 'text/javascript'], ['/crypto.js', 'text/javascript'], ['/style.css', 'text/css']]) {
      const r = await fetch(app.base + path);
      assert.equal(r.status, 200, path);
      assert.match(r.headers.get('content-type'), new RegExp(type), path);
    }
  });

  test('cabecalhos de seguranca presentes', async () => {
    const r = await fetch(app.base + '/');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'/, 'so scripts do proprio site');
    assert.match(csp, /frame-ancestors 'none'/, 'nao pode ser embutido em outro site');
    assert.doesNotMatch(csp, /script-src[^;]*unsafe/, 'nada de script inline/eval');
  });

  test('nenhuma pagina tem script inline (exigencia da CSP)', async () => {
    for (const p of ['/', '/view', '/config']) {
      const html = await (await fetch(app.base + p)).text();
      for (const [, attrs, body] of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
        assert.match(attrs, /src=/, `${p}: script sem src`);
        assert.equal(body.trim(), '', `${p}: script inline`);
      }
      assert.doesNotMatch(html, /\son[a-z]+=/i, `${p}: handler inline (onclick=...)`);
    }
  });

  test('arquivo inexistente da 404', async () => {
    assert.equal((await fetch(app.base + '/nao-existe.js')).status, 404);
  });

  test('path traversal e bloqueado (nao vaza arquivos fora de /public)', async () => {
    for (const p of ['/../src/server.js', '/..%2fsrc%2fserver.js', '/%2e%2e/package.json', '/..\\src\\server.js']) {
      const r = await rawGet(app.port, p);
      assert.ok([400, 403, 404].includes(r.status), `${p} -> ${r.status}`);
      assert.doesNotMatch(r.body, /createServer|"name"/, `${p} vazou conteudo`);
    }
  });

  test('URL malformada nao derruba o servidor', async () => {
    const r = await rawGet(app.port, '/%E0%A4%A');
    assert.equal(r.status, 400);
    assert.equal((await fetch(`${app.base}/health`)).status, 200);
  });

  test('create-room so aceita POST', async () => {
    assert.equal((await fetch(`${app.base}/api/create-room`)).status, 405);
  });

  test('salas tem IDs unicos e PINs de 6 digitos', async () => {
    const rooms = await Promise.all(Array.from({ length: 50 }, () => createRoom(app)));
    assert.equal(new Set(rooms.map((r) => r.roomId)).size, 50);
    for (const r of rooms) assert.match(r.pin, /^\d{6}$/);
  });
});

describe('PIN', () => {
  test('generatePin sempre gera 6 digitos', () => {
    for (let i = 0; i < 2000; i++) assert.match(generatePin(), /^\d{6}$/);
  });

  test('PIN guardado como HMAC-SHA-512 com chave por sala; rejeita formatos invalidos sem erro', async () => {
    const { createHmac, randomBytes } = await import('node:crypto');
    const key = randomBytes(64);
    const tag = createHmac('sha512', key).update('123456').digest();
    assert.equal(tag.length, 64, 'SHA-512 = 64 bytes');
    assert.equal(pinMatches(key, tag, '123456'), true);
    assert.equal(pinMatches(randomBytes(64), tag, '123456'), false, 'outra sala, outra chave');
    for (const bad of ['12345', '1234567', 'abcdef', '', null, undefined, 123456, {}, ['123456'], '12345\n']) {
      assert.equal(pinMatches(key, tag, bad), false, String(bad));
    }
  });

  test('o PIN nao fica guardado em texto em lugar nenhum da sala', async () => {
    const room = await createRoom(app);
    const stored = app.rooms.get(room.roomId);
    assert.ok(!('pin' in stored), 'campo pin nao deveria existir');
    for (const [k, v] of Object.entries(stored)) {
      assert.ok(!(typeof v === 'string' && v.includes(room.pin)) && v !== Number(room.pin), `PIN em texto em "${k}"`);
    }
  });

  test('PIN errado e rejeitado; PIN certo entra', async () => {
    const room = await createRoom(app);
    const v = wsClient(app.ws); await v.opened;
    v.json({ type: 'viewer-join', roomId: room.roomId, pin: '000000' === room.pin ? '111111' : '000000' });
    assert.equal((await v.next()).reason, 'pin-invalido');
    v.json({ type: 'viewer-join', roomId: room.roomId, pin: room.pin });
    assert.equal((await v.next()).type, 'viewer-accepted');
    v.close();
  });

  test(`bloqueia a sala apos ${MAX_PIN_ATTEMPTS} tentativas erradas (anti forca-bruta)`, async () => {
    const room = await createRoom(app);
    const wrong = room.pin === '999999' ? '999998' : '999999';
    const v = wsClient(app.ws); await v.opened;
    for (let i = 0; i < MAX_PIN_ATTEMPTS; i++) {
      v.json({ type: 'viewer-join', roomId: room.roomId, pin: wrong });
      assert.equal((await v.next()).reason, 'pin-invalido');
    }
    // Agora nem o PIN certo entra.
    v.json({ type: 'viewer-join', roomId: room.roomId, pin: room.pin });
    assert.equal((await v.next()).reason, 'bloqueado');
    v.close();
  });

  test('sala inexistente e rejeitada', async () => {
    const v = wsClient(app.ws); await v.opened;
    v.json({ type: 'viewer-join', roomId: 'nao-existe', pin: '123456' });
    assert.equal((await v.next()).reason, 'sala-inexistente');
    v.close();
  });
});

describe('Sinalizacao', () => {
  test('offer, answer e ICE chegam a quem devem', async () => {
    const { host, viewer, viewerId } = await roomWithViewer(app);

    host.json({ type: 'signal', viewerId, data: { sdp: { type: 'offer', sdp: 'v=0' } } });
    const offer = await viewer.next();
    assert.equal(offer.from, 'host');
    assert.equal(offer.data.sdp.type, 'offer');

    viewer.json({ type: 'signal', data: { sdp: { type: 'answer', sdp: 'v=0' } } });
    const answer = await host.next();
    assert.equal(answer.from, 'viewer');
    assert.equal(answer.viewerId, viewerId);

    viewer.json({ type: 'signal', data: { candidate: { candidate: 'x' } } });
    assert.equal((await host.next()).data.candidate.candidate, 'x');

    host.close(); viewer.close();
  });

  test('viewers sao isolados: um nao recebe a sinalizacao do outro', async () => {
    const { room, host, viewer: a, viewerId: idA } = await roomWithViewer(app);
    const b = wsClient(app.ws); await b.opened;
    b.json({ type: 'viewer-join', roomId: room.roomId, pin: room.pin });
    await b.next(); await host.next();

    host.json({ type: 'signal', viewerId: idA, data: { sdp: { type: 'offer' } } });
    await a.next();
    await b.nothing();

    host.close(); a.close(); b.close();
  });

  test('viewer nao consegue se passar por host nem mandar para outra sala', async () => {
    const one = await roomWithViewer(app);
    const two = await roomWithViewer(app);
    // Viewer da sala 1 tenta mirar um viewerId da sala 2.
    one.viewer.json({ type: 'signal', roomId: two.room.roomId, viewerId: two.viewerId, data: { evil: 1 } });
    const got = await one.host.next();         // vai para o SEU host, marcado como viewer
    assert.equal(got.from, 'viewer');
    await two.viewer.nothing();
    await two.host.nothing();
    // Segundo "host" na mesma sala e recusado.
    const intruder = wsClient(app.ws); await intruder.opened;
    intruder.json({ type: 'host-join', roomId: one.room.roomId });
    assert.equal((await intruder.next()).reason, 'sala-ja-tem-host');
    for (const w of [one.host, one.viewer, two.host, two.viewer, intruder]) w.close();
  });

  test('host e avisado quando o viewer sai', async () => {
    const { host, viewer, viewerId } = await roomWithViewer(app);
    viewer.close();
    const m = await host.next();
    assert.deepEqual(m, { type: 'viewer-left', viewerId });
    host.close();
  });

  test('quando o host sai, viewers sao avisados e a sala some', async () => {
    const { room, host, viewer } = await roomWithViewer(app);
    host.close();
    assert.equal((await viewer.next()).type, 'host-left');
    const late = wsClient(app.ws); await late.opened;
    late.json({ type: 'viewer-join', roomId: room.roomId, pin: room.pin });
    assert.equal((await late.next()).reason, 'sala-inexistente');
    viewer.close(); late.close();
  });

  test('lixo e JSON invalido sao ignorados sem derrubar a conexao', async () => {
    const room = await createRoom(app);
    const ws = wsClient(app.ws); await ws.opened;
    for (const junk of ['nao e json', '123', 'null', '"txt"', '{"type":"desconhecido"}', '[]']) ws.send(junk);
    ws.json({ type: 'host-join', roomId: room.roomId });
    assert.equal((await ws.next()).type, 'host-ready');
    ws.close();
  });

  test('mensagem gigante fecha a conexao (protecao de memoria)', async () => {
    const ws = wsClient(app.ws); await ws.opened;
    ws.send('x'.repeat(400 * 1024));
    await ws.closed;
    assert.equal((await fetch(`${app.base}/health`)).status, 200);
  });

  test('aguenta 30 viewers simultaneos na mesma sala', async () => {
    const room = await createRoom(app);
    const host = wsClient(app.ws); await host.opened;
    host.json({ type: 'host-join', roomId: room.roomId }); await host.next();
    const viewers = await Promise.all(Array.from({ length: 30 }, async () => {
      const v = wsClient(app.ws); await v.opened;
      v.json({ type: 'viewer-join', roomId: room.roomId, pin: room.pin });
      return { v, id: (await v.next()).viewerId };
    }));
    const joined = new Set();
    for (let i = 0; i < 30; i++) joined.add((await host.next()).viewerId);
    assert.equal(joined.size, 30);
    for (const { v, id } of viewers) host.json({ type: 'signal', viewerId: id, data: { n: id } });
    for (const { v, id } of viewers) assert.equal((await v.next()).data.n, id);
    host.close(); viewers.forEach(({ v }) => v.close());
  });
});

describe('Controle da sala pelo host', () => {
  test('remover espectador: ele e avisado e desconectado; outros continuam', async () => {
    const { room, host, viewer: a, viewerId: idA } = await roomWithViewer(app);
    const b = wsClient(app.ws); await b.opened;
    b.json({ type: 'viewer-join', roomId: room.roomId, pin: room.pin });
    await b.next(); await host.next();
    host.json({ type: 'kick', viewerId: idA });
    assert.equal((await a.next()).type, 'kicked');
    await a.closed;
    assert.deepEqual(await host.next(), { type: 'viewer-left', viewerId: idA });
    assert.equal(app.rooms.get(room.roomId).viewers.has(idA), false);
    await b.nothing();
    host.close(); b.close();
  });

  test('trancar a sala: ninguem novo entra, nem com o PIN certo; destrancar libera', async () => {
    const { room, host, viewer } = await roomWithViewer(app);
    host.json({ type: 'lock', locked: true });
    assert.deepEqual(await host.next(), { type: 'locked', locked: true });
    const late = wsClient(app.ws); await late.opened;
    late.json({ type: 'viewer-join', roomId: room.roomId, pin: room.pin });
    assert.equal((await late.next()).reason, 'sala-trancada');
    host.json({ type: 'lock', locked: false });
    await host.next();
    late.json({ type: 'viewer-join', roomId: room.roomId, pin: room.pin });
    assert.equal((await late.next()).type, 'viewer-accepted');
    host.close(); viewer.close(); late.close();
  });

  test('espectador nao pode remover ninguem nem trancar a sala', async () => {
    const { room, host, viewer, viewerId } = await roomWithViewer(app);
    viewer.json({ type: 'lock', locked: true });
    viewer.json({ type: 'kick', viewerId });
    await host.nothing();
    assert.equal(app.rooms.get(room.roomId).locked, undefined);
    assert.ok(app.rooms.get(room.roomId).viewers.has(viewerId));
    host.close(); viewer.close();
  });
});
