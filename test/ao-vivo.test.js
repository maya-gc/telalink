// =============================================================================
//  Configuracoes salvas DURANTE a transmissao (navegador real):
//  nada e interrompido, as mudancas valem nos dois lados (quem transmite e
//  quem assiste), e a transmissao nunca fecha sozinha.
//  Regressao do bug: escolher "Maxima (original)" ao vivo congelava a imagem.
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

let app, dir, settings, browser, blocked;
before(async () => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), 'tl-live-'));
  settings = new SettingsStore({ dir }).load();
  app = await startApp({ settings, iceProvider: new IceProvider({ settings }), getTunnelInfo: () => ({ status: 'on', url: app.base, provider: 'ssh' }) });
  browser = await chromium.launch({ args: ARGS });
  blocked = await chromium.launch({ args: [...ARGS, '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
});
after(async () => { await browser?.close(); await blocked?.close(); await app?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

async function setup() {
  const hctx = await browser.newContext();
  const host = await hctx.newPage();
  await host.goto(app.base + '/');
  await host.click('#btnScreen');
  await host.waitForSelector('#live:not(.hidden)');
  const link = await host.inputValue('#shareLink');
  const pin = (await host.textContent('#pinView')).trim();
  const vs = [];
  for (const b of [browser, blocked]) {
    const ctx = await b.newContext();
    const page = await ctx.newPage();
    await page.goto(link); await page.fill('#pin', pin); await page.click('#btnJoin');
    await page.waitForFunction(() => {
      const t = window.__telalink.transport;
      return t === 'retransmissao' ? window.__telalink.stats?.framesDecoded > 5 : t === 'direta' && document.getElementById('remote').videoWidth > 0;
    }, null, { timeout: 30_000 });
    vs.push({ page, ctx });
  }
  return { host, hctx, direta: vs[0].page, relay: vs[1].page, close: async () => { for (const v of vs) await v.ctx.close(); await hctx.close(); } };
}
const frames = (p) => p.evaluate(() => (window.__telalink.transport === 'retransmissao'
  ? window.__telalink.stats.framesDecoded : document.getElementById('remote').getVideoPlaybackQuality().totalVideoFrames));
async function flowing(p, label) {
  const a = await frames(p);
  await p.waitForFunction((a) => ((window.__telalink.transport === 'retransmissao'
    ? window.__telalink.stats?.framesDecoded : document.getElementById('remote').getVideoPlaybackQuality().totalVideoFrames) || 0) > a + 5, a, { timeout: 15_000 })
    .catch(() => assert.fail(`${label}: a imagem parou`));
}
async function save(host, fn) {
  await host.click('#btnSettings');
  await fn();
  await host.click('#btnSaveSettings');
}

describe('Salvar configuracoes ao vivo (navegador real)', { skip, timeout: 300_000 }, () => {
  test('qualidade Maxima + 60 qps + 20 Mbps + texto: nada para, e quem assiste e avisado', async () => {
    const s = await setup();
    await save(s.host, async () => {
      await s.host.selectOption('#optQuality', 'original');
      await s.host.selectOption('#optFps', '60');
      await s.host.selectOption('#optBitrate', '20');
      await s.host.check('input[name=hint][value=detail]');
    });
    await s.host.waitForFunction(() => /sem interromper/.test(document.getElementById('toast').textContent), null, { timeout: 10_000 });
    assert.ok(await s.host.isVisible('#live'), 'transmissao continua aberta');
    for (const [p, n] of [[s.direta, 'direta'], [s.relay, 'retransmissao']]) {
      await flowing(p, n);
      await p.waitForFunction(() => /Quem transmite ajustou: Máxima/.test(document.getElementById('stageMsg').textContent), null, { timeout: 5000 });
    }
    const send = (await s.host.evaluate(() => window.__telalink.sending()))[0];
    assert.equal(send.maxBitrate, 20_000_000);
    assert.equal(send.degradation, 'maintain-resolution');
    // E voltar para Economica tambem nao para nada.
    await save(s.host, () => s.host.selectOption('#optQuality', 'economica'));
    await flowing(s.direta, 'direta'); await flowing(s.relay, 'retransmissao');
    await s.direta.waitForFunction(() => document.getElementById('remote').videoHeight <= 480, null, { timeout: 15_000 });
    await s.close();
  });

  test('Seguranca: Maxima passa quem assiste para a retransmissao NA HORA; Padrao volta para a conexao direta', async () => {
    const s = await setup();
    await save(s.host, () => s.host.check('input[name=policy][value=relay]'));
    await s.direta.waitForFunction(() => window.__telalink.transport === 'retransmissao', null, { timeout: 15_000 });
    await flowing(s.direta, 'apos Maxima seguranca');
    await save(s.host, () => s.host.check('input[name=policy][value=auto]'));
    await s.direta.waitForFunction(() => window.__telalink.transport === 'direta', null, { timeout: 20_000 });
    await flowing(s.direta, 'de volta a conexao direta');
    await flowing(s.relay, 'quem so tem retransmissao continua');
    assert.equal(await s.relay.evaluate(() => window.__telalink.transport), 'retransmissao');
    await s.close();
  });

  test('trocar o tipo de link durante a transmissao fica para a proxima (nao derruba quem assiste)', async () => {
    const s = await setup();
    const antes = settings.data.tunnel;
    await save(s.host, () => s.host.selectOption('#optTunnel', antes === 'ssh' ? 'off' : 'ssh'));
    await s.host.waitForFunction(() => /próxima transmissão/.test(document.getElementById('toast').textContent));
    await s.host.waitForTimeout(500);
    assert.equal(settings.data.tunnel, antes, 'nao mudou durante a transmissao');
    await flowing(s.direta, 'direta');
    await s.host.click('#btnStop');
    await s.host.waitForTimeout(800);
    assert.notEqual(settings.data.tunnel, antes, 'aplicado ao encerrar');
    await s.close();
  });

  test('se a captura da tela parar, a transmissao NAO fecha: fica pausada e da para escolher de novo', async () => {
    const s = await setup();
    await s.host.evaluate(() => document.getElementById('preview').srcObject.getVideoTracks()[0].dispatchEvent(new Event('ended')));
    await s.host.waitForSelector('#captureEnded:not(.hidden)');
    assert.ok(await s.host.isVisible('#live'));
    assert.equal((await s.host.evaluate(() => window.__telalink.state)).paused, true, 'quem assiste ve "pausada"');
    await flowing(s.direta, 'cartao de pausa chegando');
    await s.host.click('#btnRepick');
    await s.host.waitForSelector('#captureEnded.hidden', { state: 'attached' });
    assert.equal((await s.host.evaluate(() => window.__telalink.state)).paused, false);
    await flowing(s.direta, 'tela de novo'); await flowing(s.relay, 'tela de novo (retransmissao)');
    await s.close();
  });
});
