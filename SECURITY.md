# Política de segurança

## Como reportar uma vulnerabilidade

Não abra uma *issue* pública. Use **Security → Report a vulnerability** neste repositório (aviso privado do GitHub). Inclua: versão, passos para reproduzir e impacto.

Compromisso de resposta: confirmação em até 5 dias úteis e correção priorizada conforme a gravidade.

## Escopo

Tudo neste repositório. O `cloudflared` e os navegadores são de terceiros: falhas neles devem ser reportadas aos respectivos fabricantes.

## Resumo das garantias

- Criptografia de ponta a ponta com chave que o servidor não conhece (AES-256-GCM, HKDF-SHA-512).
- Painel e configurações acessíveis apenas no computador de quem transmite.
- Segredos de TURN protegidos pelo DPAPI do Windows e nunca enviados a espectadores.
- Nenhum executável embutido; `cloudflared` verificado por assinatura digital.

Detalhes, limites e riscos residuais: [`docs/MODELO-DE-AMEACAS.md`](docs/MODELO-DE-AMEACAS.md).
