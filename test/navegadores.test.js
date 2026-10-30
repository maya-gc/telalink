// =============================================================================
//  Compatibilidade entre navegadores (roda no GitHub Actions, workflow
//  "navegadores"; localmente so se TELALINK_BROWSERS estiver definido).
//  Ex.: TELALINK_BROWSERS=firefox,webkit,msedge,chrome,brave
//   - QUEM ASSISTE em cada navegador: pela conexao direta e pela retransmissao
//     (modo Maxima seguranca), conferindo que os quadros continuam chegando;
//   - QUEM TRANSMITE em cada navegador (quando o navegador permite automatizar
//     a escolha de tela), com alguem assistindo no Chromium.
//  O Safari "de verdade" (macOS) e testado por scripts/safari-real.mjs.
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

const LIST = (process.env.TELALINK_BROWSERS || '').split(',').map((s) => s.trim()).filter(Boolean);
let pw = null;
try { pw = createRequire(import.meta.url)('playwright'); } catch {}
const skip = (!LIST.length && 'defina TELALINK_BROWSERS (roda no workflow "navegadores")') || (!pw && 'Playwright nao instalado');

const ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  '--auto-select-desktop-capture-source=Entire screen', '--autoplay-policy=no-user-gesture-required',
  '--disable-features=WebRtcHideLocalIpsWithMdns'];
const FIREFOX_PREFS = {
  'media.navigator.permission.disabled': true, 'media.navigator.streams.fake': true,
  'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0, 'media.peerconnection.ice.obfuscate_host_addresses': false,
};
function launch(name) {
  switch (name) {
    case 'firefox': return pw.firefox.launch({ firefoxUserPrefs: FIREFOX_PREFS });
    case 'webkit': return pw.webkit.launch();
    case 'chromium': return pw.chromium.launch({ args: ARGS });
    case 'msedge': return pw.chromium.launch({ channel: 'msedge', args: ARGS });
    case 'chrome': return pw.chromium.launch({ channel: 'chrome', args: ARGS });
    case 'brave': return pw.chromium.launch({ executablePath: process.env.BRAVE_PATH, args: ARGS });
    default: throw new Error(`navegador desconhecido: ${name}`);
  }
}
const CHROMIUM_LIKE = new Set(['msedge', 'chrome', 'brave', 'chromium']);

let app, dir, settings, chromium;
before(async () => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), 'tl-nav-'));
  settings = new SettingsStore({ dir }).load();
  app = await startApp({ settings, iceProvider: new IceProvider({ settings }), getTunnelInfo: () => ({ status: 'on', url: app.base, provider: 'ssh' }) });
  chromium = await pw.chromium.launch({ args: ARGS });
});
after(async () => { await chromium?.close(); await app?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

async function startHost(browser, { policy = 'auto' } = {}) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`      [host erro] ${e.message}`));
  await page.goto(app.base + '/');
  await page.waitForFunction(() => window.__telalink && document.getElementById('summary').textContent.length > 3);
  // Sempre define o modo (as configuracoes ficam salvas entre os testes).
  await page.click('#btnSettings');
  await page.check(`input[name=policy][value=${policy}]`);
  await page.click('#btnSaveSettings');
  await page.click('#btnScreen');
  await page.waitForSelector('#live:not(.hidden)', { timeout: 20_000 });
  return { page, ctx, link: await page.inputValue('#shareLink'), pin: (await page.textContent('#pinView')).trim() };
}
async function watch(browser, link, pin) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`      [espectador erro] ${e.message}`));
  await page.goto(link);
  await page.fill('#pin', pin);
  await page.click('#btnJoin');
  await page.waitForFunction(() => {
    const t = window.__telalink.transport;
    if (t === 'retransmissao') return window.__telalink.stats?.framesDecoded > 3;
    const v = document.getElementById('remote');
    return (t === 'direta' || t === 'turn') && v.videoWidth > 0;
  }, null, { timeout: 45_000 });
  return { page, ctx };
}
const frames = (p) => p.evaluate(() => (window.__telalink.transport === 'retransmissao'
  ? window.__telalink.stats.framesDecoded
  : (document.getElementById('remote').getVideoPlaybackQuality?.().totalVideoFrames ?? Math.round(document.getElementById('remote').currentTime * 30))));
async function flowing(p) {
  const a = await frames(p);
  await p.waitForTimeout(3000);
  const b = await frames(p);
  assert.ok(b > a + 3, `imagem parada (${a} -> ${b})`);
  return p.evaluate(() => ({ transport: window.__telalink.transport, height: document.getElementById(window.__telalink.transport === 'retransmissao' ? 'relayCanvas' : 'remote')[window.__telalink.transport === 'retransmissao' ? 'height' : 'videoHeight'] }));
}

describe('Compatibilidade entre navegadores', { skip, timeout: 600_000 }, () => {
  for (const name of LIST) {
    test(`${name}: quem assiste, conexao direta`, async () => {
      const b = await launch(name);
      try {
        const h = await startHost(chromium);
        const v = await watch(b, h.link, h.pin);
        const r = await flowing(v.page);
        console.log(`::notice::${name} assistindo (modo padrao): ${r.transport} ${r.height}p`);
        if (name !== 'webkit') assert.equal(r.transport, 'direta', 'conexao direta funciona');
        await v.ctx.close(); await h.ctx.close();
      } finally { await b.close(); }
    });

    test(`${name}: quem assiste, retransmissao (Maxima seguranca)`, async () => {
      const b = await launch(name);
      try {
        const h = await startHost(chromium, { policy: 'relay' });
        const v = await watch(b, h.link, h.pin);
        const r = await flowing(v.page);
        assert.equal(r.transport, 'retransmissao');
        console.log(`::notice::${name} assistindo pela retransmissao: ${r.height}p, codec ${await h.page.evaluate(() => window.__telalink.relayCodec())}`);
        await v.ctx.close(); await h.ctx.close();
      } finally { await b.close(); }
    });

    test(`${name}: quem transmite`, async (t) => {
      const b = await launch(name);
      try {
        let h;
        try { h = await startHost(b); }
        catch (err) {
          if (CHROMIUM_LIKE.has(name)) throw err;
          console.log(`::notice::${name} transmitindo: nao da para automatizar a escolha de tela neste navegador (${err.message.split('\n')[0]})`);
          return t.skip('escolha de tela nao automatizavel');
        }
        const v = await watch(chromium, h.link, h.pin);
        const r = await flowing(v.page);
        console.log(`::notice::${name} transmitindo -> Chromium: ${r.transport} ${r.height}p`);
        await v.ctx.close(); await h.ctx.close();
      } finally { await b.close(); }
    });
  }
});
