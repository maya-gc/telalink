// =============================================================================
//  Fluidez (relato: "em filmes, trava, acelera tudo e depois mostra").
//  Quem assiste passa por uma "internet ruim" (bench/rede-ruim.mjs): banda
//  limitada e, a cada ~4 s, a rede segura tudo por 700 ms e solta de uma vez,
//  como um tunel engasgando. Antes: 3 congelamentos e ~30 quadros "correndo"
//  em 15 s. Agora: no maximo o primeiro engasgo congela, nada corre.
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
import { smoothness } from '../public/media-util.js';
import { startBadLink } from '../bench/rede-ruim.mjs';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch {}
const skip = !chromium && 'Playwright nao instalado';
const ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  '--auto-select-desktop-capture-source=Entire screen', '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'];

let app, dir, browser, link;
before(async () => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), 'tl-fluidez-'));
  const settings = new SettingsStore({ dir }).load();
  app = await startApp({ settings, iceProvider: new IceProvider({ settings }), getTunnelInfo: () => ({ status: 'on', url: app.base, provider: 'ssh' }) });
  link = await startBadLink({ target: Number(new URL(app.base).port), rateBps: 6e6, stallEveryMs: 4000, stallMs: 700 });
  browser = await chromium.launch({ args: ARGS });
});
after(async () => { await browser?.close(); await link?.close(); await app?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

async function startHost(policy) {
  const ctx = await browser.newContext();
  const host = await ctx.newPage();
  await host.goto(app.base + '/');
  // A escolha fica salva: sempre define (o teste anterior pode ter deixado outra).
  await host.click('#btnSettings'); await host.check(`input[name=policy][value=${policy}]`); await host.click('#btnSaveSettings');
  await host.click('#btnScreen'); await host.waitForSelector('#live:not(.hidden)');
  return { ctx, host, link: await host.inputValue('#shareLink'), pin: (await host.textContent('#pinView')).trim() };
}

describe('Fluidez da imagem (navegador real)', { skip, timeout: 240_000 }, () => {
  test('retransmissao por internet que engasga: ritmo constante, sem "correr" depois de travar', async () => {
    const h = await startHost('relay');
    const ctx = await browser.newContext();
    const v = await ctx.newPage();
    // Conta cada vez que um quadro aparece na tela de quem assiste.
    await v.addInitScript(() => {
      window.__draws = [];
      const orig = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (...a) { if (this.canvas.id === 'relayCanvas') window.__draws.push(performance.now()); return orig.apply(this, a); };
    });
    await v.goto(h.link.replace(new URL(app.base).host, `127.0.0.1:${link.port}`));
    await v.fill('#pin', h.pin); await v.click('#btnJoin');
    await v.waitForFunction(async () => (await window.__telalink.framesReceived()) > 5, null, { timeout: 30_000 });
    await v.waitForTimeout(2000);
    await v.evaluate(() => { window.__draws = []; });
    await v.waitForTimeout(16_000);
    const r = smoothness(await v.evaluate(() => window.__draws));
    const buf = await v.evaluate(() => window.__telalink.playout());
    console.log(`      retransmissao com engasgos: ${JSON.stringify(r)} buffer=${JSON.stringify(buf)}`);
    assert.ok(r.frames > 150, `imagem chegando (${r.frames} quadros)`);
    assert.ok(r.bursts <= 3, `sem correr para alcancar (antes ~30): ${r.bursts}`);
    assert.ok(r.freezes <= 2, `no maximo o primeiro engasgo congela (antes 3+): ${r.freezes}`);
    assert.ok(buf.delayMs >= 600, 'o buffer cresceu para cobrir os engasgos');
    // Quem transmite recebe o atraso medido (para baixar a banda antes de travar).
    await h.host.waitForFunction(() => (window.__telalink.viewers || []).some((x) => x.queueDelay !== undefined), null, { timeout: 5000 });
    await ctx.close(); await h.ctx.close();
  });

  test('conexao direta: buffer de recepcao maior que o padrao de chamada (video e som)', async () => {
    const h = await startHost('auto');
    const ctx = await browser.newContext();
    const v = await ctx.newPage();
    await v.goto(h.link); await v.fill('#pin', h.pin); await v.click('#btnJoin');
    await v.waitForFunction(() => window.__telalink.transport === 'direta', null, { timeout: 20_000 });
    const targets = await v.evaluate(() => window.__telalink.jitterTargets());
    assert.ok(targets.length >= 1);
    for (const t of targets) assert.ok(t >= 200, `buffer da conexao direta ${t} ms`);
    await v.waitForTimeout(3000);
    const r = await v.evaluate(() => window.__telalink.smoothness());
    assert.ok(r.frames > 30 && r.freezes <= 1 && r.maxGapMs < 600 && r.bursts <= 3, `direta suave: ${JSON.stringify(r)}`);
    await ctx.close(); await h.ctx.close();
  });
});
