// Informa ao Iniciar.bat a situacao do cloudflared, pelo codigo de saida:
//   0 = instalado e (no Windows) com assinatura digital da Cloudflare valida
//   3 = nao instalado
//   4 = encontrado, mas a assinatura nao confere (nao sera usado)
import { findCloudflared } from '../src/tunnel.js';

try {
  const found = findCloudflared();
  if (!found) process.exit(3);
  console.log(`      cloudflared: ${found.path}${found.verified ? ' (assinatura Cloudflare OK)' : ''}`);
  process.exit(0);
} catch (err) {
  console.log(`      [AVISO] ${err.message}`);
  process.exit(4);
}
