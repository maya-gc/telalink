// =============================================================================
//  Teste de carga do servidor (retransmissao): quem transmite manda video a
//  FPS quadros/s e MBPS Mbps (quadro-chave grande a cada 3 s) para N espectadores.
//  Mede CPU, memoria e coletas de lixo do processo do servidor.
//  Uso: node bench/servidor.mjs [espectadores=1,5,20] [mbps=8] [fps=60] [segundos=8]
//       NODE_FLAGS="--max-semi-space-size=16" node bench/servidor.mjs   (testar ajustes do GC)
// =============================================================================
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const [nsArg = '1,5,20', mbpsArg = '8', fpsArg = '60', secsArg = '8'] = process.argv.slice(2);
const NS = nsArg.split(',').map(Number), MBPS = Number(mbpsArg), FPS = Number(fpsArg), SECS = Number(secsArg);
const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(url) {
  const ws = new WebSocket(url); ws.binaryType = 'arraybuffer';
  const q = []; const w = [];
  ws.bytes = 0;
  ws.onmessage = (e) => { if (typeof e.data !== 'string') { ws.bytes += e.data.byteLength; return; } const m = JSON.parse(e.data); if (w.length) w.shift()(m); else q.push(m); };
  ws.next = () => new Promise((r) => (q.length ? r(q.shift()) : w.push(r)));
  ws.opened = new Promise((r) => (ws.onopen = r));
  return ws;
}
const packet = (size, key) => { const b = new Uint8Array(size); b[0] = 1; b[1] = key ? 1 : 0; for (let i = 2; i < size; i += 4096) b[i] = i & 255; return b; };

async function run(n) {
  const child = fork(join(here, 'servidor-alvo.mjs'), [], { execArgv: (process.env.NODE_FLAGS || '').split(' ').filter(Boolean) });
  const port = await new Promise((r) => child.on('message', (m) => m.type === 'ready' && r(m.port)));
  const stats = []; child.on('message', (m) => m.type === 'stats' && stats.push(m));
  const base = `http://127.0.0.1:${port}`, wsu = `ws://127.0.0.1:${port}`;
  const room = await (await fetch(`${base}/api/create-room`, { method: 'POST' })).json();
  const host = client(wsu); await host.opened;
  host.send(JSON.stringify({ type: 'host-join', roomId: room.roomId })); await host.next();
  const viewers = [];
  for (let i = 0; i < n; i++) {
    const v = client(wsu); await v.opened;
    v.send(JSON.stringify({ type: 'viewer-join', roomId: room.roomId, pin: room.pin })); await v.next();
    v.send(JSON.stringify({ type: 'relay-subscribe' }));
    viewers.push(v);
  }
  await sleep(300);
  const delta = Math.round((MBPS * 1e6) / 8 / FPS * 0.8), key = Math.min(3.9e6, delta * FPS * 0.6);
  const pd = packet(delta, false), pk = packet(key, true);
  const t0 = performance.now(); let frame = 0; let warm = true;
  while (performance.now() - t0 < (SECS + 1) * 1000) {
    host.send(frame % (FPS * 3) === 0 ? pk : pd); frame++;
    const due = t0 + (frame * 1000) / FPS; const wait = due - performance.now();
    if (wait > 0) await sleep(wait);
    if (warm && performance.now() - t0 > 1000) { warm = false; child.send('stats'); stats.length = 0; }
    if (!warm && stats.length < Math.floor((performance.now() - t0 - 1000) / 1000)) child.send('stats');
  }
  child.send('stats'); await sleep(200);
  const got = viewers.reduce((a, v) => a + v.bytes, 0) / n;
  const avg = (k) => stats.reduce((a, s) => a + s[k], 0) / stats.length;
  const max = (k) => Math.max(...stats.map((s) => s[k]));
  const r = { espectadores: n, cpu_pct: +(avg('cpu') * 100).toFixed(1), rss_mb: +(max('rss') / 1e6).toFixed(0), heap_mb: +(max('heap') / 1e6).toFixed(1),
    buffers_mb: +(max('ext') / 1e6).toFixed(1), gc_por_s: +(avg('gcCount')).toFixed(1), gc_ms_por_s: +(avg('gcMs')).toFixed(1), recebido_mbps: +((got * 8) / 1e6 / (SECS + 1)).toFixed(1) };
  for (const v of viewers) v.close(); host.close();
  child.send('exit'); await new Promise((r) => child.on('exit', r));
  return r;
}

const results = [];
for (const n of NS) results.push(await run(n));
console.table(results);
console.log(JSON.stringify({ mbps: MBPS, fps: FPS, flags: process.env.NODE_FLAGS || '', results }));
