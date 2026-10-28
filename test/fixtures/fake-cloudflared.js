// Imita o cloudflared para os testes do tunel (sem internet).
// Uso: node fake-cloudflared.js <modo> [arquivoContador] tunnel --no-autoupdate --url http://...
//   ok      -> imprime o banner com a URL e fica rodando
//   silent  -> nunca imprime a URL (testa o timeout)
//   flaky   -> na 1a execucao imprime e cai; nas seguintes fica estavel
import { readFileSync, writeFileSync } from 'node:fs';

// Argumentos proprios vem antes de "tunnel"; o resto e o que o programa passa.
const own = process.argv.slice(2, process.argv.indexOf('tunnel'));
const [mode, counterFile] = own;
const target = process.argv[process.argv.indexOf('--url') + 1];

let run = 0;
if (counterFile) {
  try { run = Number(readFileSync(counterFile, 'utf8')) || 0; } catch {}
  writeFileSync(counterFile, String(run + 1));
}

const banner = (id) => [
  '2026-10-28T03:00:00Z INF Thank you for trying Cloudflare Tunnel.',
  '2026-10-28T03:00:00Z INF +--------------------------------------------------------------------------------------------+',
  '2026-10-28T03:00:00Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |',
  `2026-10-28T03:00:00Z INF |  https://${id}.trycloudflare.com                                       |`,
  '2026-10-28T03:00:00Z INF +--------------------------------------------------------------------------------------------+',
  `2026-10-28T03:00:01Z INF Registered tunnel connection connIndex=0 originService=${target}`,
].join('\n') + '\n';

if (mode === 'ok') {
  setTimeout(() => process.stderr.write(banner('verde-gato-azul-teste')), 50);
  setInterval(() => {}, 1000);
} else if (mode === 'silent') {
  process.stderr.write('2026-10-28T03:00:00Z INF Requesting new quick Tunnel...\n');
  setInterval(() => {}, 1000);
} else if (mode === 'flaky') {
  setTimeout(() => process.stderr.write(banner(`tentativa-${run}`)), 50);
  if (run === 0) setTimeout(() => process.exit(1), 150);
  else setInterval(() => {}, 1000);
} else if (mode === 'quic-blocked') {
  // Rede que bloqueia UDP: QUIC falha e encerra; com --protocol http2 funciona.
  if (process.argv.includes('http2')) {
    setTimeout(() => process.stderr.write(banner('via-http2')), 50);
    setInterval(() => {}, 1000);
  } else {
    process.stderr.write('2026-10-28T03:00:00Z ERR Failed to dial a quic connection error="timeout: no recent network activity"\n');
    setTimeout(() => process.exit(1), 100);
  }
}
