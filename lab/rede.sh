#!/usr/bin/env bash
# =============================================================================
#  Laboratorio de redes do TelaLink — cria uma "internet" de mentira dentro de
#  um unico Linux, com redes isoladas (network namespaces) atras de roteadores
#  com NAT, cada uma com comportamento de uma rede real.
#
#                       ┌──────────── inet (203.0.113.0/24) ─────────────┐
#                       │  STUN 203.0.113.1                              │
#      casa-r .10   casa2-r .20   empresa-r .30   cgnat-r .40   vpn-r .50
#        │ NAT        │ NAT         │ NAT+firewall  │ NAT simetrico │ NAT
#      casa         casa2         empresa         cgnat          vpn
#   (transmissor)  (casa comum)  (so TCP 80/443)  (4G/CGNAT)  (WebRTC desligado)
#
#  Uso (precisa de root):  sudo lab/rede.sh up | down
# =============================================================================
set -euo pipefail

SITES=(casa casa2 empresa cgnat vpn)
declare -A WAN=([casa]=10 [casa2]=20 [empresa]=30 [cgnat]=40 [vpn]=50)
declare -A LAN=([casa]=10 [casa2]=20 [empresa]=30 [cgnat]=40 [vpn]=50)

ns() { ip netns exec "$@"; }

up() {
  ip netns add inet
  ns inet ip link set lo up
  ns inet ip link add br0 type bridge
  ns inet ip addr add 203.0.113.1/24 dev br0
  ns inet ip link set br0 up

  for s in "${SITES[@]}"; do
    local r="$s-r" w="${WAN[$s]}" l="${LAN[$s]}"
    ip netns add "$r"; ip netns add "$s"
    ns "$r" ip link set lo up; ns "$s" ip link set lo up

    # WAN: roteador <-> "internet"
    ip link add "w-$s" type veth peer name "wp-$s"
    ip link set "w-$s" netns "$r"; ip link set "wp-$s" netns inet
    ns inet ip link set "wp-$s" master br0; ns inet ip link set "wp-$s" up
    ns "$r" ip link set "w-$s" name wan; ns "$r" ip addr add "203.0.113.$w/24" dev wan; ns "$r" ip link set wan up

    # LAN: PC <-> roteador
    ip link add "l-$s" type veth peer name "lp-$s"
    ip link set "l-$s" netns "$r"; ip link set "lp-$s" netns "$s"
    ns "$r" ip link set "l-$s" name lan; ns "$r" ip addr add "192.168.$l.1/24" dev lan; ns "$r" ip link set lan up
    ns "$s" ip link set "lp-$s" name eth0; ns "$s" ip addr add "192.168.$l.2/24" dev eth0; ns "$s" ip link set eth0 up
    ns "$s" ip route add default via "192.168.$l.1"

    ns "$r" sysctl -qw net.ipv4.ip_forward=1
  done

  # --- casa / casa2 / vpn: NAT residencial comum (mapeamento estavel, filtro por conexao)
  for s in casa casa2 vpn; do
    ns "$s-r" iptables -t nat -A POSTROUTING -o wan -j MASQUERADE
  done
  # A porta 443 publica o proxy https do transmissor (papel da Cloudflare no mundo real).
  ns casa-r iptables -t nat -A PREROUTING -i wan -p tcp --dport 443 -j DNAT --to-destination 192.168.10.2:8443

  # Firewall padrao de roteador domestico: descarta pacotes UDP de entrada nao
  # solicitados ANTES de registra-los. (Sem isso o NAT do Linux registra o
  # pacote que chega primeiro e troca a porta da resposta, virando um NAT
  # "dificil" que nao representa um roteador comum.)
  for s in casa casa2 vpn cgnat; do
    ns "$s-r" iptables -A INPUT -i wan -p udp -m conntrack --ctstate NEW -j DROP
  done

  # --- cgnat: NAT simetrico (porta de saida muda a cada destino), como em muitas operadoras 4G
  ns cgnat-r iptables -t nat -A POSTROUTING -o wan -j MASQUERADE --random-fully

  # --- empresa: firewall corporativo, so deixa sair TCP 80/443 (nada de UDP)
  ns empresa-r iptables -t nat -A POSTROUTING -o wan -j MASQUERADE
  ns empresa-r iptables -P FORWARD DROP
  ns empresa-r iptables -A FORWARD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  ns empresa-r iptables -A FORWARD -i lan -p tcp -m multiport --dports 80,443 -j ACCEPT

  echo "rede do laboratorio criada"
}

down() {
  for s in "${SITES[@]}"; do ip netns del "$s" 2>/dev/null || true; ip netns del "$s-r" 2>/dev/null || true; done
  ip netns del inet 2>/dev/null || true
  echo "rede do laboratorio removida"
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  *) echo "uso: $0 up|down"; exit 2 ;;
esac
