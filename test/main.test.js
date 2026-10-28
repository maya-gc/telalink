// Executa o programa de verdade (node src/server.js), como o Iniciar.bat faz.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = join(ROOT, 'test', 'fixtures', 'fake-cloudflared.js');

function run(env, t) {
  const dir = mkdtempSync(join(tmpdir(), 'tl-main-'));
  const child = spawn(process.execPath, [join(ROOT, 'src', 'server.js')], {
    // Cada teste define TUNNEL explicitamente (a CI liga TUNNEL=0 no ambiente).
    env: { ...process.env, NO_OPEN: '1', PORT: '0', TUNNEL: '', TELALINK_DATA_DIR: dir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  t.after(async () => { child.kill(); await exited; rmSync(dir, { recursive: true, force: true }); });
  const waitFor = async (re, ms = 8000) => {
    const end = Date.now() + ms;
    while (!re.test(out) && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    assert.match(out, re);
    return out.match(re);
  };
  return { child, exited, waitFor, out: () => out, dir };
}

test('programa sobe, mostra onde ficam as configuracoes e encerra limpo', async (t) => {
  const p = run({ TUNNEL: '0' }, t);
  const [, port] = await p.waitFor(/Painel \(so neste PC\):\s+http:\/\/localhost:(\d+)\//);
  assert.match(p.out(), /Configuracoes ficam em:/);
  assert.match(p.out(), /Link externo desligado/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
  p.child.kill('SIGTERM');
  const code = await p.exited;
  if (process.platform !== 'win32') assert.equal(code, 0, 'deveria encerrar sem erro');
});

test('escuta so em 127.0.0.1 por padrao (nada exposto na rede)', async (t) => {
  const p = run({ TUNNEL: '0' }, t);
  const [, port] = await p.waitFor(/localhost:(\d+)\//);
  const { networkInterfaces } = await import('node:os');
  const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
  if (!lan) return t.skip('sem interface de rede externa neste computador');
  await assert.rejects(fetch(`http://${lan.address}:${port}/health`, { signal: AbortSignal.timeout(2000) }));
});

test('PUBLIC_URL: endereco publico fixo e entregue ao painel', async (t) => {
  const p = run({ PUBLIC_URL: 'https://tela.exemplo.com.br/' }, t);
  const [, port] = await p.waitFor(/localhost:(\d+)\//);
  const info = await (await fetch(`http://127.0.0.1:${port}/api/info`)).json();
  assert.deepEqual(info.tunnel, { status: 'on', url: 'https://tela.exemplo.com.br', error: null });
});

test('com cloudflared: mostra o link externo assim que fica pronto',
  { skip: process.platform === 'win32' && 'wrapper de shell (no Windows o caminho real e verificado por assinatura)' }, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'tl-cf-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const wrapper = join(dir, 'cloudflared');
    writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" ok "$@"\n`);
    chmodSync(wrapper, 0o755);
    const p = run({ CLOUDFLARED_PATH: wrapper }, t);
    await p.waitFor(/Link externo ATIVO:\s+https:\/\/verde-gato-azul-teste\.trycloudflare\.com/);
  });

test('sem cloudflared: avisa como instalar e continua funcionando localmente', async (t) => {
  const p = run({ CLOUDFLARED_PATH: '', PATH: '' }, t);
  const [, port] = await p.waitFor(/localhost:(\d+)\//);
  await p.waitFor(/cloudflared nao instalado|assinatura digital nao confere/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
});

test('porta ocupada: mensagem clara e codigo de erro', async (t) => {
  const a = run({ TUNNEL: '0' }, t);
  const [, port] = await a.waitFor(/localhost:(\d+)\//);
  const b = run({ TUNNEL: '0', PORT: port }, t);
  assert.equal(await b.exited, 1);
  assert.match(b.out(), /porta \d+ ja esta em uso/);
});
