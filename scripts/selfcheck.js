// =============================================================================
//  selfcheck.js — autoteste rapido (< 1 s) executado pelo Iniciar.bat antes de
//  subir o servidor de verdade. Sobe uma copia temporaria numa porta livre,
//  testa o fluxo essencial e desliga. Sai com codigo 1 se algo falhar.
// =============================================================================
import { startServer } from '../src/server.js';
import { findCloudflared, findSsh } from '../src/tunnel.js';
import { generateSessionKey, deriveKeys, sealBytes, openBytes } from '../public/crypto.js';

const watchdog = setTimeout(() => {
  console.error('      FALHA: autoteste demorou demais (timeout).');
  process.exit(1);
}, 10_000);

const checks = [];
const check = (ok, label) => { checks.push({ ok, label }); };

let app;
try {
  const [major] = process.versions.node.split('.').map(Number);
  check(major >= 18, `Node.js ${process.versions.node} (minimo 18)`);

  app = await startServer({ port: 0, host: '127.0.0.1', log: () => {} });
  const base = `http://127.0.0.1:${app.port}`;

  const health = await fetch(`${base}/health`).then((r) => r.json());
  check(health.ok === true, 'servidor HTTP responde');

  const page = await fetch(`${base}/`);
  check(page.status === 200, 'pagina do host carrega');

  const room = await fetch(`${base}/api/create-room`, { method: 'POST' }).then((r) => r.json());
  check(/^\d{6}$/.test(room.pin) && !!room.roomId, 'criacao de sala + PIN');

  if (typeof WebSocket === 'function') {
    const ok = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${app.port}`);
      const t = setTimeout(() => resolve(false), 3000);
      ws.onopen = () => ws.send(JSON.stringify({ type: 'host-join', roomId: room.roomId }));
      ws.onmessage = (e) => { clearTimeout(t); resolve(JSON.parse(e.data).type === 'host-ready'); ws.close(); };
      ws.onerror = () => { clearTimeout(t); resolve(false); };
    });
    check(ok, 'sinalizacao WebSocket');
  }
  // Seguranca: visitante externo nao pode abrir o painel.
  const ext = await fetch(`${base}/`, { headers: { 'cf-connecting-ip': '203.0.113.1' } });
  check(ext.status === 403, 'painel bloqueado para acesso externo');

  // Criptografia de ponta a ponta (mesmo codigo do navegador).
  const keys = await deriveKeys(generateSessionKey(), room.roomId);
  const msg = new TextEncoder().encode('autoteste');
  const sealed = await sealBytes(keys.media, msg);
  const back = await openBytes(keys.media, sealed);
  const tampered = sealed.slice(); tampered[20] ^= 1;
  const detects = await openBytes(keys.media, tampered).then(() => false, () => true);
  check(new TextDecoder().decode(back) === 'autoteste' && detects, 'criptografia AES-256-GCM / HKDF-SHA-512');
} catch (err) {
  check(false, `erro inesperado: ${err.message}`);
} finally {
  if (app) await app.close();
}

// Link externo: so um AVISO se faltar (o uso local continua funcionando).
const warnings = [];
if (process.env.TUNNEL !== '0') {
  try {
    let cf = null;
    try { cf = findCloudflared(); } catch { cf = null; }
    const ssh = cf ? null : findSsh();
    if (cf) check(true, `link externo: Cloudflare${cf.verified ? ' (assinatura digital verificada)' : ''}`);
    else if (ssh) check(true, `link externo: SSH do sistema (sem instalar nada)${ssh.verified ? ', assinatura Microsoft verificada' : ''}`);
    else warnings.push('nenhum metodo de link externo disponivel: so funciona neste PC');
  } catch (err) {
    warnings.push(`link externo desativado: ${err.message}`);
  }
}
clearTimeout(watchdog);

for (const c of checks) console.log(`      ${c.ok ? 'OK   ' : 'FALHA'} ${c.label}`);
for (const w of warnings) console.log(`      AVISO ${w}`);
process.exit(checks.every((c) => c.ok) ? 0 : 1);
