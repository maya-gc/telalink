// =============================================================================
//  Baixa o cloudflared OFICIAL (GitHub da Cloudflare) para a pasta .runtime,
//  para o link externo ficar estavel sem o usuario instalar nada.
// -----------------------------------------------------------------------------
//  Seguranca (o download so e aceito se TUDO conferir):
//    1. vem do repositorio oficial cloudflare/cloudflared (versao mais recente);
//    2. SHA-256 igual ao publicado pelo GitHub para o arquivo ("digest");
//    3. Windows: assinatura digital valida da Cloudflare, Inc.;
//       macOS:   assinatura (codesign) valida.
//  Falhar aqui NAO impede o TelaLink: o link externo usa o SSH do sistema.
//  Uso: node scripts/baixar-cloudflared.js [--dest pasta] [--force]
// =============================================================================
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, renameSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyAuthenticode, findCloudflared } from '../src/tunnel.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const API = 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest';
const MAX_BYTES = 150 * 1024 * 1024;

// Nome do arquivo da versao oficial para cada sistema/processador.
export function assetName(platform = process.platform, arch = process.arch) {
  const a = { x64: 'amd64', arm64: 'arm64', ia32: '386', arm: 'arm' }[arch];
  if (!a) return null;
  if (platform === 'win32') return a === 'arm64' ? 'cloudflared-windows-amd64.exe' : `cloudflared-windows-${a}.exe`; // x64 roda no Windows ARM
  if (platform === 'darwin') return `cloudflared-darwin-${a === 'arm64' ? 'arm64' : 'amd64'}.tgz`;
  if (platform === 'linux') return `cloudflared-linux-${a}`;
  return null;
}
export const binaryName = (platform = process.platform) => (platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');

// SHA-256 esperado: campo "digest" do GitHub; se faltar, a lista do texto da versao.
export function expectedSha256(release, name) {
  const asset = release.assets?.find((x) => x.name === name);
  if (!asset) return { asset: null, sha: null };
  const d = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest || '');
  if (d) return { asset, sha: d[1].toLowerCase() };
  const m = new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*([0-9a-f]{64})`, 'i').exec(release.body || '');
  return { asset, sha: m ? m[1].toLowerCase() : null };
}

export async function download({ dest = join(ROOT, '.runtime'), platform = process.platform, arch = process.arch,
  fetchFn = globalThis.fetch, api = API, verify = true, log = (m) => console.log(`        ${m}`) } = {}) {
  const name = assetName(platform, arch);
  if (!name) throw new Error(`sistema sem versao oficial do cloudflared (${platform}/${arch})`);
  const headers = { 'user-agent': 'TelaLink', accept: 'application/vnd.github+json' };
  // No CI, o token do proprio workflow evita o limite de consultas anonimas.
  if (process.env.GITHUB_TOKEN && api.startsWith('https://api.github.com/')) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  let rel;
  for (let i = 0; i < 3; i++) {                     // limite/instabilidade: tenta de novo
    rel = await fetchFn(api, { headers, signal: AbortSignal.timeout(20_000) });
    if (rel.ok || ![403, 429, 500, 502, 503].includes(rel.status)) break;
    await new Promise((r) => setTimeout(r, (i + 1) * (process.env.NODE_TEST_CONTEXT ? 10 : 5000)));
  }
  if (!rel.ok) throw new Error(`GitHub respondeu ${rel.status}${rel.status === 403 ? ' (limite de consultas; tente mais tarde)' : ''}`);
  const release = await rel.json();
  const { asset, sha } = expectedSha256(release, name);
  if (!asset) throw new Error(`arquivo ${name} nao encontrado na versao ${release.tag_name}`);
  if (!sha) throw new Error('a versao nao publica o SHA-256 do arquivo: download recusado');
  if (!/^https:\/\/github\.com\/cloudflare\/cloudflared\/releases\/download\//.test(asset.browser_download_url)) {
    throw new Error(`endereco de download inesperado: ${asset.browser_download_url}`);
  }
  log(`Baixando cloudflared ${release.tag_name} (oficial da Cloudflare)...`);
  const res = await fetchFn(asset.browser_download_url, { headers: { 'user-agent': 'TelaLink' }, signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`download respondeu ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('arquivo grande demais');
  const got = createHash('sha256').update(buf).digest('hex');
  if (got !== sha) throw new Error(`SHA-256 NAO confere (esperado ${sha}, recebido ${got}): download recusado`);
  log('SHA-256 conferido.');

  mkdirSync(dest, { recursive: true });
  // Pasta de trabalho DENTRO do destino: mover entre discos (C: -> D:) falha.
  const work = join(dest, `.baixando-${process.pid}-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  try {
    let bin = join(work, binaryName(platform));
    if (name.endsWith('.tgz')) {
      writeFileSync(join(work, name), buf);
      const t = spawnSync('tar', ['-xzf', join(work, name), '-C', work]);
      if (t.status !== 0) throw new Error('nao foi possivel extrair o arquivo');
      bin = join(work, 'cloudflared');
    } else {
      writeFileSync(bin, buf);
    }
    if (platform !== 'win32') chmodSync(bin, 0o755);
    if (verify && platform === 'win32') {
      const v = verifyAuthenticode(bin);
      if (!v.valid) throw new Error(`assinatura digital: ${v.reason}`);
      log('Assinatura digital da Cloudflare, Inc. conferida.');
    }
    if (verify && platform === 'darwin') {
      const c = spawnSync('codesign', ['--verify', '--strict', bin]);
      if (c.status !== 0) throw new Error('assinatura digital (codesign) invalida');
      log('Assinatura digital conferida (codesign).');
    }
    const final = join(dest, binaryName(platform));
    try { rmSync(final, { force: true }); } catch {}
    renameSync(bin, final);
    writeFileSync(join(dest, 'cloudflared-version.txt'), String(release.tag_name || ''));
    log(`Pronto: cloudflared ${release.tag_name} na pasta do TelaLink.`);
    return { path: final, version: release.tag_name };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// Execucao direta (Iniciar.bat / iniciar-mac-linux.sh).
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const dest = argv.includes('--dest') ? argv[argv.indexOf('--dest') + 1] : join(ROOT, '.runtime');
  const force = argv.includes('--force');
  const local = join(dest, binaryName());
  let found = null;
  try { found = findCloudflared(); } catch { found = null; }
  if (!force && (found || existsSync(local))) {
    const v = existsSync(join(dest, 'cloudflared-version.txt')) ? readFileSync(join(dest, 'cloudflared-version.txt'), 'utf8') : '';
    console.log(`        Link externo: Cloudflare pronto${v ? ` (${v})` : ''}.`);
  } else if (process.env.TUNNEL === '0') {
    console.log('        Link externo desligado (TUNNEL=0).');
  } else {
    try { await download({ dest }); }
    catch (err) {
      console.log(`        [AVISO] cloudflared nao foi baixado: ${err.message}`);
      console.log('        Sem problema: o link externo usa o SSH do sistema.');
    }
  }
}
