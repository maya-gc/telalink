#!/usr/bin/env bash
# Inicializador para macOS e Linux:  ./iniciar-mac-linux.sh
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "  [ERRO] Node.js nao encontrado. Instale a versao LTS em https://nodejs.org"
  exit 1
fi

echo "  [1/2] Autoteste rapido..."
node scripts/selfcheck.js || { echo "  [ERRO] O autoteste falhou."; exit 1; }

if ! command -v cloudflared >/dev/null 2>&1 && [ "${TUNNEL}" != "0" ]; then
  echo "  [AVISO] cloudflared nao instalado: sem link externo."
  echo "          macOS: brew install cloudflared"
  echo "          Linux: https://pkg.cloudflare.com (pacote oficial)"
fi

echo
echo "  [2/2] Iniciando. Se o navegador nao abrir, acesse http://localhost:8080"
echo "  Mantenha este terminal aberto. Ctrl+C encerra."
echo
exec node src/server.js
