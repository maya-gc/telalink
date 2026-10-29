#!/usr/bin/env bash
# =============================================================================
#  TelaLink - prepara o Node.js no macOS e no Linux, sem administrador (sudo).
#  1. Usa o Node.js do sistema se for 20 ou mais novo.
#  2. Senao baixa o Node.js LTS OFICIAL (nodejs.org) para .runtime/node.
#  Seguranca: SHA-256 conferido com a lista oficial (SHASUMS256.txt); no macOS
#  tambem a assinatura digital (codesign) do binario.
#  Resultado: caminho do node em .runtime/node-path.txt
#  Variaveis (testes): TELALINK_NODE_DIST, TELALINK_FORCE=1, TELALINK_RUNTIME
# =============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${TELALINK_RUNTIME:-$ROOT/.runtime}"
DIST="${TELALINK_NODE_DIST:-https://nodejs.org/dist}"
MIN_MAJOR=20
say() { echo "        $*"; }
major() { "$1" --version 2>/dev/null | sed -n 's/^v\([0-9]*\)\..*/\1/p'; }
done_with() { mkdir -p "$DEST"; printf '%s' "$1" > "$DEST/node-path.txt"; exit 0; }

if [ "${TELALINK_FORCE:-0}" != "1" ]; then
  if command -v node >/dev/null 2>&1 && [ "$(major "$(command -v node)")" -ge "$MIN_MAJOR" ] 2>/dev/null; then
    say "Node.js do sistema: $(node --version)"; done_with "$(command -v node)"
  fi
  if [ -x "$DEST/node/bin/node" ] && [ "$(major "$DEST/node/bin/node")" -ge "$MIN_MAJOR" ] 2>/dev/null; then
    say "Node.js do TelaLink: $("$DEST/node/bin/node" --version)"; done_with "$DEST/node/bin/node"
  fi
fi

case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) echo "  [ERRO] sistema nao suportado: $(uname -s)"; exit 1 ;; esac
case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) echo "  [ERRO] processador nao suportado: $(uname -m)"; exit 1 ;; esac
command -v curl >/dev/null 2>&1 || { echo "  [ERRO] curl nao encontrado"; exit 1; }
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

say "Node.js nao encontrado: baixando a versao oficial (so na primeira vez)..."
# index.json: um objeto por linha; a primeira linha com "lts" diferente de false e a LTS mais nova.
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$DIST/index.json" -o "$tmp/index.json"
# (sem "head": cortar o fluxo cedo faz o grep falhar com "write error" quando o
#  sinal SIGPIPE esta ignorado, como acontece ao rodar a partir do Node.js)
ver="$(tr '{' '\n' < "$tmp/index.json" | grep '"version"' | grep -v '"lts":false' | grep -E "\"$os-$arch\"|\"osx-$arch-tar\"" | sed -n '1s/.*"version":"\(v[0-9.]*\)".*/\1/p')"
[ -n "$ver" ] || { echo "  [ERRO] nao encontrei a versao LTS"; exit 1; }
name="node-$ver-$os-$arch"; file="$name.tar.gz"
say "Versao LTS: $ver ($os-$arch)"
curl -fsSL "$DIST/$ver/$file" -o "$tmp/$file"
expected="$(curl -fsSL "$DIST/$ver/SHASUMS256.txt" | awk -v f="$file" '$2 == f { print $1 }')"
[ -n "$expected" ] || { echo "  [ERRO] $file nao esta na lista oficial de hashes"; exit 1; }
actual="$(sha256 "$tmp/$file")"
if [ "$actual" != "$expected" ]; then echo "  [ERRO] SHA-256 NAO confere (esperado $expected, recebido $actual): download recusado"; exit 1; fi
say "SHA-256 conferido com a lista oficial."
tar -xzf "$tmp/$file" -C "$tmp"
if [ "$os" = darwin ] && command -v codesign >/dev/null 2>&1 && [ "${TELALINK_SKIP_SIGNATURE:-0}" != "1" ]; then
  codesign --verify --strict "$tmp/$name/bin/node" || { echo "  [ERRO] assinatura digital do node invalida"; exit 1; }
  say "Assinatura digital conferida (codesign)."
fi
[ "$(major "$tmp/$name/bin/node")" -ge "$MIN_MAJOR" ] 2>/dev/null || { echo "  [ERRO] o Node.js baixado nao executou"; exit 1; }
mkdir -p "$DEST"; rm -rf "$DEST/node"; mv "$tmp/$name" "$DEST/node"
say "Pronto: Node.js $ver na pasta do TelaLink."
done_with "$DEST/node/bin/node"
