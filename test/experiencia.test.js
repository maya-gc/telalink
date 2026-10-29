// =============================================================================
//  Melhorias de uso da versao 2.4, com navegador real (Chromium/Playwright):
//  QR code do convite (lido por um decodificador independente, jsQR), novo PIN,
//  aviso de PIN errado, aviso de link alterado, relogio/titulo "ao vivo",
//  e reconexao automatica de quem assiste.
// =============================================================================
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './helpers.js';
import { SettingsStore } from '../src/settings.js';
import { IceProvider } from '../src/turn.js';

const require = createRequire(import.meta.url);
let chromium = null;
try { ({ chromium } = require('playwright')); } catch {}
const skip = !chromium && 'Playwright nao instalado';
const jsQR = require('./vendor/jsQR.cjs');

const ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  '--auto-select-desktop-capture-source=Entire screen', '--autoplay-policy=no-user-gesture-required',
  '--disable-features=WebRtcHideLocalIpsWithMdns'];

let app, dir, browser, blocked;
let tunnelInfo = { status: 'on', url: null, error: null, provider: 'ssh', providerName: 'teste' };
before(async () => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), 'tl-ux-'));
  const settings = new SettingsStore({ dir }).load();
  app = await startApp({ settings, iceProvider: new IceProvider({ settings }), getTunnelInfo: () => tunnelInfo });
  tunnelInfo.url = app.base;
  browser = await chromium.launch({ args: ARGS });
  blocked = await chromium.launch({ args: [...ARGS, '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
});
after(async () => { await browser?.close(); await blocked?.close(); await app?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

async function hostScreen() {
  const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  await page.goto(app.base + '/');
  await page.click('#btnScreen');
  await page.waitForSelector('#live:not(.hidden)');
  return { page, ctx, link: await page.inputValue('#shareLink'), pin: () => page.textContent('#pinView').then((t) => t.trim()) };
}
async function viewer(link, pin, b = browser) {
  const ctx = await b.newContext();
  const page = await ctx.newPage();
  await page.goto(link);
  await page.fill('#pin', pin);
  await page.click('#btnJoin');
  return { page, ctx };
}
const watching = (page) => page.waitForFunction(() => {
  const t = window.__telalink.transport;
  if (t === 'retransmissao') return window.__telalink.stats?.framesDecoded > 5;
  return t === 'direta' && document.getElementById('remote').videoWidth > 0;
}, null, { timeout: 30_000 });

describe('Experiencia de uso (navegador real)', { skip, timeout: 240_000 }, () => {
  test('QR code do convite: um leitor independente le exatamente o link', async () => {
    const h = await hostScreen();
    assert.ok(await h.page.isHidden('#qrBox'), 'fica escondido ate pedir');
    await h.page.click('#btnQr');
    const img = await h.page.evaluate(() => {
      const c = document.getElementById('qrCanvas');
      return { w: c.width, h: c.height, data: [...c.getContext('2d').getImageData(0, 0, c.width, c.height).data] };
    });
    const code = jsQR(Uint8ClampedArray.from(img.data), img.w, img.h);
    assert.ok(code, 'QR legivel');
    assert.equal(code.data, h.link, 'o QR abre o mesmo link do convite (com a chave depois do #)');
    assert.equal(await h.page.getAttribute('#btnQr', 'aria-expanded'), 'true');
    await h.ctx.close();
  });

  test('PIN errado avisa quem transmite; "Novo PIN" troca, copia o convite e quem ja assiste continua', async () => {
    const h = await hostScreen();
    const pin1 = await h.pin();
    const v = await viewer(h.link, pin1);
    await watching(v.page);
    const intruso = await viewer(h.link, pin1 === '123456' ? '654321' : '123456');
    await intruso.page.waitForSelector('#gateMsg .msg.err');
    await h.page.waitForSelector('#pinAlert .msg.warn');
    assert.match(await h.page.textContent('#pinAlert'), /1 tentativa de PIN errada/);
    await h.page.click('#btnNewPin');
    await h.page.waitForFunction((old) => document.getElementById('pinView').textContent.trim() !== old, pin1);
    const pin2 = await h.pin();
    assert.match(pin2, /^\d{6}$/);
    assert.equal(await h.page.textContent('#pinAlert'), '', 'aviso some com o PIN novo');
    assert.ok((await h.page.evaluate(() => navigator.clipboard.readText())).includes(`PIN: ${pin2}`), 'convite copiado com o PIN novo');
    // PIN antigo nao entra mais; o novo entra; quem ja assistia continua.
    const late = await viewer(h.link, pin1);
    await late.page.waitForSelector('#gateMsg .msg.err');
    const ok = await viewer(h.link, pin2);
    await watching(ok.page);
    assert.equal(await v.page.evaluate(() => window.__telalink.transport), 'direta');
    for (const c of [v, intruso, late, ok, h]) await c.ctx.close();
  });

  test('relogio e titulo "ao vivo", aviso de quem entra e de link alterado', async () => {
    const h = await hostScreen();
    await h.page.waitForFunction(() => /^Ao vivo · 00:0\d$/.test(document.getElementById('liveTxt').textContent));
    const v = await viewer(h.link, await h.pin());
    await watching(v.page);
    await h.page.waitForFunction(() => document.title.startsWith('● Ao vivo (1)'), null, { timeout: 5000 });
    assert.match(await h.page.textContent('#toast'), /entrou/);
    // O servico de link troca o endereco: o painel avisa e atualiza link e QR.
    const old = tunnelInfo.url;
    tunnelInfo = { ...tunnelInfo, url: old.replace('127.0.0.1', 'localhost') };
    await h.page.evaluate(() => window.__telalink.refreshInfo());
    await h.page.waitForSelector('#linkAlert .msg.warn');
    assert.match(await h.page.textContent('#linkAlert'), /endereço do link mudou/);
    assert.ok((await h.page.inputValue('#shareLink')).startsWith(tunnelInfo.url));
    tunnelInfo = { ...tunnelInfo, url: old };
    await v.ctx.close(); await h.ctx.close();
  });

  test('quem assiste pela retransmissao reconecta sozinho se a conexao cair', async () => {
    const h = await hostScreen();
    const v = await viewer(h.link, await h.pin(), blocked);
    await watching(v.page);
    assert.equal(await v.page.evaluate(() => window.__telalink.transport), 'retransmissao');
    // Derruba a conexao do espectador no servidor (como uma queda de internet).
    for (const c of app.wss.clients) if (c.meta?.role === 'viewer') c.terminate();
    await v.page.waitForFunction(() => window.__telalink.reconnecting === true, null, { timeout: 5000 });
    assert.match(await v.page.textContent('#stageMsg'), /reconectando/);
    await v.page.waitForFunction(() => window.__telalink.reconnecting === false && window.__telalink.transport === 'retransmissao' && window.__telalink.stats?.framesDecoded > 5, null, { timeout: 30_000 });
    assert.ok(await v.page.isHidden('#stageMsg'));
    await v.ctx.close(); await h.ctx.close();
  });

  test('conexao direta: se so o servidor cair, a imagem continua', async () => {
    const h = await hostScreen();
    const v = await viewer(h.link, await h.pin());
    await watching(v.page);
    for (const c of app.wss.clients) if (c.meta?.role === 'viewer') c.terminate();
    await v.page.waitForSelector('#stageMsg:not(.hidden)');
    assert.match(await v.page.textContent('#stageMsg'), /imagem continua/);
    const t0 = await v.page.evaluate(() => document.getElementById('remote').currentTime);
    await v.page.waitForTimeout(1500);
    assert.ok(await v.page.evaluate(() => document.getElementById('remote').currentTime) > t0 + 0.5, 'video segue tocando');
    await v.ctx.close(); await h.ctx.close();
  });
});
