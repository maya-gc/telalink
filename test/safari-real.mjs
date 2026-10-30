// =============================================================================
//  Teste com o SAFARI DE VERDADE (macOS), via safaridriver (WebDriver da Apple).
//  Quem transmite: Chromium (Playwright, tela falsa). Quem assiste: Safari.
//  Confere a conexao direta e a retransmissao (Maxima seguranca).
//  Uso (no macOS):  sudo safaridriver --enable && node test/safari-real.mjs
// =============================================================================
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './helpers.js';
import { SettingsStore } from '../src/settings.js';
import { IceProvider } from '../src/turn.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const PORT = 4444;
const WD = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wd(method, path, body) {
  const r = await fetch(WD + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`WebDriver ${method} ${path}: ${r.status} ${JSON.stringify(j.value || j).slice(0, 300)}`);
  return j.value;
}

const driver = spawn('safaridriver', ['-p', String(PORT)], { stdio: 'inherit' });
for (let i = 0; i < 50; i++) { try { await fetch(`${WD}/status`); break; } catch { await sleep(200); } }

const settings = new SettingsStore({ dir: mkdtempSync(join(tmpdir(), 'tl-safari-')) }).load();
const app = await startApp({ settings, iceProvider: new IceProvider({ settings }), getTunnelInfo: () => ({ status: 'on', url: app.base, provider: 'ssh' }) });
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  '--auto-select-desktop-capture-source=Entire screen', '--autoplay-policy=no-user-gesture-required'] });

let failures = 0;
for (const policy of ['auto', 'relay']) {
  const label = policy === 'auto' ? 'conexao direta (ou o que a rede permitir)' : 'retransmissao (Maxima seguranca)';
  let session = null;
  const ctx = await browser.newContext();
  try {
    const host = await ctx.newPage();
    await host.goto(app.base + '/');
    await host.click('#btnSettings'); await host.check(`input[name=policy][value=${policy}]`); await host.click('#btnSaveSettings');
    await host.click('#btnScreen'); await host.waitForSelector('#live:not(.hidden)');
    const link = await host.inputValue('#shareLink');
    const pin = (await host.textContent('#pinView')).trim();

    session = (await wd('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'safari' } } })).sessionId;
    const s = `/session/${session}`;
    await wd('POST', `${s}/url`, { url: link });
    // Espera a pagina terminar de carregar (scripts prontos) antes de clicar em Entrar.
    for (let i = 0; i < 50; i++) {
      if (await wd('POST', `${s}/execute/sync`, { script: 'return !!(window.__telalink && window.__telalink.framesReceived)', args: [] })) break;
      await sleep(200);
    }
    await wd('POST', `${s}/execute/sync`, { script: "document.getElementById('pin').value = arguments[0]; document.getElementById('btnJoin').click();", args: [pin] });
    const probe = `const done = arguments[arguments.length - 1];
      if (!window.__telalink || !window.__telalink.framesReceived) return done({ t: 'carregando', f: 0 });
      window.__telalink.framesReceived().then((f) => done({ t: window.__telalink.transport, f,
        gate: document.getElementById('gateMsg').textContent, ua: navigator.userAgent, diag: window.__telalink.diag }));`;
    let first = null, last = null;
    for (let i = 0; i < 60; i++) {
      last = await wd('POST', `${s}/execute/async`, { script: probe, args: [] });
      if (last.t !== 'conectando' && last.f > 0) { if (!first) first = last; else if (last.f > first.f + 10) break; }
      await sleep(1000);
    }
    const ok = first && last.f > first.f + 10 && (policy === 'auto' || last.t === 'retransmissao');
    console.log(`${ok ? 'OK   ' : 'FALHA'} Safari assistindo — ${label}: caminho=${last?.t} quadros=${first?.f}->${last?.f} ${last?.gate || ''}`);
    if (!ok) { failures++; console.log(`::error::Safari real (${label}) nao recebeu imagem: ${JSON.stringify(last).slice(0, 900)}`); }
    else console.log(`::notice::Safari real (${last.ua.match(/Version\/[\d.]+/)?.[0] || 'Safari'}) — ${label}: ${last.t}, imagem chegando` +
      (policy === 'auto' ? ` | diagnostico da conexao direta: ${JSON.stringify(last.diag || {}).slice(0, 500)}` : ''));
  } catch (err) {
    failures++; console.log(`::error::Safari real (${label}): ${err.message}`);
  } finally {
    if (session) await wd('DELETE', `/session/${session}`).catch(() => {});
    await ctx.close();
  }
}
await browser.close(); await app.close(); driver.kill();
process.exit(failures ? 1 : 0);
