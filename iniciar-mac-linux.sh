#!/usr/bin/env bash
# Inicializador para macOS e Linux:  ./iniciar-mac-linux.sh
# Na primeira vez baixa sozinho o que falta (Node.js e cloudflared oficiais,
# conferidos por SHA-256 e assinatura) para a pasta .runtime - sem sudo.
cd "$(dirname "$0")" || exit 1

echo "  [1/3] Preparando o que o TelaLink precisa..."
if bash scripts/instalar-node.sh && [ -s .runtime/node-path.txt ]; then
  NODE="$(cat .runtime/node-path.txt)"
elif command -v node >/dev/null 2>&1; then
  NODE="$(command -v node)"
else
  echo "  [ERRO] Nao foi possivel preparar o Node.js. Verifique a internet ou instale a versao LTS em https://nodejs.org"
  exit 1
fi
"$NODE" scripts/baixar-cloudflared.js

echo "  [2/3] Autoteste rapido..."
"$NODE" scripts/selfcheck.js || { echo "  [ERRO] O autoteste falhou."; exit 1; }

echo
echo "  [3/3] Iniciando. Se o navegador nao abrir, acesse http://localhost:8080"
echo "  Mantenha este terminal aberto. Ctrl+C encerra."
echo
exec "$NODE" src/server.js
