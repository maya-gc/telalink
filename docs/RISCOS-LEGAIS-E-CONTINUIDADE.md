# Riscos legais, de bloqueio e de continuidade

Levantamento feito em 29/10/2026 para a versão 2.4.0. Responde a três perguntas: **o TelaLink infringe alguma lei ou regra?**, **pode ser derrubado ou bloqueado?** e **pode ficar limitado no futuro?**

> Este documento é um levantamento técnico com base em textos públicos. **Não é parecer jurídico.** Para uso comercial (vender o serviço, usar com clientes), vale confirmar com um advogado.

## Resumo

| Pergunta | Resposta curta |
|---|---|
| O programa é ilegal? | **Não.** É uma ferramenta de compartilhamento de tela como Google Meet, Discord ou VDO.Ninja: mostra só o que o próprio dono escolhe, sem controle remoto, sem invasão, sem contornar proteções. |
| Pode ser "derrubado"? | **Não existe servidor central do TelaLink para derrubar.** Ele roda no seu PC. O que pode parar são os **serviços gratuitos de link externo** (Cloudflare e localhost.run) — por isso há dois, com troca automática, e um caminho próprio (domínio seu). |
| Pode ser bloqueado? | **Em algumas redes, sim:** empresas e escolas costumam bloquear domínios de túnel gratuitos. O programa continua funcionando nas demais redes; a solução definitiva é um domínio próprio. |
| Pode virar vírus para o antivírus? | Risco **baixo e reduzido**: nada é escondido ou ofuscado, só se baixa de fontes oficiais com **hash e assinatura digital conferidos**, e testes automáticos impedem padrões que antivírus associam a malware. |
| Vai ficar limitado no futuro? | Os pontos que dependem de terceiros estão mapeados abaixo, cada um com plano B e **testes semanais** que avisam antes de quebrar para quem usa. |

## 1. Leis brasileiras

| Tema | O que diz | Situação do TelaLink |
|---|---|---|
| **LGPD** (Lei 13.709/2018) | Art. 4º: a lei **não se aplica** ao tratamento "realizado por pessoa natural para fins exclusivamente particulares e não econômicos". | Uso pessoal: fora da LGPD. Uso profissional: a LGPD passa a valer, mas o TelaLink **não grava nada** (nem imagem, nem som, nem lista de quem assistiu). O único dado pessoal é o IP, mantido **só na memória**, por até 15 minutos, para bloquear quem erra o PIN. Recomendação para uso profissional: avisar os participantes de que a tela será compartilhada. |
| **Direitos autorais** (Lei 9.610/1998) | Transmitir obra protegida a terceiros pode exigir autorização. O art. 107, I, pune quem "alterar, suprimir, modificar ou inutilizar [...] dispositivos técnicos" que evitam a cópia. | O TelaLink **não contorna DRM**: filmes protegidos aparecem pretos e o programa só explica o motivo. O que é transmitido é responsabilidade de quem transmite (igual a qualquer chamada de vídeo). Transmitir Netflix, jogos pagos etc. para outras pessoas pode violar os termos desses serviços. |
| **Invasão de dispositivo** (Lei 12.737/2012) | Crime: invadir dispositivo alheio. | Não se aplica: o TelaLink só mostra a tela **do próprio dono**, que escolhe o que compartilhar; quem assiste não controla nada nem acessa o computador. |
| **Marco Civil** (Lei 12.965/2014) | Art. 15: guarda de registros de acesso por 6 meses vale para provedor "constituído na forma de pessoa jurídica" que atue "com fins econômicos". | Uso pessoal: não se aplica. Se um dia o TelaLink for **oferecido como serviço pago**, avaliar essa obrigação. |
| **Criptografia** | O Brasil não restringe criptografia. Nos EUA (onde ficam o GitHub e a Cloudflare), desde 29/03/2021 o código aberto com criptografia **padrão** publicado não exige notificação ao governo (a exceção é criptografia "não padrão"). | Só usa algoritmos padrão (AES-256-GCM, HKDF, SHA-512, ECDHE do WebRTC) através das bibliotecas do navegador e do Node.js. |

## 2. Licenças e patentes

| Item | Licença | Observação |
|---|---|---|
| TelaLink | MIT | Livre para usar, modificar e distribuir. |
| qrcode-generator (QR do convite) | MIT | Copiado sem alterações em `public/vendor/`, com a licença ao lado. "QR Code" é marca da DENSO WAVE, que não cobra pelo uso do padrão. |
| jsQR | Apache-2.0 | Só nos testes (confere os QR codes). Não vai para quem usa. |
| Node.js, cloudflared | MIT / Apache-2.0 | **Não são redistribuídos**: o programa baixa a cópia oficial de cada fornecedor no PC do usuário. |
| Codecs de vídeo | — | O H.264 é codificado pelo **navegador**, que já é licenciado pelo fabricante. VP8, VP9 e AV1 são livres de royalties. O TelaLink não distribui codecs. |

Lista completa: [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md).

## 3. Termos de uso dos serviços de link externo

| Serviço | O que os termos/documentação dizem | Risco | O que o TelaLink faz |
|---|---|---|---|
| **Cloudflare Quick Tunnel** (`trycloudflare.com`) | "Destinado a testes e desenvolvimento"; **sem garantia de disponibilidade** (sem SLA); limite de 200 requisições simultâneas; instalar o cloudflared implica aceitar os termos da Cloudflare. | Médio: a Cloudflare pode mudar ou limitar o serviço gratuito a qualquer momento. Uso pessoal leve está dentro do que o serviço oferece, mas não é garantido. | Usa a cópia oficial, com configuração isolada. Se falhar, troca para o SSH. Para uso contínuo/profissional: túnel com conta (seção 6). |
| **localhost.run** (SSH, plano grátis) | O endereço **muda a cada poucas horas**; há limite de velocidade e de requisições por endereço, para impedir sites de phishing. | Médio: em transmissões longas o link muda. | O painel **avisa quando o link muda** e atualiza o convite e o QR; quem assiste por conexão direta continua vendo; quem perdeu a conexão tenta voltar sozinho. O Cloudflare é preferido quando disponível. |

Os dois proíbem uso para fraude, phishing ou malware — o que nada tem a ver com o TelaLink, mas explica por que esses domínios são vigiados (seção 4).

## 4. Bloqueios técnicos possíveis

| Onde | Por quê | Mitigação |
|---|---|---|
| **Redes de empresa e escola** | Domínios de túnel gratuitos (`trycloudflare.com`, `lhr.life`, `ngrok`) são usados por criminosos em golpes; pesquisas de segurança publicam esses domínios como indicadores e muitos filtros os bloqueiam. | Quem estiver numa rede assim pode usar o 4G do celular. Solução definitiva: domínio próprio (seção 6). |
| **Computador de empresa (antivírus corporativo/EDR)** | Ferramentas de segurança corporativa alertam sobre `cloudflared` e `ssh -R` porque podem expor serviços internos. | Usar no **computador pessoal** ou com autorização da TI. Usar em PC da empresa sem permissão pode violar a política interna, mesmo não sendo crime. |
| **Antivírus/SmartScreen doméstico** | Scripts que baixam programas são um padrão comum de malware. | Sem código ofuscado, sem executar texto baixado, sem janela escondida; só fontes oficiais; **SHA-256 + assinatura digital** conferidos; código aberto; teste automático que reprova a versão se algum padrão suspeito aparecer. Para eliminar avisos de vez: assinatura de código (ver [`ASSINATURA-DE-CODIGO.md`](ASSINATURA-DE-CODIGO.md)). |
| **Navegadores** | Mudanças futuras (ex.: o Chrome está restringindo a edição de SDP). | Onde o TelaLink usa algo não padronizado (banda inicial no SDP), há **plano B automático**: se o navegador recusar, a conexão segue sem o ajuste. Os testes rodam semanalmente no navegador atual. |

## 5. O que pode limitar o programa no futuro, e o plano B

| Dependência | Se mudar... | Plano B já pronto |
|---|---|---|
| Cloudflare Quick Tunnel | Fim ou limite do serviço grátis | SSH (localhost.run) automático; túnel com conta grátis + domínio próprio |
| localhost.run | Fim do plano grátis | Cloudflare; domínio próprio |
| SSH do Windows | Ausente em alguma versão | Cloudflare baixado sozinho; o Diagnóstico explica como ativar o "Cliente OpenSSH" |
| nodejs.org / GitHub (instalação) | Mudança de nomes de arquivo, assinatura ou formato | Workflow **instalador** baixa de verdade nos 3 sistemas **toda semana** e avisa antes de chegar a quem usa |
| Recursos do navegador (WebCodecs, captura de áudio) | Mudança de API | Três caminhos (direto, TURN, retransmissão); testes E2E a cada envio |
| GitHub (hospedagem do código) | Conta suspensa por engano | O código fica no seu PC (clone completo); qualquer outro serviço git serve |

## 6. Para uso contínuo ou profissional: link próprio

Para não depender de serviços "de teste", o caminho recomendado é um **túnel da Cloudflare com conta gratuita e domínio próprio** (domínio `.com.br` custa cerca de R$ 40/ano). Vantagens: endereço fixo, permitido para uso em produção, sem troca de link, menos bloqueio em filtros.

1. Crie a conta gratuita na Cloudflare e adicione seu domínio.
2. Em **Zero Trust → Networks → Tunnels**, crie um túnel e aponte um nome (ex.: `tela.seudominio.com.br`) para **`http://localhost:8081`** — a **porta externa** do TelaLink (nunca a 8080, que é a do painel).
3. Rode o conector que a Cloudflare indica e inicie o TelaLink com `PUBLIC_URL=https://tela.seudominio.com.br` e `TUNNEL=0`.

## 7. Uso responsável (resumo para quem usa)

- Compartilhe só o que é seu ou o que você tem direito de mostrar.
- Envie o link e o PIN de preferência por canais diferentes; use **Novo PIN** se aparecer aviso de tentativas erradas.
- Em computador de empresa, peça autorização à TI.
- Não use para transmitir publicamente conteúdo pago (filmes, jogos, cursos).

## Fontes

- Lei 13.709/2018 (LGPD), art. 4º — [texto da lei (USP)](https://www.hemocentro.fmrp.usp.br/wp-content/uploads/2025/08/Lei-no-13.709-de-14-de-agosto-de-2018.pdf) · [Planalto](https://planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm)
- Exceções da LGPD — [Thomson Reuters](https://www.thomsonreuters.com.br/pt/juridico/blog/excecoes-da-lgpd.html)
- Lei 9.610/1998, art. 107 — [Jus.com.br](https://jus.com.br/artigos/33184/a-ilicitude-do-digital-rights-management-drm-no-direito-brasileiro) · [Senado](https://legis.senado.leg.br/norma/551486)
- Lei 12.965/2014 (Marco Civil), art. 15 — [ABEMD](https://abemd.org.br/wp-content/uploads/2024/11/marco_civil_internet.pdf)
- Exportação de criptografia (EUA, 2021) — [Thompson Hine](https://www.thompsonhine.com/publications/bis-eliminates-most-mass-market-encryption-reporting-obligations) · [Linux Foundation](https://bestpractices.linuxfoundation.org/export/non-standard-cryptography.html)
- Cloudflare Quick Tunnels — [documentação oficial](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
- localhost.run, plano grátis — [documentação oficial](https://localhost.run/docs/forever-free)
- Abuso de túneis gratuitos em golpes — [Gurucul](https://community.gurucul.com/articles/ThreatResearch/Criminals-Abusing-Tunneling-Services-25-2-2025) · [Proofpoint/BleepingComputer](https://proofpoint.com/us/newsroom/news/hackers-abuse-free-trycloudflare-deliver-remote-access-malware)
- Restrição de edição de SDP no WebRTC/Chrome — [libwebrtc](https://raw.githubusercontent.com/mozilla-firefox/firefox/main/third_party/libwebrtc/g3doc/todo/sdp-munging.md)
- Código do cloudflared (comportamento com `config.yaml`) — [GitHub cloudflare/cloudflared](https://github.com/cloudflare/cloudflared)
