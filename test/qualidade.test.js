// =============================================================================
//  Qualidade da imagem com navegador real (Chromium via Playwright).
//  Mede a RESOLUCAO QUE CHEGA a quem assiste, nos dois caminhos:
//   - direta: 1080p desde o inicio (antes ficava ~15 s em 360p), troca de
//     qualidade sem encolher duas vezes, limite de banda do usuario;
//   - retransmissao: cada codec (H.264, VP9, VP8) codifica e o outro lado
//     decodifica; banda adaptativa reduz a resolucao quando a fila enche.
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
  dir = mkdtempSync(join(tmpdir(), 'tl-q-'));
  const settings = new SettingsStore({ dir }).load();
  app = await startApp({ settings, iceProvider: new IceProvider({ settings }), getTunnelInfo: () => ({ status: 'on', url: app.base, error: null, providerName: 'teste' }) });
  browser = await chromium.launch({ args: ARGS });
});
after(async () => { await browser?.close(); await app?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

async function hostScreen() {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(app.base + '/');
  await page.click('#btnScreen');
  await page.waitForSelector('#live:not(.hidden)');
  return { page, ctx, link: await page.inputValue('#shareLink'), pin: (await page.textContent('#pinView')).trim() };
}
async function viewer(link, pin) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(link);
  await page.fill('#pin', pin);
  await page.click('#btnJoin');
  await page.waitForFunction(() => window.__telalink.transport === 'direta' && document.getElementById('remote').videoWidth > 0, null, { timeout: 30_000 });
  return { page, ctx };
}
const sending = (h) => h.page.evaluate(() => window.__telalink.sending());
const sourceHeight = (h) => h.page.evaluate(() => document.getElementById('preview').srcObject.getVideoTracks()[0].getSettings().height);

describe('Qualidade da imagem (navegador real)', { skip, timeout: 240_000 }, () => {
  test('conexao direta: quem assiste recebe a resolucao cheia em poucos segundos (nao 360p)', async () => {
    const h = await hostScreen();
    const src = await sourceHeight(h);
    assert.ok(src >= 720, `tela de teste deveria ter ao menos 720p (${src})`);
    const t0 = Date.now();
    const v = await viewer(h.link, h.pin);
    await v.page.waitForFunction((src) => document.getElementById('remote').videoHeight >= src, src, { timeout: 8_000 });
    const s = (await sending(h))[0];
    assert.equal(s.maxBitrate, 8_000_000, 'teto de banda do automatico');
    assert.equal(s.degradation, 'balanced');
    // O indicador mostra a resolucao para quem assiste e para quem transmite.
    await v.page.waitForFunction((src) => document.getElementById('qualityTxt').textContent.includes(`${src}p`), src, { timeout: 6_000 });
    const m = (await h.page.evaluate(() => window.__telalink.measure()))[0];
    assert.equal(m.height, src);
    assert.match(m.codec, /VP9|H264|VP8|AV1/);
    await h.page.waitForFunction((src) => document.querySelector('#viewerList [data-q]')?.textContent.includes(`${src}p`), src, { timeout: 6_000 });
    console.log(`      resolucao cheia (${src}p) em ${Date.now() - t0} ms, codec ${m.codec}`);
    await v.ctx.close(); await h.ctx.close();
  });

  test('trocar para Media (720p) entrega 720p exatos — sem encolher duas vezes', async () => {
    const h = await hostScreen();
    const v = await viewer(h.link, h.pin);
    await h.page.selectOption('#liveQuality', 'media');
    await h.page.waitForFunction(async () => { const s = await window.__telalink.sending(); return s[0]?.trackHeight <= 720; }, null, { timeout: 10_000 });
    const s = (await sending(h))[0];
    assert.equal(s.height, 720, `altura enviada ${JSON.stringify(s)}`);
    assert.equal(s.maxBitrate, 4_000_000);
    assert.equal(s.degradation, 'maintain-resolution');
    const seen = [];
    const end = Date.now() + 15_000;
    while (Date.now() < end) {
      const vh = await v.page.evaluate(() => document.getElementById('remote').videoHeight);
      seen.push(vh); if (vh === 720) break;
      await v.page.waitForTimeout(500);
    }
    assert.equal(seen.at(-1), 720, `quem assiste recebeu: ${[...new Set(seen)].join(', ')} | envio ${JSON.stringify(await sending(h))}`);
    await v.ctx.close(); await h.ctx.close();
  });

  test('Maxima (original) e limite de internet escolhido nas configuracoes', async () => {
    const h = await hostScreen();
    const v = await viewer(h.link, h.pin);
    await h.page.selectOption('#liveQuality', 'original');
    await h.page.waitForFunction(async () => (await window.__telalink.sending())[0]?.maxBitrate === 25_000_000, null, { timeout: 10_000 });
    await h.page.click('#btnSettings');
    await h.page.selectOption('#optBitrate', '2');
    await h.page.click('#btnSaveSettings');
    await h.page.waitForFunction(async () => (await window.__telalink.sending())[0]?.maxBitrate === 2_000_000, null, { timeout: 10_000 });
    assert.equal((await h.page.evaluate(() => window.__telalink.state)).bitrate, 2);
    // Guardado no PC para a proxima vez.
    const info = await (await fetch(app.base + '/api/info')).json();
    assert.equal(info.prefs.bitrate, 2);
    await h.page.click('#btnSettings');
    await h.page.selectOption('#optBitrate', '0');
    await h.page.click('#btnSaveSettings');
    await v.ctx.close(); await h.ctx.close();
  });

  test('retransmissao: cada codec disponivel codifica e o outro lado decodifica em 1080p', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(app.base + '/');
    const results = await page.evaluate(async () => {
      const { RelaySender, RelayReceiver, RELAY_CODECS } = await import('/relay.js');
      const { deriveKeys, generateSessionKey } = await import('/crypto.js');
      const keys = await deriveKeys(generateSessionKey(), 'sala');
      const out = [];
      for (const c of RELAY_CODECS) {
        // Sem placa de video na maquina de teste: testa o mesmo codec em software.
        const codec = { ...c, hardwareAcceleration: 'no-preference' };
        const sup = await VideoEncoder.isConfigSupported({ codec: codec.codec, ...(codec.avc ? { avc: codec.avc } : {}), width: 1920, height: 1080, bitrate: 8e6, framerate: 30 }).catch(() => ({ supported: false }));
        if (!sup.supported) { out.push({ label: c.label, skipped: true }); continue; }
        const canvas = document.createElement('canvas'); canvas.width = 1920; canvas.height = 1080;
        const g = canvas.getContext('2d'); let n = 0;
        const timer = setInterval(() => { g.fillStyle = `hsl(${(n++ * 7) % 360} 70% 50%)`; g.fillRect(0, 0, 1920, 1080); g.fillStyle = '#fff'; g.fillRect((n * 20) % 1800, 500, 120, 80); }, 33);
        const stream = canvas.captureStream(30);
        const outCanvas = document.createElement('canvas');
        let receiver;
        const ws = { readyState: 1, bufferedAmount: 0, send: (p) => receiver.handle(p), json: () => {} };
        receiver = new RelayReceiver({ mediaKey: keys.media, canvas: outCanvas, ws, onError: (e) => out.push({ label: c.label, error: String(e) }) });
        const errors = [];
        const sender = new RelaySender({ stream, mediaKey: keys.media, ws, codec, bitrate: 8e6, maxH: 1080, fps: 30, onError: (e) => errors.push(String(e)) });
        sender.start();
        await new Promise((r) => setTimeout(r, 2500));
        sender.stop(); clearInterval(timer); receiver.close();
        out.push({ label: c.label, decoded: receiver.stats.framesDecoded, w: outCanvas.width, h: outCanvas.height, used: sender.codec.label, errors });
      }
      return out;
    });
    console.log('      ', JSON.stringify(results));
    const ok = results.filter((r) => !r.skipped);
    assert.ok(ok.some((r) => r.label === 'VP8'), 'VP8 sempre disponivel');
    for (const r of ok) {
      assert.deepEqual(r.errors, [], `${r.label}: sem erros`);
      assert.equal(r.used, r.label, `${r.label}: usou o codec pedido`);
      assert.ok(r.decoded > 20, `${r.label}: quadros decodificados (${r.decoded})`);
      assert.equal(r.h, 1080, `${r.label}: chegou em 1080p`);
    }
    await ctx.close();
  });

  test('retransmissao: internet lenta reduz banda e resolucao; quando melhora, volta a subir', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(app.base + '/');
    const r = await page.evaluate(async () => {
      const { RelaySender, RELAY_CODECS } = await import('/relay.js');
      const { deriveKeys, generateSessionKey } = await import('/crypto.js');
      const keys = await deriveKeys(generateSessionKey(), 'sala');
      const canvas = document.createElement('canvas'); canvas.width = 1920; canvas.height = 1080;
      const g = canvas.getContext('2d'); let n = 0;
      const timer = setInterval(() => { g.fillStyle = `hsl(${n++ % 360} 70% 50%)`; g.fillRect(0, 0, 1920, 1080); }, 33);
      const ws = { readyState: 1, bufferedAmount: 3_000_000, send: () => {}, json: () => {} };
      const s = new RelaySender({ stream: canvas.captureStream(30), mediaKey: keys.media, ws, codec: RELAY_CODECS[2], bitrate: 8e6, maxH: 1080, fps: 30, autoRes: true });
      s.start();
      await new Promise((res) => setTimeout(res, 4500));
      const slow = s.quality(); const slowBps = s.bitrate;
      ws.bufferedAmount = 0;
      await new Promise((res) => setTimeout(res, 6000));
      const fast = s.quality(); const fastBps = s.bitrate;
      s.stop(); clearInterval(timer);
      return { slow, slowBps, fast, fastBps };
    });
    console.log('      ', JSON.stringify({ lenta: [r.slow.height, r.slowBps], depois: [r.fast.height, r.fastBps] }));
    assert.ok(r.slowBps < 3e6, `banda reduzida (${r.slowBps})`);
    assert.ok(r.slow.height < 1080, `resolucao reduzida (${r.slow.height})`);
    assert.equal(r.slow.limit, 'bandwidth');
    assert.ok(r.fastBps > r.slowBps * 1.4, `banda voltou a subir (${r.fastBps})`);
    await ctx.close();
  });
});
