// =============================================================================
//  Regressao do relato "transmitiu pelo Brave e eu nao via nada":
//  o Brave com protecao contra fingerprinting usa "Desativar UDP sem proxy"
//  (conexao direta impossivel). Antes, quem assistia ficava ~13 s em
//  "Conectando..." sem explicacao. Agora a imagem tem que chegar em poucos
//  segundos em TODAS as combinacoes, e as etapas/diagnostico ficam visiveis.
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
  '--auto-select-desktop-capture-source=Entire screen', '--autoplay-policy=no-user-gesture-required'];
const POLICY = { protegido: 'disable_non_proxied_udp', publica: 'default_public_interface_only', normal: null };
const MAX_MS = 6000;

let app, dir;
const browsers = {};
before(async () => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), 'tl-brave-'));
  const settings = new SettingsStore({ dir }).load();
  app = await startApp({ settings, iceProvider: new IceProvider({ settings }), getTunnelInfo: () => ({ status: 'on', url: app.base, provider: 'ssh' }) });
  for (const [k, p] of Object.entries(POLICY)) browsers[k] = await chromium.launch({ args: [...ARGS, ...(p ? [`--force-webrtc-ip-handling-policy=${p}`] : [])] });
});
after(async () => { for (const b of Object.values(browsers)) await b.close(); await app?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

async function run(hostKind, viewerKind) {
  const hctx = await browsers[hostKind].newContext();
  const host = await hctx.newPage();
  await host.goto(app.base + '/');
  await host.click('#btnScreen');
  await host.waitForSelector('#live:not(.hidden)');
  await host.waitForTimeout(3500);                     // teste de conexao direta do painel
  const link = await host.inputValue('#shareLink'), pin = (await host.textContent('#pinView')).trim();
  const vctx = await browsers[viewerKind].newContext();
  const v = await vctx.newPage();
  await v.goto(link); await v.fill('#pin', pin);
  const t0 = Date.now();
  await v.click('#btnJoin');
  await v.waitForFunction(async () => (await window.__telalink.framesReceived()) > 5, null, { timeout: 20_000 });
  const ms = Date.now() - t0;
  await v.waitForFunction(() => window.__telalink.transport !== 'conectando', null, { timeout: 5000 });
  const r = { ms, transport: await v.evaluate(() => window.__telalink.transport), host, v, close: async () => { await vctx.close(); await hctx.close(); } };
  return r;
}

describe('Brave e navegadores com WebRTC restrito (navegador real)', { skip, timeout: 300_000 }, () => {
  test('transmitindo do Brave protegido: imagem em poucos segundos e o painel explica', async () => {
    const r = await run('protegido', 'normal');
    console.log(`      Brave protegido -> normal: ${r.ms} ms, ${r.transport}`);
    assert.ok(r.ms < MAX_MS, `imagem demorou ${r.ms} ms (antes: ~13 s)`);
    assert.equal(r.transport, 'retransmissao');
    await r.host.waitForFunction(() => /bloqueando a conexão direta/.test(document.getElementById('directNote').textContent), null, { timeout: 8000 });
    await r.close();
  });

  for (const [h, w, expect] of [['normal', 'protegido', 'retransmissao'], ['protegido', 'protegido', 'retransmissao'], ['normal', 'publica', 'direta'], ['normal', 'normal', 'direta']]) {
    test(`transmite ${h} -> assiste ${w}: imagem em menos de ${MAX_MS / 1000} s (${expect})`, async () => {
      const r = await run(h, w);
      console.log(`      ${h} -> ${w}: ${r.ms} ms, ${r.transport}`);
      assert.ok(r.ms < MAX_MS, `imagem demorou ${r.ms} ms`);
      assert.equal(r.transport, expect, 'conexao direta quando ela e possivel');
      await r.close();
    });
  }

  test('quem transmite nao responde (painel fechado/travado): quem assiste ve o que fazer, nao uma espera muda', async () => {
    // Sala criada, mas sem ninguem transmitindo nela.
    const room = await (await fetch(`${app.base}/api/create-room`, { method: 'POST' })).json();
    const ctx = await browsers.normal.newContext();
    const v = await ctx.newPage();
    await v.goto(`${app.base}/view?room=${room.roomId}#k=${'A'.repeat(43)}`);
    await v.fill('#pin', room.pin); await v.click('#btnJoin');
    await v.waitForFunction(() => /Quem transmite não respondeu/.test(document.getElementById('gateMsg').textContent), null, { timeout: 15_000 });
    assert.ok(await v.isVisible('#btnDiag'), 'botao de diagnostico aparece');
    const steps = await v.$$eval('#steps li', (ls) => ls.map((l) => l.className));
    assert.deepEqual(steps.slice(0, 3), ['ok', 'ok', 'pending'], 'mostra que travou em "Falar com quem transmite"');
    await ctx.close();
  });

  test('etapas visiveis e diagnostico sem PIN, chave ou sala', async () => {
    const r = await run('protegido', 'normal');
    const steps = await r.v.$$eval('#steps li', (ls) => ls.map((l) => [l.className, l.textContent]));
    assert.equal(steps.length, 4);
    await r.v.waitForFunction(() => [...document.querySelectorAll('#steps li')].every((l) => l.className === 'ok'), null, { timeout: 5000 });
    await r.v.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    // O botao so aparece quando algo trava; aqui deu certo, entao o teste o revela.
    await r.v.evaluate(() => { document.getElementById('gate').style.display = ''; document.getElementById('btnDiag').classList.remove('hidden'); });
    await r.v.click('#btnDiag');
    const clip = await r.v.evaluate(() => navigator.clipboard.readText());
    const j = JSON.parse(clip);
    assert.equal(j.telalink, 'diagnostico');
    assert.ok(j.etapas.image >= 0, 'tempos das etapas');
    const pin = (await r.host.textContent('#pinView')).trim();
    const link = await r.host.inputValue('#shareLink');
    const key = link.split('#k=')[1], room = new URL(link).searchParams.get('room');
    for (const secret of [pin, key, room]) assert.ok(!clip.includes(secret), 'diagnostico nao contem segredos');
    await r.close();
  });
});
