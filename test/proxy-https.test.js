// Caminho completo como no mundo real: espectador -> https (proxy no papel da
// Cloudflare) -> TelaLink em 127.0.0.1. Valida visitante externo de verdade,
// pagina segura, WebSocket pelo proxy e a retransmissao cifrada.
// Precisa de openssl (gera certificado de teste) e Playwright; senao e pulado.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './helpers.js';
import { startTlsProxy } from '../lab/tls-proxy.js';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch {}
const hasOpenssl = spawnSync('openssl', ['version']).status === 0;
const skip = (!chromium && 'Playwright nao instalado') || (!hasOpenssl && 'openssl nao disponivel');

// Navegador sem proxy de sistema e com "lab.test" apontando para este PC.
const NO_PROXY_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(https?|all)_proxy$/i.test(k)));
const ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  '--auto-select-desktop-capture-source=Entire screen', '--autoplay-policy=no-user-gesture-required',
  // Teste na mesma maquina: IPs locais visiveis (no mac do CI o mDNS nao resolve).
  '--disable-features=WebRtcHideLocalIpsWithMdns',
  '--no-proxy-server', '--host-resolver-rules=MAP lab.test 127.0.0.1'];

let app, proxy, dir, browser, blocked, publicUrl;
before(async () => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), 'tl-tls-'));
  spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=lab.test',
    '-addext', 'subjectAltName=DNS:lab.test', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')]);
  app = await startApp({ getTunnelInfo: () => ({ status: 'on', url: publicUrl, error: null }) });
  proxy = await startTlsProxy({ key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')), port: 0, host: '127.0.0.1', target: app.port });
  publicUrl = `https://lab.test:${proxy.address().port}`;
  browser = await chromium.launch({ args: ARGS, env: NO_PROXY_ENV });
  blocked = await chromium.launch({ args: [...ARGS, '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'], env: NO_PROXY_ENV });
});
after(async () => { await browser?.close(); await blocked?.close(); proxy?.close(); await app?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

async function host() {
  const page = await (await browser.newContext()).newPage();
  await page.goto(app.base + '/');
  await page.waitForSelector('#tunnelStatus.on');
  await page.click('#btnStart');
  await page.waitForSelector('#share:not(.hidden)');
  return { page, link: await page.inputValue('#shareLink'), pin: (await page.textContent('#pinView')).trim() };
}

test('pelo proxy https: visitante e externo, pagina e segura e o painel e bloqueado', { skip, timeout: 60_000 }, async () => {
  const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
  assert.equal((await page.goto(publicUrl + '/')).status(), 403, 'painel nao pode abrir por fora');
  const h = await host();
  assert.ok(h.link.startsWith(publicUrl + '/view?room='), h.link);
  await page.goto(h.link);
  assert.equal(await page.evaluate(() => isSecureContext && !!crypto.subtle), true);
  await h.page.close();
});

test('pelo proxy https, rede sem WebRTC: retransmissao cifrada entrega a imagem', { skip, timeout: 90_000 }, async () => {
  const h = await host();
  const v = await (await blocked.newContext({ ignoreHTTPSErrors: true })).newPage();
  await v.goto(h.link);
  await v.fill('#pin', h.pin);
  await v.click('#btnJoin');
  await v.waitForFunction(() => window.__telalink.transport === 'retransmissao' && window.__telalink.stats?.framesDecoded > 30, null, { timeout: 45_000 });
  assert.equal((await v.evaluate(() => window.__telalink.stats)).rejected, 0);
  await h.page.close();
});

test('pelo proxy https, rede comum: conexao direta', { skip, timeout: 90_000 }, async () => {
  const h = await host();
  const v = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
  await v.goto(h.link);
  await v.fill('#pin', h.pin);
  await v.click('#btnJoin');
  await v.waitForFunction(() => window.__telalink.transport === 'direta', null, { timeout: 30_000 });
  await h.page.close();
});
