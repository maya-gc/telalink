#!/usr/bin/env bash
# =============================================================================
#  Roda o laboratorio completo: cria as redes, sobe STUN + TelaLink na "casa",
#  abre um transmissor e um espectador em cada rede, e confere os resultados.
#  Precisa de root (Linux):  sudo -E env "PATH=$PATH" bash lab/run.sh
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."

export LAB_OUT="${LAB_OUT:-$PWD/lab-results}"
export LAB_STATE=/tmp/telalink-lab
rm -rf "$LAB_OUT" "$LAB_STATE"; mkdir -p "$LAB_OUT" "$LAB_STATE"
PIDS=()

cleanup() {
  touch "$LAB_STATE/fim"
  sleep 2
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  bash lab/rede.sh down >/dev/null 2>&1 || true
}
trap cleanup EXIT

bash lab/rede.sh down >/dev/null 2>&1 || true
bash lab/rede.sh up

echo "== STUN no 'provedor' (203.0.113.1)"
ip netns exec inet node lab/stun-server.js > "$LAB_OUT/stun.log" 2>&1 & PIDS+=($!)

echo "== TelaLink no PC da casa"
ip netns exec casa env HOST=0.0.0.0 PORT=8080 TUNNEL=0 NO_OPEN=1 \
  PUBLIC_URL=http://203.0.113.10 TELALINK_DATA_DIR="$LAB_STATE/dados" \
  ICE_SERVERS_JSON='[{"urls":"stun:203.0.113.1:3478"}]' \
  node src/server.js > "$LAB_OUT/servidor.log" 2>&1 & PIDS+=($!)
for i in $(seq 1 40); do ip netns exec casa curl -fsS http://localhost:8080/health >/dev/null 2>&1 && break; sleep 0.25; done

echo "== Transmissor (casa)"
ip netns exec casa node lab/host-run.js > "$LAB_OUT/host.log" 2>&1 & PIDS+=($!)
for i in $(seq 1 120); do [ -f "$LAB_STATE/sessao.json" ] && break; sleep 0.5; done
[ -f "$LAB_STATE/sessao.json" ] || { echo "transmissor nao iniciou"; cat "$LAB_OUT/host.log"; exit 1; }

echo "== Conferindo isolamento: a casa2 NAO alcanca o PC da casa direto (so pelo roteador)"
if ip netns exec casa2 curl -fsS --max-time 3 http://192.168.10.2:8080/health >/dev/null 2>&1; then
  echo "ERRO: redes nao estao isoladas"; exit 1
fi
echo "   isolamento OK"

echo "== Espectadores, cada um na sua rede"
V=()
ip netns exec casa2   node lab/viewer-run.js casa2               & V+=($!)
ip netns exec vpn     node lab/viewer-run.js vpn --sem-webrtc    & V+=($!)
ip netns exec empresa node lab/viewer-run.js empresa             & V+=($!)
ip netns exec cgnat   node lab/viewer-run.js cgnat               & V+=($!)
for p in "${V[@]}"; do wait "$p"; done

touch "$LAB_STATE/fim"
sleep 3
node lab/resumo.js
