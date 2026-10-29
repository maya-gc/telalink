// =============================================================================
//  TelaLink — servidor HTTP + sinalizacao + retransmissao cifrada
// -----------------------------------------------------------------------------
//  O servidor NUNCA ve a tela: sinalizacao e pacotes de midia chegam cifrados
//  de ponta a ponta (chave no "#" do link, que nao e enviado a servidores).
//  Ele so: serve as paginas, confere o PIN, repassa mensagens e distribui os
//  pacotes da retransmissao com controle de congestionamento.
//
//  Modelo de acesso:
//    LOCAL   = o PC de quem transmite (http://localhost:PORTA): painel,
//              configuracoes, criar sala, ser host.
//    EXTERNO = quem chega pelo tunel (ou pela rede, se HOST=0.0.0.0):
//              so a pagina de espectador e, com o PIN, assistir.
// =============================================================================

import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { randomUUID, randomInt, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { extname, join, normalize, sep, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { attachWebSocket, MAX_PAYLOAD_HARD } from './ws-lite.js';
import { DEFAULT_STUN } from './turn.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = normalize(join(__dirname, '..'));
export const PUBLIC_DIR = join(ROOT_DIR, 'public');

export const MAX_PIN_ATTEMPTS = 10;          // por sala; depois, pausa de PIN_LOCK_MS
export const PIN_LOCK_MS = 5 * 60 * 1000;
export const MAX_WS_PER_IP = 20;             // conexoes simultaneas por IP
export const UNAUTH_TIMEOUT_MS = 60 * 1000;  // conexao que nao entrou em sala e fechada
export const MESSAGE_RATE = { perSec: 30, burst: 300 }; // mensagens de texto por conexao
export const MAX_IP_FAILURES = 30;           // por IP...
export const IP_WINDOW_MS = 15 * 60 * 1000;  // ...nesta janela
export const ORPHAN_ROOM_MS = 10 * 60 * 1000;
export const MAX_VIEWERS = 50;               // por sala
export const RELAY_SOFT_QUEUE = 1.5 * 1024 * 1024; // acima disto, so quadros-chave
export const RELAY_HARD_QUEUE = 6 * 1024 * 1024;   // acima disto, descarta tudo
const MAX_BODY = 16 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
  'content-security-policy': CSP,
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), bluetooth=(), payment=(), display-capture=(self), fullscreen=(self), picture-in-picture=(self), clipboard-write=(self)',
  'cross-origin-resource-policy': 'same-origin',
  'x-permitted-cross-domain-policies': 'none',
  'origin-agent-cluster': '?1',
};

// Rotas que so o dono do PC pode usar.
const HOST_ONLY = new Set(['/', '/host', '/host.html', '/host.js', '/config', '/config.html', '/config.js',
  '/api/create-room', '/api/info', '/api/settings', '/api/settings/test']);

// --------------------------------------------------------------- PIN
export const generatePin = () => String(randomInt(100000, 1000000));
const pinTag = (roomKey, pin) => createHmac('sha512', roomKey).update(String(pin)).digest();
export function pinMatches(roomKey, tag, pin) {
  if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) return false;
  return timingSafeEqual(tag, pinTag(roomKey, pin));
}

// --------------------------------------------------------------- quem e quem
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const hostnameOf = (hostHeader = '') => hostHeader.toLowerCase().replace(/:\d+$/, '');

export function isExternal(req) {
  // Tudo que chega pela porta externa (a dos tuneis) e externo, sempre,
  // independente de cabecalhos: nao depende do provedor do tunel.
  if (req.socket.__telalinkExternal) return true;
  const h = req.headers;
  if (h['cf-connecting-ip'] || h['cf-ray'] || h['x-forwarded-for'] || h['forwarded']) return true;
  return !LOOPBACK.has(req.socket.remoteAddress);
}

export function isLocal(req) {
  return !isExternal(req) && LOCAL_HOSTNAMES.has(hostnameOf(req.headers.host));
}

// IP de quem chegou pelo tunel. So confia no cabecalho que o PROVEDOR ATIVO
// escreve (um visitante pode inventar cabecalhos):
//   Cloudflare: CF-Connecting-IP (a Cloudflare sobrescreve o que vier do visitante);
//   outros: o ULTIMO item de X-Forwarded-For (acrescentado pelo proxy, nao pelo visitante).
export function clientIp(req, provider = null) {
  const h = req.headers;
  const direct = req.socket.remoteAddress;
  if (!isExternal(req)) return direct;
  if (provider === 'cloudflare' && h['cf-connecting-ip']) return String(h['cf-connecting-ip']).trim();
  const xff = String(h['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : direct;
}

export function originOk(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host.toLowerCase() === String(req.headers.host || '').toLowerCase(); }
  catch { return false; }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return reject(Object.assign(new Error('use application/json'), { status: 415 }));
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('corpo grande demais'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('JSON invalido'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

// -----------------------------------------------------------------------------
//  Cria (sem iniciar) o servidor.
// -----------------------------------------------------------------------------
export function createServer({
  log = console.log,
  getTunnelInfo = () => ({ status: 'off', url: null, error: null }),
  iceProvider = { forSession: async () => [...DEFAULT_STUN], publicServers: () => [...DEFAULT_STUN], test: async () => ({ ok: true, message: 'sem TURN', servers: [] }) },
  settings = null,
  onRequest = null,
  onSettingsChanged = () => {},
  limits: limitsIn = {},
} = {}) {
  // Limites (ajustaveis nos testes).
  const limits = { pinLockMs: PIN_LOCK_MS, maxWsPerIp: MAX_WS_PER_IP, unauthTimeoutMs: UNAUTH_TIMEOUT_MS, messageRate: MESSAGE_RATE,
    heartbeatMs: 25_000, idleMs: 75_000, ...limitsIn };
  const rooms = new Map();
  const ipFailures = new Map(); // ip -> { count, resetAt }

  const json = (res, status, obj) => {
    res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  const text = (res, status, msg) => {
    res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
    res.end(msg);
  };

  async function handleApi(req, res, pathname) {
    if (pathname === '/api/create-room') {
      if (req.method !== 'POST') return text(res, 405, 'Use POST');
      const roomId = randomUUID();
      const pin = generatePin();
      const roomKey = randomBytes(64);
      rooms.set(roomId, {
        roomKey, pinTag: pinTag(roomKey, pin), host: null, viewers: new Map(), relay: new Set(),
        attempts: 0, createdAt: Date.now(), lastKeyReq: 0,
      });
      return json(res, 200, { roomId, pin });
    }
    if (pathname === '/api/info') {
      const conexao = settings ? {
        defaultMode: settings.data.defaultMode,
        provider: settings.data.turn.provider,
        capGB: settings.data.capGB,
        usageGB: Number(settings.usageGB().toFixed(2)),
        overCap: settings.overCap(),
        turnError: iceProvider.lastError || null,
        tunnel: settings.data.tunnel,
      } : { defaultMode: 'auto', provider: 'none', capGB: null, usageGB: 0, overCap: false, turnError: null, tunnel: 'auto' };
      const prefs = settings ? settings.data.prefs : { quality: 'auto', fps: 30, hint: 'motion', audio: true, volume: 100, bitrate: 0, notify: true };
      return json(res, 200, { tunnel: getTunnelInfo(), defaultMode: conexao.defaultMode, conexao, prefs });
    }
    if (pathname === '/api/settings') {
      if (!settings) return text(res, 404, 'Configuracoes indisponiveis');
      if (req.method === 'GET') return json(res, 200, settings.publicView());
      if (req.method === 'PUT') {
        const body = await readJson(req);
        try { settings.update(body); } catch (err) { return json(res, 400, { error: err.message }); }
        iceProvider.cache = null;
        try { onSettingsChanged(settings.data); } catch {}
        return json(res, 200, settings.publicView());
      }
      return text(res, 405, 'Metodo nao permitido');
    }
    if (pathname === '/api/settings/test') {
      if (req.method !== 'POST') return text(res, 405, 'Use POST');
      return json(res, 200, await iceProvider.test());
    }
    if (pathname === '/api/ice') return json(res, 200, { iceServers: iceProvider.publicServers() });
    if (pathname === '/health') return json(res, 200, { ok: true });
    return null;
  }

  const handler = async (req, res) => {
    try {
      onRequest?.(req);
      const url = new URL(req.url, 'http://localhost');
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); }
      catch { return text(res, 400, 'Requisicao invalida'); }

      if (HOST_ONLY.has(pathname)) {
        if (!isLocal(req)) {
          return text(res, 403, 'Esta pagina e so para quem esta transmitindo.\n' +
                                'Se voce recebeu um link para assistir, abra o link completo (com /view?room=...).');
        }
        if (req.method !== 'GET' && req.method !== 'HEAD' && !originOk(req)) return text(res, 403, 'Origem nao permitida');
      }

      if (pathname.startsWith('/api/') || pathname === '/health') {
        const handled = await handleApi(req, res, pathname);
        if (handled === null) text(res, 404, 'Nao encontrado');
        return;
      }

      if (pathname === '/' || pathname === '/host') pathname = '/host.html';
      else if (pathname === '/view' || pathname === '/viewer') pathname = '/viewer.html';
      else if (pathname === '/config') pathname = '/config.html';

      const filePath = normalize(join(PUBLIC_DIR, pathname));
      if (!filePath.startsWith(PUBLIC_DIR + sep)) return text(res, 403, 'Proibido');
      if (!existsSync(filePath) || !statSync(filePath).isFile()) return text(res, 404, 'Nao encontrado');
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': MIME[extname(filePath)] || 'application/octet-stream' });
      createReadStream(filePath).pipe(res);
    } catch (err) {
      if (err.status) return text(res, err.status, err.message);
      log('[erro http]', err.message);
      if (!res.headersSent) res.writeHead(500, SECURITY_HEADERS);
      res.end('Erro interno');
    }
  };
  const server = http.createServer(handler);
  // Porta exclusiva para os tuneis (Cloudflare, SSH...): tudo que chega aqui e externo.
  const externalServer = http.createServer(handler);
  externalServer.on('connection', (sock) => { sock.__telalinkExternal = true; });

  // ---------------------------------------------------------------- WebSocket
  const wss = attachWebSocket([server, externalServer], { messageRate: limits.messageRate, heartbeatMs: limits.heartbeatMs, idleMs: limits.idleMs });
  const wsPerIp = new Map();
  wss.verify = (req) => {
    if (originOk(req)) return true;
    const t = getTunnelInfo();
    try { return !!t.url && new URL(req.headers.origin).host === new URL(t.url).host; } catch { return false; }
  };
  const send = (ws, obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };

  const ipBlocked = (ip) => {
    const e = ipFailures.get(ip);
    if (!e) return false;
    if (Date.now() > e.resetAt) { ipFailures.delete(ip); return false; }
    return e.count >= MAX_IP_FAILURES;
  };
  const ipFail = (ip) => {
    const e = ipFailures.get(ip);
    if (!e || Date.now() > e.resetAt) ipFailures.set(ip, { count: 1, resetAt: Date.now() + IP_WINDOW_MS });
    else e.count++;
  };

  const requestKeyframe = (room) => {
    const now = Date.now();
    if (now - room.lastKeyReq < 1000) return;
    room.lastKeyReq = now;
    send(room.host, { type: 'relay-keyframe' });
  };

  // Distribui um pacote do host para quem esta na retransmissao.
  function fanOut(room, buf) {
    const isVideo = buf[0] === 1;
    const isKey = (buf[1] & 1) === 1;
    let wantKey = false;
    for (const v of room.relay) {
      const q = v.bufferedAmount;
      if (q > RELAY_HARD_QUEUE) { v.needKey = true; wantKey = true; continue; }
      if (isVideo) {
        if (isKey) { if (q > RELAY_SOFT_QUEUE * 2) { wantKey = true; continue; } v.needKey = false; }
        else if (v.needKey || q > RELAY_SOFT_QUEUE) { v.needKey = true; wantKey = true; continue; }
      } else if (q > RELAY_SOFT_QUEUE) continue; // audio: descarta se a fila estiver cheia
      v.sendBinary(buf);
    }
    if (wantKey) requestKeyframe(room);
  }

  wss.on('connection', (ws, req) => {
    ws.meta = { role: null, roomId: null, viewerId: null };
    ws.local = isLocal(req);
    ws.ip = clientIp(req, getTunnelInfo().provider);
    // Limite de conexoes simultaneas por IP (o PC local nao tem limite).
    if (!ws.local) {
      const n = (wsPerIp.get(ws.ip) || 0) + 1;
      wsPerIp.set(ws.ip, n);
      ws.on('close', () => { const m = (wsPerIp.get(ws.ip) || 1) - 1; if (m <= 0) wsPerIp.delete(ws.ip); else wsPerIp.set(ws.ip, m); });
      if (n > limits.maxWsPerIp) { ws.close(); return; }
    }
    // Quem conecta e nao entra em nenhuma sala e desconectado.
    const unauth = setTimeout(() => { if (!ws.meta.role) ws.close(); }, limits.unauthTimeoutMs);
    unauth.unref?.();
    ws.on('close', () => clearTimeout(unauth));

    ws.on('binary', (buf) => {
      const room = rooms.get(ws.meta.roomId);
      // So o host da sala pode enviar midia.
      if (ws.meta.role !== 'host' || !room || buf.length < 30 || (buf[0] !== 1 && buf[0] !== 2)) { ws.close(); return; }
      fanOut(room, buf);
    });

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      const room = rooms.get(ws.meta.roomId || msg.roomId);

      switch (msg.type) {
        case 'host-join': {
          if (!ws.local) return send(ws, { type: 'error', reason: 'proibido' });
          if (!room) return send(ws, { type: 'error', reason: 'sala-inexistente' });
          if (room.host && room.host !== ws) return send(ws, { type: 'error', reason: 'sala-ja-tem-host' });
          room.host = ws;
          ws.meta = { role: 'host', roomId: msg.roomId, viewerId: null };
          ws.maxPayload = MAX_PAYLOAD_HARD;
          const iceServers = await iceProvider.forSession();
          return send(ws, { type: 'host-ready', roomId: msg.roomId, iceServers });
        }
        case 'viewer-join': {
          if (ws.meta.role) return;
          if (ipBlocked(ws.ip)) return send(ws, { type: 'error', reason: 'bloqueado' });
          if (!room) { ipFail(ws.ip); return send(ws, { type: 'error', reason: 'sala-inexistente' }); }
          // Muitas tentativas erradas: pausa de alguns minutos (nao trava a sala
          // para sempre — senao qualquer um com o link derrubaria a transmissao).
          if (room.lockUntil && Date.now() < room.lockUntil) return send(ws, { type: 'error', reason: 'bloqueado' });
          if (!pinMatches(room.roomKey, room.pinTag, msg.pin)) {
            room.attempts++;
            room.totalFailures = (room.totalFailures || 0) + 1;
            ipFail(ws.ip);
            if (room.attempts >= MAX_PIN_ATTEMPTS) { room.lockUntil = Date.now() + limits.pinLockMs; room.attempts = 0; }
            send(room.host, { type: 'pin-failures', count: room.totalFailures, lockedUntil: room.lockUntil || 0 });
            return send(ws, { type: 'error', reason: room.lockUntil > Date.now() ? 'bloqueado' : 'pin-invalido' });
          }
          if (room.locked) return send(ws, { type: 'error', reason: 'sala-trancada' });
          if (room.viewers.size >= MAX_VIEWERS) return send(ws, { type: 'error', reason: 'sala-cheia' });
          const viewerId = randomUUID();
          room.viewers.set(viewerId, ws);
          ws.meta = { role: 'viewer', roomId: msg.roomId, viewerId };
          // Credenciais TURN temporarias: so para quem acertou o PIN.
          const iceServers = await iceProvider.forSession();
          send(ws, { type: 'viewer-accepted', viewerId, iceServers });
          return send(room.host, { type: 'viewer-joined', viewerId });
        }
        case 'signal': {
          if (!room) return;
          if (ws.meta.role === 'host') {
            send(room.viewers.get(msg.viewerId), { type: 'signal', from: 'host', data: msg.data });
          } else if (ws.meta.role === 'viewer') {
            send(room.host, { type: 'signal', from: 'viewer', viewerId: ws.meta.viewerId, data: msg.data });
          }
          return;
        }
        case 'relay-subscribe': {
          if (ws.meta.role !== 'viewer' || !room || room.relay.has(ws)) return;
          ws.needKey = true;
          room.relay.add(ws);
          send(room.host, { type: 'relay-want', viewerId: ws.meta.viewerId });
          room.lastKeyReq = 0;
          return requestKeyframe(room);
        }
        case 'relay-need-key': {
          if (ws.meta.role !== 'viewer' || !room || !room.relay.has(ws)) return;
          ws.needKey = true;
          return requestKeyframe(room);
        }
        case 'kick': {
          // Host remove um espectador da transmissao.
          if (ws.meta.role !== 'host' || !room) return;
          const v = room.viewers.get(msg.viewerId);
          if (!v) return;
          send(v, { type: 'kicked' });
          room.viewers.delete(msg.viewerId);
          room.relay.delete(v);
          v.meta = { role: null, roomId: null, viewerId: null };
          setTimeout(() => v.close(), 50);
          return send(ws, { type: 'viewer-left', viewerId: msg.viewerId });
        }
        case 'new-pin': {
          // Host gera um PIN novo (ex.: alguem esta tentando adivinhar). Quem ja
          // assiste continua; tentativas e pausa sao zeradas.
          if (ws.meta.role !== 'host' || !room) return;
          const pin = generatePin();
          room.pinTag = pinTag(room.roomKey, pin);
          room.attempts = 0; room.lockUntil = 0; room.totalFailures = 0;
          return send(ws, { type: 'pin', pin });
        }
        case 'lock': {
          // Host tranca/destranca a sala para novas entradas.
          if (ws.meta.role !== 'host' || !room) return;
          room.locked = msg.locked === true;
          return send(ws, { type: 'locked', locked: room.locked });
        }
        case 'turn-usage': {
          // Host informa bytes que passaram por TURN (para a trava de consumo).
          if (ws.meta.role !== 'host' || !settings) return;
          const b = Number(msg.bytes);
          if (Number.isFinite(b) && b > 0 && b < 10e9) settings.addUsage(b);
          return;
        }
        default: return;
      }
    });

    ws.on('close', () => {
      const { role, roomId, viewerId } = ws.meta;
      const room = rooms.get(roomId);
      if (!room) return;
      if (role === 'host') {
        for (const v of room.viewers.values()) send(v, { type: 'host-left' });
        rooms.delete(roomId);
      } else if (role === 'viewer') {
        room.viewers.delete(viewerId);
        room.relay.delete(ws);
        send(room.host, { type: 'viewer-left', viewerId });
      }
    });
  });

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, room] of rooms) {
      if (!room.host && now - room.createdAt > ORPHAN_ROOM_MS) rooms.delete(id);
    }
    for (const [ip, e] of ipFailures) if (now > e.resetAt) ipFailures.delete(ip);
    try { settings?.save(); } catch {}
  }, 60 * 1000);
  sweeper.unref();
  server.on('close', () => { clearInterval(sweeper); clearInterval(wss.heartbeat); });

  return { server, externalServer, rooms, wss };
}

// -----------------------------------------------------------------------------
//  Inicia o servidor. port=0 escolhe uma porta livre (usado nos testes).
// -----------------------------------------------------------------------------
export function startServer({ port = 8080, externalPort = 0, host = '127.0.0.1', ...opts } = {}) {
  const app = createServer(opts);
  const listen = (srv, p) => new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(p, host, () => { srv.off('error', reject); resolve(srv.address().port); });
  });
  return (async () => {
    app.port = await listen(app.server, port);
    // A porta externa escuta SEMPRE so em 127.0.0.1: so o tunel local a alcanca.
    app.externalPort = await new Promise((resolve, reject) => {
      app.externalServer.once('error', reject);
      app.externalServer.listen(externalPort, '127.0.0.1', () => resolve(app.externalServer.address().port));
    }).catch((err) => { app.server.close(); throw err; });
    app.close = () => {
      const closing = [app.server, app.externalServer].map((srv) => new Promise((r) => srv.close(() => r())));
      app.wss.terminateAll();                       // conexoes WebSocket primeiro (o http.Server nao as fecha)
      for (const srv of [app.server, app.externalServer]) srv.closeAllConnections?.();
      return Promise.all(closing).then(() => {});
    };
    return app;
  })();
}

function openBrowser(url) {
  if (process.env.NO_OPEN) return;
  try {
    const win = process.platform === 'win32';
    const cmd = win ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = win ? ['/c', 'start', '', url] : [url];
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
  } catch { /* usuario abre na mao */ }
}

// -----------------------------------------------------------------------------
//  Execucao direta: node src/server.js
// -----------------------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { TunnelManager } = await import('./tunnel-manager.js');
  const { SettingsStore } = await import('./settings.js');
  const { IceProvider } = await import('./turn.js');
  const { isElevated, lowerPriority, ADMIN_WARNING } = await import('./sistema.js');
  lowerPriority();                       // nunca disputa processador com jogos/aplicativos
  if (isElevated()) for (const l of ADMIN_WARNING) console.log(l);
  const envPort = (name, def) => (process.env[name] !== undefined && process.env[name] !== '' ? Number(process.env[name]) : def);
  const port = envPort('PORT', 8080);
  const externalPort = envPort('EXT_PORT', port === 0 ? 0 : port + 1);
  const host = process.env.HOST || '127.0.0.1';

  const settings = new SettingsStore().load();
  let stun;
  try { stun = process.env.ICE_SERVERS_JSON ? JSON.parse(process.env.ICE_SERVERS_JSON) : undefined; } catch { stun = undefined; }
  const iceProvider = new IceProvider({ settings, ...(stun ? { stun } : {}) });

  // PUBLIC_URL: endereco publico fixo (proxy reverso proprio ou laboratorio de testes).
  const fixedUrl = process.env.PUBLIC_URL ? process.env.PUBLIC_URL.replace(/\/+$/, '') : null;
  let manager = null;
  const getTunnelInfo = () => (fixedUrl ? { status: 'on', url: fixedUrl, error: null, provider: 'fixo', providerName: 'endereco fixo' }
    : manager ? manager.info() : { status: 'off', url: null, error: 'link externo desligado' });

  try {
    const app = await startServer({
      port, externalPort, host, settings, iceProvider, getTunnelInfo,
      onSettingsChanged: () => manager?.refresh(),
    });
    const localUrl = `http://localhost:${app.port}/`;
    console.log('');
    console.log('  TelaLink rodando');
    console.log(`  Painel (so neste PC):  ${localUrl}`);
    console.log(`  Configuracoes ficam em: ${settings.dir}`);

    if (fixedUrl) {
      console.log(`  Endereco publico fixo: ${fixedUrl}`);
    } else if (process.env.TUNNEL !== '0') {
      manager = new TunnelManager({ port: app.externalPort, dataDir: settings.dir, getChoice: () => settings.data.tunnel || 'auto' });
      let lastUrl = null;
      manager.on('change', (i) => {
        if (i.status === 'on' && i.url !== lastUrl) {
          lastUrl = i.url;
          console.log('');
          console.log(`  Link externo ATIVO (${i.providerName}):  ${i.url}`);
          console.log('');
        } else if (i.status === 'error') {
          console.log(`  [AVISO] Link externo indisponivel: ${i.error}`);
        } else if (i.status === 'starting') {
          lastUrl = null;
          console.log(`  Preparando link externo${i.providerName ? ` (${i.providerName})` : ''}...`);
        }
      });
      manager.on('protocol', () => console.log('  [tunel] rede bloqueando QUIC: tentando via HTTP/2 (TCP)...'));
      manager.start();
    } else {
      console.log('  Link externo desligado (TUNNEL=0).');
    }

    console.log('');
    console.log('  MANTENHA ESTA JANELA ABERTA enquanto transmite.');
    console.log('');
    openBrowser(localUrl);

    const shutdown = () => { manager?.stop(); try { settings.save(); } catch {} app.close().then(() => process.exit(0)); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('SIGHUP', shutdown);
    process.on('exit', () => manager?.stop());
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  [ERRO] A porta ${err.port || port} ja esta em uso (outra copia aberta?).`);
      console.error('  Feche a outra janela ou use outra porta (veja o README).\n');
    } else {
      console.error('\n  [ERRO] Nao foi possivel iniciar:', err.message, '\n');
    }
    process.exitCode = 1;
  }
}
