// Confere os resultados do laboratorio contra o esperado e gera o relatorio.
import { readFileSync, existsSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.env.LAB_OUT || 'lab-results';

// O que cada rede DEVE conseguir (sem TURN configurado no laboratorio).
export const EXPECTED = {
  casa2:   { desc: 'Outra casa (NAT residencial)',           aceita: ['direta'] },
  vpn:     { desc: 'VPN/extensao que desliga o WebRTC',      aceita: ['retransmissao'] },
  empresa: { desc: 'Empresa: firewall so libera TCP 80/443', aceita: ['retransmissao'] },
  cgnat:   { desc: '4G / CGNAT (NAT simetrico)',             aceita: ['direta', 'retransmissao'] },
};

export function evaluate(results) {
  return Object.entries(EXPECTED).map(([name, exp]) => {
    const r = results[name] || { ok: false, error: 'sem resultado' };
    const pass = r.ok && exp.aceita.includes(r.transport);
    return { name, ...exp, ...r, pass };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const results = {};
  for (const name of Object.keys(EXPECTED)) {
    const f = join(OUT, `${name}.json`);
    if (existsSync(f)) results[name] = JSON.parse(readFileSync(f, 'utf8'));
  }
  const rows = evaluate(results);
  const label = { direta: 'Conexão direta', turn: 'TURN', retransmissao: 'Retransmissão pelo link' };
  const md = [
    '## Laboratório de redes isoladas',
    '',
    'Transmissor na rede **casa** (NAT residencial). Cada espectador em uma rede separada, atrás do próprio roteador.',
    '',
    '| Rede do espectador | Resultado | Caminho usado | Tempo até a imagem | Esperado |',
    '|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.desc} | ${r.pass ? '✅' : '❌'} ${r.ok ? '' : (r.error || '')} | ${label[r.transport] || '-'} | ${r.firstFrameMs ? (r.firstFrameMs / 1000).toFixed(1) + ' s' : '-'} | ${r.aceita.map((a) => label[a]).join(' ou ')} |`),
    '',
  ].join('\n');
  console.log(md);
  writeFileSync(join(OUT, 'resumo.md'), md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
  process.exit(rows.every((r) => r.pass) ? 0 : 1);
}
