// =============================================================================
//  sistema.js — o TelaLink se comporta como um programa comum e discreto.
//  - Avisa se estiver rodando como ADMINISTRADOR (nao precisa; programa com
//    privilegio elevado e mais arriscado e chama mais atencao de antivirus e
//    anti-cheats).
//  - Roda com prioridade ABAIXO DO NORMAL (o servidor e os tuneis nunca
//    disputam processador com um jogo aberto).
//  Nada aqui toca em outros processos: so consulta o proprio.
// =============================================================================
import { spawnSync } from 'node:child_process';
import { setPriority, constants } from 'node:os';

export function isElevated({ platform = process.platform, run = spawnSync, getuid = process.getuid } = {}) {
  try {
    if (platform === 'win32') {
      // "net session" so funciona para administrador (consulta somente leitura).
      return run('net', ['session'], { stdio: 'ignore', windowsHide: true, timeout: 5000 }).status === 0;
    }
    return typeof getuid === 'function' && getuid() === 0;
  } catch { return false; }
}

// Prioridade abaixo do normal para o proprio processo (ou um filho, como o tunel).
export function lowerPriority(pid = process.pid, { env = process.env, set = setPriority } = {}) {
  if (env.TELALINK_PRIORITY === 'normal') return false;
  try { set(pid, constants.priority.PRIORITY_BELOW_NORMAL); return true; } catch { return false; }
}

export const ADMIN_WARNING = [
  '  [AVISO] O TelaLink esta rodando como ADMINISTRADOR.',
  '          Nao precisa: feche e abra o Iniciar.bat com duplo-clique normal.',
  '          (Programas com privilegio elevado chamam mais atencao de antivirus e anti-cheats.)',
];
