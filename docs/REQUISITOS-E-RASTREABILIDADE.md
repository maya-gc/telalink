# Requisitos e rastreabilidade

Cada requisito aponta para o teste automatizado que o verifica. Um requisito sem teste é uma lacuna e deve ser tratado antes da próxima versão.

Legenda: **RF** funcional · **RS** segurança · **RD** desempenho/robustez · **RU** usabilidade · **RO** operação

## Funcionais

| ID | Requisito | Verificação |
|---|---|---|
| RF-01 | Transmitir tela, janela ou aba com áudio do sistema | `e2e.test.js` › conexão direta (vídeo + áudio) |
| RF-02 | Quem assiste entra só com link + PIN, sem instalar nada | `e2e.test.js` |
| RF-03 | Link público gerado automaticamente | `tunnel.test.js` › captura a URL; `main.test.js` › mostra o link externo |
| RF-04 | Troca automática direta → TURN → retransmissão | `e2e.test.js` › rede que bloqueia WebRTC; laboratório (empresa, VPN, CGNAT) |
| RF-05 | Modo Máxima segurança (sempre retransmissão cifrada) | `e2e.test.js` › modo máxima segurança |
| RF-06 | Vários espectadores simultâneos | `server.test.js` › 30 viewers simultâneos |
| RF-07 | Cadastro de TURN (Cloudflare, coturn, usuário/senha) pela tela "Conexão e segurança", com teste real e motivo da falha | `config-ui.test.js` (navegador real + servidor TURN de teste com autenticação), `turn.test.js`, `acesso.test.js` |
| RF-08 | Trava de consumo mensal de TURN | `settings.test.js`, `turn.test.js` › trava |
| RF-09 | Aviso de tela preta com orientação | `media.test.js` › tela preta |
| RF-10 | Painel mostra o caminho usado por cada espectador | `e2e.test.js` (host vê "retransmissao") |
| RF-11 | Painel mostra resumo de conexão (modo, TURN, consumo) com atalho para configurar | `config-ui.test.js` |
| RF-12 | Transmitir em 3 cliques, com convite (link + PIN) copiado automaticamente | `controles.test.js` › 3 cliques |
| RF-13 | Pausar, volume/mudo e qualidade ajustáveis ao vivo, sem reconectar quem assiste | `controles.test.js`, `media.test.js` › qualidade/volume |
| RF-14 | Transmitir imagens como slides e trocar de fonte durante a transmissão | `controles.test.js` › imagens, trocar |
| RF-15 | Trancar sala e remover espectador | `server.test.js` › kick/lock, `controles.test.js` |
| RF-16 | Controles de quem assiste (volume, encaixe, flutuante, tela cheia) com preferências guardadas | `controles.test.js` › espectador |
| RF-18 | Quem assiste recebe a resolução cheia em poucos segundos (sem começar em 360p) | `qualidade.test.js` › resolução cheia |
| RF-19 | Qualidades até 4K e limite de banda ajustável; troca ao vivo sem encolher duas vezes | `qualidade.test.js`, `media.test.js` › qualidade/SDP, `controles.test.js` › Econômica |
| RF-20 | Retransmissão com H.264/VP9/VP8, banda adaptativa e resolução conforme a banda | `qualidade.test.js` › retransmissão, `media.test.js` › banda adaptativa |
| RF-21 | Indicador de qualidade recebida/enviada (resolução, qps, Mbps, codec, limitação) | `qualidade.test.js` |
| RF-22 | Requisitos baixados sozinhos (Node.js e cloudflared), sem administrador, em Windows, macOS e Linux | `instalador.test.js`, workflow `instalador` (downloads reais, semanal) |
| RF-23 | QR code do convite | `experiencia.test.js` › QR lido por jsQR |
| RF-24 | Novo PIN e aviso de tentativas erradas | `experiencia.test.js`, `seguranca.test.js` |
| RF-25 | Aviso quando o link externo muda; relógio e título "ao vivo"; avisos de entrada/saída | `experiencia.test.js` |
| RF-26 | Quem assiste reconecta sozinho; imagem direta continua se só o servidor cair | `experiencia.test.js` |
| RF-17 | Link externo sem instalar nada (SSH do sistema), com escolha automática do provedor | `tunnel-manager.test.js`, `tunnel.test.js` › SSH, `main.test.js` › SSH |

## Segurança

| ID | Requisito | Verificação |
|---|---|---|
| RS-01 | Mídia e sinalização cifradas de ponta a ponta; servidor não conhece a chave | `crypto.test.js`; `e2e.test.js` › a chave nunca chegou ao servidor |
| RS-02 | AES-256-GCM, HKDF-SHA-512, IV único, detecção de adulteração | `crypto.test.js`, `media.test.js` |
| RS-03 | Anti-replay e amarração de contexto (sala/espectador/direção) | `crypto.test.js` › SecureChannel |
| RS-04 | Sem a chave correta, a transmissão não é aceita (anti-MITM) | `crypto.test.js`; `e2e.test.js` › chave adulterada |
| RS-05 | PIN armazenado só como HMAC-SHA-512 com chave por sala; comparação em tempo constante | `server.test.js` › PIN |
| RS-06 | Bloqueio por sala (10) e por IP (30/15 min) | `server.test.js`, `acesso.test.js` |
| RS-07 | Painel, configurações e papel de host só locais | `acesso.test.js`, `selfcheck.js` |
| RS-08 | Proteção contra CSRF, DNS rebinding e WebSocket entre sites | `acesso.test.js` |
| RS-09 | Segredos de TURN só no PC (DPAPI no Windows), mascarados no painel, fora do repositório | `settings.test.js` (inclui DPAPI real no Windows) |
| RS-10 | Credencial TURN temporária e só após PIN | `acesso.test.js` › credencial TURN |
| RS-11 | `cloudflared` só com assinatura digital válida da Cloudflare; nenhum executável no projeto | `tunnel.test.js` (inclui verificação real no Windows) |
| RS-12 | CSP estrita, sem script inline, sem `innerHTML`/`eval` | `server.test.js`, `arquivos.test.js` |
| RS-13 | Bloqueio de path traversal | `server.test.js` |
| RS-14 | Servidor escuta só em 127.0.0.1 | `main.test.js` |
| RS-15 | Espectador não pode enviar mídia; host não pode enviar lixo | `relay.test.js` |
| RS-18 | Erros de PIN pausam (não travam) a sala; host avisado | `seguranca.test.js` |
| RS-19 | Limites de conexões, mensagens e tempo sem sala; ping de vida | `seguranca.test.js` |
| RS-20 | IP confiável conforme o provedor do túnel | `seguranca.test.js` |
| RS-21 | Túnel SSH não revela chaves nem usa configuração pessoal | `tunnel-manager.test.js` |
| RS-22 | Downloads só de fonte oficial com SHA-256 e assinatura; sem padrões de malware nos scripts | `instalador.test.js`, `arquivos.test.js` |
| RS-23 | Sem nada que anti-cheats/antivírus vigiam (injeção, memória, entradas, drivers, admin, ofuscação); lista fixa de programas executados; prioridade baixa | `anticheat.test.js` |
| RS-16 | Túnel só alcança a porta externa dedicada; nela tudo é externo | `acesso.test.js` › porta externa |
| RS-17 | `ssh` só com assinatura Microsoft válida; chave do servidor fixada no primeiro uso | `tunnel.test.js` (inclui verificação real no Windows) |

## Desempenho e robustez

| ID | Requisito | Verificação |
|---|---|---|
| RD-01 | Rede sem WebRTC cai na retransmissão em poucos segundos (sem esperar o tempo-limite) | `e2e.test.js` (~2,5 s) |
| RD-02 | Espectador lento não acumula atraso nem afeta os outros | `relay.test.js` › internet lenta |
| RD-03 | Limites de mensagem por papel; conexões abandonadas liberadas | `ws-lite.test.js`, `relay.test.js` |
| RD-04 | Túnel reconecta sozinho e tenta HTTP/2 se QUIC for bloqueado | `tunnel.test.js` |
| RD-05 | Falha do provedor TURN não impede a transmissão | `turn.test.js` |
| RD-06 | Arquivo de configuração corrompido não derruba o programa | `settings.test.js` |

## Usabilidade e operação

| ID | Requisito | Verificação |
|---|---|---|
| RU-01 | Janela do `Iniciar.bat` nunca fecha sozinha; mensagens visíveis | `arquivos.test.js` (CRLF, ASCII, sem `<>` em `echo`, `cmd /k`) |
| RU-02 | Nenhuma instalação extra para o link externo (SSH do sistema; Cloudflare opcional) | `tunnel-manager.test.js`, `selfcheck.js` |
| RU-03 | Porta ocupada e cloudflared ausente geram mensagem clara | `main.test.js` |
| RO-01 | Autoteste antes de iniciar | `selfcheck.js` (CI) |
| RO-02 | Testes em Windows, macOS e Linux a cada mudança; cobertura mínima | `.github/workflows/testes.yml` |
| RO-03 | Validação em redes isoladas (casa, empresa, CGNAT, VPN) | `.github/workflows/laboratorio.yml` |
