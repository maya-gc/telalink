// =============================================================================
//  "Pegada" do TelaLink no computador: garante que ele continua sendo um
//  programa comum, sem nada que antivirus ou anti-cheats (Vanguard, Easy
//  Anti-Cheat, VAC, BattlEye, FACEIT) vigiam:
//   - nada de injetar codigo, ler/escrever memoria de outro processo, ganchos
//     de teclado/mouse, simular entradas, drivers ou modulos nativos;
//   - so executa programas de uma lista fixa (e todos assinados pelo fabricante);
//   - nunca pede administrador;
//   - nada escondido nem ofuscado;
//   - roda com prioridade abaixo do normal (nao disputa com o jogo).
//  Se alguma mudanca futura quebrar uma dessas regras, a versao e reprovada.
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isElevated, lowerPriority } from '../src/sistema.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['.git', 'node_modules', '.runtime', 'coverage', 'lab-results', 'test']);
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const files = walk(ROOT);
const code = files.filter((f) => ['.js', '.mjs', '.cjs', '.ps1', '.sh', '.bat', '.html'].includes(extname(f)));
const read = (f) => readFileSync(f, 'utf8');

test('nenhum executavel, driver ou modulo nativo dentro do projeto', () => {
  const bins = files.filter((f) => /\.(exe|dll|sys|node|so|dylib|msi|scr|com)$/i.test(f)).map((f) => relative(ROOT, f));
  assert.deepEqual(bins, []);
  const pkg = JSON.parse(read(join(ROOT, 'package.json')));
  assert.deepEqual(Object.keys(pkg.dependencies || {}), [], 'sem dependencias npm em producao');
});

test('nada que mexa em outros processos, teclado, mouse ou memoria', () => {
  const proibidos = [
    /\bprocess\.dlopen\b/, /\brequire\(['"](ffi|ffi-napi|koffi|robotjs|iohook|node-global-key-listener|memoryjs|winax|edge-js)['"]\)/,
    /from ['"](ffi|ffi-napi|koffi|robotjs|iohook|memoryjs|winax|edge-js)['"]/,
    /\b(OpenProcess|ReadProcessMemory|WriteProcessMemory|CreateRemoteThread|VirtualAllocEx|SetWindowsHookEx|SendInput|keybd_event|mouse_event)\b/,
    /Add-Type\s+-(TypeDefinition|MemberDefinition|Path|Language)/i,   // compilar C# pelo PowerShell (-AssemblyName de biblioteca da Microsoft e ok)
    /\[DllImport/i,
  ];
  for (const f of code) {
    if (f.includes(`${join('public', 'vendor')}`)) continue;   // conferido abaixo
    const s = read(f);
    for (const re of proibidos) assert.ok(!re.test(s), `${relative(ROOT, f)}: ${re}`);
  }
});

test('so executa programas de uma lista fixa (todos assinados pelo fabricante)', () => {
  // Cada chamada spawn/spawnSync: o comando tem que ser um destes.
  const permitidos = new Set(["'powershell.exe'", 'ps', "'where'", "'which'", "platform === 'win32' ? 'where' : 'which'", "'tar'", "'codesign'", "'net'", 'cmd', 'this.bin']);
  const achados = [];
  for (const f of code.filter((x) => /\.(js|mjs)$/.test(x) && !x.includes('vendor'))) {
    for (const m of read(f).matchAll(/\bspawn(?:Sync)?\(\s*([^,]+),/g)) achados.push([relative(ROOT, f), m[1].trim()]);
    for (const m of read(f).matchAll(/\brun\(\s*([^,]+),/g)) achados.push([relative(ROOT, f), m[1].trim()]);
    assert.ok(!/\b(exec|execSync)\(/.test(read(f).replace(/\.exec\(/g, '')), `${relative(ROOT, f)}: exec() monta comando com texto`);
  }
  const fora = achados.filter(([, c]) => !permitidos.has(c));
  assert.deepEqual(fora, [], 'comando fora da lista');
});

test('nunca pede administrador nem esconde janela/codigo', () => {
  for (const f of code) {
    if (f.includes('vendor')) continue;
    const s = read(f);
    assert.ok(!/-Verb\s+RunAs|requireAdministrator|\brunas\b/i.test(s), `${relative(ROOT, f)}: pede administrador`);
    assert.ok(!/-WindowStyle\s+Hidden|-EncodedCommand/i.test(s), `${relative(ROOT, f)}: esconde janela ou codigo`);
    // Texto em base64 so pode virar DADO (ex.: segredo protegido pelo DPAPI), nunca codigo executado.
    assert.ok(!/FromBase64String[\s\S]{0,200}(Invoke-Expression|\biex\b|ScriptBlock|Invoke-Command)/i.test(s), `${relative(ROOT, f)}: executa codigo decodificado`);
  }
});

test('biblioteca incluida (QR code) e so calculo: sem rede, sem pagina, sem processos', () => {
  const s = read(join(ROOT, 'public', 'vendor', 'qrcode.js'));
  for (const re of [/\bfetch\(/, /XMLHttpRequest/, /WebSocket/, /document\./, /window\./, /\beval\(/, /new Function/, /import\(/, /localStorage/]) {
    assert.ok(!re.test(s), `qrcode.js: ${re}`);
  }
});

test('avisa se estiver como administrador; roda com prioridade abaixo do normal', () => {
  assert.equal(isElevated({ platform: 'win32', run: () => ({ status: 0 }) }), true);
  assert.equal(isElevated({ platform: 'win32', run: () => ({ status: 2 }) }), false);
  assert.equal(isElevated({ platform: 'linux', getuid: () => 0 }), true);
  assert.equal(isElevated({ platform: 'linux', getuid: () => 1000 }), false);
  const calls = [];
  assert.equal(lowerPriority(123, { env: {}, set: (...a) => calls.push(a) }), true);
  assert.equal(calls[0][0], 123);
  assert.ok(calls[0][1] > 0, 'abaixo do normal (valor positivo de "nice")');
  assert.equal(lowerPriority(123, { env: { TELALINK_PRIORITY: 'normal' }, set: () => calls.push('x') }), false, 'pode ser desligado');
  assert.ok(lowerPriority(process.pid), 'funciona de verdade neste sistema');
});
