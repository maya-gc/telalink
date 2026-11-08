# Estudo: aplicativo nativo (Rust ou outra linguagem) × versão web atual

Processo: **Análise e Resolução de Decisão (DAR)** do CMMI. Data: 08/11/2026. Versão analisada: 2.7.0.

## 1. Problema a decidir

Vale a pena trocar (ou complementar) o TelaLink atual, feito de páginas no navegador e servidor Node.js sem dependências, por um **executável próprio** em Rust, Go, C# ou outra linguagem? O objetivo é chegar ao "aplicativo mais otimizável possível" sem perder o que já funciona.

Fatos que delimitam a decisão:

- **Quem assiste continua no navegador em qualquer alternativa.** Abrir um link sem instalar nada é o requisito principal (RF-01). Um executável só muda o lado de **quem transmite**.
- **O problema do Brave era do lado de quem assiste e da conexão**, não da linguagem. Ele foi resolvido na própria versão web (2.7.0; ver `NAVEGADORES.md`). Um aplicativo nativo não teria evitado esse problema.
- O servidor Node já é leve: ver `DESEMPENHO.md`, com codificação uma vez para todos e 0,6 coletas de lixo/s com 20 pessoas. **O peso real está na captura e na codificação**, que hoje o navegador faz, e o Chrome/Edge já usam a placa de vídeo (NVENC, Quick Sync, AMF) quando ela existe.

## 2. Critérios e pesos

| # | Critério | Peso | Por quê |
|---|---|---|---|
| C1 | Desempenho em quem transmite (processador, memória, latência) | 25% | Pedido principal ("o mais otimizável") |
| C2 | Compatibilidade (sistemas, navegadores de quem assiste, sem instalar) | 20% | Requisito central do produto |
| C3 | Segurança (superfície de ataque, memória segura, atualização) | 15% | `MODELO-DE-AMEACAS.md` |
| C4 | Antivírus e anti-cheat (Vanguard, EAC, VAC…) | 15% | `ANTI-CHEAT-E-ANTIVIRUS.md`: hoje não há nenhum executável próprio |
| C5 | Custo (assinatura de código; regra do projeto: sem cartão, sem cobrança) | 10% | `ASSINATURA-DE-CODIGO.md` |
| C6 | Esforço e manutenção (3 sistemas, testes, CI) | 15% | Projeto mantido por uma pessoa |

Notas de 1 (ruim) a 5 (ótimo).

## 3. Alternativas

| | Alternativa | Como seria |
|---|---|---|
| **A** | **Web + Node (atual)** | O navegador captura e codifica (WebRTC/WebCodecs, placa de vídeo quando houver); o Node serve, retransmite e abre o túnel |
| **B** | **Rust nativo (quem transmite)** | Captura pela API do sistema (Windows Graphics Capture, ScreenCaptureKit, PipeWire), codificador da placa sem cópias (Media Foundation/NVENC), WebRTC em Rust (`webrtc-rs`/`str0m`), som por processo (WASAPI *process loopback*); serve a mesma página de quem assiste |
| **C** | **Go + Pion** | Igual a B, com WebRTC maduro (Pion) e captura via cgo |
| **D** | **C#/.NET** | Igual a B, com as APIs do Windows à mão (WGC, Media Foundation, WASAPI) e SIPSorcery para WebRTC |
| **E** | **Tauri** | Janela própria com o WebView do sistema e um núcleo Rust |
| **F** | **Electron** | Janela própria com um Chromium embutido (~150 MB) |
| **G** | **Híbrido: A + auxiliar nativo opcional** | Tudo continua como em A; um pequeno programa Rust *opcional*, desligado por padrão, entra só onde o navegador não alcança (ex.: som de um programa em Windows antigo, codificação sem cópia), atrás de uma "porta" bem definida |

## 4. Avaliação

| Critério (peso) | A | B | C | D | E | F | G |
|---|---|---|---|---|---|---|---|
| C1 Desempenho (25%) | 3 | **5** | 4 | 4 | 3 | 2 | 4 |
| C2 Compatibilidade (20%) | **5** | 4 | 4 | 3 | 3 | 4 | **5** |
| C3 Segurança (15%) | 4 | 4 | 4 | 4 | 4 | 3 | 4 |
| C4 Antivírus/anti-cheat (15%) | **5** | 2 | 2 | 3 | 3 | 3 | 4 |
| C5 Custo (10%) | **5** | 2 | 2 | 2 | 2 | 2 | 4 |
| C6 Esforço (15%) | **5** | 1 | 2 | 2 | 3 | 3 | 3 |
| **Nota ponderada** | **4,35** | 3,30 | 3,20 | 3,15 | 3,05 | 2,85 | **4,05** |

Justificativas das notas que mais pesam:

- **C1, B = 5.** Um nativo bem feito evita o processo do navegador (centenas de MB) e as cópias de quadro entre captura e codificador. O ganho esperado é de 20–40% de processador e algumas centenas de MB de memória em quem transmite. **Em jogos leves o gargalo já é pequeno**, porque a codificação vai para a placa de vídeo; o ganho aparece mais em PCs sem codificador na placa.
- **C1, A = 3.** O navegador já usa a placa de vídeo e o servidor está otimizado. O que sobra é o custo fixo do Chrome.
- **C4, B/C = 2.** Um `.exe` novo, sem assinatura e sem reputação, que **captura a tela, o som e abre conexões de rede** é exatamente o perfil que antivírus heurísticos vigiam. Binários Go têm histórico conhecido de falsos positivos. Anti-cheats não banem por captura via APIs oficiais (OBS e Discord usam as mesmas), mas qualquer técnica de "game capture" por injeção está fora de questão.
- **C5, B–F = 2.** Para não gerar alertas é preciso assinatura de código: Trusted Signing exige assinatura paga no Azure, e certificados OV/EV custam por ano. Isso conflita com a regra "sem cartão, sem cobrança".
- **C2, E = 3.** No Windows, o WebView2 é Chromium e funciona como hoje. No macOS, o WKWebView tem as limitações do Safari, e no Linux o WebKitGTK tem suporte instável a captura de tela e WebRTC.
- **C6, B = 1.** Seria reescrever captura, codificação, som, WebRTC e retransmissão três vezes (uma por sistema), e o laboratório de testes atual teria que ser refeito.

**Sensibilidade.** Mesmo com o desempenho a **40%** do peso (C2 15%, C3 10%, C4 15%, C5 5%, C6 15%), a ordem não muda: A 4,10 · G 4,00 · B 3,55 · C 3,30 · D 3,30. Rust puro só venceria se antivírus, custo e esforço deixassem de importar. Isso não é o caso de um projeto público, gratuito e mantido por uma pessoa.

## 5. Decisão

1. **Manter a versão web + Node como produto principal (A).**
2. **Reservar o auxiliar nativo opcional em Rust (G)** para quando um gatilho medido for atingido (seção 7). Rust tem segurança de memória sem coletor de lixo, binário pequeno e sem *runtime*, e as APIs de captura dos três sistemas.
3. **Descartar Electron** (mais pesado que o próprio Chrome) e **Tauri** como janela principal (no Mac e no Linux, o WebView é pior para captura do que o navegador da pessoa).

## 6. Arquitetura recomendada (padrões de projeto)

O que já existe e o que fica como meta:

| Padrão | Onde já está | O que fazer |
|---|---|---|
| **Portas e adaptadores (hexagonal)** | `startApp({ settings, iceProvider, getTunnelInfo })` recebe as dependências; `Tunnel`/`SshTunnel` são adaptadores do mesmo contrato | Formalizar 4 portas: **Captura** (tela/janela/imagens), **Codificador**, **Transporte** (direta/retransmissão), **Túnel** (Cloudflare/SSH). O auxiliar nativo da fase 3 entra como mais um adaptador de Captura/Codificador, **sem mudar o resto** |
| **Strategy** | `orderCodecs(codecs, hw, priority)` (H.264/VP9/VP8, placa × processador); `TunnelManager` escolhe o provedor | Mesmo contrato para os transportes: `DirectTransport` e `RelayTransport` |
| **State (máquina de estados)** | Conexão de quem assiste: `conectando → direta / retransmissao`, com `upgrading`/`fallingBack` | Trocar os indicadores soltos por uma máquina explícita (`link → pin → host → imagem`, `direta ⇄ retransmissao`), que já é o que as etapas visíveis da 2.7.0 mostram |
| **Observer** | `EventEmitter` em `Tunnel`/`TunnelManager`; mensagens de sinalização (`hello`, `settings`, `no-direct`…) | Um barramento de eventos da sessão no navegador, que a interface só escuta |
| **MVC / MVVM** | Hoje `host.js` (898 linhas) e `viewer.js` (516 linhas) misturam estado, regras e DOM | Separar **Modelo** (sessão, pessoas, transporte), **Controlador** (sinalização, decisões de fallback) e **Visão** (`render*`), para testar as regras sem navegador |

```
              ┌──────────── Núcleo (regras da sessão) ────────────┐
 Visão  ⇄  Controlador  ⇄  Modelo (estado)  ⇄  Eventos (Observer)
              └──┬──────────┬──────────────┬──────────────┬──────┘
           porta Captura  porta Codif.  porta Transporte  porta Túnel
              │             │              │                 │
     navegador | nativo  WebRTC/WebCodecs  direta | retransm.  Cloudflare | SSH
     (fase 3, opcional)  | nativo (fase 3)
```

## 7. Plano por fases

| Fase | O que | Critério de pronto |
|---|---|---|
| **1 (agora, 2.7.0)** | Brave/WebRTC restrito resolvido na web, etapas e diagnóstico visíveis, interface de celular | `brave.test.js`, `celular.test.js` e o CI verdes |
| **2** | Refatorar para as portas da seção 6, em JavaScript: extrair Modelo/Controlador de `host.js` e `viewer.js` e criar a máquina de estados da conexão | Mesmos testes passando, mais testes unitários das regras sem navegador |
| **3 (só com gatilho)** | Auxiliar Rust opcional, desligado por padrão, falando com o Node por `localhost`: som por processo (WASAPI) e/ou captura + NVENC sem cópia | **Gatilhos:** (a) medição em `bench/navegador.mjs` mostra o Chrome acima de 25% de processador ou 1,5 GB num PC típico a 1080p60; **ou** (b) há demanda real por som de um programa fora do Chrome/Edge 141+; **e** (c) existe forma de assinar sem cobrança, ou a pessoa aceita o custo |
| **4 (não recomendado)** | Reescrever quem transmite inteiro em Rust | Só se a fase 3 provar ganho grande **e** os custos de C4/C5 forem resolvidos |

Riscos da fase 3 e mitigação: alertas de antivírus (assinar e publicar os hashes); a regra "sem executáveis no repositório" continua valendo (o binário viria de uma Release assinada, nunca do repositório, e o `anticheat.test.js` segue barrando); manutenção em 3 sistemas (começar só pelo Windows, onde está a demanda).

## 8. Resumo para quem decide

Um executável em Rust deixaria quem transmite um pouco mais leve. Mas ele não resolve nada do lado de quem assiste, gera alertas de antivírus sem uma assinatura paga e custa uma reescrita grande. A melhor relação custo/benefício é **continuar na web**, organizar o código em portas e adaptadores (fase 2) e deixar um auxiliar Rust **opcional** pronto para entrar só se as medições mostrarem necessidade.
