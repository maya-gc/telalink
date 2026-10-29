// Testes do link externo (tunel Cloudflare) e da verificacao de integridade.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tunnel, parseTunnelUrl, findCloudflared, verifyAuthenticode, windowsCandidates, WINGET_ID } from '../src/tunnel.js';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-cloudflared.js');
const once = (em, ev, ms = 6000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`timeout esperando "${ev}"`)), ms);
  em.once(ev, (v) => { clearTimeout(t); res(v); });
});

const CF_SUBJECT = 'CN="Cloudflare, Inc.", O="Cloudflare, Inc.", L=San Francisco, S=California, C=US';
// Simula spawnSync: "where"/"which" e o PowerShell da verificacao de assinatura.
function fakeRun({ where = [], sig = {} } = {}) {
  const calls = [];
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === 'where' || cmd === 'which') return where.length ? { status: 0, stdout: where.join('\r\n') } : { status: 1, stdout: '' };
    if (cmd === 'powershell.exe') return { status: 0, stdout: 'TL|' + (sig[opts.env.TL_FILE] ?? 'NotSigned|') };
    return { status: 1 };
  };
  run.calls = calls;
  return run;
}

describe('Localizar e verificar o cloudflared', () => {
  test('o projeto nao embute nenhum executavel (evita alarme de antivirus)', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    assert.ok(!existsSync(join(root, 'bin')), 'pasta bin/ com binarios nao deveria existir');
  });

  test('sem cloudflared instalado: retorna null (programa segue so com uso local)', () => {
    assert.equal(findCloudflared({ platform: 'win32', env: {}, run: fakeRun(), exists: () => false }), null);
  });

  test('Windows: aceita so com assinatura VALIDA da Cloudflare, Inc.', () => {
    const p = 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe';
    const env = { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' };
    const ok = findCloudflared({ platform: 'win32', env, run: fakeRun({ sig: { [p]: `Valid|${CF_SUBJECT}` } }), exists: (f) => f === p });
    assert.deepEqual(ok, { path: p, verified: true, signer: 'Cloudflare, Inc.' });
  });

  test('Windows: arquivo sem assinatura, adulterado ou de outro fabricante e recusado', () => {
    const p = 'C:\\x\\cloudflared.exe';
    for (const [sig, re] of [['NotSigned|', /NotSigned/], ['HashMismatch|' + CF_SUBJECT, /HashMismatch/],
      ['Valid|CN=Evil Corp, O=Evil Corp', /nao pela Cloudflare/], ['Valid|CN="Cloudflare, Inc. Fake", O="Cloudflare, Inc. Fake"', /nao pela Cloudflare/]]) {
      assert.throws(
        () => findCloudflared({ platform: 'win32', env: { CLOUDFLARED_PATH: p }, run: fakeRun({ sig: { [p]: sig } }), exists: (f) => f === p }),
        (err) => re.test(err.message) && err.message.includes(`winget install --id ${WINGET_ID}`),
        sig,
      );
    }
  });

  test('Windows: se houver uma copia ruim no PATH e a oficial instalada, usa a oficial', () => {
    const bad = 'C:\\Downloads\\cloudflared.exe';
    const good = 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe';
    const r = findCloudflared({
      platform: 'win32', env: { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
      run: fakeRun({ where: [bad], sig: { [bad]: 'NotSigned|', [good]: `Valid|${CF_SUBJECT}` } }),
      exists: () => true,
    });
    assert.equal(r.path, good);
  });

  test('o caminho do arquivo vai por variavel de ambiente, nunca no texto do comando', () => {
    const evil = "C:\\x\\'; Remove-Item C:\\ -Recurse; '.exe";
    const run = fakeRun();
    verifyAuthenticode(evil, run);
    const ps = run.calls.find((c) => c.cmd === 'powershell.exe');
    assert.ok(!ps.args.join(' ').includes('Remove-Item'), 'caminho vazou para o comando');
    assert.equal(ps.opts.env.TL_FILE, evil);
  });

  test('candidatos do Windows incluem os locais do instalador oficial/winget', () => {
    const c = windowsCandidates({ 'ProgramFiles(x86)': 'P86', ProgramFiles: 'P', LOCALAPPDATA: 'L' });
    assert.ok(c.some((p) => p.includes('P86') && p.endsWith('cloudflared.exe')));
    assert.ok(c.some((p) => p.includes('WinGet')));
  });

  test('Linux/macOS: usa o cloudflared do sistema (instalado pelo gerenciador de pacotes)', () => {
    const r = findCloudflared({ platform: 'linux', env: {}, run: fakeRun({ where: ['/usr/bin/cloudflared'] }), exists: () => true });
    assert.deepEqual(r, { path: '/usr/bin/cloudflared', verified: false, signer: null });
  });

  test('falha ao rodar o PowerShell vira motivo claro (nunca "valido")', () => {
    const v = verifyAuthenticode('C:\\x.exe', () => ({ status: 0, stdout: '', stderr: 'Get-AuthenticodeSignature : modulo nao carregou\r\nmais' }));
    assert.equal(v.valid, false);
    assert.match(v.reason, /nao foi possivel verificar a assinatura \(Get-AuthenticodeSignature : modulo nao carregou\)/);
    const env = []; verifyAuthenticode('C:\\x.exe', (cmd, args, o) => { env.push(o.env); return { status: 1 }; });
    assert.ok(!Object.keys(env[0]).some((k) => k.toLowerCase() === 'psmodulepath'), 'nao herda o PSModulePath');
  });

  test('Windows REAL: um executavel da Microsoft e "valido" mas recusado por nao ser da Cloudflare',
    { skip: process.platform !== 'win32' && 'so roda no Windows' }, () => {
      const notepad = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'notepad.exe');
      const v = verifyAuthenticode(notepad);
      assert.equal(v.valid, false);
      assert.match(v.reason, /nao pela Cloudflare/, `a verificacao em si precisa funcionar: ${v.reason}`);
    });
});

describe('Tunel', () => {
  test('parseTunnelUrl acha a URL no log e ignora enderecos falsos', () => {
    assert.equal(parseTunnelUrl('INF |  https://abc-def-123.trycloudflare.com   |'), 'https://abc-def-123.trycloudflare.com');
    assert.equal(parseTunnelUrl('INF Requesting new quick Tunnel on trycloudflare.com...'), null);
    assert.equal(parseTunnelUrl('https://evil.com/?x=.trycloudflare.com'), null);
  });

  test('captura a URL publica', async (t) => {
    const tun = new Tunnel({ port: 1234, bin: process.execPath, binArgs: [FAKE, 'ok'] });
    t.after(() => tun.stop());
    tun.start();
    assert.equal(await once(tun, 'url'), 'https://verde-gato-azul-teste.trycloudflare.com');
    assert.deepEqual(tun.info(), { status: 'on', url: 'https://verde-gato-azul-teste.trycloudflare.com', error: null });
  });

  test('se cair, reinicia sozinho e anuncia a nova URL', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'tl-'));
    const tun = new Tunnel({ port: 1234, bin: process.execPath, binArgs: [FAKE, 'flaky', join(dir, 'n')], restartDelayMs: 100 });
    t.after(() => { tun.stop(); rmSync(dir, { recursive: true, force: true }); });
    tun.start();
    assert.equal(await once(tun, 'url'), 'https://tentativa-0.trycloudflare.com');
    await once(tun, 'restart');
    assert.equal(tun.info().url, null, 'URL antiga nao pode continuar anunciada');
    assert.equal(await once(tun, 'url'), 'https://tentativa-1.trycloudflare.com');
  });

  test('rede que bloqueia UDP/QUIC: troca sozinho para HTTP/2 e conecta', async (t) => {
    const tun = new Tunnel({ port: 1234, bin: process.execPath, binArgs: [FAKE, 'quic-blocked'], restartDelayMs: 100 });
    t.after(() => tun.stop());
    tun.start();
    assert.equal(await once(tun, 'protocol'), 'http2');
    assert.equal(await once(tun, 'url'), 'https://via-http2.trycloudflare.com');
  });

  test('sem resposta: vira erro depois das tentativas (o painel avisa em vez de travar)', async (t) => {
    const tun = new Tunnel({ port: 1234, bin: process.execPath, binArgs: [FAKE, 'silent'], startTimeoutMs: 200, maxRestarts: 1, restartDelayMs: 50 });
    t.after(() => tun.stop());
    tun.start();
    assert.match(await once(tun, 'error-status'), /nao conseguiu se conectar/);
    assert.equal(tun.info().status, 'error');
    assert.equal(tun.protocol, 'http2', 'deveria ter tentado HTTP/2 antes de desistir');
  });

  test('binario inexistente vira erro sem derrubar o programa', async (t) => {
    const tun = new Tunnel({ port: 1234, bin: join(tmpdir(), 'nao-existe-cloudflared'), maxRestarts: 0 });
    t.after(() => tun.stop());
    tun.start();
    await once(tun, 'error-status');
    assert.equal(tun.info().status, 'error');
  });
});
