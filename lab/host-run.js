// Roda DENTRO da rede "casa": abre o painel, inicia a transmissao e publica
// link + PIN para os espectadores do laboratorio. Fica no ar ate o fim.
import { createRequire } from 'node:module';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const { chromium } = createRequire(import.meta.url)('playwright');
const OUT = process.env.LAB_OUT || 'lab-results';
const STATE = process.env.LAB_STATE || '/tmp/telalink-lab';
mkdirSync(OUT, { recursive: true }); mkdirSync(STATE, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--auto-select-desktop-capture-source=Entire screen', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[host console]', m.text()); });
await page.goto('http://localhost:8080/');
await page.waitForSelector('#tunnelStatus.on', { timeout: 20_000 });
await page.click('#btnScreen');
await page.waitForSelector('#live:not(.hidden)');
const link = await page.inputValue('#shareLink');
const pin = (await page.textContent('#pinView')).trim();
writeFileSync(join(STATE, 'sessao.json'), JSON.stringify({ link, pin }));
console.log('[host] transmitindo:', link.replace(/#k=.*/, '#k=(oculto)'));

while (!existsSync(join(STATE, 'fim'))) await new Promise((r) => setTimeout(r, 500));
const viewers = await page.evaluate(() => window.__telalink.viewers);
writeFileSync(join(OUT, 'host.json'), JSON.stringify({ viewers }, null, 2));
await page.screenshot({ path: join(OUT, 'host.png') });
await browser.close();
