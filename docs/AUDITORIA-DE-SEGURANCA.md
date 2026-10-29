# Auditoria de segurança — versão 2.4.0

Data: 29/10/2026. Escopo: todo o código do TelaLink (servidor, WebSocket, túneis, páginas, scripts de inicialização e instalação, pipeline do GitHub Actions) e as bibliotecas de terceiros incluídas.

**Método:** revisão de código componente a componente, guiada pelo [modelo de ameaças](MODELO-DE-AMEACAS.md) (STRIDE); conferência do comportamento real do `cloudflared` no código-fonte oficial; e, para cada achado, um **teste automatizado de ataque** que falhava antes da correção e passa depois (`test/seguranca.test.js`, `test/instalador.test.js`, `test/arquivos.test.js`).

## Resultado

Nenhuma falha permitia ver a tela de alguém, roubar a chave ou controlar o computador. Foram encontrados e corrigidos **7 pontos** de disponibilidade, privacidade e robustez, mais 2 melhorias preventivas.

| # | Gravidade | Achado | Correção | Teste |
|---|---|---|---|---|
| S-01 | **Média** (disponibilidade) | Quem tivesse só o link (sem o PIN) podia errar o PIN 10 vezes e **travar a sala para sempre**, impedindo novas pessoas de entrar. | Depois de 10 erros, **pausa de 5 minutos** (não trava para sempre); quem transmite é **avisado** e pode gerar um **Novo PIN** (quem já assiste continua). | `seguranca` › pausa do PIN, aviso e novo PIN |
| S-02 | **Média** (privacidade) | O túnel SSH oferecia ao servidor do localhost.run as **chaves SSH pessoais** do usuário e lia o `~/.ssh/config`. Chaves públicas podem identificar a pessoa (ex.: pela conta do GitHub). | `PubkeyAuthentication=no`, `IdentitiesOnly=yes`, `IdentityAgent=none`, `PasswordAuthentication=no`, `-F none`. | `tunnel-manager` › argumentos; `fake-ssh` recusa sem as opções |
| S-03 | **Média** (disponibilidade) | Sem limite de conexões por IP nem de mensagens; conexões que nunca entravam em sala ficavam abertas. Um atacante podia ocupar memória e processamento pelo link. | Máx. **20 conexões por IP** (o PC local não tem limite), **30 mensagens/s** por conexão (quem passa é desconectado), conexão sem sala fechada em **60 s**, teto geral de **500 conexões**. | `seguranca` › limite por IP, inundação, conexão sem sala |
| S-04 | **Baixa** | O limite de erros por IP usava o **primeiro** item do `X-Forwarded-For`, que o visitante pode inventar pelo túnel SSH; o `CF-Connecting-IP` também era aceito de qualquer túnel. | Só confia no cabeçalho escrito pelo **provedor ativo**: `CF-Connecting-IP` só com Cloudflare; nos demais, o **último** item do `X-Forwarded-For`. | `seguranca` › X-Forwarded-For forjado |
| S-05 | **Baixa** (confiabilidade) | Conexões paradas (quem assiste por conexão direta não troca mensagens) eram derrubadas pelos túneis após ~100 s; conexões mortas não eram detectadas. | **Ping de vida** a cada 25 s; conexão sem resposta por 75 s é encerrada. | `seguranca` › ping de vida |
| S-06 | **Baixa** | Um `~/.cloudflared/config.yaml` pessoal podia alterar ou quebrar o túnel rápido (documentado pela Cloudflare). | O TelaLink passa uma **configuração própria e vazia** (`--config`), conferida no código-fonte do `cloudflared`. | `tunnel-manager` › configuração isolada |
| S-07 | **Baixa** (cadeia de suprimentos) | As ações do GitHub Actions eram referenciadas por **etiqueta** (`@v7`), que o dono da ação pode mover. | Fixadas por **SHA do commit**; o Dependabot propõe as atualizações. | revisão |
| P-01 | Preventiva | Cabeçalhos de segurança | `Permissions-Policy` ampliada (USB, serial, HID, Bluetooth, pagamento bloqueados), `Cross-Origin-Resource-Policy`, `Origin-Agent-Cluster`, `X-Permitted-Cross-Domain-Policies`. | `seguranca` › cabeçalhos |
| P-02 | Preventiva | Ajuste de banda no SDP (não padronizado) pode ser recusado por navegadores futuros. | Se recusado, a conexão segue sem o ajuste (só a subida de banda fica mais lenta). | revisão |

## Novas superfícies desta versão (revisadas)

| Item | Risco avaliado | Controle |
|---|---|---|
| Instalador do Node.js (`instalar-node.ps1` / `.sh`) | Baixar e executar um binário trocado (servidor ou rede comprometidos) | Só HTTPS do `nodejs.org`; **SHA-256** igual ao `SHASUMS256.txt` oficial; no Windows, **assinatura Authenticode válida da OpenJS Foundation**; no macOS, `codesign`. Instala só na pasta do programa, sem administrador. |
| Baixador do `cloudflared` | Idem | Só da versão oficial `cloudflare/cloudflared`; endereço de download conferido; **SHA-256** publicado pelo GitHub; **assinatura da Cloudflare, Inc.** (Windows) ou `codesign` (macOS). Falha não impede o uso (cai no SSH). |
| Padrões que antivírus associam a malware | Falso positivo ou, pior, abrir espaço para execução de texto baixado | Teste estático reprova a versão se aparecer `Invoke-Expression`, `iex`, `-EncodedCommand`, `DownloadString`, janela escondida ou `curl | bash`. |
| Biblioteca de QR code (`public/vendor/qrcode.js`) | Código de terceiros na página | Cópia **sem alterações** do qrcode-generator 2.0.4 (MIT, commit `83b7e8fe`); revisada: sem `eval`, sem `innerHTML`, sem acesso à página ou à rede. QR conferido por leitor independente (jsQR) nos testes. |
| Reconexão automática | Reconexão sem autorização | Quem reconecta passa de novo pelo **PIN** (o mesmo digitado, guardado só na memória da aba) e recebe novo identificador; quem foi **removido** não reconecta. |
| Conexão direta mantida quando o servidor cai | Pessoa removida continuar vendo | "Remover" encerra a conexão direta na hora; só quem **perdeu o servidor sem ser removido** continua vendo. |

## Verificado e mantido (sem alteração)

Criptografia de ponta a ponta (chave no `#`, AES-256-GCM, HKDF-SHA-512, anti-replay), PIN com HMAC-SHA-512 e comparação em tempo constante, painel só local (Host/Origin, porta externa separada, CSRF, DNS rebinding), CSP sem script inline, sem `innerHTML`/`eval`, bloqueio de caminho (`../`), segredos de TURN com DPAPI e fora do repositório, zero dependências npm em produção, servidor só em `127.0.0.1`.

## Riscos residuais

Ver [`MODELO-DE-AMEACAS.md`](MODELO-DE-AMEACAS.md) (riscos residuais) e [`RISCOS-LEGAIS-E-CONTINUIDADE.md`](RISCOS-LEGAIS-E-CONTINUIDADE.md). Os principais: quem entrega a página (o túnel) poderia, em tese, servir JavaScript alterado; espectador legítimo pode gravar a tela; serviços de link gratuitos sem garantia.

## Como repetir

```
npm test                      # inclui seguranca, instalador, experiencia
npm run test:coverage         # com cobertura minima obrigatoria
```

No GitHub Actions: `testes` (3 sistemas), `instalador` (downloads reais, semanal), `laboratorio-de-redes`, `codeql`.
