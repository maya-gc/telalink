# Plano de testes

## Níveis

| Nível | Onde | O que cobre | Quando roda |
|---|---|---|---|
| Autoteste | `scripts/selfcheck.js` | Servidor, sala, WebSocket, bloqueio externo, criptografia | Toda vez que o `Iniciar.bat` abre |
| Unidade | `crypto`, `media`, `settings`, `turn`, `ws-lite`, `tunnel-manager`, `lab` | Funções isoladas, casos de borda, entradas maliciosas | Cada envio (CI) |
| Integração | `server`, `acesso`, `relay`, `tunnel`, `main` | Servidor real em porta aleatória, WebSocket real, processo real | Cada envio (CI) |
| Estático | `arquivos` | `.bat` (CRLF/ASCII/redirecionamentos), sintaxe, CSP, IDs do HTML | Cada envio (CI) |
| E2E | `e2e`, `proxy-https`, `config-ui`, `controles` | Chromium real: 3 cliques, pausar, volume, qualidade, imagens, trocar fonte, trancar/remover, controles de quem assiste, direta, retransmissão, máxima segurança, chave ausente/adulterada, caminho https como na Cloudflare, cadastro de cada método TURN contra um servidor TURN de teste com autenticação real | Cada envio (CI, 3 sistemas) |
| Rede | `lab/` | Transmissor e espectadores em redes isoladas com NAT/firewall reais | Envio na `main`, PR e semanal |
| Manual | Este documento | Rede de celular real, outro PC | Antes de cada versão |

## Critérios de aprovação

- 100% dos testes automatizados passando nos 3 sistemas e nas 2 versões de Node.
- Cobertura mínima: **90% linhas, 85% desvios, 90% funções** nos módulos centrais (`npm run test:coverage`). Abaixo disso a pipeline reprova.
- Laboratório de redes: todas as redes recebem imagem pelo caminho esperado.

## Laboratório de redes isoladas

`lab/rede.sh` cria *network namespaces* no Linux:

| Rede | Simula | Regra | Caminho esperado |
|---|---|---|---|
| casa | PC de quem transmite | NAT residencial; porta 80 publicada (papel do túnel) | — |
| casa2 | Outra casa | NAT residencial | Direta |
| empresa | Rede corporativa | Firewall: só TCP 80/443 saem, UDP bloqueado | Retransmissão |
| cgnat | 4G / NAT de operadora | NAT simétrico (`--random-fully`) | Direta ou retransmissão |
| vpn | VPN/extensão que desliga WebRTC | NAT + navegador sem caminho UDP | Retransmissão |

Um servidor STUN próprio (`lab/stun-server.js`) roda na "internet". O laboratório confere primeiro que as redes estão **isoladas** (a casa2 não alcança o PC da casa diretamente) e depois mede, para cada espectador, se a imagem chegou, por qual caminho e em quanto tempo. O resultado aparece como tabela no resumo da execução no GitHub, com capturas de tela como evidência.

Rodar localmente (Linux, root): `npm run lab`.

## Teste manual em rede real (antes de cada versão)

Leva 5 minutos e usa só o seu celular:

1. No PC, rode o `Iniciar.bat`, confira **Link externo pronto** (SSH ou Cloudflare) e clique em **Minha tela** escolhendo uma **aba do YouTube** com áudio.
2. No celular, **desligue o Wi-Fi** (fica só no 4G/5G) e abra o link; digite o PIN.
3. Confira: imagem e som chegam; a barra superior mostra o caminho usado.
4. Repita com uma **VPN** ligada no celular.
5. Repita com o modo **Máxima segurança**.
6. No painel, confira que cada espectador aparece com o caminho certo.
7. Teste **Pausar**, o **volume** e **Imagens**; no celular, **Caber/Preencher** e **tela cheia**.
8. Encerre a transmissão: o celular deve mostrar "A transmissão foi encerrada".

Registre o resultado em `CHANGELOG.md` na versão correspondente.
