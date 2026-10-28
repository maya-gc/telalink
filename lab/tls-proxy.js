// =============================================================================
//  Proxy HTTPS do laboratorio: faz o papel da Cloudflare/cloudflared.
//  Recebe https (porta 443 publicada pelo roteador), repassa para o TelaLink
//  em 127.0.0.1:8080 e marca o visitante como externo (cf-connecting-ip),
//  exatamente como o tunel real faz. Repassa tambem WebSocket.
//  Uso: node lab/tls-proxy.js <chave.pem> <certificado.pem> [porta] [destino]
// =============================================================================
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import { readFileSync } from 'node:fs';

export function startTlsProxy({ key, cert, port = 8443, host = '0.0.0.0', target = 8080 }) {
  const mark = (req) => {
    const ip = req.socket.remoteAddress?.replace(/^::ffff:/, '');
    return { ...req.headers, 'cf-connecting-ip': ip, 'x-forwarded-for': ip, 'x-forwarded-proto': 'https' };
  };

  const server = https.createServer({ key, cert }, (req, res) => {
    const up = http.request({ host: '127.0.0.1', port: target, method: req.method, path: req.url, headers: mark(req) }, (ur) => {
      res.writeHead(ur.statusCode, ur.headers);
      ur.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  });

  server.on('upgrade', (req, sock, head) => {
    const up = net.connect(target, '127.0.0.1', () => {
      const lines = Object.entries(mark(req)).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : [`${k}: ${v}`]));
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`);
      if (head?.length) up.write(head);
      sock.pipe(up).pipe(sock);
    });
    up.on('error', () => sock.destroy());
    sock.on('error', () => up.destroy());
  });

  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [keyFile, certFile, port = '8443', target = '8080'] = process.argv.slice(2);
  await startTlsProxy({ key: readFileSync(keyFile), cert: readFileSync(certFile), port: Number(port), target: Number(target) });
  console.log(`proxy https ouvindo em ${port} -> 127.0.0.1:${target}`);
}
