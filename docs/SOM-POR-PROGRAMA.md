# Som de cada programa (como no Discord)

O TelaLink deixa escolher **qual som vai** em cada transmissão.

## 1. Só o som do programa que você compartilha (recomendado)

**Chrome ou Edge 141 ou mais novo, no Windows ou no macOS 14.2+.**

1. Clique em **Minha tela**.
2. Na janela de escolha, vá em **Janela** e escolha o programa (jogo, player, navegador).
3. Deixe marcado **"Compartilhar o áudio"**.

Vai **só o som daquele programa**: notificações, música de fundo e outros programas ficam de fora. O TelaLink pede isso ao navegador automaticamente (`windowAudio: "window"`) e também tira da captura os sons do próprio painel.

| Você escolhe | Som que vai |
|---|---|
| **Janela** | Só aquele programa (Chrome/Edge 141+) |
| **Aba** do navegador | Só aquela aba |
| **Tela inteira** | Todo o som do computador |

Trocar de janela durante a transmissão (🔄 **Trocar**) troca o som junto.

## 2. Somar o microfone ou outro dispositivo

Em ⚙ **Configurações → Áudio → "Somar também o som de"**:

- **Meu microfone**, para narrar, com redução de eco e ruído;
- **Outro dispositivo**: clique em "Mostrar outros dispositivos de som" e escolha. Serve para placa de captura, "Mixagem estéreo" ou cabo de áudio virtual. O som vai puro, sem processamento.

O som somado tem **volume próprio**, e durante a transmissão aparece o botão **🎙 Microfone ligado/desligado**.

Isso também funciona no **Firefox e no Safari**, que não capturam o som da tela.

## 3. Windows antigo, Firefox ou Safari: som de um programa só

Sem o recurso do item 1, dá para chegar no mesmo resultado com o roteamento de som do próprio Windows:

1. Instale um **cabo de áudio virtual**. O VB-CABLE, da VB-Audio, é gratuito. É um programa de terceiros: baixe só do site oficial.
2. Em **Configurações do Windows → Sistema → Som → Mixer de volume**, mude a **saída** do jogo para "CABLE Input".
3. No TelaLink, em "Somar também", escolha **"CABLE Output"**.

Você deixa de ouvir o jogo nos seus fones. Para continuar ouvindo, ative "Escutar este dispositivo" no CABLE Output (Painel de Som → Gravação → Propriedades → Escutar).

## Por que não um capturador próprio por processo?

O Discord usa um recurso do Windows (*process loopback*, no WASAPI) através de um programa instalado. Para fazer igual, o TelaLink precisaria distribuir um **executável nativo**. Isso quebra a regra de não ter nada que antivírus e anti-cheats vigiam (ver [`ANTI-CHEAT-E-ANTIVIRUS.md`](ANTI-CHEAT-E-ANTIVIRUS.md)) e exigiria assinatura de código. Como o Chrome e o Edge já fazem isso nativamente (item 1), essa opção fica para o futuro, se for realmente necessária.
