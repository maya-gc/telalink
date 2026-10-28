// =============================================================================
//  Controles da transmissao com navegador real (Chromium via Playwright):
//  fluxo de 3 cliques, volume/mudo medidos no AUDIO RECEBIDO, qualidade medida
//  na RESOLUCAO RECEBIDA, imagens conferidas pela COR dos pixels, pausa nos dois
//  caminhos (direto e retransmissao), trancar sala, remover espectador,
//  controles de quem assiste e janela de configuracoes.
// =============================================================================
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
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

// ---------- PNG de cor solida (para conferir pixels do outro lado)
function crc32(buf) {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}
function png(w, h, [r, g, b]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).map((_, i) => [r, g, b][i % 3])]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const RED = png(640, 360, [220, 30, 30]);
const GREEN = png(640, 360, [30, 200, 60]);

let app, dir, browser, blocked;
before(async () => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), 'tl-ctl-'));
  const settings = new SettingsStore({ dir }).load();
  app = await startApp({ settings, iceProvider: new IceProvider({ settings }), getTunnelInfo: () => ({ status: 'on', url: app.base, error: null, providerName: 'teste' }) });
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
  return { page, ctx, link: await page.inputValue('#shareLink'), pin: (await page.textContent('#pinView')).trim() };
}
async function hostImages(files) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(app.base + '/');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#btnImages')]);
  await chooser.setFiles(files.map((buffer, i) => ({ name: `img${i}.png`, mimeType: 'image/png', buffer })));
  await page.waitForSelector('#live:not(.hidden)');
  return { page, ctx, link: await page.inputValue('#shareLink'), pin: (await page.textContent('#pinView')).trim() };
}
async function viewer(link, pin, b = browser) {
  const ctx = await b.newContext();
  const page = await ctx.newPage();
  await page.goto(link);
  await page.fill('#pin', pin);
  await page.click('#btnJoin');
  await page.waitForFunction(() => {
    const t = window.__telalink.transport;
    if (t === 'retransmissao') return window.__telalink.stats?.framesDecoded > 5;
    const v = document.getElementById('remote');
    return t === 'direta' && v.videoWidth > 0 && v.currentTime > 0.3;
  }, null, { timeout: 30_000 });
  return { page, ctx };
}

// Cor media de um ponto da imagem que quem assiste esta vendo (video ou canvas).
const centerColor = (page) => page.evaluate(() => {
  const relay = window.__telalink.transport === 'retransmissao';
  const src = relay ? document.getElementById('relayCanvas') : document.getElementById('remote');
  const w = relay ? src.width : src.videoWidth, h = relay ? src.height : src.videoHeight;
  const c = document.createElement('canvas'); c.width = 40; c.height = 40;
  // Amostra a 1/4 da largura e altura: fora do texto do cartao de pausa.
  c.getContext('2d').drawImage(src, w / 4 - 20, h / 4 - 20, 40, 40, 0, 0, 40, 40);
  const d = c.getContext('2d').getImageData(0, 0, 40, 40).data;
  let r = 0, g = 0, b = 0; for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
  const n = d.length / 4; return [r / n, g / n, b / n];
});
const near = (c, target, tol = 45) => c.every((v, i) => Math.abs(v - target[i]) <= tol);
async function waitColor(page, target, ms = 15_000) {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { last = await centerColor(page); if (near(last, target)) return last; await page.waitForTimeout(250); }
  assert.fail(`cor esperada ${target}, recebida ${last?.map(Math.round)}`);
}

// Nivel do som RECEBIDO (pico) por quem assiste numa conexao direta.
// Pico, e nao media: o audio de teste e feito de bipes, e a media dependeria
// de quantos bipes caem na janela de medicao.
const audioLevel = (page, ms = 2500) => page.evaluate(async (ms) => {
  const v = document.getElementById('remote');
  const ctx = window.__nivel ||= new AudioContext();
  const an = window.__an ||= (() => { const a = ctx.createAnalyser(); a.fftSize = 2048; ctx.createMediaStreamSource(v.srcObject).connect(a); return a; })();
  await ctx.resume();
  const buf = new Float32Array(an.fftSize); let peak = 0; const end = performance.now() + ms;
  while (performance.now() < end) { an.getFloatTimeDomainData(buf); for (const x of buf) peak = Math.max(peak, Math.abs(x)); await new Promise((r) => setTimeout(r, 20)); }
  return peak;
}, ms);

const PAUSED = [26, 31, 43];

describe('Controles da transmissao (navegador real)', { skip, timeout: 240_000 }, () => {
  test('3 cliques: abrir, "Minha tela", escolher — e o convite ja esta copiado', async () => {
    const h = await hostScreen();            // clique 2 (o 1 e abrir; o 3 e a escolha, automatica no teste)
    const clip = await h.page.evaluate(() => navigator.clipboard.readText());
    assert.match(clip, /Assista minha tela pelo TelaLink/);
    assert.ok(clip.includes(h.link), 'convite contem o link');
    assert.ok(clip.includes(`PIN: ${h.pin}`), 'convite contem o PIN');
    assert.match(await h.page.textContent('#toast'), /Convite copiado/);
    await h.ctx.close();
  });

  test('volume: 100% chega, mudo zera, 50% chega pela metade, 200% amplifica (medido no som recebido)', async () => {
    const h = await hostScreen();
    const v = await viewer(h.link, h.pin);
    const setVol = async (n) => { await h.page.fill('#volume', String(n)); await h.page.dispatchEvent('#volume', 'input'); await v.page.waitForTimeout(800); };
    const normal = await audioLevel(v.page);
    assert.ok(normal > 0.05, `som deveria chegar (${normal})`);
    await h.page.click('#btnMute');
    await v.page.waitForTimeout(500);
    const mudo = await audioLevel(v.page);
    assert.ok(mudo < normal / 10, `mudo deveria zerar (${mudo} vs ${normal})`);
    await h.page.click('#btnMute');
    await setVol(50);
    const metade = await audioLevel(v.page);
    assert.ok(metade > normal * 0.3 && metade < normal * 0.7, `50% deveria chegar pela metade (${metade} vs ${normal})`);
    // O som de teste ja e de volume maximo; em 200% ele satura, entao so pode
    // ficar igual ou acima de 100% (o ganho de 2x em si e verificado em media.test.js).
    await setVol(200);
    const alto = await audioLevel(v.page);
    assert.ok(alto >= normal * 0.95, `200% nao pode ficar mais baixo (${alto} vs ${normal})`);
    assert.equal(await h.page.textContent('#volumeTxt'), '200%');
    await v.ctx.close(); await h.ctx.close();
  });

  test('qualidade "Economica" durante a transmissao: quem assiste recebe no maximo 480p', async () => {
    const h = await hostScreen();
    const v = await viewer(h.link, h.pin);
    // O WebRTC comeca baixo e sobe conforme mede a internet: espera passar de 480p.
    await v.page.waitForFunction(() => document.getElementById('remote').videoHeight > 480, null, { timeout: 20_000 });
    await h.page.selectOption('#liveQuality', 'economica');
    await v.page.waitForFunction(() => { const x = document.getElementById('remote'); return x.videoHeight > 0 && x.videoHeight <= 480; }, null, { timeout: 20_000 });
    await v.ctx.close(); await h.ctx.close();
  });

  test('pausar mostra o cartao "Transmissao pausada" e retomar volta a tela (conexao direta)', async () => {
    const h = await hostScreen();
    const v = await viewer(h.link, h.pin);
    await h.page.click('#btnPause');
    await waitColor(v.page, PAUSED);
    assert.match(await h.page.textContent('#liveTxt'), /Pausado/);
    await h.page.click('#btnPause');
    const end = Date.now() + 15_000; let c;
    while (Date.now() < end) { c = await centerColor(v.page); if (!near(c, PAUSED, 12)) break; await v.page.waitForTimeout(250); }
    assert.ok(!near(c, PAUSED, 12), 'deveria ter voltado a tela');
    await v.ctx.close(); await h.ctx.close();
  });

  test('imagens: quem assiste ve a cor certa e "Proxima" troca a imagem (conexao direta)', async () => {
    const h = await hostImages([RED, GREEN]);
    const v = await viewer(h.link, h.pin);
    await waitColor(v.page, [220, 30, 30]);
    assert.equal(await h.page.textContent('#imgPos'), '1 de 2');
    await h.page.click('#imgNext');
    await waitColor(v.page, [30, 200, 60]);
    assert.equal(await h.page.textContent('#imgPos'), '2 de 2');
    await v.ctx.close(); await h.ctx.close();
  });

  test('imagens e pausa pela RETRANSMISSAO (rede sem WebRTC): troca de fonte sem desconectar', async () => {
    const h = await hostImages([RED]);
    const v = await viewer(h.link, h.pin, blocked);
    assert.equal(await v.page.evaluate(() => window.__telalink.transport), 'retransmissao');
    await waitColor(v.page, [220, 30, 30]);
    await h.page.click('#btnPause');
    await waitColor(v.page, PAUSED);
    await h.page.click('#btnPause');
    await waitColor(v.page, [220, 30, 30]);
    assert.equal((await v.page.evaluate(() => window.__telalink.stats)).rejected, 0);
    await v.ctx.close(); await h.ctx.close();
  });

  test('trancar a sala: quem chega depois ve o aviso; quem ja estava continua', async () => {
    const h = await hostScreen();
    const a = await viewer(h.link, h.pin);
    await h.page.click('#btnLock');
    await h.page.waitForFunction(() => /trancada/.test(document.getElementById('btnLock').textContent));
    const late = await (await browser.newContext()).newPage();
    await late.goto(h.link); await late.fill('#pin', h.pin); await late.click('#btnJoin');
    await late.waitForFunction(() => /trancada/.test(document.getElementById('gateMsg').textContent));
    assert.equal(await a.page.evaluate(() => window.__telalink.transport), 'direta');
    await a.ctx.close(); await h.ctx.close();
  });

  test('remover espectador: a pessoa e desconectada e avisada', async () => {
    const h = await hostScreen();
    const v = await viewer(h.link, h.pin);
    await h.page.waitForSelector('#viewerList button[data-viewer]');
    await h.page.click('#viewerList button[data-viewer]');
    await v.page.waitForFunction(() => /removido/.test(document.getElementById('gateMsg').textContent));
    await h.page.waitForFunction(() => document.getElementById('viewerCount').textContent === '0');
    await v.ctx.close(); await h.ctx.close();
  });

  test('quem assiste: volume, mudo e ajuste da imagem funcionam e sao lembrados', async () => {
    const h = await hostScreen();
    const v = await viewer(h.link, h.pin);
    await v.page.fill('#volume', '40'); await v.page.dispatchEvent('#volume', 'input');
    assert.equal(await v.page.evaluate(() => document.getElementById('remote').volume), 0.4);
    await v.page.click('#btnMute');
    assert.equal(await v.page.evaluate(() => document.getElementById('remote').muted), true);
    await v.page.click('#btnFit');
    assert.equal(await v.page.evaluate(() => document.getElementById('stage').classList.contains('fit-cover')), true);
    await v.page.click('#btnFit');
    assert.equal(await v.page.evaluate(() => document.getElementById('stage').classList.contains('fit-real')), true);
    // Recarrega: volume e ajuste continuam (preferencia deste navegador).
    await v.page.reload();
    assert.equal(await v.page.evaluate(() => window.__telalink.view.volume), 40);
    assert.equal(await v.page.evaluate(() => window.__telalink.view.fit), 'real');
    await v.ctx.close(); await h.ctx.close();
  });

  test('configuracoes: escolhas salvas neste PC e aplicadas (qualidade, quadros, som, link externo)', async () => {
    const page = await (await browser.newContext()).newPage();
    await page.goto(app.base + '/');
    await page.click('#btnSettings');
    assert.equal(await page.isVisible('#settings'), true);
    await page.selectOption('#optQuality', 'media');
    await page.selectOption('#optFps', '15');
    await page.uncheck('#optAudio');
    await page.selectOption('#optTunnel', 'off');
    await page.click('#btnSaveSettings');
    assert.equal(await page.isVisible('#settings'), false);
    assert.match(await page.textContent('#summary'), /média.*15 quadros.*Som desligado/i);
    await page.waitForTimeout(300); // salvar segue em segundo plano
    const saved = await (await fetch(`${app.base}/api/settings`)).json();
    assert.deepEqual({ q: saved.prefs.quality, f: saved.prefs.fps, a: saved.prefs.audio, t: saved.tunnel }, { q: 'media', f: 15, a: false, t: 'off' });
    // Uma nova aba ja abre com as escolhas salvas.
    const again = await (await browser.newContext()).newPage();
    await again.goto(app.base + '/');
    await again.waitForFunction(() => /média/i.test(document.getElementById('summary').textContent));
    // Volta ao padrao para nao afetar os outros testes.
    await fetch(`${app.base}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prefs: { quality: 'auto', fps: 30, audio: true }, tunnel: 'auto' }) });
  });
});
