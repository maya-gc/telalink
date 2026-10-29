// =============================================================================
//  Instalacao automatica dos requisitos.
//   - cloudflared: escolhe o arquivo certo por sistema, exige o SHA-256
//     publicado e recusa download adulterado ou de outro endereco;
//   - Node.js (instalar-node.sh no Linux/macOS, instalar-node.ps1 no Windows):
//     contra um "nodejs.org" falso local, instala na pasta .runtime e RECUSA
//     arquivo com hash diferente da lista oficial.
//  O download REAL (nodejs.org e GitHub) roda no workflow "instalador".
// =============================================================================
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assetName, expectedSha256, download } from '../scripts/baixar-cloudflared.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sha = (b) => createHash('sha256').update(b).digest('hex');

describe('cloudflared: download verificado', () => {
  test('arquivo oficial certo para cada sistema', () => {
    assert.equal(assetName('win32', 'x64'), 'cloudflared-windows-amd64.exe');
    assert.equal(assetName('win32', 'arm64'), 'cloudflared-windows-amd64.exe', 'Windows ARM roda a versao x64');
    assert.equal(assetName('darwin', 'arm64'), 'cloudflared-darwin-arm64.tgz');
    assert.equal(assetName('darwin', 'x64'), 'cloudflared-darwin-amd64.tgz');
    assert.equal(assetName('linux', 'x64'), 'cloudflared-linux-amd64');
    assert.equal(assetName('linux', 'arm64'), 'cloudflared-linux-arm64');
    assert.equal(assetName('aix', 'ppc64'), null);
  });

  test('SHA-256 vem do "digest" do GitHub ou, na falta, da lista do texto da versao', () => {
    const h = 'a'.repeat(64);
    assert.equal(expectedSha256({ assets: [{ name: 'x', digest: `sha256:${h}` }] }, 'x').sha, h);
    assert.equal(expectedSha256({ assets: [{ name: 'cloudflared-linux-amd64' }], body: `SHA256 Checksums:\ncloudflared-linux-amd64: ${h}\n` }, 'cloudflared-linux-amd64').sha, h);
    assert.equal(expectedSha256({ assets: [{ name: 'x' }], body: '' }, 'x').sha, null);
    assert.equal(expectedSha256({ assets: [] }, 'x').asset, null);
  });

  const BIN = Buffer.from('#!/bin/sh\necho cloudflared version 2026.10.0\n');
  const URL_OK = 'https://github.com/cloudflare/cloudflared/releases/download/2026.10.0/cloudflared-linux-amd64';
  const fakeFetch = ({ digest = `sha256:${sha(BIN)}`, url = URL_OK, body = BIN } = {}) => async (u) => {
    if (u.includes('api.github.com')) return { ok: true, json: async () => ({ tag_name: '2026.10.0', assets: [{ name: 'cloudflared-linux-amd64', digest, browser_download_url: url }] }) };
    return { ok: true, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length) };
  };

  test('baixa, confere o SHA-256 e deixa executavel na pasta .runtime', async (t) => {
    const dest = mkdtempSync(join(tmpdir(), 'tl-cf-'));
    t.after(() => rmSync(dest, { recursive: true, force: true }));
    const r = await download({ dest, platform: 'linux', arch: 'x64', fetchFn: fakeFetch(), log: () => {} });
    assert.equal(r.version, '2026.10.0');
    assert.deepEqual(readFileSync(r.path), BIN);
    assert.deepEqual(readdirSync(dest).sort(), ['cloudflared', 'cloudflared-version.txt'], 'pasta de trabalho temporaria removida');
    if (process.platform !== 'win32') assert.ok(statSync(r.path).mode & 0o100, 'executavel');
  });

  test('RECUSA: arquivo adulterado, versao sem hash e endereco de download estranho', async (t) => {
    const dest = mkdtempSync(join(tmpdir(), 'tl-cf-'));
    t.after(() => rmSync(dest, { recursive: true, force: true }));
    const opts = { dest, platform: 'linux', arch: 'x64', log: () => {} };
    await assert.rejects(download({ ...opts, fetchFn: fakeFetch({ body: Buffer.from('#!/bin/sh\nmalware\n') }) }), /SHA-256 NAO confere/);
    await assert.rejects(download({ ...opts, fetchFn: fakeFetch({ digest: '' }) }), /nao publica o SHA-256/);
    await assert.rejects(download({ ...opts, fetchFn: fakeFetch({ url: 'https://evil.example/cloudflared' }) }), /endereco de download inesperado/);
    assert.ok(!existsSync(join(dest, 'cloudflared')), 'nada foi gravado');
  });
});

// ---------------------------------------------------------------- Node.js
// "nodejs.org" falso: serve index.json, o pacote e a lista de hashes.
async function fakeDist({ files, sums }) {
  const srv = http.createServer((req, res) => {
    const f = files[req.url];
    if (req.url.endsWith('/SHASUMS256.txt')) return res.end(sums);   // sem content-type de proposito (robustez)
    if (!f) { res.statusCode = 404; return res.end(); }
    res.end(f);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}
// O script roda com SIGPIPE ignorado, como no GitHub Actions e quando chamado
// por outros programas: pega o erro de cortar o fluxo cedo ("grep: write error").
const runAsync = (cmd, args, opts) => new Promise((resolve) => {
  const c = spawn(cmd, args, opts); let out = '';
  c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (out += d));
  c.on('close', (status) => resolve({ status, out }));
});

describe('Node.js portatil no Linux/macOS (instalar-node.sh)', { skip: process.platform === 'win32' && 'so Linux/macOS' }, () => {
  const os = process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const ver = process.version;
  const name = `node-${ver}-${os}-${arch}`;

  function pack() {
    const work = mkdtempSync(join(tmpdir(), 'tl-pack-'));
    mkdirSync(join(work, name, 'bin'), { recursive: true });
    copyFileSync(process.execPath, join(work, name, 'bin', 'node'));     // binario real do Node
    spawnSync('tar', ['-czf', join(work, `${name}.tar.gz`), '-C', work, name]);
    const tgz = readFileSync(join(work, `${name}.tar.gz`));
    rmSync(work, { recursive: true, force: true });
    return tgz;
  }
  const index = JSON.stringify([
    { version: 'v99.0.0', lts: false, files: [`${os}-${arch}`, `osx-${arch}-tar`] },
    { version: ver, lts: 'Teste', files: [`${os}-${arch}`, `osx-${arch}-tar`] },
    // Lista grande como a real (~1 MB): pega o problema de cortar o fluxo cedo (SIGPIPE).
    ...Array.from({ length: 8000 }, (_, i) => ({ version: `v1.${i}.0`, lts: 'Antiga', files: [`${os}-${arch}`, `osx-${arch}-tar`] })),
  ]).replace(/\},\{/g, '},\n{');

  test('instala o LTS na pasta .runtime e grava o caminho; arquivo adulterado e RECUSADO', async (t) => {
    const tgz = pack();
    const files = { '/index.json': index, [`/${ver}/${name}.tar.gz`]: tgz };
    const dest = mkdtempSync(join(tmpdir(), 'tl-rt-'));
    t.after(() => rmSync(dest, { recursive: true, force: true }));
    const env = { ...process.env, TELALINK_FORCE: '1', TELALINK_RUNTIME: dest, TELALINK_SKIP_SIGNATURE: '1' };

    const good = await fakeDist({ files, sums: `${sha(tgz)}  ${name}.tar.gz\n${'b'.repeat(64)}  outro.tar.gz\n` });
    const r = await runAsync('bash', ['-c', 'trap "" PIPE; exec bash "$0"', join(ROOT, 'scripts', 'instalar-node.sh')], { env: { ...env, TELALINK_NODE_DIST: good.url } });
    good.close();
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /SHA-256 conferido/);
    assert.match(r.out, new RegExp(`Versao LTS: ${ver.replace(/\./g, '\\.')}`), 'escolhe o LTS, nao a versao mais nova');
    const nodePath = readFileSync(join(dest, 'node-path.txt'), 'utf8');
    assert.equal(nodePath, join(dest, 'node', 'bin', 'node'));
    assert.equal(spawnSync(nodePath, ['--version'], { encoding: 'utf8' }).stdout.trim(), ver);

    rmSync(join(dest, 'node'), { recursive: true, force: true });
    const bad = await fakeDist({ files, sums: `${'c'.repeat(64)}  ${name}.tar.gz\n` });
    const r2 = await runAsync('bash', ['-c', 'trap "" PIPE; exec bash "$0"', join(ROOT, 'scripts', 'instalar-node.sh')], { env: { ...env, TELALINK_NODE_DIST: bad.url } });
    bad.close();
    assert.notEqual(r2.status, 0);
    assert.match(r2.out, /SHA-256 NAO confere/);
    assert.ok(!existsSync(join(dest, 'node')), 'nada instalado');
  });

  test('ja tem Node.js 20+: usa o do sistema, sem baixar nada', async (t) => {
    const dest = mkdtempSync(join(tmpdir(), 'tl-rt-'));
    t.after(() => rmSync(dest, { recursive: true, force: true }));
    const r = await runAsync('bash', ['-c', 'trap "" PIPE; exec bash "$0"', join(ROOT, 'scripts', 'instalar-node.sh')], {
      env: { ...process.env, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TELALINK_RUNTIME: dest, TELALINK_NODE_DIST: 'http://127.0.0.1:9' },
    });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /Node.js do sistema/);
    assert.equal(readFileSync(join(dest, 'node-path.txt'), 'utf8'), process.execPath);
  });
});

describe('Node.js portatil no Windows (instalar-node.ps1)', { skip: process.platform !== 'win32' && 'so Windows' }, () => {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const ver = process.version;
  const name = `node-${ver}-win-${arch}`;
  const ps = (args, env) => runAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'scripts', 'instalar-node.ps1'), ...args], { env });

  test('instala na pasta .runtime com SHA-256 e assinatura da OpenJS conferidos; adulterado e RECUSADO', async (t) => {
    const work = mkdtempSync(join(tmpdir(), 'tl-zip-'));
    t.after(() => rmSync(work, { recursive: true, force: true }));
    mkdirSync(join(work, name));
    copyFileSync(process.execPath, join(work, name, 'node.exe'));   // node.exe real, assinado
    const z = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Path '${join(work, name)}' -DestinationPath '${join(work, `${name}.zip`)}'`], { encoding: 'utf8' });
    assert.equal(z.status, 0, z.stderr);
    const zip = readFileSync(join(work, `${name}.zip`));
    const files = { '/index.json': JSON.stringify([{ version: ver, lts: 'Teste', files: [`win-${arch}-zip`] }]), [`/${ver}/${name}.zip`]: zip };
    const dest = join(work, 'rt');
    const env = { ...process.env };
    delete env.PSModulePath;

    const good = await fakeDist({ files, sums: `${sha(zip)}  ${name}.zip\n` });
    const r = await ps(['-Dest', dest, '-DistUrl', good.url, '-Force'], env);
    good.close();
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /SHA-256 conferido/);
    assert.match(r.out, /OpenJS Foundation conferida/);
    const nodePath = readFileSync(join(dest, 'node-path.txt'), 'utf8');
    assert.equal(spawnSync(nodePath, ['--version'], { encoding: 'utf8' }).stdout.trim(), ver);

    rmSync(join(dest, 'node'), { recursive: true, force: true });
    const bad = await fakeDist({ files, sums: `${'c'.repeat(64)}  ${name}.zip\n` });
    const r2 = await ps(['-Dest', dest, '-DistUrl', bad.url, '-Force'], env);
    bad.close();
    assert.notEqual(r2.status, 0);
    assert.match(r2.out, /SHA-256 NAO confere/);
    assert.ok(!existsSync(join(dest, 'node')), 'nada instalado');
  });
});
