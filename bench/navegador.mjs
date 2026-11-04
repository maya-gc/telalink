// =============================================================================
//  Consumo do NAVEGADOR de quem transmite (todos os processos do Chromium dele):
//  varia numero de espectadores, codec e modo (conexao direta x retransmissao).
//  Uso: node bench/navegador.mjs [segundos=10]
// =============================================================================
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from '../test/helpers.js';
import { SettingsStore } from '../src/settings.js';
import { IceProvider } from '../src/turn.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const SECS = Number(process.argv[2] || 10);
const ONLY = process.env.CASOS ? process.env.CASOS.split(',') : null;
const ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--auto-select-desktop-capture-source=Entire screen',
  '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns', '--window-size=1920,1080'];
const HZ = 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tree(root) {
  const kids = new Map();
  for (const p of readdirSync('/proc')) {
    if (!/^\d+$/.test(p)) continue;
    try { const st = readFileSync(`/proc/${p}/stat`, 'utf8'); const ppid = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]); (kids.get(ppid) || kids.set(ppid, []).get(ppid)).push(Number(p)); } catch {}
  }
  const out = []; const stack = [root];
  while (stack.length) { const p = stack.pop(); out.push(p); stack.push(...(kids.get(p) || [])); }
  return out;
}
function cpuTicks(pids) {
  let t = 0, rss = 0;
  for (const p of pids) {
    try {
      const st = readFileSync(`/proc/${p}/stat`, 'utf8'); const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
      t += Number(f[11]) + Number(f[12]); rss += Number(f[21]) * 4096;
    } catch {}
  }
  return { t, rss };
}

const settings = new SettingsStore({ dir: mkdtempSync(join(tmpdir(), 'bench-')) }).load();
const app = await startApp({ settings, iceProvider: new IceProvider({ settings }), getTunnelInfo: () => ({ status: 'on', url: app.base, provider: 'ssh' }) });
const viewersBrowser = await chromium.launch({ args: ARGS });
const relayBrowser = await chromium.launch({ args: [...ARGS, '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });

async function scenario({ name, viewers, codec = null, relay = false, quality = 'alta', fps = 60, script = null, maxDirect = 2 }) {
  const server = await chromium.launchServer({ args: ARGS, headless: true });
  const browser = await chromium.connect(server.wsEndpoint());
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  if (codec) await ctx.addInitScript((mime) => {   // so oferece o codec escolhido
    const orig = RTCRtpSender.getCapabilities.bind(RTCRtpSender);
    RTCRtpSender.getCapabilities = (k) => { const c = orig(k); if (k === 'video') c.codecs = c.codecs.filter((x) => x.mimeType === mime || /rtx|red|ulpfec/i.test(x.mimeType)); return c; };
  }, codec);
  if (script) await ctx.addInitScript(script);
  const host = await ctx.newPage();
  await host.goto(app.base + '/');
  await host.click('#btnSettings');
  await host.selectOption('#optQuality', quality); await host.selectOption('#optFps', String(fps));
  await host.check(`input[name=policy][value=${relay ? 'relay' : 'auto'}]`);
  await host.selectOption('#optMaxDirect', String(maxDirect));
  await host.click('#btnSaveSettings');
  await host.click('#btnScreen'); await host.waitForSelector('#live:not(.hidden)');
  const link = await host.inputValue('#shareLink'), pin = (await host.textContent('#pinView')).trim();
  const vctxs = [];
  for (let i = 0; i < viewers; i++) {
    const vc = await (relay ? relayBrowser : viewersBrowser).newContext(); const vp = await vc.newPage();
    await vp.goto(link); await vp.fill('#pin', pin); await vp.click('#btnJoin');
    await vp.waitForFunction(() => window.__telalink.transport !== 'conectando', null, { timeout: 30000 });
    vctxs.push({ vc, vp });
  }
  await sleep(4000);                                   // estabiliza (banda sobe, codificador aquece)
  const pids = tree(server.process().pid);
  const a = cpuTicks(pids); const t0 = performance.now();
  await sleep(SECS * 1000);
  const b = cpuTicks(tree(server.process().pid)); const dt = (performance.now() - t0) / 1000;
  const m = await host.evaluate(() => window.__telalink.measure());
  const res = { cenario: name, espectadores: viewers, cpu_nucleos: +(((b.t - a.t) / HZ) / dt).toFixed(2), ram_mb: +(b.rss / 1e6).toFixed(0),
    enviado: m.map((x) => `${x.height || '?'}p${Math.round(x.fps || 0)} ${x.codec || ''}`).slice(0, 3).join(' | ') };
  for (const { vc } of vctxs) await vc.close();
  await browser.close(); await server.close();
  return res;
}

const CASES = [
  { name: 'NOVO padrao (Leve, ate 2 diretas)', viewers: 1 },
  { name: 'NOVO padrao (Leve, ate 2 diretas)', viewers: 3 },
  { name: 'ANTIGO (VP9, todas diretas)', viewers: 3, codec: 'video/VP9', maxDirect: 0 },
  { name: 'NOVO 5 pessoas', viewers: 5 },
  { name: 'ANTIGO 5 pessoas', viewers: 5, codec: 'video/VP9', maxDirect: 0 },
  { name: 'direta VP9 (padrao atual sem hardware)', viewers: 1, codec: 'video/VP9' },
  { name: 'direta VP9', viewers: 3, codec: 'video/VP9' },
  { name: 'direta VP8', viewers: 1, codec: 'video/VP8' },
  { name: 'direta VP8', viewers: 3, codec: 'video/VP8' },
  { name: 'direta H264', viewers: 1, codec: 'video/H264' },
  { name: 'retransmissao (1 codificacao)', viewers: 1, relay: true },
  { name: 'retransmissao (1 codificacao)', viewers: 3, relay: true },
  { name: 'so captura (0 espectadores)', viewers: 0 },
];
const results = [];
for (const c of CASES) {
  if (ONLY && !ONLY.some((o) => c.name.includes(o))) continue;
  try { results.push(await scenario(c)); } catch (e) { results.push({ cenario: c.name, espectadores: c.viewers, erro: e.message.split('\n')[0] }); }
  console.log(JSON.stringify(results.at(-1)));
}
console.table(results);
await viewersBrowser.close(); await relayBrowser.close(); await app.close();
