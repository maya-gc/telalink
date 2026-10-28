# Processo de qualidade

## O que este documento é (e o que não é)

CMMI, ISO/IEC 27001, ISO/IEC 25010, IEC 62304 (software médico) e DO-178C (aviação) avaliam **organizações e processos**, por meio de **auditoria independente**. Um software não "vira" CMMI 5 nem é "certificado ISO" sozinho. Este projeto adota práticas compatíveis com essas referências e mantém as evidências que uma auditoria pediria. A certificação em si depende de um processo formal na organização que usa o software.

## Práticas adotadas

| Prática | Como aparece no projeto | Referência relacionada |
|---|---|---|
| Requisitos versionados e rastreáveis | `docs/REQUISITOS-E-RASTREABILIDADE.md` (cada requisito → teste) | CMMI REQD/RDM; IEC 62304 §5.2; DO-178C (rastreabilidade) |
| Análise de ameaças e riscos | `docs/MODELO-DE-AMEACAS.md` (STRIDE, riscos residuais) | ISO/IEC 27001 Anexo A; ISO 14971 (por analogia) |
| Arquitetura documentada | `docs/ARQUITETURA.md` | CMMI TS; IEC 62304 §5.3 |
| Verificação automatizada em cada mudança | GitHub Actions: 3 sistemas × 2 versões de Node | CMMI VV; ISO/IEC 25010 (confiabilidade) |
| Portão de qualidade quantitativo | Cobertura mínima obrigatória (linhas/desvios/funções) | CMMI MPM/PQA (medição) |
| Validação em ambiente representativo | Laboratório de redes isoladas | CMMI VV (validação) |
| Análise estática de segurança | CodeQL (repositório público) | ISO/IEC 27001 A.8.28 (codificação segura) |
| Gestão de configuração | Git, tags de versão, `CHANGELOG.md`, `.gitattributes` | CMMI CM |
| Gestão de dependências | Zero dependências em produção; Dependabot para as ações de CI | ISO/IEC 27001 A.8.8 |
| Resposta a vulnerabilidades | `SECURITY.md` | ISO/IEC 29147 / 30111 |
| Integridade de componentes de terceiros | `cloudflared` oficial com assinatura digital verificada | ISO/IEC 27001 A.8.19 |

## Fluxo de mudança

1. Toda mudança entra por **pull request** para a `main`.
2. Pipeline obrigatória: `testes` (todos os sistemas), `cobertura` e `laboratorio-de-redes` precisam passar.
3. Mudanças em `src/`, `public/crypto.js`, `public/relay.js` ou `docs/MODELO-DE-AMEACAS.md` exigem atualizar a rastreabilidade e, se for o caso, o modelo de ameaças.
4. Versão: atualizar `CHANGELOG.md`, rodar o teste manual (`docs/PLANO-DE-TESTES.md`) e criar a tag `vX.Y.Z`.

Recomendado no GitHub (Settings → Branches → regra para `main`): exigir pull request e exigir os checks `testes`, `cobertura` e `laboratorio`.

## O que faltaria para um nível "crítico" (hospital/aviação)

Para uso em contexto regulado, além do que já existe:

- **Verificação independente**: revisão de código e de testes por pessoa que não escreveu o código.
- **Cobertura estrutural mais rígida**: DO-178C nível A exige MC/DC; IEC 62304 classe C exige verificação de unidade documentada.
- **Teste de intrusão** por terceiros e **auditoria de criptografia**.
- **Assinatura de código** com certificado da organização e distribuição controlada (`docs/ASSINATURA-DE-CODIGO.md`).
- **Gestão de risco clínico/operacional** formal (ISO 14971 no caso médico) e plano de manutenção pós-lançamento.
- **Infraestrutura própria** (túnel nomeado ou servidor próprio) em vez do túnel rápido gratuito.
