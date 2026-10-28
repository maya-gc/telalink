# Assinatura de código e alertas do Windows

## Por que o Windows avisava

A versão anterior trazia o `cloudflared` compactado e um script o extraía e executava. Esse padrão ("um script escreve um `.exe` e roda") é exatamente o que antivírus procuram em programas maliciosos (*droppers*). Por isso o alerta, mesmo o arquivo sendo o oficial.

## O que mudou

- O projeto **não contém nenhum executável**. Há só scripts (`.bat`, `.js`) executados pelo `node.exe`, que é assinado pela OpenJS Foundation.
- O `cloudflared` é instalado pelo **winget** (pacote `Cloudflare.cloudflared`), o instalador oficial da Microsoft, a partir do instalador assinado da Cloudflare.
- Antes de usar, o TelaLink confere a **assinatura Authenticode**: precisa estar válida e pertencer à **Cloudflare, Inc.** Qualquer outro arquivo é recusado.

## Se ainda aparecer um aviso

| Aviso | Causa | O que fazer |
|---|---|---|
| "O Windows protegeu o computador" (SmartScreen) ao abrir um `.bat` | O arquivo veio da internet (zip baixado) e não tem assinatura | Clique com o botão direito no zip → Propriedades → **Desbloquear**, antes de extrair. Ou use o projeto clonado pelo GitHub Desktop |
| Antivírus alerta sobre `cloudflared` | Alguns antivírus classificam ferramentas de túnel como "potencialmente indesejadas" | Confira em Propriedades → Assinaturas Digitais que o assinante é *Cloudflare, Inc.*; se for, envie como falso positivo ao fabricante do antivírus (Microsoft: https://www.microsoft.com/wdsi/filesubmission) |

## Assinar o próprio TelaLink (opcional, para distribuir)

Para distribuir o TelaLink a outras pessoas sem nenhum aviso, a solução definitiva é empacotá-lo como instalador **assinado com um certificado de assinatura de código** em nome do seu CPF/CNPJ:

1. **Obter um certificado de assinatura de código**:
   - *Microsoft Trusted Signing* (Azure): opção mais barata, assinatura mensal, validação de identidade feita pela Microsoft.
   - Certificado OV/EV de uma autoridade certificadora (DigiCert, Sectigo, GlobalSign...): pago por ano. Certificados EV ganham a confiança do SmartScreen mais rápido.
2. **Empacotar**: gerar um instalador MSI/MSIX (ex.: WiX Toolset) que inclua o `node.exe` oficial e os arquivos do TelaLink, e instale o `cloudflared` via winget na primeira execução.
3. **Assinar** o instalador com `signtool sign /fd SHA256 /tr <servidor de carimbo de tempo> /td SHA256 /a TelaLink.msi`.
4. **Publicar** os hashes SHA-256/SHA-512 do instalador junto da versão no GitHub (Releases).

Nenhum projeto consegue garantir "nunca vai aparecer aviso" sem assinatura de código: a reputação no SmartScreen é atribuída a quem assina.
