// =============================================================================
//  turn.js — monta a lista de servidores ICE (STUN/TURN) entregue aos navegadores.
// -----------------------------------------------------------------------------
//  Regras de seguranca:
//    - Segredos (API token, segredo do coturn) NUNCA saem deste PC. O navegador
//      recebe so credenciais TEMPORARIAS (algumas horas).
//    - Credenciais TURN so sao entregues a quem ja provou o PIN (ver server.js);
//      a rota publica /api/ice entrega apenas STUN.
//    - Se a trava de consumo mensal estourar, o TURN some da lista e quem
//      precisar cai automaticamente na retransmissao pelo link.
// =============================================================================
import { createHmac } from 'node:crypto';
import { parseTurnUrls } from './settings.js';

export const DEFAULT_STUN = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];

export const TTL_SECONDS = 4 * 3600;
const CLOUDFLARE_API = 'https://rtc.live.cloudflare.com/v1/turn/keys';

// Navegadores bloqueiam a porta 53; URLs assim so geram erro.
const usable = (urls) => urls.filter((u) => !/:53(\?|$)/.test(u));

// Credenciais temporarias no padrao "TURN REST API" (usado pelo coturn com
// use-auth-secret). O HMAC-SHA1 aqui e exigido pelo protocolo do coturn; ele
// so autentica o pedido ao TURN, nao protege o conteudo (que e cifrado E2E).
export function coturnCredentials(secret, urls, { now = Date.now(), ttl = TTL_SECONDS, user = 'telalink' } = {}) {
  const username = `${Math.floor(now / 1000) + ttl}:${user}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { urls, username, credential };
}

export class IceProvider {
  constructor({ settings, fetchImpl = globalThis.fetch, stun = DEFAULT_STUN, now = () => Date.now() }) {
    Object.assign(this, { settings, fetchImpl, stun, now });
    this.cache = null; // { servers, expiresAt, key }
    this.lastError = null;
  }

  // Lista completa (STUN + TURN temporario) para host e espectadores aprovados.
  async forSession() {
    const turn = await this.turnServers().catch((err) => { this.lastError = err.message; return []; });
    return [...this.stun, ...turn];
  }

  // So STUN (rota publica).
  publicServers() { return [...this.stun]; }

  async turnServers() {
    const s = this.settings.data;
    if (s.turn.provider === 'none' || this.settings.overCap()) return [];
    const key = JSON.stringify([s.turn.provider, s.turn[s.turn.provider]]);
    if (this.cache && this.cache.key === key && this.cache.expiresAt > this.now()) return this.cache.servers;

    let servers;
    switch (s.turn.provider) {
      case 'cloudflare': servers = await this.cloudflare(); break;
      case 'coturn': {
        const secret = this.settings.secret('coturn');
        if (!secret) throw new Error('segredo do coturn nao configurado');
        servers = [coturnCredentials(secret, parseTurnUrls(s.turn.coturn.urls), { now: this.now() })];
        break;
      }
      case 'static': {
        const credential = this.settings.secret('static');
        servers = [{ urls: parseTurnUrls(s.turn.static.urls), username: s.turn.static.username, credential }];
        break;
      }
      default: servers = [];
    }
    // Renova com folga (metade da validade) para ninguem receber senha vencendo.
    this.cache = { key, servers, expiresAt: this.now() + (TTL_SECONDS * 1000) / 2 };
    this.lastError = null;
    return servers;
  }

  async cloudflare() {
    const { keyId } = this.settings.data.turn.cloudflare;
    const token = this.settings.secret('cloudflare');
    if (!keyId || !token) throw new Error('Turn Token ID ou API Token nao configurados');
    const res = await this.fetchImpl(`${CLOUDFLARE_API}/${encodeURIComponent(keyId)}/credentials/generate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl: TTL_SECONDS }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) throw new Error('Cloudflare recusou as credenciais (confira o Token ID e o API Token)');
    if (!res.ok) throw new Error(`Cloudflare respondeu ${res.status}`);
    const body = await res.json();
    const ice = body && body.iceServers;
    if (!ice || !Array.isArray(ice.urls) || !ice.username || !ice.credential) throw new Error('resposta inesperada da Cloudflare');
    return [{ urls: usable(ice.urls), username: ice.username, credential: ice.credential }];
  }

  // Usado pelo botao "Testar" do painel.
  async test() {
    this.cache = null;
    try {
      const servers = await this.turnServers();
      if (!servers.length) {
        return { ok: true, message: this.settings.overCap() ? 'Trava de consumo atingida: TURN pausado ate o proximo mes.' : 'Sem TURN configurado: a retransmissao pelo link cobre as redes dificeis.', servers: [] };
      }
      return { ok: true, message: 'Credenciais geradas. Testando conexao com o servidor TURN no navegador...', servers };
    } catch (err) {
      return { ok: false, message: err.message, servers: [] };
    }
  }
}
