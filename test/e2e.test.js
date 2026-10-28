// =============================================================================
//  E2E com navegador real (Chromium via Playwright).
//  Cenarios: conexao direta, rede que bloqueia WebRTC (-> retransmissao),
//  modo maxima seguranca, link sem chave, link com chave adulterada,
//  e a garantia de que a chave do link nunca chega ao servidor.
//  OPCIONAL: pulado se o Playwright nao estiver instalado
//  (npm run test:e2e:setup habilita).
// =============================================================================
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startApp } from './helpers.js';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* sem playwright */ }

const BASE_ARGS = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--auto-select-desktop-capture-source=Entire screen',
  '--autoplay-policy=no-user-gesture-required',
];
// Simula VPN/extensao que desliga o WebRTC "de verdade": sem caminho UDP.
const NO_WEBRTC_ARGS = [...BASE_ARGS, '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'];

const skip = !chromium && 'Playwright nao instalado';
let app, hostBrowser, blockedBrowser;
const requests = [];

before(async () => {
  if (skip) return;
  app = await startApp({
    getTunnelInfo: () => ({ status: 'on', url: app.base, error: null }),
    onRequest: (req) => requests.push(req.url),
  });
  hostBrowser = await chromium.launch({ args: BASE_ARGS });
  blockedBrowser = await chromium.launch({ args: NO_WEBRTC_ARGS });
});
after(async () => { await hostBrowser?.close(); await blockedBrowser?.close(); await app?.close(); });

async function startHost({ policy = 'auto' } = {}) {
  const ctx = await hostBrowser.newContext();
  const page = await ctx.newPage();
  await page.goto(app.base + '/');
  await page.waitForSelector('#tunnelStatus.on');
  await page.check(`input[name=policy][value=${policy}]`);
  await page.click('#btnStart');
  await page.waitForSelector('#share:not(.hidden)');
  const link = await page.inputValue('#shareLink');
  const pin = (await page.textContent('#pinView')).trim();
  return { page, ctx, link, pin };
}

async function openViewer(browser, link, pin) {
  const ctx = await browser.newContext({ extraHTTPHeaders: { 'cf-connecting-ip': '203.0.113.50' } }); // "externo"
  const page = await ctx.newPage();
  await page.goto(link);
  await page.fill('#pin', pin);
  await page.click('#btnJoin');
  return { page, ctx };
}

const transportOf = (page) => page.evaluate(() => window.__telalink.transport);

describe('E2E navegador real', { skip, timeout: 120_000 }, () => {
  test('link tem sala + chave de 256 bits no fragmento; visitante externo nao abre o painel', async () => {
    const h = await startHost();
    assert.match(h.link, /^http:\/\/127\.0\.0\.1:\d+\/view\?room=[0-9a-f-]{36}#k=[A-Za-z0-9_-]{43}$/);
    const ext = await (await hostBrowser.newContext({ extraHTTPHeaders: { 'cf-connecting-ip': '203.0.113.9' } })).newPage();
    assert.equal((await ext.goto(app.base + '/')).status(), 403);
    await h.ctx.close();
  });

  test('conexao direta: video e audio chegam e o caminho e "direta"', async () => {
    const h = await startHost();
    const v = await openViewer(hostBrowser, h.link, h.pin);
    await v.page.waitForFunction(() => window.__telalink.transport === 'direta', null, { timeout: 20_000 });
    await v.page.waitForFunction(() => {
      const el = document.getElementById('remote');
      return el.videoWidth > 0 && el.currentTime > 0.5;
    }, null, { timeout: 20_000 });
    const kinds = await v.page.evaluate(() => document.getElementById('remote').srcObject.getTracks().map((t) => t.kind).sort());
    assert.deepEqual(kinds, ['audio', 'video']);
    await h.page.waitForFunction(() => document.getElementById('viewerCount').textContent === '1');
    await v.ctx.close(); await h.ctx.close();
  });

  test('rede que bloqueia WebRTC (VPN): cai sozinho na retransmissao e recebe video + audio', async () => {
    const h = await startHost();
    const v = await openViewer(blockedBrowser, h.link, h.pin);
    await v.page.waitForFunction(() => window.__telalink.transport === 'retransmissao', null, { timeout: 30_000 });
    await v.page.waitForFunction(() => window.__telalink.stats?.framesDecoded > 30, null, { timeout: 30_000 });
    await v.page.waitForFunction(() => window.__telalink.stats?.audioDecoded > 10, null, { timeout: 30_000 });
    const s = await v.page.evaluate(() => window.__telalink.stats);
    assert.equal(s.rejected, 0, 'nenhum pacote deveria falhar na verificacao criptografica');
    // A imagem desenhada nao pode ser preta.
    const lit = await v.page.evaluate(() => {
      const c = document.getElementById('relayCanvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let sum = 0; for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
      return sum / (d.length / 4) / 3;
    });
    assert.ok(lit > 10, `imagem escura demais (${lit})`);
    await h.page.waitForFunction(() => window.__telalink.viewers.some((x) => x.transport === 'retransmissao'));
    await v.ctx.close(); await h.ctx.close();
  });

  test('modo maxima seguranca: sempre retransmissao cifrada, mesmo com WebRTC disponivel', async () => {
    const h = await startHost({ policy: 'relay' });
    const v = await openViewer(hostBrowser, h.link, h.pin);
    await v.page.waitForFunction(() => window.__telalink.stats?.framesDecoded > 15, null, { timeout: 30_000 });
    assert.equal(await transportOf(v.page), 'retransmissao');
    await v.ctx.close(); await h.ctx.close();
  });

  test('link sem a chave (#k=...) nem deixa tentar entrar', async () => {
    const h = await startHost();
    const page = await (await hostBrowser.newContext()).newPage();
    await page.goto(h.link.split('#')[0]);
    assert.match(await page.textContent('#gateMsg'), /falta a chave de seguran/);
    assert.ok(await page.isDisabled('#btnJoin'));
    await h.ctx.close();
  });

  test('chave adulterada: PIN certo nao basta, a transmissao nao e aceita', async () => {
    const h = await startHost();
    const bad = h.link.replace(/#k=(.)/, (m, c) => `#k=${c === 'A' ? 'B' : 'A'}`);
    const v = await openViewer(hostBrowser, bad, h.pin);
    await v.page.waitForFunction(() => /validar a transmiss/.test(document.getElementById('gateMsg').textContent), null, { timeout: 15_000 });
    assert.equal(await transportOf(v.page), 'conectando');
    await v.ctx.close(); await h.ctx.close();
  });

  test('a chave secreta do link nunca chegou ao servidor', () => {
    assert.ok(requests.length > 20, 'deveria ter registrado as requisicoes');
    for (const url of requests) assert.doesNotMatch(url, /k=|#/, `vazou: ${url}`);
  });
});
