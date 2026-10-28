// Testes das credenciais TURN (todos os provedores) com rede simulada.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore } from '../src/settings.js';
import { IceProvider, coturnCredentials, DEFAULT_STUN, TTL_SECONDS } from '../src/turn.js';

function store(t, update) {
  const dir = mkdtempSync(join(tmpdir(), 'tl-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const s = new SettingsStore({ dir, platform: 'linux' }).load();
  if (update) s.update(update);
  return s;
}

const cfResponse = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test('sem provedor: so STUN, sem chamadas de rede', async (t) => {
  let called = false;
  const p = new IceProvider({ settings: store(t), fetchImpl: async () => { called = true; } });
  assert.deepEqual(await p.forSession(), DEFAULT_STUN);
  assert.equal(called, false);
});

test('Cloudflare: chamada correta, porta 53 removida, token nunca vai para a resposta', async (t) => {
  const s = store(t, { turn: { provider: 'cloudflare', cloudflare: { keyId: 'abc123', apiToken: 'TOKEN-XYZ' } } });
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { status: 201, ok: true, json: async () => ({ iceServers: {
      urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
      username: 'user-temp', credential: 'cred-temp' } }) };
  };
  const p = new IceProvider({ settings: s, fetchImpl });
  const ice = await p.forSession();
  assert.equal(calls[0].url, 'https://rtc.live.cloudflare.com/v1/turn/keys/abc123/credentials/generate');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers.authorization, 'Bearer TOKEN-XYZ');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { ttl: TTL_SECONDS });
  const turn = ice.find((x) => x.credential);
  assert.ok(!turn.urls.some((u) => u.includes(':53')), 'porta 53 bloqueada nos navegadores');
  assert.ok(turn.urls.includes('turns:turn.cloudflare.com:443?transport=tcp'), 'TURN sobre TLS/443 para redes de empresa');
  assert.ok(!JSON.stringify(ice).includes('TOKEN-XYZ'));
  // Cache: segunda sessao nao chama a API de novo.
  await p.forSession();
  assert.equal(calls.length, 1);
});

test('Cloudflare: credenciais recusadas viram mensagem clara e a sessao segue so com STUN', async (t) => {
  const s = store(t, { turn: { provider: 'cloudflare', cloudflare: { keyId: 'abc', apiToken: 'ruim' } } });
  const p = new IceProvider({ settings: s, fetchImpl: cfResponse(401, {}) });
  assert.deepEqual(await p.forSession(), DEFAULT_STUN, 'falha no TURN nao pode impedir a transmissao');
  assert.match(p.lastError, /recusou as credenciais/);
  const r = await p.test();
  assert.equal(r.ok, false);
});

test('Cloudflare: resposta estranha ou fora do ar nao quebra nada', async (t) => {
  const s = store(t, { turn: { provider: 'cloudflare', cloudflare: { keyId: 'abc', apiToken: 'x' } } });
  for (const f of [cfResponse(200, { nada: 1 }), cfResponse(500, {}), async () => { throw new Error('rede caiu'); }]) {
    const p = new IceProvider({ settings: s, fetchImpl: f });
    assert.deepEqual(await p.forSession(), DEFAULT_STUN);
    assert.ok(p.lastError);
  }
});

test('coturn: credencial temporaria no padrao TURN REST (HMAC do segredo)', (t) => {
  const now = Date.UTC(2026, 9, 28, 12, 0, 0);
  const c = coturnCredentials('meu-segredo', ['turn:t.com:3478'], { now });
  const expiry = now / 1000 + TTL_SECONDS;
  assert.equal(c.username, `${expiry}:telalink`);
  assert.equal(c.credential, createHmac('sha1', 'meu-segredo').update(c.username).digest('base64'));
});

test('coturn: renova antes de vencer (metade da validade)', async (t) => {
  let clock = Date.UTC(2026, 9, 28, 12);
  const s = store(t, { turn: { provider: 'coturn', coturn: { urls: 'turn:t.com:3478', secret: 'sss' } } });
  const p = new IceProvider({ settings: s, now: () => clock });
  const a = (await p.forSession()).find((x) => x.credential);
  clock += (TTL_SECONDS / 2) * 1000 - 1000;
  assert.equal((await p.forSession()).find((x) => x.credential).username, a.username, 'ainda no cache');
  clock += 2000;
  assert.notEqual((await p.forSession()).find((x) => x.credential).username, a.username, 'renovou');
});

test('usuario/senha fixos: entregues como configurados', async (t) => {
  const s = store(t, { turn: { provider: 'static', static: { urls: 'turns:t.com:443?transport=tcp', username: 'u1', credential: 'p1' } } });
  const turn = (await new IceProvider({ settings: s }).forSession()).find((x) => x.credential);
  assert.deepEqual(turn, { urls: ['turns:t.com:443?transport=tcp'], username: 'u1', credential: 'p1' });
});

test('trava de consumo atingida: TURN some e o teste explica o motivo', async (t) => {
  const s = store(t, { capGB: 1, turn: { provider: 'static', static: { urls: 'turn:t.com:3478', username: 'u', credential: 'p' } } });
  s.addUsage(2e9);
  const p = new IceProvider({ settings: s });
  assert.deepEqual(await p.forSession(), DEFAULT_STUN);
  assert.match((await p.test()).message, /Trava de consumo/);
});

test('mudar o provedor invalida o cache na hora', async (t) => {
  const s = store(t, { turn: { provider: 'static', static: { urls: 'turn:a.com:3478', username: 'u', credential: 'p' } } });
  const p = new IceProvider({ settings: s });
  assert.ok((await p.forSession()).some((x) => x.credential));
  s.update({ turn: { provider: 'none' } });
  assert.deepEqual(await p.forSession(), DEFAULT_STUN);
});
