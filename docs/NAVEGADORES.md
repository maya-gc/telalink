# Navegadores suportados

O TelaLink detecta o que cada navegador consegue fazer e se adapta sozinho. Quem **assiste** pode usar qualquer navegador moderno, inclusive no celular. Quem **transmite** precisa de um computador.

| | Chrome | Edge | Brave | Opera | Firefox | Safari (Mac) | iPhone / iPad | Android |
|---|---|---|---|---|---|---|---|---|
| **Assistir** (conexão direta) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Assistir** pela retransmissão / Máxima segurança | ✅ | ✅ | ✅ | ✅ | ✅ 130+ | ✅ 16.4+ ¹ | ✅ 16.4+ ¹ | ✅ |
| **Transmitir a tela** | ✅ | ✅ | ✅ | ✅ | ✅ sem som ² | ✅ sem som ² | — ³ | — ³ |
| **Transmitir imagens** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Som do computador** junto | ✅ | ✅ | ✅ | ✅ | — ² | — ² | — | — |

1. Se a versão do Safari não tiver o decodificador de som da retransmissão, a imagem chega normalmente e a página avisa que o som não está disponível nesse caminho (na conexão direta o som funciona).
2. Limitação do próprio navegador: só os navegadores baseados no Chromium (Chrome, Edge, Brave, Opera) entregam o som da tela/aba para páginas. O painel avisa.
3. Celulares e tablets não permitem que páginas capturem a tela. O botão fica desativado com a explicação; dá para transmitir **Imagens**.

## O que o TelaLink faz para funcionar em todos

| Diferença entre navegadores | Como o TelaLink lida |
|---|---|
| Safari bloqueia som automático | Começa mudo e mostra "Toque para ativar o som" |
| iPhone não tem tela cheia em elementos da página | Usa a tela cheia do próprio vídeo ou um modo de tela cheia da página |
| Firefox e Safari não expõem os quadros da tela do jeito do Chrome | A retransmissão copia os quadros da pré-visualização (`requestVideoFrameCallback`) ou, em último caso, num ritmo fixo |
| Firefox e Safari: som da retransmissão | Capturado por AudioWorklet e codificado em Opus (WebCodecs) |
| Cada navegador decodifica codecs diferentes | Quem assiste informa quais decodifica; quem transmite escolhe um codec que **todos** aceitam (H.264, VP9 ou VP8) e troca na hora se entrar alguém com outro navegador |
| Firefox marca a conexão em uso de outro jeito | Detecção do caminho (direta/TURN) reconhece os dois formatos |
| Opções de captura não reconhecidas em versões antigas | Tenta de novo com o pedido mais simples |
| Brave com WebRTC restrito (Shields) | Troca sozinho para a retransmissão |
| Safari antigo (`webkitAudioContext`) | Usado automaticamente |

## Como é testado

Workflow **navegadores** no GitHub Actions (a cada envio e toda semana, para pegar versões novas):

| Sistema | Navegadores |
|---|---|
| Linux | Firefox, WebKit (motor do Safari), Chrome |
| Windows | Edge, Chrome, Firefox, Brave |
| macOS | WebKit, Chrome e o **Safari de verdade** (via `safaridriver` da Apple) |

Para cada um: assistir pela conexão direta, assistir pela retransmissão (Máxima segurança) e, onde o navegador permite automatizar a escolha de tela, transmitir. Os testes do dia a dia (`npm test`) usam o Chromium.
