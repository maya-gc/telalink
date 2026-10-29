# Componentes de terceiros

O TelaLink (licença MIT) não tem dependências npm em produção. Componentes de terceiros:

| Componente | Versão | Licença | Onde | Como chega |
|---|---|---|---|---|
| [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) — Kazuhiko Arase | 2.0.4 (commit `83b7e8fe`) | MIT ([texto](public/vendor/LICENSE-qrcode-generator.txt)) | `public/vendor/qrcode.js` | Incluído, sem alterações |
| [jsQR](https://github.com/cozmo/jsQR) — cozmo e colaboradores | 1.4.0 | Apache-2.0 ([texto](test/vendor/LICENSE-jsQR.txt)) | `test/vendor/jsQR.cjs` | Só nos testes; não é usado pelo programa |
| [Node.js](https://nodejs.org) — OpenJS Foundation | LTS mais recente | MIT | `.runtime/node` (não versionado) | Baixado do site oficial no PC do usuário, se faltar |
| [cloudflared](https://github.com/cloudflare/cloudflared) — Cloudflare, Inc. | mais recente | Apache-2.0 | `.runtime/` (não versionado) | Baixado da versão oficial no PC do usuário |
| OpenSSH — Microsoft (Windows) / sistema | do sistema | BSD | do sistema | Já vem com o Windows 10/11, macOS e Linux |

"QR Code" é marca registrada da DENSO WAVE INCORPORATED.
