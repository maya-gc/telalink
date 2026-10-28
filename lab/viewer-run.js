// Roda DENTRO de uma rede de espectador: abre o link, entra com o PIN e mede
// se a imagem chegou, por qual caminho e em quanto tempo.
// Uso: node lab/viewer-run.js <cenario> [--sem-webrtc]
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const { chromium } = createRequire(import.meta.url)('playwright');
const [scenario, ...flags] = process.argv.slice(2);
const OUT = process.env.LAB_OUT || 'lab-results';
const STATE = process.env.LAB_STATE || '/tmp/telalink-lab';
mkdirSync(OUT, { recursive: true });

const { link, pin } = JSON.parse(readFileSync(join(STATE, 'sessao.json'), 'utf8'));
const args = ['--autoplay-policy=no-user-gesture-required'];
if (flags.includes('--sem-webrtc')) args.push('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');

const result = { scenario, ok: false, transport: null, firstFrameMs: null, error: null };
const browser = await chromium.launch({ args });
try {
  // O laboratorio usa um certificado de teste (no mundo real: o da Cloudflare).
  const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${scenario} console]`, m.text()); });
  page.on('pageerror', (e) => console.log(`[${scenario} erro na pagina]`, e.message));
  const t0 = Date.now();
  await page.goto(link, { timeout: 20_000 });
  await page.fill('#pin', pin);
  await page.click('#btnJoin');
  await page.waitForFunction(() => {
    const t = window.__telalink.transport;
    if (t === 'retransmissao') return (window.__telalink.stats?.framesDecoded || 0) > 30;
    if (t === 'direta' || t === 'turn') { const v = document.getElementById('remote'); return v.videoWidth > 0 && v.currentTime > 1; }
    return false;
  }, null, { timeout: 60_000, polling: 250 });
  result.firstFrameMs = Date.now() - t0;
  result.transport = await page.evaluate(() => window.__telalink.transport);
  result.stats = await page.evaluate(() => window.__telalink.stats);
  result.diag = await page.evaluate(() => window.__telalink.diag);
  console.log(`[${scenario} diag]`, JSON.stringify(result.diag));
  result.ok = true;
  await page.screenshot({ path: join(OUT, `${scenario}.png`) });
} catch (err) {
  result.error = err.message.split('\n')[0];
  // Estado da pagina no momento da falha, para diagnostico.
  try {
    const ctx = browser.contexts()[0];
    const pg = ctx?.pages()[0];
    if (pg) result.estado = await pg.evaluate(() => ({ seguro: isSecureContext, transporte: window.__telalink?.transport, stats: window.__telalink?.stats, mensagem: document.getElementById('gateMsg')?.textContent }));
    result.error += ' | estado: ' + JSON.stringify(result.estado);
  } catch {}
} finally {
  await browser.close();
  writeFileSync(join(OUT, `${scenario}.json`), JSON.stringify(result, null, 2));
  console.log(`[${scenario}]`, result.ok ? `OK via ${result.transport} em ${result.firstFrameMs} ms` : `FALHOU: ${result.error}`);
}
