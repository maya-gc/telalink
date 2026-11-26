// =============================================================================
//  Link estavel (relato: "fica gerando uns links aleatorios").
//  O link e o PIN sao guardados no PC de quem transmite: recarregar o painel ou
//  encerrar e comecar de novo NAO gera link novo; quem assiste entra de novo
//  com o mesmo link; "Gerar link novo" descarta o antigo.
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
  '--auto-select-desktop-capture-source=Entire screen', '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'];

let app, dir, browser;
before(async () => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), 'tl-link-'));
  const settings = new SettingsStore({ dir }).load();
  app = await startApp({ settings, iceProvider: new IceProvider({ settings }), getTunnelInfo: () => ({ status: 'on', url: app.base, provider: 'ssh' }) });
  browser = await chromium.launch({ args: ARGS });
});
after(async () => { await browser?.close(); await app?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

const live = async (host) => {
  await host.click('#btnScreen'); await host.waitForSelector('#live:not(.hidden)');
  return { link: await host.inputValue('#shareLink'), pin: (await host.textContent('#pinView')).trim() };
};

describe('Link estavel (navegador real)', { skip, timeout: 180_000 }, () => {
  test('recarregar o painel mantem link e PIN; quem assiste entra de novo; "Gerar link novo" troca', async () => {
    const hctx = await browser.newContext();
    const host = await hctx.newPage();
    await host.goto(app.base + '/');
    assert.ok(await host.isHidden('#sameLink'), 'primeira vez: nada a reaproveitar');
    const first = await live(host);

    const vctx = await browser.newContext();
    const v = await vctx.newPage();
    await v.goto(first.link); await v.fill('#pin', first.pin); await v.click('#btnJoin');
    await v.waitForFunction(async () => (await window.__telalink.framesReceived()) > 5, null, { timeout: 30_000 });

    // Painel recarregado (ou fechado sem querer): quem assiste ve o aviso e pode entrar de novo.
    host.on('dialog', (d) => d.accept());
    await host.reload();
    await v.waitForFunction(() => /link e o PIN continuam os mesmos/.test(document.getElementById('gateMsg').textContent), null, { timeout: 10_000 });
    assert.ok(await host.isVisible('#sameLink'), 'painel avisa que vai usar o mesmo link');
    const second = await live(host);
    assert.equal(second.link, first.link, 'mesmo link');
    assert.equal(second.pin, first.pin, 'mesmo PIN');
    await v.click('#btnJoin');
    await v.waitForFunction(async () => window.__telalink.transport !== 'conectando' && (await window.__telalink.framesReceived()) > 5, null, { timeout: 30_000 });

    // Gerar link novo: o antigo deixa de valer.
    await host.reload();
    await host.click('#btnFreshLink');
    const third = await live(host);
    assert.notEqual(third.link, first.link);
    const w = await (await browser.newContext()).newPage();
    await w.goto(first.link); await w.fill('#pin', first.pin); await w.click('#btnJoin');
    await w.waitForFunction(() => /não encontrada|encerrada/i.test(document.getElementById('gateMsg').textContent), null, { timeout: 15_000 });
    await w.context().close(); await vctx.close(); await hctx.close();
  });
});
