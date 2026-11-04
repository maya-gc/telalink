// Processo do servidor para o teste de carga: sobe o TelaLink e informa, a cada
// segundo, CPU, memoria e coletas de lixo (GC) do proprio processo.
import { PerformanceObserver } from 'node:perf_hooks';
import { startServer } from '../src/server.js';

const gc = { count: 0, ms: 0 };
new PerformanceObserver((list) => { for (const e of list.getEntries()) { gc.count++; gc.ms += e.duration; } }).observe({ entryTypes: ['gc'] });
const app = await startServer({ port: 0, log: () => {} });
process.send({ type: 'ready', port: app.port });
let last = process.cpuUsage(), lastT = performance.now();
process.on('message', (m) => {
  if (m === 'stats') {
    const now = performance.now(), c = process.cpuUsage(last);
    const mem = process.memoryUsage();
    process.send({ type: 'stats', cpu: (c.user + c.system) / 1000 / (now - lastT), rss: mem.rss, heap: mem.heapUsed, ext: mem.external + mem.arrayBuffers, gcCount: gc.count, gcMs: gc.ms });
    last = process.cpuUsage(); lastT = now; gc.count = 0; gc.ms = 0;
  }
  if (m === 'exit') app.close().then(() => process.exit(0));
});
