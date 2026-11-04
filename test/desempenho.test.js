// =============================================================================
//  Desempenho do servidor (retransmissao): 10 espectadores, 8 Mbps, 60 qps,
//  com quadros-chave grandes. Limites generosos (maquinas de CI variam), mas
//  que pegam regressoes grosseiras (copias por espectador, juntar pedacos de
//  novo a cada pacote, vazamento de memoria).
//  Medicao detalhada: node bench/servidor.mjs   (ver docs/DESEMPENHO.md)
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const BENCH = join(dirname(fileURLToPath(import.meta.url)), '..', 'bench', 'servidor.mjs');

test('servidor com 10 espectadores a 8 Mbps / 60 qps: pouco processador, memoria e coleta de lixo', { timeout: 120_000 }, async () => {
  const child = fork(BENCH, ['10', '8', '60', '4'], { stdio: ['ignore', 'pipe', 'inherit', 'ipc'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  await new Promise((r) => child.on('exit', r));
  const line = out.trim().split('\n').at(-1);
  const r = JSON.parse(line).results[0];
  console.log(`      servidor: ${r.cpu_pct}% de um nucleo, ${r.rss_mb} MB, ${r.gc_por_s} GC/s (${r.gc_ms_por_s} ms/s), ${r.recebido_mbps} Mbps por pessoa`);
  assert.ok(r.recebido_mbps > 6, `todos receberam o video (${r.recebido_mbps} Mbps)`);
  assert.ok(r.cpu_pct < 60, `processador do servidor (${r.cpu_pct}%)`);
  assert.ok(r.rss_mb < 400, `memoria do servidor (${r.rss_mb} MB)`);
  assert.ok(r.gc_ms_por_s < 50, `tempo em coleta de lixo (${r.gc_ms_por_s} ms/s)`);
});
