// =============================================================================
//  tunnel.js — link publico https via Cloudflare Quick Tunnel.
// -----------------------------------------------------------------------------
//  O cloudflared abre uma conexao de SAIDA do seu PC ate a Cloudflare e recebe
//  um endereco https://<aleatorio>.trycloudflare.com.
//
//  Integridade (e por que antivirus nao reclama):
//    - O TelaLink NAO embute nem descompacta executaveis. O cloudflared e
//      instalado pelo canal oficial (winget, pacote Cloudflare.cloudflared).
//    - No Windows, antes de usar, conferimos a assinatura digital Authenticode:
//      precisa ser VALIDA e emitida para "Cloudflare, Inc.". Se nao for, nao roda.
// =============================================================================
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';
import { EventEmitter } from 'node:events';

export const WINGET_ID = 'Cloudflare.cloudflared';
const SIGNER_RE = /\bO="?Cloudflare, Inc\.?"?(,|$)/;

// Caminhos onde o instalador oficial costuma colocar o cloudflared no Windows.
export function windowsCandidates(env = process.env) {
  const list = [];
  for (const base of [env['ProgramFiles(x86)'], env.ProgramFiles]) if (base) list.push(win32.join(base, 'cloudflared', 'cloudflared.exe'));
  if (env.LOCALAPPDATA) list.push(win32.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'));
  return list;
}

// Confere a assinatura Authenticode via PowerShell (recurso nativo do Windows).
// O caminho vai por variavel de ambiente: nada de montar comando com texto externo.
export function verifyAuthenticode(file, run = spawnSync, { signer = SIGNER_RE, signerName = 'Cloudflare' } = {}) {
  const script = "$ErrorActionPreference='Stop'; Import-Module Microsoft.PowerShell.Security; "
    + '$s=Get-AuthenticodeSignature -LiteralPath $env:TL_FILE; [Console]::Out.Write("TL|$($s.Status)|$($s.SignerCertificate.Subject)")';
  // Caminho completo do Windows PowerShell (nao depende do PATH) e sem o
  // PSModulePath herdado: vindo do PowerShell 7 ele quebra o modulo de assinaturas.
  const root = process.env.SystemRoot || 'C:\\Windows';
  const ps = run === spawnSync ? win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
  const env = { ...process.env, TL_FILE: file };
  for (const k of Object.keys(env)) if (k.toLowerCase() === 'psmodulepath') delete env[k];
  const r = run(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    env, encoding: 'utf8', windowsHide: true, timeout: 20_000,
  });
  const out = String(r.stdout || '');
  if (r.status !== 0 || !out.startsWith('TL|')) {
    const detail = String(r.stderr || '').trim().split(/\r?\n/)[0];
    return { valid: false, reason: `nao foi possivel verificar a assinatura${detail ? ` (${detail.slice(0, 160)})` : ''}` };
  }
  const [, status, subject = ''] = out.split('|');
  if (status !== 'Valid') return { valid: false, reason: `assinatura ${status || 'ausente'}` };
  if (!signer.test(subject)) return { valid: false, reason: `assinado, mas nao pela ${signerName}` };
  return { valid: true, signer: 'Cloudflare, Inc.' };
}

function whichAll(platform, run) {
  const r = run(platform === 'win32' ? 'where' : 'which', ['cloudflared'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? String(r.stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
}

// Retorna { path, verified, signer } ou lanca erro explicando o problema.
// Retorna null se o cloudflared nao estiver instalado.
export function findCloudflared({ platform = process.platform, env = process.env, run = spawnSync, exists = existsSync } = {}) {
  const candidates = [];
  if (env.CLOUDFLARED_PATH) candidates.push(env.CLOUDFLARED_PATH);
  candidates.push(...whichAll(platform, run));
  if (platform === 'win32') candidates.push(...windowsCandidates(env));
  const unique = [...new Set(candidates)].filter((p) => exists(p));
  if (!unique.length) return null;

  if (platform !== 'win32') return { path: unique[0], verified: false, signer: null };

  const reasons = [];
  for (const p of unique) {
    const v = verifyAuthenticode(p, run);
    if (v.valid) return { path: p, verified: true, signer: v.signer };
    reasons.push(`${p}: ${v.reason}`);
  }
  throw new Error(`cloudflared encontrado, mas a assinatura digital nao confere (${reasons.join('; ')}). Reinstale com: winget install --id ${WINGET_ID} -e`);
}

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
export const parseTunnelUrl = (text) => (String(text).match(URL_RE) || [null])[0];

// -----------------------------------------------------------------------------
//  Tunnel: sobe o cloudflared, emite 'url' quando o link fica pronto e
//  reinicia sozinho se cair. Se a rede bloquear QUIC (UDP), a proxima
//  tentativa usa HTTP/2 sobre TCP. status: off|starting|on|error
// -----------------------------------------------------------------------------
export class Tunnel extends EventEmitter {
  constructor({ port, bin, binArgs = [], log = console.log, startTimeoutMs = 30_000, maxRestarts = 6, restartDelayMs = 3000 }) {
    super();
    Object.assign(this, { port, bin, binArgs, log, startTimeoutMs, maxRestarts, restartDelayMs });
    this.status = 'off';
    this.url = null;
    this.error = null;
    this.restarts = 0;
    this.protocol = 'auto';
    this._stopped = false;
  }

  parseUrl(text) { return parseTunnelUrl(text); }

  args() {
    const a = [...this.binArgs, 'tunnel', '--no-autoupdate'];
    if (this.protocol === 'http2') a.push('--protocol', 'http2');
    a.push('--url', `http://127.0.0.1:${this.port}`);
    return a;
  }

  start() {
    if (this._stopped) return;
    this.status = 'starting';
    this.url = null;
    let child;
    try {
      child = spawn(this.bin, this.args(), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      return this._fail(err.message);
    }
    this.child = child;
    let gotUrl = false;

    const timer = setTimeout(() => {
      if (this.status === 'starting') { this._preferHttp2(); child.kill(); }
    }, this.startTimeoutMs);
    timer.unref();

    const onData = (chunk) => {
      const text = chunk.toString();
      if (!gotUrl) {
        const url = this.parseUrl(text);
        if (url) {
          gotUrl = true;
          clearTimeout(timer);
          this.url = url;
          this.status = 'on';
          this.error = null;
          this.emit('url', url);
        }
      }
      if (process.env.TUNNEL_DEBUG) this.log('[tunel]', text.trim());
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('error', (err) => { clearTimeout(timer); this.restarts = this.maxRestarts; this._fail(err.message); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (this._stopped || this.status === 'error') return;
      if (!gotUrl) this._preferHttp2();
      this.url = null;
      if (this.restarts < this.maxRestarts) {
        this.restarts++;
        this.status = 'starting';
        this.emit('restart', { code, protocol: this.protocol });
        setTimeout(() => this.start(), this.restartDelayMs).unref();
      } else {
        this._fail('o tunel nao conseguiu se conectar (internet ou firewall bloqueando a Cloudflare?)');
      }
    });
  }

  _preferHttp2() {
    if (this.protocol !== 'http2') { this.protocol = 'http2'; this.emit('protocol', 'http2'); }
  }

  _fail(msg) {
    this.status = 'error';
    this.error = msg;
    this.url = null;
    this.emit('error-status', msg);
  }

  info() { return { status: this.status, url: this.url, error: this.error }; }

  stop() {
    this._stopped = true;
    this.status = 'off';
    this.url = null;
    if (this.child && this.child.exitCode === null) this.child.kill();
  }
}

// =============================================================================
//  Tunel via SSH (localhost.run) — NAO precisa instalar nada no Windows 10/11:
//  usa o cliente OpenSSH que ja vem com o sistema (C:\Windows\System32\OpenSSH).
//  O SSH abre uma conexao de SAIDA e o servico devolve um https publico que
//  aponta para a porta externa do TelaLink.
// =============================================================================
export const SSH_HOST = 'localhost.run';
const SSH_URL_RE = /https:\/\/[a-z0-9-]+\.(?:lhr\.life|localhost\.run)\b/i;
export const parseSshTunnelUrl = (text) => {
  for (const m of String(text).matchAll(new RegExp(SSH_URL_RE, 'gi'))) {
    if (!/^https:\/\/(www|admin|api)\./i.test(m[0])) return m[0];   // ignora links de propaganda/painel
  }
  return null;
};
const MICROSOFT_RE = /\bO="?Microsoft Corporation"?(,|$)/;

// Acha o ssh do sistema. No Windows exige assinatura valida da Microsoft.
// Lista cada ssh encontrado e o resultado da verificacao (usado no Diagnostico).
export function diagnoseSsh(opts = {}) {
  const { platform = process.platform, env = process.env, run = spawnSync, exists = existsSync } = opts;
  const candidates = [];
  if (env.TELALINK_SSH_PATH) candidates.push(env.TELALINK_SSH_PATH);
  if (platform === 'win32') candidates.push(win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe'));
  const r = run(platform === 'win32' ? 'where' : 'which', ['ssh'], { encoding: 'utf8', windowsHide: true });
  if (r.status === 0) candidates.push(...String(r.stdout).split(/\r?\n/).map((x) => x.trim()).filter(Boolean));
  return [...new Set(candidates)].map((path) => {
    if (!exists(path)) return { path, ok: false, reason: 'nao existe' };
    if (platform !== 'win32' || env.TELALINK_SSH_PATH) return { path, ok: true, verified: false };
    const v = verifyAuthenticode(path, run, { signer: MICROSOFT_RE, signerName: 'Microsoft' });
    return { path, ok: v.valid, verified: v.valid, reason: v.reason };
  });
}

// Retorna { path, verified } do primeiro ssh aceito, ou null.
// No Windows, so aceita ssh com assinatura valida da Microsoft.
export function findSsh(opts = {}) {
  const ok = diagnoseSsh(opts).find((c) => c.ok);
  return ok ? { path: ok.path, verified: ok.verified } : null;
}

export class SshTunnel extends Tunnel {
  constructor({ knownHostsFile, host = SSH_HOST, ...opts }) {
    super({ startTimeoutMs: 25_000, ...opts });
    this.knownHostsFile = knownHostsFile;
    this.host = host;
  }

  parseUrl(text) { return parseSshTunnelUrl(text); }

  args() {
    return [...this.binArgs,
      '-T',                                         // sem terminal interativo
      '-o', 'StrictHostKeyChecking=accept-new',     // guarda a chave do servidor na 1a vez e exige a mesma depois
      '-o', `UserKnownHostsFile=${this.knownHostsFile}`,
      '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=3',
      '-o', 'ExitOnForwardFailure=yes',
      '-R', `80:127.0.0.1:${this.port}`,
      `nokey@${this.host}`];
  }

  _preferHttp2() { /* nao se aplica ao SSH */ }
}
