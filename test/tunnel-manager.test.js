// Escolha automatica do link externo, tunel SSH e preferencias.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TunnelManager } from '../src/tunnel-manager.js';
import { SshTunnel, parseSshTunnelUrl, findSsh, diagnoseSsh } from '../src/tunnel.js';
import { applyUpdate, DEFAULTS, SettingsStore } from '../src/settings.js';

const FAKE_SSH = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-ssh.js');

class FakeTunnel extends EventEmitter {
  constructor(o) { super(); this.opts = o; this.status = 'off'; }
  start() { this.status = 'on'; this.emit('url', 'https://x'); }
  info() { return { status: this.status, url: 'https://x', error: null }; }
  stop() { this.status = 'off'; }
}
const manager = (choice, available) => {
  const created = [];
  const m = new TunnelManager({
    port: 9999, dataDir: '/tmp', getChoice: () => choice.value,
    find: {
      cloudflare: () => (available.cloudflare ? { path: '/cf' } : null),
      ssh: () => (available.ssh ? { path: '/ssh' } : null),
    },
    create: { cloudflare: (o) => (created.push(['cloudflare', o]), new FakeTunnel(o)), ssh: (o) => (created.push(['ssh', o]), new FakeTunnel(o)) },
  });
  return { m, created };
};

describe('Escolha do link externo', () => {
  test('repassa mudancas do tunel (reconexao, protocolo, erro) para o painel', () => {
    const { m, created } = manager({ value: 'ssh' }, { cloudflare: false, ssh: true });
    const changes = []; const protos = [];
    m.on('change', (i) => changes.push(i.status));
    m.on('protocol', (p) => protos.push(p));
    m.start();
    const t = m.tunnel;
    const before = changes.length;
    t.emit('restart'); t.emit('error-status'); t.emit('protocol', 'http2');
    assert.equal(changes.length, before + 2);
    assert.deepEqual(protos, ['http2']);
    assert.equal(created[0][1].port, 9999);
    m.stop();
    t.emit('restart');
    assert.equal(changes.length, before + 2, 'apos parar, o tunel antigo nao mexe mais no painel');
  });

  test('padrao usa os localizadores reais e grava a chave do SSH na pasta de dados', () => {
    const m = new TunnelManager({ port: 1, dataDir: '/tmp/telalink-x' });
    assert.equal(typeof m.find.cloudflare, 'function');
    const t = m.create.ssh({ port: 1, bin: '/x', log: () => {} });
    assert.equal(t.constructor.name, 'SshTunnel');
    assert.ok(t.args().join(' ').includes(join('/tmp/telalink-x', 'known_hosts')));
    assert.equal(m.create.cloudflare({ port: 1, bin: '/x' }).constructor.name, 'Tunnel');
  });

  test('automatico: Cloudflare se instalado; senao SSH (sem instalar nada)', () => {
    let r = manager({ value: 'auto' }, { cloudflare: true, ssh: true }); r.m.start();
    assert.equal(r.m.info().provider, 'cloudflare');
    r = manager({ value: 'auto' }, { cloudflare: false, ssh: true }); r.m.start();
    assert.equal(r.m.info().provider, 'ssh');
    assert.equal(r.m.info().providerName, 'SSH (localhost.run)');
  });

  test('o tunel sempre aponta para a porta EXTERNA', () => {
    const r = manager({ value: 'auto' }, { cloudflare: false, ssh: true }); r.m.start();
    assert.equal(r.created[0][1].port, 9999);
  });

  test('nada disponivel / escolha indisponivel / desligado: erro explicado, sem travar', () => {
    let r = manager({ value: 'auto' }, {}); r.m.start();
    assert.equal(r.m.info().status, 'error');
    assert.match(r.m.info().error, /nenhum metodo/);
    r = manager({ value: 'cloudflare' }, { ssh: true }); r.m.start();
    assert.match(r.m.info().error, /Cloudflare nao instalado/);
    assert.equal(r.created.length, 0, 'nao cai para outro metodo quando o usuario escolheu um');
    r = manager({ value: 'off' }, { cloudflare: true, ssh: true }); r.m.start();
    assert.equal(r.m.info().status, 'off');
  });

  test('trocar a escolha nas configuracoes reinicia o tunel na hora', () => {
    const choice = { value: 'cloudflare' };
    const r = manager(choice, { cloudflare: true, ssh: true }); r.m.start();
    r.m.refresh();
    assert.equal(r.created.length, 1, 'sem mudanca, nao reinicia');
    choice.value = 'ssh'; r.m.refresh();
    assert.equal(r.m.info().provider, 'ssh');
    assert.equal(r.created.length, 2);
  });
});

describe('Tunel SSH (localhost.run)', () => {
  test('parser pega o endereco do tunel e ignora links do banner', () => {
    const banner = 'To set up custom domains go to https://admin.localhost.run/\nsee https://localhost.run/docs\nabc123.lhr.life tunneled with tls termination, https://abc123.lhr.life';
    assert.equal(parseSshTunnelUrl(banner), 'https://abc123.lhr.life');
    assert.equal(parseSshTunnelUrl('https://admin.localhost.run/ apenas'), null);
    assert.equal(parseSshTunnelUrl('https://evil.com/?x=abc.lhr.life'), null);
  });

  test('SshTunnel com ssh falso: argumentos seguros e URL capturada', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'tl-ssh-'));
    const tun = new SshTunnel({ port: 8081, bin: process.execPath, binArgs: [FAKE_SSH], knownHostsFile: join(dir, 'known_hosts') });
    t.after(() => { tun.stop(); rmSync(dir, { recursive: true, force: true }); });
    const url = new Promise((res, rej) => { tun.once('url', res); tun.once('error-status', rej); setTimeout(() => rej(new Error('timeout')), 5000); });
    tun.start();
    assert.equal(await url, 'https://f00dcafe1234ab.lhr.life');
    const a = tun.args();
    assert.ok(a.includes('StrictHostKeyChecking=accept-new'), 'chave do servidor fica gravada (detecta troca)');
    assert.ok(a.includes(`UserKnownHostsFile=${join(dir, 'known_hosts')}`), 'known_hosts proprio, fora do usuario');
    assert.ok(a.includes('80:127.0.0.1:8081'), 'so a porta externa e publicada');
  });

  test('findSsh: no Windows exige assinatura da Microsoft no ssh.exe', () => {
    const run = (cmd, args, opts) => {
      if (cmd === 'where') return { status: 1, stdout: '' };
      return { status: 0, stdout: opts.env.TL_FILE.includes('System32') ? 'TL|Valid|CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond' : 'TL|NotSigned|' };
    };
    const r = findSsh({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, run, exists: () => true });
    assert.deepEqual(r, { path: 'C:\\Windows\\System32\\OpenSSH\\ssh.exe', verified: true });
    const bad = (cmd) => (cmd === 'where' ? { status: 1 } : { status: 0, stdout: 'TL|Valid|CN=Outro, O=Outra Empresa' });
    assert.equal(findSsh({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, run: bad, exists: () => true }), null);
  });

  test('Windows REAL: o ssh.exe do sistema existe e e da Microsoft',
    { skip: process.platform !== 'win32' && 'so roda no Windows' }, () => {
      const r = findSsh();
      assert.ok(r, `OpenSSH do Windows nao aceito: ${JSON.stringify(diagnoseSsh())}`);
      assert.equal(r.verified, true);
    });
});

describe('Preferencias de transmissao', () => {
  test('padrao simples: qualidade automatica, 30 fps, audio ligado, volume 100%', () => {
    assert.deepEqual(DEFAULTS.prefs, { quality: 'auto', fps: 30, hint: 'motion', audio: true, volume: 100, bitrate: 0 });
    assert.equal(DEFAULTS.tunnel, 'auto');
  });

  test('aceita valores validos e recusa os invalidos', () => {
    const ok = applyUpdate(DEFAULTS, { tunnel: 'ssh', prefs: { quality: 'original', fps: 15, volume: 150, audio: false, hint: 'detail', bitrate: 20 } }, { protectFn: (x) => x });
    assert.deepEqual(ok.prefs, { quality: 'original', fps: 15, hint: 'detail', audio: false, volume: 150, bitrate: 20 });
    assert.equal(ok.tunnel, 'ssh');
    for (const bad of [{ tunnel: 'ngrok' }, { prefs: { quality: '4k' } }, { prefs: { fps: 24 } }, { prefs: { volume: 300 } },
      { prefs: { volume: 1.5 } }, { prefs: { audio: 'sim' } }, { prefs: null }, { prefs: { bitrate: 7 } }, { prefs: { bitrate: '8' } }, { prefs: { bitrate: 100 } }]) {
      assert.throws(() => applyUpdate(DEFAULTS, bad, { protectFn: (x) => x }), JSON.stringify(bad));
    }
  });

  test('preferencias salvas persistem; arquivo antigo sem prefs ganha o padrao', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'tl-prefs-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const s = new SettingsStore({ dir }).load();
    s.update({ prefs: { volume: 60 } });
    const again = new SettingsStore({ dir }).load();
    assert.equal(again.data.prefs.volume, 60);
    assert.equal(again.data.prefs.quality, 'auto');
  });
});
