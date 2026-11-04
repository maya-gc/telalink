# Desempenho

Levantamento de 04/11/2026 (versão 2.6.0): onde o TelaLink gasta processador e memória, o que foi corrigido e que outras opções existem.

## Onde está o peso

Medido com `bench/servidor.mjs` e `bench/navegador.mjs` (máquina de teste com 2 núcleos, tela de 1080p).

**Servidor (Node.js) — leve.** Retransmitindo para 20 pessoas a 25 Mbps e 60 qps, com quadros-chave grandes:

| | Antes | Depois |
|---|---|---|
| Processador | ~6% de um núcleo | ~6% de um núcleo |
| Memória (RSS) | 119 MB | 104 MB |
| Coletas de lixo | 2,6/s | 0,6/s |

O servidor não é o gargalo: trocar o coletor de lixo (GC) do V8 ou reescrever o servidor em outra linguagem **não diminuiria** o peso que você sente. Um ajuste de GC (`--max-semi-space-size=16`) foi testado e não trouxe ganho, por isso não foi aplicado.

**Navegador de quem transmite — aqui está o peso.** Ele captura a tela e **codifica** o vídeo. Na conexão direta, **cada pessoa tem uma codificação própria**:

| Cenário (1080p) | Processador | Memória |
|---|---|---|
| Só capturar a tela | 0,20 núcleo | 716 MB |
| 1 pessoa, VP9 (padrão antigo sem placa de vídeo) | 0,51 | 927 MB |
| 1 pessoa, H.264 (novo padrão "Leve") | **0,40** | **763 MB** |
| 3 pessoas — antigo (3 codificações VP9) | 0,92 | 1380 MB |
| 3 pessoas — **novo** (2 diretas + 1 compartilhada) | **0,80** | **876 MB** |
| 5 pessoas — antigo | 0,94 ¹ | 1783 MB |
| 5 pessoas — **novo** | **0,74** ¹ | **892 MB** |

¹ Com 5 pessoas a máquina de teste fica saturada; num PC com mais núcleos a diferença é maior. Num jogo a 60 qps, cada codificação custa várias vezes mais que na tela de teste — por isso evitar codificações repetidas é a otimização mais importante.

## O que foi feito

| Otimização | Efeito |
|---|---|
| **Placa de vídeo primeiro**: o TelaLink pergunta ao navegador quais codecs o PC codifica por hardware e os usa antes de tudo | Quase zero de processador para codificar, quando há suporte |
| **Prioridade "Leve" (padrão)**: sem placa de vídeo, usa o codec mais leve (H.264); "Mais nitidez" usa o VP9 | ~20% menos processador por pessoa |
| **Codificação compartilhada**: a partir de N pessoas (padrão: 2), quem entra recebe pela retransmissão, que codifica **uma vez para todos** | O processador e a memória param de crescer com o número de pessoas |
| **Captura só do necessário**: com qualidade 1080p num monitor 4K, captura em 1080p | Até 4× menos pixels para processar |
| **Painel em segundo plano**: pré-visualização e detector de tela preta pausam enquanto você joga | Menos uso da placa de vídeo |
| **Servidor**: junta os pedaços de rede uma vez só, monta cada pacote uma vez para todos os espectadores, remove a máscara do WebSocket de 4 em 4 bytes | −75% de coletas de lixo, −13% de memória |
| **Indicador**: o painel mostra, por pessoa, se o vídeo sai pela **placa de vídeo** ou pelo **processador** | Diagnóstico rápido |

## Como deixar ainda mais leve (no seu PC)

1. **Aceleração de hardware ligada** no navegador (Chrome/Edge: Configurações → Sistema → "Usar aceleração de hardware quando disponível") e driver de vídeo atualizado. No painel, confira "(placa de vídeo)" ao lado do codec.
2. **Jogos**: qualidade **Média (720p)** a 60 qps, ou **Alta (1080p)** a 30 qps.
3. **Várias pessoas**: deixe "Pessoas com conexão direta própria" em 1 ou 2.
4. **Máxima segurança**: todos recebem pela retransmissão, sempre com uma codificação só.

## Outras opções avaliadas (não implementadas)

| Opção | Ganho | Por que não agora |
|---|---|---|
| **SFU no servidor** (o servidor repassa a mesma codificação por WebRTC para todos, com a latência baixa da conexão direta) | Uma codificação para todos **sem** a latência maior da retransmissão | Exige uma pilha WebRTC no servidor (biblioteca nativa): quebraria "zero dependências" e "nenhum executável" (ver `ANTI-CHEAT-E-ANTIVIRUS.md`) |
| **Aplicativo nativo** (em vez do navegador) para capturar e codificar | Controle total do codificador de hardware | Programa instalável, precisaria de assinatura de código e revisão de antivírus/anti-cheat |
| **Simulcast/SVC** (uma codificação em várias camadas) | Cada pessoa recebe a camada que a internet dela aguenta | Ganho de qualidade, não de processador |
| **Outro GC / back-end em Go ou Rust** | Nenhum relevante (servidor já usa ~6% de um núcleo) | Medido: não é gargalo |

## Como medir

```
node bench/servidor.mjs 1,5,20 25 60 8        # servidor: pessoas, Mbps, qps, segundos
node bench/navegador.mjs 10                    # navegador de quem transmite (Linux)
NODE_FLAGS="--max-semi-space-size=16" node bench/servidor.mjs 20 25 60 6   # testar ajustes de GC
```

O teste `test/desempenho.test.js` roda a cada envio e reprova a versão se o servidor passar dos limites (processador, memória ou coleta de lixo).
