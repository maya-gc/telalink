# Fluidez da imagem e por que o link muda

## 1. "Trava, acelera e depois mostra"

### O que acontecia

A internet não entrega os dados num ritmo perfeito. O túnel do link (Cloudflare, localhost.run), o Wi-Fi e a operadora às vezes seguram tudo por algumas centenas de milissegundos e depois soltam de uma vez.

- **Na retransmissão** (pelo link), quem assiste mostrava cada quadro **no instante em que chegava**. Quando a rede segurava, a imagem congelava; quando soltava, os quadros acumulados apareciam todos juntos, e a imagem "corria" para alcançar.
- O ajuste automático de banda olhava só a fila **do próprio computador de quem transmite**. Como o servidor roda no mesmo PC, essa fila nunca enchia: com internet lenta, a banda não baixava, e o atraso se acumulava no túnel até travar.
- Se o decodificador recebia mais de 8 quadros de uma vez (justamente na rajada), descartava tudo até o próximo quadro-chave, o que congelava a imagem de novo.
- **Na conexão direta**, o navegador usa por padrão um *buffer* mínimo, pensado para chamadas de vídeo. Com a banda curta, conteúdo em movimento perdia **quadros** em vez de resolução, e isso aparecia como "travadinhas".

### O que mudou (2.8.0)

| Onde | Correção |
|---|---|
| Retransmissão: quem assiste | **Buffer de reprodução** (*jitter buffer*): cada quadro tem o horário em que foi capturado e é mostrado nesse horário mais um atraso. Quando a rede engasga, o atraso cresce na hora (até 1,2 s) e a rajada sai no **ritmo normal**. Com a rede estável, o atraso volta a cair devagar (~1,5% de velocidade, imperceptível). |
| Retransmissão: som | Usa o mesmo atraso do vídeo (sincronia labial). Pequenas diferenças são corrigidas tocando 2% mais rápido ou mais devagar, sem cortes. |
| Retransmissão: banda | Quem assiste mede o atraso de fila e avisa quem transmite a cada segundo, e a banda baixa **antes** de travar. Com 3 ou mais pessoas, vale a segunda pior conexão: uma só muito ruim não derruba a qualidade de todos. |
| Retransmissão: decodificador | Recebe os quadros já no ritmo certo; só descarta se o PC realmente não der conta. |
| Conexão direta | Buffer de recepção de 200 ms (antes, o mínimo de chamada). Se a imagem congelar, ele sobe sozinho até 600 ms. No Safari/iPhone fica o buffer do próprio navegador (o ajuste ainda não pôde ser conferido no Safari de verdade). |
| Conexão direta: banda curta | Conteúdo em **Vídeo / movimento** (filmes, jogos, vídeos) passa a manter os quadros por segundo e baixar a resolução por alguns segundos. Com uma resolução escolhida a mão, usa um meio-termo. **Texto e detalhes** continuam mantendo a nitidez. |

O preço é um atraso um pouco maior: 0,2 a 1 s, conforme a rede. Para assistir a um filme ou jogo, isso não se nota.

### Medição

Teste `test/fluidez.test.js` e a ferramenta `bench/rede-ruim.mjs`. A rede ruim simulada tem banda limitada e, a cada ~4 s, segura tudo por 700 ms e solta de uma vez. Resultado em 15 s pela retransmissão:

| | Congelamentos | Tempo congelado | Quadros "correndo" |
|---|---|---|---|
| Antes | 3 | 2,0 s | 30 |
| Depois | 1 (só o primeiro engasgo, até o buffer se ajustar) | 0,7 s | **0** |

Em 30 s, o resultado continua o mesmo: depois do primeiro engasgo, nada mais congela. Sem engasgos, nada muda (0 congelamentos).

O **📋 Copiar diagnóstico** de quem assiste agora inclui a fluidez (congelamentos, "correrias", variação) e o atraso do buffer.

### Se ainda travar

- **Conexão direta** costuma ser mais fluida que a retransmissão. Se aparecer "pela retransmissão" no painel, veja `NAVEGADORES.md` (Brave, VPN).
- Wi-Fi fraco de quem transmite afeta todo mundo. Cabo de rede ajuda muito.
- Em ⚙ Configurações, **Vídeo / movimento** (o padrão) é o certo para filmes.

## 2. Por que o link muda ("links aleatórios")

O link tem três partes, e cada uma tem um motivo:

```
https://palavras-aleatorias.trycloudflare.com/view?room=2f1c…e9#k=Qm9…X4
└────────────── endereço ─────────────────┘      └─ sala ─┘   └── chave ──┘
```

| Parte | Por que é aleatória | Quando muda |
|---|---|---|
| **Endereço** | O link externo gratuito, sem conta, sorteia um endereço a cada vez que o TelaLink é aberto. É assim que esses serviços funcionam, e não dá para escolher o nome. | Toda vez que o programa é aberto. Também quando o serviço reconecta (o localhost.run troca de tempos em tempos; o painel avisa) |
| **Sala** | Identifica a transmissão. Aleatória para ninguém adivinhar. | **Antes:** a cada transmissão. **Agora:** só quando você clica em "Gerar link novo" |
| **Chave** (depois do `#`) | É a chave da criptografia de ponta a ponta. **Precisa** ser aleatória e secreta: nunca passa pelo servidor nem pelo túnel. | Junto com a sala |

### O que mudou (2.8.0)

- **Mesmo link e PIN** ao recarregar o painel, ao encerrar e começar de novo e ao reabrir o programa. Na reabertura, o endereço do serviço gratuito ainda muda; veja o item abaixo. Os dados ficam guardados só neste computador.
- Quem assiste vê *"A transmissão foi encerrada. Se quem transmite recomeçar, toque em Entrar de novo"* e volta sem pedir outro link. Quem abrir o link enquanto o painel está fechado fica esperando e entra sozinho quando a transmissão recomeça.
- **Gerar link novo** (tela inicial) desativa o link antigo na hora. Use se o link foi parar com quem não devia.
- **Endereço fixo** (opcional): com um domínio seu e uma conta gratuita na Cloudflare, o endereço também fica sempre o mesmo. Configure em ⚙ → Avançado → **Link fixo** e escolha *Link externo → Endereço fixo*.
  - O token fica criptografado neste PC e vai para o conector só pela variável de ambiente (não aparece na lista de processos).
  - O domínio é pago à parte (um `.com.br` custa cerca de R$ 40/ano). Não há como ter endereço fixo grátis sem conta num serviço de túnel.

### Segurança

- Reaproveitar a sala não enfraquece a criptografia: a chave continua aleatória, de 256 bits, e só existe no seu PC e nos links que você mandou.
- O link guardado só vale enquanto o programa está aberto, e por até 10 min depois que o painel fecha. Ao reabrir, a mesma sala é recriada a partir do seu PC. Só o próprio computador pode recriar ou apagar salas (a porta do túnel recusa).
- Quem já tem o link e o PIN continua podendo entrar nas próximas transmissões. Se não quiser isso, use **Gerar link novo** ou **↻ Novo PIN**.
