# Histórico de versões

## 2.4.1 — 2026-10-29

### Novo
- `docs/ANTI-CHEAT-E-ANTIVIRUS.md`: o que Vanguard, Easy Anti-Cheat, VAC, BattlEye e FACEIT procuram e por que o TelaLink não se parece com isso; cuidados de uso (ghosting).
- Teste automático (`anticheat.test.js`) que reprova a versão se aparecer: executável/driver/módulo nativo, código que mexa em outros processos, memória, teclado ou mouse, programa fora da lista fixa, pedido de administrador, janela escondida ou execução de código decodificado.
- Aviso se o TelaLink for aberto como administrador; servidor e túnel com prioridade abaixo do normal (não disputam processador com jogos).
- Dica de uso com jogos em ⚙ Configurações.

## 2.4.0 — 2026-10-29

### Novo
- **Instalação automática**: na primeira vez, o `Iniciar.bat` (e o `iniciar-mac-linux.sh`) baixa sozinho o **Node.js** e o **cloudflared** oficiais para a pasta `.runtime`, sem administrador; cada download exige **SHA-256** da lista oficial e **assinatura digital** do fabricante. Testado com downloads reais nos 3 sistemas, toda semana.
- **QR code do convite** para abrir no celular.
- **Novo PIN** e aviso de tentativas de PIN erradas.
- Aviso quando o **endereço do link muda** (o serviço gratuito troca de tempos em tempos), com link e QR atualizados.
- Relógio "ao vivo", título da aba com o número de pessoas, avisos (com som opcional) de entrada e saída, confirmação antes de fechar a aba.
- **Reconexão automática** de quem assiste; com conexão direta, a imagem continua mesmo se o servidor/link cair.
- **Tema claro** automático e ícone próprio.

### Segurança (auditoria completa: `docs/AUDITORIA-DE-SEGURANCA.md`)
- Erros de PIN **pausam** a sala por 5 min em vez de travá-la para sempre (impede derrubar a transmissão só com o link).
- Limites de conexões por IP, de mensagens por conexão e de tempo sem entrar em sala; ping de vida.
- IP confiável conforme o provedor do túnel (não dá para forjar `X-Forwarded-For`).
- Túnel SSH não oferece mais as **chaves SSH pessoais** ao servidor nem lê `~/.ssh/config`.
- cloudflared com configuração isolada (um `config.yaml` pessoal não interfere).
- Ações do GitHub Actions fixadas por SHA; cabeçalhos de segurança ampliados.
- Se um navegador futuro recusar o ajuste de banda no SDP, a conexão segue sem ele.

### Documentação
- `docs/RISCOS-LEGAIS-E-CONTINUIDADE.md`: LGPD, direitos autorais, Marco Civil, criptografia, licenças, termos dos serviços de link, bloqueios possíveis e plano B.
- `THIRD-PARTY-NOTICES.md`.

## 2.3.0 — 2026-10-28

### Corrigido
- **Imagem em 360p para quem assiste**: a transmissão começava com ~0,3 Mbps (padrão do navegador) e ficava em 640×360 por cerca de 15 s; o modo "movimento" ainda reduzia a resolução primeiro. Agora começa com banda alta e chega em **1080p em ~2 s** (medido em teste).
- Trocar a qualidade durante a transmissão podia encolher a imagem duas vezes (ex.: 720p virava 480p). Agora a escala é calculada sobre a altura real dos quadros.
- Captura limitava a largura a 16:9, cortando a resolução de monitores ultralargos.

### Novo
- Qualidades **Máxima (original, até 4K)**, **Muito alta (1440p)**, Alta (1080p), Média (720p), Econômica (480p) e Automática (até 1080p); banda maior em todas (ex.: 1080p até 8 Mbps, 4K até 25 Mbps; 60 qps ganham +50%).
- **Limite de internet usada** ajustável (2 a 30 Mbps) em ⚙ Configurações.
- Codec escolhido pelo que o PC codifica **por hardware** (VP9/H.264/AV1), senão VP9.
- **Retransmissão**: H.264 ou VP9 por hardware quando disponível (VP8 como reserva), banda adaptativa (reduz rápido, sobe devagar) e resolução conforme a banda no modo automático.
- **Indicador de qualidade**: quem assiste vê "1080p · 30 qps · 6,2 Mbps"; o painel mostra o mesmo por pessoa, com o codec e o motivo quando há limitação (internet ou processador).

## 2.2.0 — 2026-10-28

### Novo
- **Transmitir em 3 cliques**: abrir, escolher **Minha tela** ou **Imagens**, e o convite (link + PIN) já vai copiado.
- **Link externo sem instalar nada**: túnel SSH (localhost.run) com o `ssh.exe` do Windows, verificado pela assinatura da Microsoft. O Cloudflare continua disponível e é preferido quando instalado.
- **Controles ao vivo**: pausar, som/volume (0–200%), qualidade (Automática/Alta/Média/Econômica), trocar fonte sem derrubar ninguém, trancar sala e remover pessoa.
- **Modo imagens**: fotos e prints como slides, com ◀ ▶ e adição a qualquer momento.
- **Quem assiste**: volume, mudo, Caber/Preencher/Tamanho real, janela flutuante, tela cheia e atalhos; preferências lembradas.
- **⚙ Configurações** simples (qualidade, quadros, tipo de conteúdo, som, segurança, link externo); TURN foi para "Opções avançadas".

### Segurança
- O túnel aponta para uma **porta externa dedicada**; tudo que chega por ela é tratado como externo (painel, configurações e papel de host bloqueados).
- `ssh` só é usado com assinatura Microsoft válida; chave do servidor gravada no primeiro uso (`accept-new`) em arquivo próprio.

### Corrigido
- Áudio da retransmissão em PCs com 44,1 kHz (agora o áudio é gerado a 48 kHz, aceito pelo Opus).

## 2.1.0 — 2026-10-28

### Novo
- Painel mostra o quadro **Conexão e segurança** (modo, TURN cadastrado, consumo do mês) com botão **Configurar**.
- **Testar conexão** salva o que está na tela e explica o motivo da falha (credencial recusada, servidor inacessível, sem resposta).
- Testes de navegador real da tela de cadastro, para cada método (Cloudflare, coturn, usuário/senha), contra um servidor TURN de teste com autenticação real.
- Laboratório de redes isoladas aprovado: outra casa (direta, ~2 s), VPN, empresa e 4G/CGNAT (retransmissão, ~3–6 s).

### Alterado
- Espectador troca para a retransmissão em ~4 s quando nenhuma tentativa de conexão direta é respondida (antes 12 s).

## 2.0.0 — 2026-10-28

### Novo
- **Criptografia de ponta a ponta**: chave de 256 bits no fragmento do link; sinalização e retransmissão cifradas com AES-256-GCM (HKDF-SHA-512), com anti-replay.
- **Retransmissão pelo link**: quando a conexão direta não é possível (VPN, empresa, 4G/CGNAT), vídeo VP8 e áudio Opus passam pela própria conexão https, cifrados. Troca automática em ~2,5 s quando não há caminho WebRTC.
- **Modo Máxima segurança** (sempre retransmissão cifrada, resistente a computação quântica).
- **Tela "Conexão e segurança"**: TURN opcional (Cloudflare, coturn próprio, usuário/senha), descrições e nível de segurança de cada opção, botão de teste e trava de consumo mensal.
- **Detector de tela preta** com orientação (YouTube em "Janela" → usar "Aba"; DRM não é contornado).
- Escolha do tipo de conteúdo (movimento × texto) e opções de captura melhores.
- Painel mostra o caminho usado por cada espectador.
- **Laboratório de redes isoladas** no GitHub Actions (casa, empresa, CGNAT, VPN).
- Documentação de qualidade: arquitetura, ameaças (STRIDE), requisitos com rastreabilidade, plano de testes, processo.

### Segurança
- PIN guardado como HMAC-SHA-512 com chave por sala.
- Credenciais TURN temporárias, entregues só após o PIN; limite de 50 espectadores por sala.
- Content-Security-Policy estrita; páginas sem script inline.
- Configurações fora do projeto, segredos com DPAPI.

### Alterado
- `cloudflared` deixa de ser embutido: instalação pelo winget e verificação da assinatura digital da Cloudflare (resolve alerta de antivírus). Tenta HTTP/2 quando a rede bloqueia QUIC.
- Projeto renomeado para **TelaLink**.

## 1.1.0 — 2026-10-28
- Link externo via Cloudflare Quick Tunnel; painel restrito ao PC local; proteções anti-força-bruta.
- Correção: `Iniciar.bat` fechava sozinho (caracteres `<` `>` em `echo`).

## 1.0.0 — 2026-10-27
- Primeira versão: compartilhamento de tela por WebRTC com link + PIN.
