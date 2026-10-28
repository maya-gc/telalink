// Testes das configuracoes (guardadas fora do projeto, segredos protegidos).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore, applyUpdate, DEFAULTS, protect, unprotect, parseTurnUrls, mask, dataDir } from '../src/settings.js';

const tmp = (t) => { const d = mkdtempSync(join(tmpdir(), 'tl-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };

test('pasta de configuracoes fica fora do projeto', () => {
  const saved = process.env.TELALINK_DATA_DIR; delete process.env.TELALINK_DATA_DIR;
  try {
    const d = dataDir();
    assert.ok(!d.startsWith(process.cwd()), `nao pode ficar dentro do projeto: ${d}`);
    assert.match(d, /TelaLink|telalink/);
  } finally { if (saved) process.env.TELALINK_DATA_DIR = saved; }
});

test('.gitignore impede que configuracoes locais entrem no repositorio', () => {
  const gi = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
  assert.match(gi, /settings\.json/);
  assert.match(gi, /config\.json/);
});

test('segredo salvo nunca aparece em texto no arquivo', (t) => {
  const dir = tmp(t);
  const s = new SettingsStore({ dir }).load();
  s.update({ turn: { provider: 'cloudflare', cloudflare: { keyId: 'abc123', apiToken: 'TOKEN-ULTRA-SECRETO-123' } } });
  const raw = readFileSync(join(dir, 'settings.json'), 'utf8');
  assert.ok(!raw.includes('TOKEN-ULTRA-SECRETO-123'));
  if (process.platform === 'win32') assert.match(raw, /"prot": "dpapi"/, 'no Windows deve usar DPAPI');
  else assert.equal(statSync(join(dir, 'settings.json')).mode & 0o777, 0o600, 'arquivo so legivel pelo dono');
  // Recarregando, o segredo volta igual.
  const s2 = new SettingsStore({ dir }).load();
  assert.equal(s2.secret('cloudflare'), 'TOKEN-ULTRA-SECRETO-123');
});

test('visao publica mostra o segredo so mascarado', (t) => {
  const s = new SettingsStore({ dir: tmp(t) }).load();
  s.update({ turn: { provider: 'static', static: { urls: 'turn:t.exemplo.com:3478', username: 'u', credential: 'senha-longa-9f3a' } } });
  const v = s.publicView();
  assert.equal(v.turn.static.credential, '••••••9f3a');
  assert.ok(!JSON.stringify(v).includes('senha-longa'));
  assert.equal(mask(''), '');
});

test('segredo vazio na alteracao = manter o atual; clearSecret apaga', (t) => {
  const s = new SettingsStore({ dir: tmp(t) }).load();
  s.update({ turn: { provider: 'coturn', coturn: { urls: 'turn:a.com:3478', secret: 's1' } } });
  s.update({ turn: { provider: 'coturn', coturn: { urls: 'turn:b.com:3478', secret: '' } } });
  assert.equal(s.secret('coturn'), 's1');
  assert.equal(s.data.turn.coturn.urls, 'turn:b.com:3478');
  s.update({ turn: { provider: 'coturn', clearSecret: 'coturn' } });
  assert.equal(s.secret('coturn'), null);
});

test('validacao recusa entradas perigosas ou erradas', () => {
  const bad = [
    { defaultMode: 'qualquer' }, { capGB: 0 }, { capGB: 'muito' }, { turn: { provider: 'ftp' } },
    { turn: { provider: 'cloudflare', cloudflare: { keyId: '../../etc' } } },
    { turn: { provider: 'coturn', coturn: { urls: 'javascript:alert(1)' } } },
    { turn: { provider: 'static', static: { urls: 'turn:a.com:3478', username: 'x'.repeat(300) } } },
    null, 'texto',
  ];
  for (const b of bad) assert.throws(() => applyUpdate(DEFAULTS, b, { protectFn: (x) => x }), JSON.stringify(b));
});

test('parseTurnUrls aceita turn/turns com transporte e recusa o resto', () => {
  assert.deepEqual(parseTurnUrls('turns:t.com:443?transport=tcp\nturn:t.com:3478'), ['turns:t.com:443?transport=tcp', 'turn:t.com:3478']);
  for (const bad of ['', 'http://t.com', 'turn:t.com:3478?transport=sctp', 'turn:t.com;rm', Array(10).fill('turn:a.com').join(' ')]) {
    assert.throws(() => parseTurnUrls(bad), bad);
  }
});

test('trava de consumo: soma no mes, zera no mes seguinte e respeita "sem limite"', (t) => {
  const s = new SettingsStore({ dir: tmp(t) }).load();
  s.update({ capGB: 1 });
  const out = new Date('2026-10-15T12:00:00Z');
  s.addUsage(0.6e9, out); assert.equal(s.overCap(out), false);
  s.addUsage(0.5e9, out); assert.equal(s.overCap(out), true);
  const nov = new Date('2026-11-01T00:00:01Z');
  assert.equal(s.usageGB(nov), 0, 'mes novo');
  assert.equal(s.overCap(nov), false);
  s.update({ capGB: null });
  s.addUsage(1e15, nov);
  assert.equal(s.overCap(nov), false, 'sem limite');
});

test('arquivo corrompido nao derruba o programa (volta ao padrao)', (t) => {
  const dir = tmp(t);
  writeFileSync(join(dir, 'settings.json'), '{ isso nao e json');
  const s = new SettingsStore({ dir }).load();
  assert.equal(s.data.turn.provider, 'none');
});

test('protecao por plataforma: Linux/macOS ida e volta; DPAPI nao abre fora do Windows', () => {
  const box = protect('abc', 'linux');
  assert.equal(unprotect(box, 'linux'), 'abc');
  assert.throws(() => unprotect({ prot: 'dpapi', data: 'xx' }, 'linux'), /Windows/);
  assert.throws(() => unprotect({ prot: '???', data: 'xx' }, 'linux'), /desconhecido/);
});

test('Windows REAL: DPAPI cifra e decifra; o resultado nao contem o segredo',
  { skip: process.platform !== 'win32' && 'so roda no Windows' }, () => {
    const box = protect('segredo-dpapi-123', 'win32');
    assert.equal(box.prot, 'dpapi');
    assert.ok(!Buffer.from(box.data, 'base64').toString('latin1').includes('segredo-dpapi'));
    assert.equal(unprotect(box, 'win32'), 'segredo-dpapi-123');
  });
