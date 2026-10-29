# TelaLink

Compartilhe sua **tela, janela ou aba, com áudio**, com pessoas em **qualquer rede** (casa, empresa, 4G, VPN), enviando só um **link + PIN**. Tudo é **criptografado de ponta a ponta**: nem o servidor do TelaLink nem o serviço de link externo conseguem ver sua tela.

[![testes](../../actions/workflows/testes.yml/badge.svg)](../../actions/workflows/testes.yml)
[![laboratório de redes](../../actions/workflows/laboratorio.yml/badge.svg)](../../actions/workflows/laboratorio.yml)

## Uso no Windows

Instale o **Node.js LTS** uma vez (https://nodejs.org ou `winget install --id OpenJS.NodeJS.LTS -e`). Depois, são **3 cliques**:

1. Duplo-clique em **`Iniciar.bat`** — o painel abre sozinho.
2. Clique em **Minha tela** (ou **Imagens**) e escolha o que mostrar.
3. O **convite (link + PIN) já vai copiado** — é só colar no WhatsApp ou e-mail.

Não precisa instalar mais nada: o link externo usa o **SSH que já vem no Windows 10/11** (serviço gratuito localhost.run). Se você tiver o `cloudflared` instalado, ele é usado automaticamente (dá para escolher em ⚙ Configurações).

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

O painel mostra, para cada pessoa, a qualidade que está chegando (ex.: `1080p · 30 qps · 6,2 Mbps · VP9`) e avisa se a internet ou o processador estão limitando. Quem assiste vê o mesmo na barra de cima.

Quem assiste tem: volume e mudo, **Caber / Preencher / Tamanho real**, janela **flutuante** (picture-in-picture) e **tela cheia** (teclas F, M, A; duplo-clique = tela cheia). As preferências ficam guardadas no navegador dela.

### ⚙ Configurações (opcional)

Tudo tem padrão bom; só abra se quiser mudar: qualidade, quadros por segundo (15/30/60), limite de internet usada (2 a 30 Mbps), tipo de conteúdo (vídeo × texto), som e volume inicial, segurança (Padrão × Máxima) e tipo de link externo (automático, Cloudflare, SSH ou desligado). As opções avançadas de TURN ficam em **Opções avançadas de conexão**.

| Arquivo | O que faz |
|---|---|
| `Iniciar.bat` | Autoteste, sobe o servidor, abre o painel e o link externo |
| `Testar.bat` | Roda a bateria completa de testes |
| `Diagnostico.bat` | Mostra o que está faltando se algo der errado |

macOS/Linux: `./iniciar-mac-linux.sh` (usa o `ssh` do sistema ou o `cloudflared`, se instalado).

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

Detalhes: [`docs/MODELO-DE-AMEACAS.md`](docs/MODELO-DE-AMEACAS.md) e [`SECURITY.md`](SECURITY.md).

## Tela preta?

- **Vídeos (YouTube etc.) em uma “Janela”** podem sair pretos por causa da aceleração de hardware do navegador. Compartilhe a **“Aba”** do vídeo (também leva o áudio) ou desligue “Usar aceleração de hardware” no navegador. O painel detecta a tela preta e avisa.
- **Filmes pagos/protegidos (DRM)** saem pretos de propósito, por decisão do site. O TelaLink não contorna essa proteção.

## Opções avançadas de conexão (TURN)

Em ⚙ Configurações → **Opções avançadas de conexão** é possível escolher o modo padrão e, opcionalmente, um servidor TURN (Cloudflare, coturn próprio ou usuário/senha), com **trava de consumo mensal**. Cada opção tem descrição e nível de segurança na própria tela.

## Testes

```
npm test                 # 200+ testes: unidade, integração, segurança, E2E com navegador real
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
| [`docs/ASSINATURA-DE-CODIGO.md`](docs/ASSINATURA-DE-CODIGO.md) | Como evitar alertas do Windows (SmartScreen/antivírus) |
| [`SECURITY.md`](SECURITY.md) | Como reportar vulnerabilidades |
| [`CHANGELOG.md`](CHANGELOG.md) | Histórico de versões |

Licença: MIT.
