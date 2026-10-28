// Testes "estaticos": pegam bugs que so apareceriam no Windows ou no navegador.
// Inclui a regressao do bug que fazia a janela do Iniciar.bat fechar na hora.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const bats = readdirSync(ROOT).filter((f) => f.toLowerCase().endsWith('.bat'));

test('existem os inicializadores esperados', () => {
  for (const f of ['Iniciar.bat', 'Diagnostico.bat', 'Testar.bat']) assert.ok(bats.includes(f), f);
});

for (const file of bats) {
  const raw = readFileSync(join(ROOT, file));
  const text = raw.toString('latin1');
  const lines = text.split('\r\n');

  test(`${file}: usa quebra de linha do Windows (CRLF)`, () => {
    assert.ok(!/(^|[^\r])\n/.test(text), 'tem LF sem CR');
  });

  test(`${file}: so caracteres ASCII (evita texto quebrado no cmd)`, () => {
    const bad = [...raw].findIndex((b) => b > 0x7e || (b < 0x20 && b !== 0x0d && b !== 0x0a && b !== 0x09));
    assert.equal(bad, -1, `byte invalido na posicao ${bad}`);
  });

  test(`${file}: nenhum echo com < > | & soltos (fechava a janela)`, () => {
    lines.forEach((line, i) => {
      const m = line.match(/\becho\b(.*)$/i);
      if (!m) return;
      // Corta o que vem depois de um ")" que fecha o bloco do if/for.
      const body = m[1].replace(/\)\s*(else\s*\(.*)?$/i, '').replace(/\^[<>|&()]/g, '');
      assert.doesNotMatch(body, /[<>|&]/, `linha ${i + 1}: ${line.trim()}`);
    });
  });

  test(`${file}: se reabre com cmd /k (janela nunca fecha sozinha)`, () => {
    assert.match(text, /cmd \/k ""%~f0" __run"/);
  });

  test(`${file}: todo "goto :rotulo" tem o rotulo definido`, () => {
    for (const [, label] of text.matchAll(/goto\s+:(\w+)/gi)) {
      if (label.toLowerCase() === 'eof') continue;
      assert.match(text, new RegExp(`^:${label}\\b`, 'im'), `rotulo :${label} nao existe`);
    }
  });

  test(`${file}: arquivos citados existem`, () => {
    for (const [, rel] of text.matchAll(/%~dp0([\w\\.-]+\.(?:js|html))/g)) {
      assert.ok(existsSync(join(ROOT, ...rel.split('\\'))), rel);
    }
  });
}

const jsFiles = [...readdirSync(join(ROOT, 'src')).map((f) => join('src', f)),
  ...readdirSync(join(ROOT, 'public')).filter((f) => f.endsWith('.js')).map((f) => join('public', f)),
  join('scripts', 'selfcheck.js')];

for (const rel of jsFiles) {
  test(`${rel}: sintaxe JavaScript valida`, () => {
    const r = spawnSync(process.execPath, ['--check', join(ROOT, rel)], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  });
}

test('codigo do navegador nao usa innerHTML/eval (evita injecao de codigo)', () => {
  for (const f of readdirSync(join(ROOT, 'public')).filter((x) => x.endsWith('.js'))) {
    const code = readFileSync(join(ROOT, 'public', f), 'utf8');
    assert.doesNotMatch(code, /\.innerHTML\s*=|\beval\(|new Function\(/, f);
  }
});

for (const page of ['host', 'viewer', 'config']) {
  test(`todo $("id") usado em ${page}.js existe em ${page}.html`, () => {
    const code = readFileSync(join(ROOT, 'public', `${page}.js`), 'utf8');
    const html = readFileSync(join(ROOT, 'public', `${page}.html`), 'utf8');
    const ids = new Set([...code.matchAll(/\$\(['`]([\w-]+)['`]\)/g)].map((m) => m[1]));
    assert.ok(ids.size > 2, 'deveria achar ids');
    for (const id of ids) assert.match(html, new RegExp(`id="${id}"`), `${page}.html sem #${id}`);
  });
}
