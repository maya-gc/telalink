# TelaLink

Compartilhe sua **tela, janela ou aba, com áudio**, com pessoas em **qualquer rede** (casa, empresa, 4G, VPN), enviando só um **link + PIN**. Tudo é **criptografado de ponta a ponta**: nem o servidor do TelaLink nem a Cloudflare conseguem ver sua tela.

[![testes](../../actions/workflows/testes.yml/badge.svg)](../../actions/workflows/testes.yml)
[![laboratório de redes](../../actions/workflows/laboratorio.yml/badge.svg)](../../actions/workflows/laboratorio.yml)

## Uso no Windows

1. Instale o **Node.js LTS** uma vez: https://nodejs.org (ou `winget install --id OpenJS.NodeJS.LTS -e`).
2. Dê duplo-clique em **`Iniciar.bat`**. Na primeira vez ele oferece instalar o `cloudflared` oficial pelo **winget** (instalador da Microsoft), necessário para o link externo.
3. Espere **"Link externo pronto"** no painel, clique em **Iniciar transmissão** e envie o **link** e o **PIN** (de preferência por canais diferentes).

A janela preta fica aberta de propósito: ela é o servidor.

| Arquivo | O que faz |
|---|---|
| `Iniciar.bat` | Autoteste, verifica/instala o cloudflared, sobe o servidor e abre o painel |
| `Testar.bat` | Roda a bateria completa de testes |
| `Diagnostico.bat` | Mostra o que está faltando se algo der errado |

macOS/Linux: `./iniciar-mac-linux.sh` (instale o `cloudflared` pelo gerenciador de pacotes).

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
- **Nenhum executável embutido**: o `cloudflared` vem do winget e só é usado se a **assinatura digital da Cloudflare, Inc.** for válida.

Detalhes: [`docs/MODELO-DE-AMEACAS.md`](docs/MODELO-DE-AMEACAS.md) e [`SECURITY.md`](SECURITY.md).

## Tela preta?

- **Vídeos (YouTube etc.) em uma “Janela”** podem sair pretos por causa da aceleração de hardware do navegador. Compartilhe a **“Aba”** do vídeo (também leva o áudio) ou desligue “Usar aceleração de hardware” no navegador. O painel detecta a tela preta e avisa.
- **Filmes pagos/protegidos (DRM)** saem pretos de propósito, por decisão do site. O TelaLink não contorna essa proteção.

## Conexão e segurança (configurações)

No painel, **Conexão e segurança** permite escolher o modo padrão e, opcionalmente, um servidor TURN (Cloudflare, coturn próprio ou usuário/senha), com **trava de consumo mensal**. Cada opção tem descrição e nível de segurança na própria tela.

## Testes

```
npm test                 # 160+ testes: unidade, integração, segurança, E2E com navegador real
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
