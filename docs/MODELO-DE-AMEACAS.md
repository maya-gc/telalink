# Modelo de ameaças (STRIDE)

## Ativos

| Ativo | Por que importa |
|---|---|
| Conteúdo da tela e do áudio | Pode conter dados pessoais, de saúde, financeiros |
| Chave de sessão (fragmento do link) | Quem a tem decifra a transmissão |
| PIN | Segundo fator para entrar |
| Painel e configurações | Controlam o que é transmitido e guardam tokens de TURN |
| Cota de TURN (se configurado) | Abuso gera custo |
| PC de quem transmite | Roda o servidor |

## Adversários considerados

1. **Alguém na internet** que descobre ou adivinha o endereço do túnel.
2. **Intermediários de rede**: Wi-Fi público, provedor, rede corporativa.
3. **A infraestrutura do túnel/TURN** (Cloudflare ou outro), tratada como *honesta-mas-curiosa*.
4. **Sites maliciosos** abertos no navegador de quem transmite.
5. **Espectador legítimo mal-intencionado** (tem link e PIN).
6. **Adversário futuro com computador quântico** que grava o tráfego hoje ("armazenar agora, decifrar depois").

## Ameaças e controles

| # | STRIDE | Ameaça | Controle | Verificado por |
|---|---|---|---|---|
| A1 | S | Estranho entra na transmissão | Sala UUID + PIN (HMAC-SHA-512) + chave de 256 bits no link | `acesso.test.js`, `e2e.test.js` |
| A2 | S | Força bruta de PIN / varredura de salas | 10 erros/sala, 30 erros/IP em 15 min (chute de sala conta) | `acesso.test.js`, `server.test.js` |
| A3 | T/I | Intermediário lê ou altera a mídia | DTLS-SRTP (direto/TURN); AES-256-GCM com chave do link (retransmissão) | `crypto.test.js`, `media.test.js`, `e2e.test.js` |
| A4 | S/T | Servidor/túnel faz *man-in-the-middle* no WebRTC trocando *fingerprints* | Sinalização cifrada e autenticada com chave que o servidor não tem | `crypto.test.js` ("sem a chave do link…"), `e2e.test.js` (chave adulterada) |
| A5 | T | Replay/reordenação de mensagens ou pacotes | Contador por canal; `seq` crescente por tipo de mídia | `crypto.test.js`, `relay.js` |
| A6 | E | Visitante externo abre painel, cria sala ou vira host | Rotas e papel de host só para requisição **local** (loopback, sem cabeçalhos de proxy, `Host` local) | `acesso.test.js`, `selfcheck` |
| A7 | E | Site malicioso usa o servidor local (CSRF, DNS rebinding, WebSocket entre sites) | Checagem de `Host` e `Origin`; alterações só com `application/json` | `acesso.test.js` |
| A8 | I | Vazamento de token TURN | Token só no PC (DPAPI); navegador recebe senha temporária (4 h) e só após o PIN; painel mostra mascarado | `acesso.test.js`, `settings.test.js`, `turn.test.js` |
| A9 | D | Abuso de cota TURN | Credencial só após PIN; trava de consumo mensal | `turn.test.js`, `settings.test.js` |
| A10 | D | Mensagens gigantes / conexões abandonadas esgotam memória | Limites por papel (256 KB / 4 MB), fecha conexões meio abertas, limite de 50 espectadores | `ws-lite.test.js`, `relay.test.js` |
| A11 | D | Espectador lento degrada todos | Controle de fila por espectador | `relay.test.js` |
| A12 | T | Binário do túnel trocado por malware | Só usa `cloudflared` com assinatura Authenticode **válida** da Cloudflare, Inc.; caminho passado sem interpolação | `tunnel.test.js` |
| A13 | T/E | Injeção de código nas páginas | CSP estrita (`script-src 'self'`, sem inline), `textContent`, sem `innerHTML`/`eval`, `X-Frame-Options: DENY` | `server.test.js`, `arquivos.test.js` |
| A14 | I | Leitura de arquivos fora de `public/` | Normalização de caminho + verificação de prefixo | `server.test.js` |
| A15 | I | Exposição do PC na rede local | Servidor escuta só em `127.0.0.1` | `main.test.js` |
| A17 | E | Visitante via túnel finge ser local (o túnel conecta de 127.0.0.1) | Túnel aponta para **porta externa dedicada**; conexões nela são sempre externas, independentemente do endereço | `acesso.test.js` › porta externa |
| A18 | T | `ssh.exe` trocado ou servidor do túnel falsificado | `ssh` só com assinatura Microsoft válida; `StrictHostKeyChecking=accept-new` com `known_hosts` próprio (troca posterior da chave é recusada) | `tunnel.test.js` |
| A19 | D | Quem tem só o link trava a sala errando o PIN (negação de serviço) | Pausa de 5 min após 10 erros (não trava para sempre); host avisado; **Novo PIN** | `seguranca.test.js` |
| A20 | D | Inundar o servidor com conexões/mensagens pelo link | 20 conexões por IP, 30 mensagens/s por conexão, conexão sem sala fechada em 60 s, teto de 500 conexões, ping de vida | `seguranca.test.js` |
| A21 | S | Visitante inventa IP (`X-Forwarded-For`, `CF-Connecting-IP`) para escapar do limite por IP | Só o cabeçalho do provedor ativo; último item do `X-Forwarded-For` | `seguranca.test.js` |
| A22 | I | Túnel SSH revela a identidade do usuário (chaves SSH pessoais oferecidas ao servidor) | Sem autenticação por chave, sem agente, sem `~/.ssh/config` | `tunnel-manager.test.js` |
| A23 | T | Instalador baixa Node.js ou cloudflared adulterado | HTTPS de fonte oficial + SHA-256 publicado + assinatura digital do fabricante; falha = nada instalado | `instalador.test.js`, workflow `instalador` |
| A24 | T | Ação do GitHub Actions trocada (etiqueta movida) | Ações fixadas por SHA de commit | revisão |
| A25 | — | Anti-cheat ou antivírus confunde o TelaLink com trapaça/malware (falso positivo) | Nenhum contato com processos de jogo, sem drivers, sem admin, só programas assinados, código aberto; teste que impede regressões | `anticheat.test.js` |
| A16 | I | "Armazenar agora, decifrar depois" (quântico) | Modo **Máxima segurança**: só AES-256 com chave pré-compartilhada (Grover → ~128 bits efetivos). HTTPS até a Cloudflare usa troca de chaves híbrida pós-quântica nos navegadores atuais | `e2e.test.js` (modo máxima segurança) |

## Riscos residuais (aceitos e comunicados)

| Risco | Por que existe | Mitigação possível |
|---|---|---|
| Quem entrega a **página** (servidor local via túnel) poderia, em tese, servir JavaScript alterado e roubar a chave | Inerente a aplicações web | Rodar o próprio túnel/domínio; publicar hashes das páginas; versão empacotada assinada |
| Espectador legítimo pode gravar a tela | Inerente a qualquer compartilhamento | Compartilhar só o necessário |
| WebRTC direto usa ECDHE (não pós-quântico) | Limitação atual dos navegadores | Usar Máxima segurança quando o conteúdo exigir |
| Metadados (quem conectou, quando, quanto tráfego) visíveis ao túnel/TURN | Inerente a qualquer intermediário | TURN próprio |
| Link + PIN enviados pelo mesmo canal reduzem a proteção a um fator | Uso | Enviar PIN por outro canal (o painel orienta) |
| Túnel rápido (`trycloudflare.com`) sem garantia de disponibilidade e às vezes bloqueado por filtros corporativos | Política do serviço | Túnel nomeado com domínio próprio |
| localhost.run (túnel SSH padrão) é um serviço gratuito de terceiro que termina o HTTPS e vê metadados | Sem conta nem cartão exige um intermediário | Conteúdo segue cifrado de ponta a ponta (chave no `#`); usar Cloudflare ou domínio próprio se preferir |
| Primeiro uso do SSH confia na chave do servidor sem verificação prévia (TOFU) | Serviço não publica *fingerprint* fixo | Mudanças posteriores da chave são recusadas |
| Domínios de túnel gratuitos bloqueados em redes de empresa/escola | Esses domínios são usados em golpes e entram em listas de bloqueio | Domínio próprio (ver `RISCOS-LEGAIS-E-CONTINUIDADE.md`) |
| Conteúdo protegido por DRM sai preto | Decisão do detentor dos direitos | Nenhuma (não contornar) |
