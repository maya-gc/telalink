// =============================================================================
//  tunnel-manager.js — escolhe e mantem o link externo.
//    auto       -> Cloudflare se estiver instalado (assinatura verificada);
//                  senao SSH do proprio Windows (nao precisa instalar nada)
//    cloudflare -> so Cloudflare      ssh -> so SSH      off -> sem link externo
//  O tunel sempre aponta para a PORTA EXTERNA do TelaLink (tudo ali e externo).
// =============================================================================
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { Tunnel, SshTunnel, findCloudflared, findSsh, WINGET_ID } from './tunnel.js';

export const TUNNEL_CHOICES = ['auto', 'cloudflare', 'ssh', 'off'];
export const PROVIDER_NAMES = { cloudflare: 'Cloudflare', ssh: 'SSH (localhost.run)' };

export class TunnelManager extends EventEmitter {
  constructor({
    port, dataDir, getChoice = () => 'auto', log = () => {},
    find = { cloudflare: () => findCloudflared(), ssh: () => findSsh() },
    create = {
      cloudflare: (o) => new Tunnel(o),
      ssh: (o) => new SshTunnel({ ...o, knownHostsFile: join(dataDir, 'known_hosts') }),
    },
  }) {
    super();
    Object.assign(this, { port, dataDir, getChoice, log, find, create });
    this.tunnel = null;
    this.provider = null;
    this.state = { status: 'off', url: null, error: null };
  }

  _pick(choice) {
    const tryFind = (name) => {
      try { return this.find[name]() ? name : null; }
      catch (err) { this.lastFindError = err.message; return null; }
    };
    if (choice === 'off') return { provider: null, error: 'link externo desligado nas configuracoes' };
    if (choice === 'cloudflare') {
      return tryFind('cloudflare') ? { provider: 'cloudflare' }
        : { provider: null, error: this.lastFindError || `Cloudflare nao instalado (winget install --id ${WINGET_ID} -e)` };
    }
    if (choice === 'ssh') return tryFind('ssh') ? { provider: 'ssh' } : { provider: null, error: 'SSH do Windows nao encontrado' };
    // auto
    if (tryFind('cloudflare')) return { provider: 'cloudflare' };
    if (tryFind('ssh')) return { provider: 'ssh' };
    return { provider: null, error: 'nenhum metodo de link externo disponivel neste computador' };
  }

  start() {
    this.stop();
    const choice = this.getChoice();
    const { provider, error } = this._pick(choice);
    this.choice = choice;
    if (!provider) {
      this.state = { status: choice === 'off' ? 'off' : 'error', url: null, error };
      this.emit('change', this.info());
      return;
    }
    const found = this.find[provider]();
    this.provider = provider;
    const t = this.create[provider]({ port: this.port, bin: found.path, log: this.log });
    this.tunnel = t;
    t.on('url', () => this.emit('change', this.info()));
    t.on('restart', () => this.emit('change', this.info()));
    t.on('protocol', (p) => this.emit('protocol', p));
    t.on('error-status', () => this.emit('change', this.info()));
    t.start();
    this.emit('change', this.info());
  }

  // Reinicia se a escolha mudou (chamado quando as configuracoes sao salvas).
  refresh() { if (this.getChoice() !== this.choice) this.start(); }

  info() {
    const base = this.tunnel ? this.tunnel.info() : this.state;
    return { ...base, provider: this.provider, providerName: PROVIDER_NAMES[this.provider] || null, choice: this.choice || this.getChoice() };
  }

  stop() {
    if (this.tunnel) { this.tunnel.removeAllListeners(); this.tunnel.stop(); }
    this.tunnel = null;
    this.provider = null;
  }
}
