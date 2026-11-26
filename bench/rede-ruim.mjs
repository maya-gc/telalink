// =============================================================================
//  "Internet ruim" para testes: proxy TCP entre quem assiste e o servidor.
//  No sentido servidor -> quem assiste: limita a banda e, de tempos em tempos,
//  segura tudo por alguns centenas de ms e depois solta de uma vez, como um
//  tunel (Cloudflare) ou Wi-Fi engasgando. E o padrao que causava
//  "trava, acelera e depois mostra".
//  Uso: import { startBadLink } from './rede-ruim.mjs'
//       const link = await startBadLink({ target: 8080, rateBps: 6e6, stallEveryMs: 4000, stallMs: 700 })
//       ... use http://127.0.0.1:${link.port} no lugar do servidor ...
// =============================================================================
import net from 'node:net';

export function startBadLink({ target, host = '127.0.0.1', rateBps = 6_000_000, stallEveryMs = 4000, stallMs = 700, burstFactor = 6, seed = 1 } = {}) {
  let rnd = seed;
  const random = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
  const sockets = new Set();
  const server = net.createServer((client) => {
    const upstream = net.connect(target, host);
    sockets.add(client); sockets.add(upstream);
    client.pipe(upstream);                       // quem assiste -> servidor: sem limite
    const queue = [];
    let queued = 0, stalledUntil = 0, nextStall = Date.now() + stallEveryMs * (0.5 + random());
    let budget = 0, last = Date.now();
    upstream.on('data', (chunk) => { queue.push(chunk); queued += chunk.length; });
    const pump = setInterval(() => {
      const now = Date.now();
      const dt = now - last; last = now;
      if (stallMs > 0 && now >= nextStall) { stalledUntil = now + stallMs; nextStall = now + stallMs + stallEveryMs * (0.6 + 0.8 * random()); }
      if (now < stalledUntil) return;
      // Depois de um engasgo, o acumulado sai mais rapido (rajada), como num tunel.
      const rate = queued > rateBps / 8 / 4 ? rateBps * burstFactor : rateBps;
      budget = Math.min(budget + (rate / 8) * (dt / 1000), rate / 8);
      while (queue.length && budget > 0) {
        let c = queue[0];
        if (c.length > budget) { const part = c.subarray(0, Math.floor(budget)); queue[0] = c.subarray(part.length); c = part; }
        else queue.shift();
        if (!c.length) break;
        budget -= c.length; queued -= c.length;
        client.write(c);
      }
    }, 5);
    const end = () => { clearInterval(pump); client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
    client.on('close', end); upstream.on('close', end); client.on('error', end); upstream.on('error', end);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  })));
}
