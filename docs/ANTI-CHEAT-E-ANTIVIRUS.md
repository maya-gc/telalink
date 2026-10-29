# Anti-cheats e antivírus

**Pergunta:** o TelaLink pode ser visto como trapaça ou malware por anti-cheats (Riot Vanguard, Easy Anti-Cheat, VAC da Valve, BattlEye, FACEIT) ou por antivírus, e causar banimento?

**Resposta curta:** o risco é **muito baixo**, porque o TelaLink não faz nada do que esses programas procuram. Ninguém consegue garantir **zero** falso positivo (os anti-cheats são fechados e mudam sem aviso), mas os falsos positivos conhecidos envolveram programas que **entram no processo do jogo** — e o TelaLink nunca entra.

## O que os anti-cheats procuram

Segundo os próprios fabricantes:

| Anti-cheat | O que procura / bloqueia | Sobre outros programas |
|---|---|---|
| **VAC** (Valve) | Programas que se **conectam (hook) aos arquivos do jogo** em execução | Reconhece que programas que não são trapaça já geraram ban por engano — gravadores, sobreposições e drivers que se conectavam ao jogo (ex.: AMD Anti-Lag+, que mexia nos arquivos do jogo) — e que esses bans são revertidos |
| **Easy Anti-Cheat** | Programas de trapaça e arquivos de sistema desconhecidos, depuradores, programas suspeitos | Permite apelação para erros raros |
| **BattlEye** | Programas de trapaça e programas feitos para **burlar** anti-cheats | "Não vai bloquear programas populares que muitos jogadores usam" (Discord, OBS, XSplit...) |
| **Riot Vanguard** | Pode **bloquear o carregamento** de algo no PC (drivers vulneráveis, módulos suspeitos) e avisa sobre vulnerabilidades | Mostra um aviso do que bloqueou |
| **FACEIT** | Trapaças, macros (sem recuo, bunny hop), exploits, uso em máquina virtual | Programas fora das listas podem receber aviso de que não rodam junto |

## Por que o TelaLink não se parece com nada disso

| O que gera ban | TelaLink |
|---|---|
| Injetar código / DLL no jogo | **Nunca.** Não existe nenhuma ligação com o processo do jogo |
| Ler ou escrever a memória do jogo | **Nunca** |
| Desenhar sobreposição dentro do jogo | **Nunca** (o painel é uma página no navegador) |
| Simular teclado/mouse, macros | **Nunca** (quem assiste não controla nada) |
| Drivers de sistema, módulos nativos | **Nenhum** |
| Pedir administrador | **Não pede**; avisa se for aberto assim |
| Esconder ou ofuscar código | **Não**: código aberto, legível |
| Programas não assinados | Só executa **Node.js** (OpenJS Foundation), **cloudflared** (Cloudflare, Inc.), **ssh** (Microsoft) e **PowerShell** (Microsoft), todos com assinatura conferida |

**Como a tela é capturada:** pelo **próprio navegador** (Chrome/Edge), com a API de captura do Windows — a mesma do compartilhamento de tela do **Discord, Teams e Google Meet**. É diferente do modo "Captura de jogo" do OBS, que entra no processo do jogo (e por isso precisa de autorização especial dos anti-cheats).

## Proteções implementadas

| Proteção | Onde |
|---|---|
| Teste automático que **reprova a versão** se aparecer: executável, driver ou módulo nativo no projeto; código para mexer em outros processos, memória, teclado ou mouse; execução de programa fora da lista fixa; pedido de administrador; janela escondida; execução de código decodificado | `test/anticheat.test.js` |
| Aviso se o TelaLink for aberto **como administrador** (não precisa) | `src/sistema.js`, autoteste |
| Servidor e túnel com **prioridade abaixo do normal**: nunca disputam processador com o jogo | `src/sistema.js` |
| Downloads só de fontes oficiais, com SHA-256 e assinatura | `scripts/instalar-node.ps1`, `scripts/baixar-cloudflared.js` |
| Scripts sem padrões que antivírus associam a malware | `test/arquivos.test.js` |

## O risco que existe de verdade: as regras do jogo

O que pode gerar punição **não é o programa, é o uso**:

- **"Ghosting"**: transmitir sua tela ao vivo para alguém que está **na mesma partida** ou te ajudando em tempo real (técnico, colega de time) durante **ranqueada ou campeonato** é proibido nos regulamentos de jogos competitivos e campeonatos.
- **Contas compartilhadas** ou alguém jogando por você: proibido em praticamente todos os jogos (a Riot já baniu jogadores de eventos oficiais por colocar alguém não registrado para jogar).
- Transmitir para amigos assistirem fora da partida, gravar ou fazer live: **permitido** pelas políticas comuns de streaming.

## Recomendações

1. Abra o `Iniciar.bat` com duplo-clique normal (**não** como administrador).
2. No jogo, use **"Janela sem bordas"** e compartilhe a **Tela inteira** (tela cheia exclusiva pode sair preta em qualquer programa de captura).
3. Não use o TelaLink para passar informação em tempo real durante ranqueada/campeonato.
4. Se um anti-cheat mostrar aviso de bloqueio, **não tente contornar** (isso, sim, gera ban): feche o TelaLink e reporte ao suporte do jogo como falso positivo, informando que é um programa de compartilhamento de tela via navegador.
5. Em computador de empresa, peça autorização à TI (ver [`RISCOS-LEGAIS-E-CONTINUIDADE.md`](RISCOS-LEGAIS-E-CONTINUIDADE.md)).

## Fontes

- Valve Anti-Cheat — [Valve Developer Community](https://developer.valvesoftware.com/wiki/Valve_Anti-Cheat) · [Wikipédia](https://en.wikipedia.org/wiki/Valve_Anti-Cheat)
- Easy Anti-Cheat FAQ — [Saber Interactive](https://support.saber.games/hc/en-us/articles/22303848570001-Easy-Anti-Cheat-FAQ)
- BattlEye FAQ — [Ubisoft](https://www.ubisoft.com/en-us/game/rainbow-six/siege/news-updates/2999gdyIXLbeiZP78R7545/battleye-faq) · [Rockstar](https://support.rockstargames.com/en-US/articles/1nenwhZlVrJY6CTFeSS2Fx/grand-theft-auto-online-battleye-faq)
- Riot Vanguard — [Suporte Riot](https://support.riotgames.com/ru-ru/valorant/performance/what-is-vanguard) · [FAQ League of Legends](https://support-leagueoflegends.riotgames.com/hc/articles/24169857932435)
- FACEIT — [O que é considerado trapaça](https://support.faceit.com/hc/en-us/articles/360015788779-What-is-deemed-to-be-a-cheat) · [Como funciona o anti-cheat](https://support.faceit.com/hc/en-us/articles/9394666828188-What-is-FACEIT-Anti-cheat-and-how-does-it-work)
- Banimento em eventos da Riot por irregularidade de jogadores — [Inven Global](https://www.invenglobal.com/articles/14512/team-besties-members-banned-from-riot-valorant-events-for-using-unregistered-player)
