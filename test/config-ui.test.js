// =============================================================================
//  Tela "Conexao e seguranca" com navegador real (Chromium via Playwright).
//  Cada metodo de cadastro e testado de ponta a ponta contra um servidor TURN
//  de teste com autenticacao real: credencial certa -> caminho de retransmissao;
//  credencial errada -> erro 401 explicado na tela.
// =============================================================================
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import dgram from 'node:dgram';
import { startApp } from './helpers.js';
import { SettingsStore } from '../src/settings.js';
import { IceProvider } from '../src/turn.js';
import { startFakeTurn } from './fixtures/fake-turn.js';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch {}
const skip = !chromium && 'Playwright nao instalado';

const SECRET = 'segredo-do-coturn-de-teste-123';
let app, dir, settings, browser, turnSecret, turnUser, fakeFetch, deadPort;

before(async () => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), 'tl-cfg-'));
  settings = new SettingsStore({ dir }).load();
  turnSecret = await startFakeTurn({ secret: SECRET });
  turnUser = await startFakeTurn({ username: 'maria', password: 'senha-certa' });
  // Porta UDP sem ninguem ouvindo (servidor TURN "fora do ar").
  const s = dgram.createSocket('udp4'); await new Promise((r) => s.bind(0, '127.0.0.1', r)); deadPort = s.address().port; s.close();
  // A API da Cloudflare e simulada (este teste nao depende de internet).
  fakeFetch = async () => ({ status: 201, ok: true, json: async () => ({ iceServers: {
    urls: [`turn:127.0.0.1:${turnUser.port}?transport=udp`, 'turn:turn.cloudflare.com:53?transport=udp'], username: 'maria', credential: 'senha-certa' } }) });
  const iceProvider = new IceProvider({ settings, fetchImpl: (...a) => fakeFetch(...a) });
  app = await startApp({ settings, iceProvider });
  browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
});
after(async () => { await browser?.close(); await app?.close(); turnSecret?.close(); turnUser?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

async function openConfig() {
  const page = await (await browser.newContext()).newPage();
  await page.goto(app.base + '/config');
  await page.waitForFunction(() => document.getElementById('storageDir').textContent.length > 0);
  return page;
}
const msg = (page) => page.textContent('#msg');
async function testarConexao(page) {
  await page.evaluate(() => { document.getElementById('msg').textContent = ''; }); // nao ler resultado antigo
  await page.click('#btnTest');
  await page.waitForFunction(() => /✅|recusou|alcançar|não respondeu|Falhou|Sem TURN|Trava/.test(document.getElementById('msg').textContent), null, { timeout: 15_000 });
  return msg(page);
}

describe('Tela Conexao e seguranca (navegador real)', { skip, timeout: 120_000 }, () => {
  test('painel mostra o quadro "Conexao e seguranca" e o botao leva a tela de cadastro', async () => {
    const page = await (await browser.newContext()).newPage();
    await page.goto(app.base + '/');
    await page.waitForFunction(() => document.getElementById('sumTurn').textContent !== '...');
    assert.match(await page.textContent('#sumTurn'), /Nenhum/);
    await page.click('#btnConfig');
    await page.waitForURL(/\/config$/);
    assert.match(await page.textContent('h1'), /Conexão e segurança/);
  });

  test('cada metodo mostra so os campos dele, com descricao e nivel de seguranca', async () => {
    const page = await openConfig();
    const visible = async () => Object.fromEntries(await Promise.all(['cloudflare', 'coturn', 'static'].map(async (p) => [p, await page.isVisible(`#f-${p}`)])));
    for (const p of ['none', 'cloudflare', 'coturn', 'static']) {
      await page.check(`input[name=provider][value=${p}]`);
      const v = await visible();
      for (const [k, on] of Object.entries(v)) assert.equal(on, k === p, `${p}: campo ${k}`);
    }
    const text = await page.textContent('#providers');
    for (const t of ['Recomendado', 'Avançado', 'Menos seguro', 'Cloudflare', 'coturn', 'senha']) assert.ok(text.includes(t), t);
  });

  test('sem TURN: teste explica que a retransmissao cobre as redes dificeis', async () => {
    const page = await openConfig();
    await page.check('input[name=provider][value=none]');
    assert.match(await testarConexao(page), /Sem TURN/);
  });

  test('TURN proprio (coturn): segredo certo funciona, fica mascarado e persiste', async () => {
    const page = await openConfig();
    await page.check('input[name=provider][value=coturn]');
    await page.fill('#ctUrls', `turn:127.0.0.1:${turnSecret.port}?transport=udp`);
    await page.fill('#ctSecret', SECRET);
    assert.match(await testarConexao(page), /✅/);
    assert.ok(turnSecret.stats.allocations >= 1, 'o navegador alocou no TURN de teste');
    assert.match(await page.textContent('#ctSecretNow'), /••••••-123/);
    assert.equal(await page.inputValue('#ctSecret'), '', 'campo de segredo e limpo apos salvar');
    assert.ok(!(await page.content()).includes(SECRET), 'segredo inteiro nunca volta para a pagina');
    assert.ok(!readFileSync(join(dir, 'settings.json'), 'utf8').includes(SECRET), 'segredo nao fica em texto no arquivo');
    // Recarregando, a configuracao continua la.
    const again = await openConfig();
    assert.equal(await again.isChecked('input[name=provider][value=coturn]'), true);
    assert.match(await again.inputValue('#ctUrls'), new RegExp(String(turnSecret.port)));
  });

  test('TURN proprio (coturn): segredo errado e recusado com motivo claro', async () => {
    const page = await openConfig();
    await page.check('input[name=provider][value=coturn]');
    await page.fill('#ctUrls', `turn:127.0.0.1:${turnSecret.port}?transport=udp`);
    await page.fill('#ctSecret', 'segredo-errado');
    assert.match(await testarConexao(page), /recusou o usuário\/senha \(erro 401\)/);
  });

  test('usuario e senha fixos: certo funciona, errado e recusado', async () => {
    const page = await openConfig();
    await page.check('input[name=provider][value=static]');
    await page.fill('#stUrls', `turn:127.0.0.1:${turnUser.port}?transport=udp`);
    await page.fill('#stUser', 'maria');
    await page.fill('#stCred', 'senha-certa');
    assert.match(await testarConexao(page), /✅/);
    await page.fill('#stCred', 'senha-errada');
    assert.match(await testarConexao(page), /erro 401/);
  });

  test('Cloudflare: credenciais temporarias da API funcionam; token recusado vira mensagem', async () => {
    const page = await openConfig();
    await page.check('input[name=provider][value=cloudflare]');
    await page.fill('#cfKeyId', 'abc123def456');
    await page.fill('#cfToken', 'TOKEN-DE-TESTE-9z9z');
    assert.match(await testarConexao(page), /✅/);
    assert.match(await page.textContent('#cfTokenNow'), /••••••9z9z/);
    fakeFetch = async () => ({ status: 401, ok: false, json: async () => ({}) });
    assert.match(await testarConexao(page), /Cloudflare recusou as credenciais/);
  });

  test('servidor TURN fora do ar: avisa que nao foi possivel alcancar', async () => {
    const page = await openConfig();
    await page.check('input[name=provider][value=static]');
    await page.fill('#stUrls', `turn:127.0.0.1:${deadPort}?transport=udp`);
    await page.fill('#stUser', 'x');
    await page.fill('#stCred', 'y');
    assert.match(await testarConexao(page), /alcançar|não respondeu/);
  });

  test('endereco invalido nao e salvo e a tela diz o motivo', async () => {
    const page = await openConfig();
    await page.check('input[name=provider][value=static]');
    await page.fill('#stUrls', 'http://isto-nao-e-turn.com');
    await page.click('#btnSave');
    await page.waitForFunction(() => /invalido/.test(document.getElementById('msg').textContent));
  });

  test('modo padrao e trava de consumo: salvos e refletidos no painel', async () => {
    const page = await openConfig();
    await page.check('input[name=defaultMode][value=relay]');
    await page.check('input[name=provider][value=static]');
    await page.fill('#stUrls', `turn:127.0.0.1:${turnUser.port}?transport=udp`);
    await page.fill('#stUser', 'maria');
    await page.fill('#capGB', '1');
    await page.click('#btnSave');
    await page.waitForFunction(() => /Salvo/.test(document.getElementById('msg').textContent));
    settings.addUsage(2e9); // simula 2 GB usados
    const panel = await (await browser.newContext()).newPage();
    await panel.goto(app.base + '/');
    await panel.waitForFunction(() => /limite atingido/.test(document.getElementById('sumUsage').textContent));
    assert.match(await panel.textContent('#sumMode'), /Máxima segurança/);
    assert.equal(await panel.isChecked('input[name=policy][value=relay]'), true, 'modo padrao ja vem marcado');
    const cfg = await openConfig();
    assert.match(await cfg.textContent('#msg'), /Trava de consumo|trava de consumo/);
  });
});
