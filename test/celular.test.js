// =============================================================================
//  Quem assiste pelo CELULAR (emulacao de Android e iPhone, com toque):
//  um toque mostra os controles, outro esconde; dois toques = tela cheia;
//  botoes do tamanho do dedo; sem rolagem lateral; tela do PIN legivel.
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

let pw = null;
try { pw = createRequire(import.meta.url)('playwright'); } catch {}
const skip = !pw && 'Playwright nao instalado';
const ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  '--auto-select-desktop-capture-source=Entire screen', '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'];

let app, dir, browser;
before(async () => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), 'tl-cel-'));
  const settings = new SettingsStore({ dir }).load();
  app = await startApp({ settings, iceProvider: new IceProvider({ settings }), getTunnelInfo: () => ({ status: 'on', url: app.base, provider: 'ssh' }) });
  browser = await pw.chromium.launch({ args: ARGS });
});
after(async () => { await browser?.close(); await app?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

// Aparelho emulado no Chromium (tela, toque, celular), sem trocar de motor.
const device = (name) => { const { defaultBrowserType, ...d } = pw.devices[name]; return d; };

for (const name of ['Pixel 7', 'iPhone 13']) {
  describe(`Celular: ${name} (emulacao com toque)`, { skip, timeout: 180_000 }, () => {
    test('PIN legivel, controles do tamanho do dedo, toque mostra/esconde, dois toques = tela cheia', async () => {
      const hctx = await browser.newContext();
      const host = await hctx.newPage();
      await host.goto(app.base + '/'); await host.click('#btnScreen'); await host.waitForSelector('#live:not(.hidden)');
      const link = await host.inputValue('#shareLink'), pin = (await host.textContent('#pinView')).trim();

      const ctx = await browser.newContext({ ...device(name) });
      const p = await ctx.newPage();
      await p.goto(link);
      // Tela do PIN: fonte >= 16 px (o iPhone nao da zoom sozinho) e sem rolagem lateral.
      const fs = await p.$eval('#pin', (e) => parseFloat(getComputedStyle(e).fontSize));
      assert.ok(fs >= 16, `fonte do PIN ${fs}px`);
      assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'sem rolagem lateral');
      await p.fill('#pin', pin); await p.tap('#btnJoin');
      await p.waitForFunction(async () => (await window.__telalink.framesReceived()) > 5, null, { timeout: 30_000 });
      await p.waitForSelector('#stage.on');
      assert.equal((await p.evaluate(() => window.__telalink.bar())).touch, true, 'modo toque');

      // Botoes grandes (>= 44 px), so icones, volume pelos botoes do aparelho.
      const sizes = await p.$$eval('.bar .controls button:not(.hidden)', (bs) => bs.map((b) => { const r = b.getBoundingClientRect(); return [r.width, r.height]; }));
      for (const [w, h] of sizes) assert.ok(w >= 44 && h >= 44, `botao ${w}x${h}`);
      assert.equal(await p.$eval('#volume', (e) => getComputedStyle(e).display), 'none');
      assert.equal(await p.$eval('#btnFull .lbl', (e) => getComputedStyle(e).display), 'none');

      // Um toque mostra / outro esconde (os controles comecam visiveis por alguns segundos).
      const vis = () => p.evaluate(() => window.__telalink.bar().visible);
      const box = await p.$eval('#stage', (e) => { const r = e.getBoundingClientRect(); return { x: r.width / 2, y: r.height / 3 }; });
      const before0 = await vis();
      await p.touchscreen.tap(box.x, box.y); await p.waitForTimeout(450);
      const after1 = await vis();
      assert.notEqual(after1, before0, 'primeiro toque alterna');
      await p.touchscreen.tap(box.x, box.y); await p.waitForTimeout(450);
      assert.equal(await vis(), before0, 'segundo toque volta');
      // Tocar num botao NAO esconde os controles.
      if (!(await vis())) { await p.touchscreen.tap(box.x, box.y); await p.waitForTimeout(450); }
      await p.tap('#btnFit'); await p.waitForTimeout(450);
      assert.equal(await vis(), true, 'toque num botao mantem os controles');
      // Dois toques rapidos: tela cheia.
      await p.touchscreen.tap(box.x, box.y); await p.waitForTimeout(80); await p.touchscreen.tap(box.x, box.y);
      await p.waitForFunction(() => !!(document.fullscreenElement || document.getElementById('stage').classList.contains('pseudo-full')), null, { timeout: 3000 });
      await ctx.close(); await hctx.close();
    });
  });
}
