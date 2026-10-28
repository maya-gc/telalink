# Histórico de versões

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
