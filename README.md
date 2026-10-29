# TelaLink

Compartilhe sua **tela, janela ou aba, com áudio**, com pessoas em **qualquer rede** (casa, empresa, 4G, VPN), enviando só um **link + PIN**. Tudo é **criptografado de ponta a ponta**: nem o servidor do TelaLink nem o serviço de link externo conseguem ver sua tela.

[![testes](../../actions/workflows/testes.yml/badge.svg)](../../actions/workflows/testes.yml)
[![laboratório de redes](../../actions/workflows/laboratorio.yml/badge.svg)](../../actions/workflows/laboratorio.yml)

## Uso no Windows

Não precisa instalar nada antes. São **3 cliques**:

1. Duplo-clique em **`Iniciar.bat`** — o painel abre sozinho.
2. Clique em **Minha tela** (ou **Imagens**) e escolha o que mostrar.
3. O **convite (link + PIN) já vai copiado** — é só colar no WhatsApp ou e-mail.

Na **primeira vez**, o `Iniciar.bat` baixa sozinho o que falta — o **Node.js** e o **cloudflared** oficiais — para a pasta `.runtime` do próprio TelaLink: sem administrador e sem instalar nada no Windows. Cada download só é aceito se o **SHA-256** bater com a lista oficial e a **assinatura digital** for do fabricante (OpenJS Foundation / Cloudflare, Inc.). Sem o cloudflared, o link externo usa o **SSH que já vem no Windows 10/11**.

A janela preta fica aberta de propósito: ela é o servidor.

### Durante a transmissão

| Controle | O que faz |
|---|---|
| **Pausar** | Quem assiste vê "Transmissão pausada" (sem imagem nem som seus) |
| **Som / volume** | Liga/desliga e ajusta de 0 a 200% o som enviado |
| **Qualidade** | Automática (até 1080p), Máxima (original, até 4K), 1440p, 1080p, 720p ou 480p — muda na hora |
| **Trocar** | Troca de tela/janela ou passa para imagens, sem derrubar ninguém |
| **Imagens** | Mostre fotos/prints como slides (◀ ▶), adicione mais a qualquer momento |
| **Trancar sala** | Ninguém novo entra; quem já está continua |
| **Remover** | Tira uma pessoa da transmissão |
| **↻ Novo PIN** | Gera outro PIN (quem já assiste continua). O painel avisa quando alguém erra o PIN |
| **📱 QR code** | Mostra o link em QR para abrir no celular |

O painel mostra há quanto tempo está ao vivo, avisa (com um som discreto, que dá para desligar) quando alguém entra ou sai e alerta se o endereço do link externo mudar. Fechar a aba sem querer pede confirmação. Quem assiste **reconecta sozinho** se a internet cair. O visual segue o tema claro ou escuro do sistema.

O painel mostra, para cada pessoa, a qualidade que está chegando (ex.: `1080p · 30 qps · 6,2 Mbps · VP9`) e avisa se a internet ou o processador estão limitando. Quem assiste vê o mesmo na barra de cima.

Quem assiste tem: volume e mudo, **Caber / Preencher / Tamanho real**, janela **flutuante** (picture-in-picture) e **tela cheia** (teclas F, M, A; duplo-clique = tela cheia). As preferências ficam guardadas no navegador dela.

### ⚙ Configurações (opcional)

Tudo tem padrão bom; só abra se quiser mudar: qualidade, quadros por segundo (15/30/60), limite de internet usada (2 a 30 Mbps), tipo de conteúdo (vídeo × texto), som e volume inicial, segurança (Padrão × Máxima) e tipo de link externo (automático, Cloudflare, SSH ou desligado). As opções avançadas de TURN ficam em **Opções avançadas de conexão**.

| Arquivo | O que faz |
|---|---|
| `Iniciar.bat` | Baixa o que falta (1ª vez), autoteste, sobe o servidor, abre o painel e o link externo |
| `Testar.bat` | Roda a bateria completa de testes |
| `Diagnostico.bat` | Mostra o que está faltando se algo der errado |

macOS/Linux: `./iniciar-mac-linux.sh` — também baixa sozinho o Node.js e o cloudflared oficiais (sem `sudo`).

## Como a imagem chega a quem assiste

Para cada pessoa, o TelaLink tenta, nesta ordem e sozinho:

| Caminho | Quando | Atraso |
|---|---|---|
| **Conexão direta** (WebRTC) | Redes comuns | ~0,2 s |
| **TURN** (opcional, configurável) | Redes difíceis, se você configurar um | ~0,2–0,3 s |
| **Retransmissão pelo link** | VPN, empresa, 4G com NAT de operadora — qualquer rede onde a página abre | ~0,5–1 s |

O modo **Máxima segurança** usa sempre a retransmissão cifrada (ver abaixo).

## Segurança, em resumo

- **Chave de 256 bits no link**, depois do `#`. Navegadores nunca enviam essa parte a servidores; o servidor e a Cloudflare não a conhecem.
- **AES-256-GCM** (chaves derivadas com **HKDF-SHA-512**) protege a sinalização e todo o vídeo/áudio retransmitido. A sinalização cifrada impede ataques man-in-the-middle no WebRTC.
- **Modo Máxima segurança**: só criptografia simétrica com chave pré-compartilhada, considerada resistente a computadores quânticos.
- **PIN** de 6 dígitos guardado como HMAC-SHA-512 com chave por sala; bloqueio após 10 erros por sala e 30 por IP.
- **Painel só no seu PC**: quem vem pelo link só consegue assistir. Servidor escuta apenas em `127.0.0.1`.
- **Configurações fora do projeto**, com tokens protegidos pelo **DPAPI** do Windows.
- **Nenhum executável embutido**: o link externo usa o `ssh.exe` do Windows (só com **assinatura da Microsoft**) ou o `cloudflared` (só com **assinatura da Cloudflare, Inc.**).
- **Porta separada para o link externo**: o túnel só alcança uma porta dedicada, que nunca serve o painel nem as configurações.

- **Proteções contra abuso pelo link**: erros de PIN pausam a sala por alguns minutos (sem travar para sempre), limites de conexões e mensagens por pessoa, e o túnel SSH não revela suas chaves SSH pessoais.

Detalhes: [`docs/MODELO-DE-AMEACAS.md`](docs/MODELO-DE-AMEACAS.md), [`docs/AUDITORIA-DE-SEGURANCA.md`](docs/AUDITORIA-DE-SEGURANCA.md) e [`SECURITY.md`](SECURITY.md).

## Anti-cheat e antivírus (Vanguard, Easy Anti-Cheat, VAC, BattlEye, FACEIT)

Risco muito baixo: o TelaLink **não mexe no jogo** — não injeta código, não lê memória, não desenha sobre o jogo, não simula teclado/mouse, não instala driver e não pede administrador. A tela é capturada pelo navegador, como no compartilhamento do Discord ou do Meet. Um teste automático reprova qualquer versão que passe a fazer algo disso. O que é proibido pelos jogos é o **uso** (transmitir ao vivo para alguém na mesma partida ranqueada/campeonato). Detalhes e fontes: [`docs/ANTI-CHEAT-E-ANTIVIRUS.md`](docs/ANTI-CHEAT-E-ANTIVIRUS.md).

## É legal? Pode ser bloqueado?

Sim, é legal: funciona como uma chamada de vídeo (mostra só o que você escolhe, sem controle remoto nem invasão, sem contornar DRM). Não há servidor central para "derrubar" — roda no seu PC. O que depende de terceiros é o link externo gratuito (Cloudflare e localhost.run, sem garantia de disponibilidade e às vezes bloqueados em redes de empresa); para uso contínuo, o recomendado é um domínio próprio. Levantamento completo, com fontes: [`docs/RISCOS-LEGAIS-E-CONTINUIDADE.md`](docs/RISCOS-LEGAIS-E-CONTINUIDADE.md).

## Tela preta?

- **Vídeos (YouTube etc.) em uma “Janela”** podem sair pretos por causa da aceleração de hardware do navegador. Compartilhe a **“Aba”** do vídeo (também leva o áudio) ou desligue “Usar aceleração de hardware” no navegador. O painel detecta a tela preta e avisa.
- **Filmes pagos/protegidos (DRM)** saem pretos de propósito, por decisão do site. O TelaLink não contorna essa proteção.

## Opções avançadas de conexão (TURN)

Em ⚙ Configurações → **Opções avançadas de conexão** é possível escolher o modo padrão e, opcionalmente, um servidor TURN (Cloudflare, coturn próprio ou usuário/senha), com **trava de consumo mensal**. Cada opção tem descrição e nível de segurança na própria tela.

## Testes

```
npm test                 # 250 testes: unidade, integração, segurança, E2E com navegador real
npm run test:coverage    # idem, com cobertura mínima obrigatória
npm run lab              # laboratório de redes isoladas (Linux, root)
```

O **GitHub Actions** roda tudo a cada envio, em Windows, macOS e Linux, e o **laboratório de redes isoladas** simula casa, empresa, 4G/CGNAT e VPN. Ver [`docs/PLANO-DE-TESTES.md`](docs/PLANO-DE-TESTES.md).

## Documentação

| Documento | Conteúdo |
|---|---|
| [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md) | Componentes, fluxos e protocolos |
| [`docs/MODELO-DE-AMEACAS.md`](docs/MODELO-DE-AMEACAS.md) | Análise STRIDE, controles e riscos residuais |
| [`docs/REQUISITOS-E-RASTREABILIDADE.md`](docs/REQUISITOS-E-RASTREABILIDADE.md) | Requisitos e o teste que verifica cada um |
| [`docs/PLANO-DE-TESTES.md`](docs/PLANO-DE-TESTES.md) | Estratégia, níveis, laboratório e teste manual |
| [`docs/PROCESSO-DE-QUALIDADE.md`](docs/PROCESSO-DE-QUALIDADE.md) | Práticas alinhadas a CMMI e ISO, e o que exige auditoria |
| [`docs/RISCOS-LEGAIS-E-CONTINUIDADE.md`](docs/RISCOS-LEGAIS-E-CONTINUIDADE.md) | Leis, termos dos serviços de link, bloqueios possíveis e plano B |
| [`docs/ANTI-CHEAT-E-ANTIVIRUS.md`](docs/ANTI-CHEAT-E-ANTIVIRUS.md) | Por que anti-cheats e antivírus não têm o que detectar, e cuidados de uso |
| [`docs/AUDITORIA-DE-SEGURANCA.md`](docs/AUDITORIA-DE-SEGURANCA.md) | Auditoria da versão 2.4: achados, correções e testes |
| [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) | Componentes de terceiros e licenças |
| [`docs/ASSINATURA-DE-CODIGO.md`](docs/ASSINATURA-DE-CODIGO.md) | Como evitar alertas do Windows (SmartScreen/antivírus) |
| [`SECURITY.md`](SECURITY.md) | Como reportar vulnerabilidades |
| [`CHANGELOG.md`](CHANGELOG.md) | Histórico de versões |

Licença: MIT.
