# Arquitetura

## Visão geral

```
 PC de quem transmite                                     Quem assiste (qualquer rede)
 ┌───────────────────────────────────────┐               ┌──────────────────────────┐
 │ Navegador: painel (host.js)           │               │ Navegador: viewer.js     │
 │  getDisplayMedia → WebRTC / WebCodecs │               │  WebRTC / WebCodecs      │
 │  AES-256-GCM com a chave do link      │               │  AES-256-GCM (mesma chave│
 │            │ localhost                │               │  vinda do "#" do link)   │
 │ Servidor TelaLink (Node, 127.0.0.1)   │   https/wss   │            │             │
 │  páginas · sinalização · retransmissão│◄─ cloudflared ─┼── Cloudflare ┘             │
 └───────────────────────────────────────┘   (saída)     └──────────────────────────┘
          ▲ mídia direta (WebRTC, DTLS-SRTP) quando a rede permite ▲
```

## Componentes

| Arquivo | Responsabilidade |
|---|---|
| `src/server.js` | HTTP (páginas, API local), controle de acesso local/externo, PIN, sinalização, distribuição da retransmissão com controle de fila |
| `src/ws-lite.js` | WebSocket RFC 6455 sem dependências (texto, binário, fragmentação, limites) |
| `src/tunnel.js` | Localiza o `cloudflared`, verifica a assinatura Authenticode, mantém o túnel (reconexão, fallback HTTP/2) |
| `src/settings.js` | Configurações em `%APPDATA%\TelaLink`, segredos com DPAPI, validação, trava de consumo |
| `src/turn.js` | Lista de servidores ICE; credenciais TURN temporárias (Cloudflare, coturn, fixo) |
| `public/crypto.js` | Chave de sessão, HKDF-SHA-512, AES-256-GCM, canal de sinalização com anti-replay |
| `public/media-util.js` | Formato dos pacotes de mídia, detector de tela preta |
| `public/relay.js` | Retransmissão: codifica (VP8/Opus), cifra, envia; recebe, decifra, decodifica, desenha/toca |
| `public/host.js`, `viewer.js`, `config.js` | Páginas |

## Fluxo de uma sessão

1. **Criação** — o painel (local) chama `POST /api/create-room`; recebe `roomId` (UUID) e PIN. O navegador gera a **chave de sessão K** (256 bits) e monta o link `…/view?room=ID#k=K`.
2. **Entrada** — o espectador abre o link; a página lê K do fragmento (que o navegador não envia ao servidor) e envia o PIN pelo WebSocket. O servidor confere o PIN (HMAC-SHA-512, tempo constante) e devolve os servidores ICE (TURN temporário só nesse momento).
3. **Apresentação cifrada** — host e espectador derivam `K_sig` e `K_media` com HKDF-SHA-512 (sal = sala). Toda mensagem de sinalização é `AES-256-GCM(K_sig)` com contador anti-replay e contexto `sala|espectador|direção`.
4. **Caminho da mídia**
   - Política *Padrão*: oferta/resposta WebRTC. Conectou → direta ou TURN (DTLS-SRTP, com *fingerprints* autenticados pela sinalização cifrada). Sem candidatos de rede, falha ou 12 s sem conectar → retransmissão.
   - Política *Máxima segurança*: direto para a retransmissão.
5. **Retransmissão** — o host codifica VP8/Opus (WebCodecs), cifra cada pacote com `K_media` e envia por WebSocket binário. O servidor lê só os 2 bytes de cabeçalho (tipo e "é quadro-chave") e distribui, descartando quadros de quem está com a fila cheia e pedindo quadro-chave ao host.

## Formato do pacote de mídia

```
byte 0  tipo (1 vídeo, 2 áudio)        ┐ em claro, autenticados como AAD
byte 1  flags (bit 0 = quadro-chave)   ┘
bytes 2… IV(12) | AES-256-GCM( seq u32 | timestamp i64 | duração u32 | metaLen u16 | meta JSON | dados ) | tag(16)
```

## Controle de congestionamento (servidor)

| Fila de saída do espectador | Ação |
|---|---|
| até 1,5 MB | entrega tudo |
| acima de 1,5 MB | descarta quadros delta, marca "precisa de quadro-chave", pede um ao host (máx. 1/s) |
| acima de 6 MB | descarta tudo até a fila esvaziar |

Assim um espectador com internet lenta perde fluidez, mas não acumula atraso, e não afeta os outros.

## Decisões de projeto

| Decisão | Motivo |
|---|---|
| Sem dependências npm em produção | Superfície de ataque mínima, nada para manter atualizado, roda com `node` puro |
| Chave no fragmento do link | Único jeito de o servidor e o túnel não conhecerem a chave sem um serviço de troca de chaves |
| WebCodecs + WebSocket na retransmissão | Passa por qualquer rede que abra a página (porta 443), inclusive com WebRTC desligado |
| VP8 / Opus | Livres de royalties e suportados por WebCodecs em Chrome, Edge e Firefox |
| `cloudflared` via winget + Authenticode | Evita o padrão "script extrai e roda .exe" que antivírus bloqueiam; garante binário oficial |
