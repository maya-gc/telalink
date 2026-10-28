// =============================================================================
//  settings.js — configuracoes de quem transmite, guardadas FORA do projeto.
// -----------------------------------------------------------------------------
//  Local:   Windows  %APPDATA%\TelaLink\settings.json
//           outros   $XDG_CONFIG_HOME/telalink ou ~/.config/telalink
//  Segredos (tokens/senhas):
//           Windows  criptografados com DPAPI (CurrentUser): so o seu usuario
//                    do Windows, neste PC, consegue abrir.
//           outros   arquivo com permissao 600 (so o dono le).
//  Nada disso entra no repositorio do projeto.
// =============================================================================
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const PROVIDERS = ['none', 'cloudflare', 'coturn', 'static'];
export const QUALITIES = ['auto', 'alta', 'media', 'economica'];
export const SECRET_FIELDS = { cloudflare: 'apiToken', coturn: 'secret', static: 'credential' };

export const DEFAULTS = Object.freeze({
  version: 1,
  defaultMode: 'auto',              // 'auto' (direta -> TURN -> retransmissao) | 'relay' (maxima seguranca)
  turn: {
    provider: 'none',
    cloudflare: { keyId: '', apiToken: null },
    coturn: { urls: '', secret: null },
    static: { urls: '', username: '', credential: null },
  },
  capGB: 800,                       // trava de consumo mensal estimado de TURN (null = sem trava)
  tunnel: 'auto',                   // link externo: auto | cloudflare | ssh | off
  prefs: { quality: 'auto', fps: 30, hint: 'motion', audio: true, volume: 100 },
  usage: { month: '', bytes: 0 },
});

export function dataDir() {
  if (process.env.TELALINK_DATA_DIR) return process.env.TELALINK_DATA_DIR;
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'TelaLink');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'telalink');
}

// ------------------------------------------------------------- protecao
const PS_PROTECT = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$in=[Console]::In.ReadToEnd().Trim()
$b=[Convert]::FromBase64String($in)
$o=[Security.Cryptography.ProtectedData]::__OP__($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($o))`;

function dpapi(op, b64) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_PROTECT.replace('__OP__', op)], {
    input: b64, encoding: 'utf8', windowsHide: true, timeout: 20_000,
  });
  if (r.status !== 0) throw new Error('DPAPI falhou: ' + (r.stderr || r.error?.message || '').trim().slice(0, 200));
  return r.stdout.trim();
}

export function protect(secret, platform = process.platform) {
  if (secret == null || secret === '') return null;
  const b64 = Buffer.from(String(secret), 'utf8').toString('base64');
  if (platform === 'win32') return { prot: 'dpapi', data: dpapi('Protect', b64) };
  return { prot: 'file600', data: b64 };
}

export function unprotect(box, platform = process.platform) {
  if (!box) return null;
  if (box.prot === 'dpapi') {
    if (platform !== 'win32') throw new Error('segredo protegido por DPAPI so abre no Windows de origem');
    return Buffer.from(dpapi('Unprotect', box.data), 'base64').toString('utf8');
  }
  if (box.prot === 'file600') return Buffer.from(box.data, 'base64').toString('utf8');
  throw new Error('formato de segredo desconhecido');
}

export const mask = (s) => (s ? '••••••' + String(s).slice(-4) : '');

// ------------------------------------------------------------- validacao
const isStr = (v, max = 512) => typeof v === 'string' && v.length <= max;
const TURN_URL = /^turns?:[A-Za-z0-9.\-\[\]:]+(\?transport=(udp|tcp))?$/;

export function parseTurnUrls(text) {
  const urls = String(text || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  if (!urls.length) throw new Error('informe ao menos um endereco turn: ou turns:');
  if (urls.length > 8) throw new Error('no maximo 8 enderecos');
  for (const u of urls) if (!TURN_URL.test(u)) throw new Error(`endereco invalido: ${u}`);
  return urls;
}

// Aplica uma alteracao vinda do painel. Segredo vazio/ausente = manter o atual.
export function applyUpdate(current, input, { protectFn = protect } = {}) {
  if (!input || typeof input !== 'object') throw new Error('dados invalidos');
  const next = structuredClone(current);

  if (input.defaultMode !== undefined) {
    if (!['auto', 'relay'].includes(input.defaultMode)) throw new Error('modo invalido');
    next.defaultMode = input.defaultMode;
  }
  if (input.capGB !== undefined) {
    if (input.capGB !== null && !(Number.isFinite(input.capGB) && input.capGB >= 1 && input.capGB <= 100000)) {
      throw new Error('trava de consumo deve ser entre 1 e 100000 GB, ou vazia');
    }
    next.capGB = input.capGB;
  }
  if (input.tunnel !== undefined) {
    if (!['auto', 'cloudflare', 'ssh', 'off'].includes(input.tunnel)) throw new Error('metodo de link externo invalido');
    next.tunnel = input.tunnel;
  }
  if (input.prefs !== undefined) {
    const p = input.prefs;
    if (!p || typeof p !== 'object') throw new Error('preferencias invalidas');
    const out = { ...(next.prefs || DEFAULTS.prefs) };
    if (p.quality !== undefined) { if (!QUALITIES.includes(p.quality)) throw new Error('qualidade invalida'); out.quality = p.quality; }
    if (p.fps !== undefined) { if (![15, 30, 60].includes(p.fps)) throw new Error('quadros por segundo invalidos'); out.fps = p.fps; }
    if (p.hint !== undefined) { if (!['motion', 'detail'].includes(p.hint)) throw new Error('tipo de conteudo invalido'); out.hint = p.hint; }
    if (p.audio !== undefined) { if (typeof p.audio !== 'boolean') throw new Error('audio invalido'); out.audio = p.audio; }
    if (p.volume !== undefined) { if (!(Number.isInteger(p.volume) && p.volume >= 0 && p.volume <= 200)) throw new Error('volume deve ser de 0 a 200'); out.volume = p.volume; }
    next.prefs = out;
  }
  const t = input.turn;
  if (t !== undefined) {
    if (!t || !PROVIDERS.includes(t.provider)) throw new Error('provedor invalido');
    next.turn.provider = t.provider;
    if (t.cloudflare) {
      if (!isStr(t.cloudflare.keyId, 128) || !/^[A-Za-z0-9_-]*$/.test(t.cloudflare.keyId)) throw new Error('Turn Token ID invalido');
      next.turn.cloudflare.keyId = t.cloudflare.keyId;
      if (isStr(t.cloudflare.apiToken, 512) && t.cloudflare.apiToken) next.turn.cloudflare.apiToken = protectFn(t.cloudflare.apiToken);
    }
    if (t.coturn) {
      if (t.coturn.urls) parseTurnUrls(t.coturn.urls);
      next.turn.coturn.urls = String(t.coturn.urls || '');
      if (isStr(t.coturn.secret, 512) && t.coturn.secret) next.turn.coturn.secret = protectFn(t.coturn.secret);
    }
    if (t.static) {
      if (t.static.urls) parseTurnUrls(t.static.urls);
      if (!isStr(t.static.username || '', 256)) throw new Error('usuario invalido');
      next.turn.static.urls = String(t.static.urls || '');
      next.turn.static.username = String(t.static.username || '');
      if (isStr(t.static.credential, 512) && t.static.credential) next.turn.static.credential = protectFn(t.static.credential);
    }
    if (t.clearSecret && SECRET_FIELDS[t.clearSecret]) next.turn[t.clearSecret][SECRET_FIELDS[t.clearSecret]] = null;
  }
  return next;
}

// ------------------------------------------------------------- persistencia
export class SettingsStore {
  constructor({ dir = dataDir(), platform = process.platform } = {}) {
    this.dir = dir;
    this.file = join(dir, 'settings.json');
    this.platform = platform;
    this.data = structuredClone(DEFAULTS);
    this._secretCache = new Map();
  }

  load() {
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, 'utf8'));
        this.data = { ...structuredClone(DEFAULTS), ...raw, turn: { ...structuredClone(DEFAULTS.turn), ...raw.turn }, prefs: { ...DEFAULTS.prefs, ...raw.prefs } };
      } catch { /* arquivo corrompido: volta ao padrao sem derrubar o programa */ }
    }
    return this;
  }

  save() {
    mkdirSync(this.dir, { recursive: true });
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    if (this.platform !== 'win32') try { chmodSync(this.file, 0o600); } catch {}
  }

  update(input) {
    this.data = applyUpdate(this.data, input, { protectFn: (s) => protect(s, this.platform) });
    this._secretCache.clear();
    this.save();
  }

  secret(provider) {
    const field = SECRET_FIELDS[provider];
    if (!field) return null;
    if (!this._secretCache.has(provider)) {
      this._secretCache.set(provider, unprotect(this.data.turn[provider][field], this.platform));
    }
    return this._secretCache.get(provider);
  }

  // Consumo mensal estimado de TURN (zera ao virar o mes).
  addUsage(bytes, now = new Date()) {
    const month = now.toISOString().slice(0, 7);
    if (this.data.usage.month !== month) this.data.usage = { month, bytes: 0 };
    this.data.usage.bytes += bytes;
  }

  usageGB(now = new Date()) {
    return this.data.usage.month === now.toISOString().slice(0, 7) ? this.data.usage.bytes / 1e9 : 0;
  }

  overCap(now = new Date()) {
    return this.data.capGB != null && this.usageGB(now) >= this.data.capGB;
  }

  // Visao segura para o painel: nenhum segredo sai inteiro.
  publicView(now = new Date()) {
    const d = this.data;
    const view = structuredClone(d);
    for (const [p, f] of Object.entries(SECRET_FIELDS)) {
      let shown = '';
      try { shown = d.turn[p][f] ? mask(this.secret(p)) : ''; } catch { shown = '(nao foi possivel abrir neste PC)'; }
      view.turn[p][f] = shown;
    }
    view.usageGB = Number(this.usageGB(now).toFixed(2));
    view.overCap = this.overCap(now);
    view.storage = { dir: this.dir, protection: this.platform === 'win32' ? 'DPAPI (Windows, so seu usuario)' : 'arquivo com permissao 600' };
    delete view.usage;
    return view;
  }
}
