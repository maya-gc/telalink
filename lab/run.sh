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

# Publica um erro como anotacao do GitHub com o fim de um log (para diagnostico).
fail() {
  local msg="$1" log="${2:-}"
  local tail=""
  [ -n "$log" ] && [ -f "$log" ] && tail=$(tail -n 25 "$log" | sed 's/%/%25/g' | awk '{printf "%s%%0A", $0}')
  echo "::error title=Laboratorio de redes::${msg}%0A${tail}"
  exit 1
}

bash lab/rede.sh down >/dev/null 2>&1 || true
bash lab/rede.sh up > "$LAB_OUT/rede.log" 2>&1 || fail "nao foi possivel criar as redes isoladas" "$LAB_OUT/rede.log"
cat "$LAB_OUT/rede.log"

echo "== STUN no 'provedor' (203.0.113.1)"
ip netns exec inet node lab/stun-server.js > "$LAB_OUT/stun.log" 2>&1 & PIDS+=($!)

echo "== TelaLink no PC da casa"
ip netns exec casa env HOST=0.0.0.0 PORT=8080 TUNNEL=0 NO_OPEN=1 \
  PUBLIC_URL=http://203.0.113.10 TELALINK_DATA_DIR="$LAB_STATE/dados" \
  ICE_SERVERS_JSON='[{"urls":"stun:203.0.113.1:3478"}]' \
  node src/server.js > "$LAB_OUT/servidor.log" 2>&1 & PIDS+=($!)
ok=0; for i in $(seq 1 40); do ip netns exec casa curl -fsS http://localhost:8080/health >/dev/null 2>&1 && ok=1 && break; sleep 0.25; done
[ "$ok" = 1 ] || fail "o servidor TelaLink nao subiu na rede casa" "$LAB_OUT/servidor.log"

echo "== Transmissor (casa)"
ip netns exec casa node lab/host-run.js > "$LAB_OUT/host.log" 2>&1 & PIDS+=($!)
for i in $(seq 1 120); do [ -f "$LAB_STATE/sessao.json" ] && break; sleep 0.5; done
[ -f "$LAB_STATE/sessao.json" ] || fail "o transmissor nao iniciou" "$LAB_OUT/host.log"

echo "== Conferindo isolamento: a casa2 NAO alcanca o PC da casa direto (so pelo roteador)"
if ip netns exec casa2 curl -fsS --max-time 3 http://192.168.10.2:8080/health >/dev/null 2>&1; then
  fail "as redes NAO estao isoladas (casa2 alcancou o PC da casa direto)"
fi
echo "   isolamento OK"

echo "== Espectadores, cada um na sua rede"
V=()
ip netns exec casa2   node lab/viewer-run.js casa2 > "$LAB_OUT/casa2.log" 2>&1               & V+=($!)
ip netns exec vpn     node lab/viewer-run.js vpn --sem-webrtc > "$LAB_OUT/vpn.log" 2>&1    & V+=($!)
ip netns exec empresa node lab/viewer-run.js empresa > "$LAB_OUT/empresa.log" 2>&1             & V+=($!)
ip netns exec cgnat   node lab/viewer-run.js cgnat > "$LAB_OUT/cgnat.log" 2>&1               & V+=($!)
for p in "${V[@]}"; do wait "$p"; done
for n in casa2 vpn empresa cgnat; do cat "$LAB_OUT/$n.log"; done

touch "$LAB_STATE/fim"
sleep 3
node lab/resumo.js
