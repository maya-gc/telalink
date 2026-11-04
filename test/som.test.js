// =============================================================================
//  Som da transmissao (navegador real):
//  - pede ao navegador o som SO da janela escolhida (windowAudio: "window",
//    Chrome/Edge 141+), o som do sistema na tela inteira e SEM os sons do
//    proprio TelaLink (restrictOwnAudio);
//  - "Somar tambem": microfone/dispositivo chega a quem assiste, com botao
//    para ligar/desligar ao vivo (medido no SOM RECEBIDO);
//  - lista os dispositivos de som do computador.
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

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch {}
const skip = !chromium && 'Playwright nao instalado';
const ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  '--auto-select-desktop-capture-source=Entire screen', '--autoplay-policy=no-user-gesture-required',
  '--disable-features=WebRtcHideLocalIpsWithMdns'];

let app, dir, browser;
before(async () => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), 'tl-som-'));
  const settings = new SettingsStore({ dir }).load();
  app = await startApp({ settings, iceProvider: new IceProvider({ settings }), getTunnelInfo: () => ({ status: 'on', url: app.base, provider: 'ssh' }) });
  browser = await chromium.launch({ args: ARGS });
});
after(async () => { await browser?.close(); await app?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

async function host(setup) {
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  await ctx.addInitScript(() => {             // registra o que foi pedido ao navegador
    const orig = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getDisplayMedia = (o) => { window.__pedido = JSON.parse(JSON.stringify(o)); return orig(o); };
  });
  const page = await ctx.newPage();
  await page.goto(app.base + '/');
  await page.waitForFunction(() => document.getElementById('summary').textContent.length > 3);
  await page.click('#btnSettings');
  await setup?.(page);
  await page.click('#btnSaveSettings');
  await page.click('#btnScreen');
  await page.waitForSelector('#live:not(.hidden)');
  return { page, ctx, link: await page.inputValue('#shareLink'), pin: (await page.textContent('#pinView')).trim() };
}
async function viewer(link, pin) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(link); await page.fill('#pin', pin); await page.click('#btnJoin');
  await page.waitForFunction(() => window.__telalink.transport === 'direta' && document.getElementById('remote').videoWidth > 0, null, { timeout: 30_000 });
  return { page, ctx };
}
// Pico do som recebido por quem assiste.
const level = (page, ms = 2500) => page.evaluate(async (ms) => {
  const v = document.getElementById('remote');
  const ctx = window.__nivel ||= new AudioContext();
  const an = window.__an ||= (() => { const a = ctx.createAnalyser(); a.fftSize = 2048; ctx.createMediaStreamSource(v.srcObject).connect(a); return a; })();
  await ctx.resume();
  const buf = new Float32Array(an.fftSize); let peak = 0; const end = performance.now() + ms;
  while (performance.now() < end) { an.getFloatTimeDomainData(buf); for (const x of buf) peak = Math.max(peak, Math.abs(x)); await new Promise((r) => setTimeout(r, 20)); }
  return peak;
}, ms);

describe('Som da transmissao (navegador real)', { skip, timeout: 240_000 }, () => {
  test('pede o som SO da janela escolhida, o do sistema na tela inteira e sem os sons do proprio TelaLink', async () => {
    const h = await host();
    const p = await h.page.evaluate(() => window.__pedido);
    assert.equal(p.windowAudio, 'window', 'janela: so o som daquele programa (Chrome/Edge 141+)');
    assert.equal(p.systemAudio, 'include', 'tela inteira: som do computador');
    assert.equal(p.audio.restrictOwnAudio, true, 'sem o aviso sonoro do proprio painel');
    assert.equal(p.audio.suppressLocalAudioPlayback, false, 'voce continua ouvindo no seu PC');
    await h.ctx.close();
    // Som desligado: nao pede som de nenhum tipo.
    const h2 = await host((pg) => pg.uncheck('#optAudio'));
    const p2 = await h2.page.evaluate(() => window.__pedido);
    assert.equal(p2.audio, false); assert.equal(p2.windowAudio, 'exclude'); assert.equal(p2.systemAudio, 'exclude');
    await h2.ctx.close();
  });

  test('"Somar tambem: microfone" chega a quem assiste e o botao liga/desliga ao vivo', async () => {
    // Sem som da tela: o unico som que pode chegar e o do microfone somado.
    const h = await host(async (pg) => { await pg.uncheck('#optAudio'); await pg.selectOption('#optExtra', 'mic'); });
    await h.page.waitForSelector('#btnExtra:not(.hidden)');
    assert.match(await h.page.textContent('#btnExtra'), /Microfone ligado/);
    const v = await viewer(h.link, h.pin);
    const on = await level(v.page);
    assert.ok(on > 0.02, `microfone deveria chegar (${on})`);
    await h.page.click('#btnExtra');
    assert.match(await h.page.textContent('#btnExtra'), /Microfone desligado/);
    await v.page.waitForTimeout(500);
    const off = await level(v.page);
    assert.ok(off < on / 10, `desligado nao deveria chegar (${off} vs ${on})`);
    await v.ctx.close(); await h.ctx.close();
  });

  test('lista os dispositivos de som do computador para escolher', async () => {
    const ctx = await browser.newContext({ permissions: ['microphone'] });
    const page = await ctx.newPage();
    await page.goto(app.base + '/');
    await page.click('#btnSettings');
    await page.click('#btnListDevices');
    await page.waitForFunction(() => /dispositivo/.test(document.getElementById('settingsMsg').textContent));
    const opts = await page.$$eval('#optExtra option', (os) => os.map((o) => [o.value.slice(0, 4), o.textContent]));
    assert.ok(opts.some(([v]) => v === 'dev:'), `dispositivos listados: ${JSON.stringify(opts)}`);
    await ctx.close();
  });
});
