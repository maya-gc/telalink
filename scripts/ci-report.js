// Le o relatorio JUnit dos testes e publica cada falha como anotacao do
// GitHub Actions (aparece destacada na pagina da execucao e na API).
// Uso: node scripts/ci-report.js relatorio-testes.xml
import { readFileSync, existsSync } from 'node:fs';

const file = process.argv[2] || 'relatorio-testes.xml';
if (!existsSync(file)) { console.log(`::warning::relatorio ${file} nao encontrado`); process.exit(0); }
const xml = readFileSync(file, 'utf8');

const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
// Anotacoes usam %0A para quebra de linha e precisam escapar % , : no titulo.
const data = (s) => s.replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A');
const prop = (s) => data(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

let count = 0;
// Casos que passam sao tags vazias (<testcase .../>); so os com corpo podem ter falha.
for (const m of xml.matchAll(/<testcase\b((?:[^>"]|"[^"]*")*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
  const attrs = m[1];
  const body = m[2] || '';
  const fail = /<failure\b([^>]*)>([\s\S]*?)<\/failure>|<failure\b([^>]*)\/>/.exec(body);
  if (!fail) continue;
  const name = unescape((/\bname="([^"]*)"/.exec(attrs) || [])[1] || 'teste');
  const file = unescape((/\bfile="([^"]*)"/.exec(attrs) || [])[1] || '');
  const msg = unescape((/\bmessage="([^"]*)"/.exec(fail[1] || fail[3] || '') || [])[1] || '');
  const detail = unescape(fail[2] || '').split('\n').filter((l) => !/^\s+at /.test(l)).slice(0, 12).join('\n');
  const where = file ? `file=${prop(file.replace(/^.*?(test\/)/, '$1'))},` : '';
  console.log(`::error ${where}title=${prop(name)}::${data(`${msg}\n${detail}`.trim().slice(0, 3000))}`);
  count++;
}
console.log(`${count} teste(s) com falha publicados como anotacao.`);
