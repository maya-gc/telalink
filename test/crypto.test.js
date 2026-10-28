// Testes da criptografia de ponta a ponta (mesmo codigo que roda no navegador).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateSessionKey, toB64url, fromB64url, keyFromHash, deriveKeys,
  sealBytes, openBytes, SecureChannel, KEY_BYTES,
} from '../public/crypto.js';

const ROOM = '7d3c1e2a-0000-4000-8000-000000000000';

test('chave de sessao: 256 bits aleatorios, nunca repetida', () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i++) {
    const k = generateSessionKey();
    assert.equal(k.length, KEY_BYTES);
    seen.add(toB64url(k));
  }
  assert.equal(seen.size, 1000);
});

test('base64url: ida e volta e rejeicao de lixo', () => {
  for (let n = 0; n < 70; n++) {
    const b = crypto.getRandomValues(new Uint8Array(n));
    assert.deepEqual(fromB64url(toB64url(b)), b);
  }
  assert.throws(() => fromB64url('a+b/c='), /invalido/);
});

test('keyFromHash: so aceita chave de 256 bits bem formada', () => {
  const k = generateSessionKey();
  const s = toB64url(k);
  assert.deepEqual(keyFromHash(`#k=${s}`), k);
  assert.deepEqual(keyFromHash(`#x=1&k=${s}&y=2`), k);
  for (const bad of ['', '#', '#k=', `#k=${s.slice(1)}`, `#k=${s}A`, '#k=' + '!'.repeat(43), `?k=${s}`]) {
    assert.equal(keyFromHash(bad), null, bad);
  }
});

test('HKDF-SHA-512: mesma chave+sala = mesmas chaves; sala diferente = chaves diferentes', async () => {
  const k = generateSessionKey();
  const a = await deriveKeys(k, ROOM);
  const b = await deriveKeys(k, ROOM);
  const c = await deriveKeys(k, ROOM.replace('7', '8'));
  const msg = new TextEncoder().encode('ola');
  const sealed = await sealBytes(a.media, msg);
  assert.deepEqual(await openBytes(b.media, sealed), msg);
  await assert.rejects(openBytes(c.media, sealed), 'outra sala nao pode abrir');
  await assert.rejects(openBytes(a.sig, sealed), 'chave de sinalizacao != chave de midia');
});

test('AES-256-GCM: qualquer bit alterado e detectado', async () => {
  const { media } = await deriveKeys(generateSessionKey(), ROOM);
  const msg = crypto.getRandomValues(new Uint8Array(500));
  const sealed = await sealBytes(media, msg, Uint8Array.of(1, 1));
  for (const pos of [0, 5, 12, 100, sealed.length - 1]) {
    const bad = sealed.slice(); bad[pos] ^= 0x01;
    await assert.rejects(openBytes(media, bad, Uint8Array.of(1, 1)), `posicao ${pos}`);
  }
  await assert.rejects(openBytes(media, sealed, Uint8Array.of(1, 0)), 'cabecalho (AAD) adulterado');
  await assert.rejects(openBytes(media, sealed.subarray(0, 20)), 'truncado');
});

test('IV nunca se repete (mesma mensagem cifra diferente toda vez)', async () => {
  const { media } = await deriveKeys(generateSessionKey(), ROOM);
  const ivs = new Set();
  for (let i = 0; i < 500; i++) ivs.add(toB64url((await sealBytes(media, new Uint8Array(4))).subarray(0, 12)));
  assert.equal(ivs.size, 500);
});

test('SecureChannel: ida e volta, contexto amarrado e protecao contra replay', async () => {
  const k = generateSessionKey();
  const { sig } = await deriveKeys(k, ROOM);
  const hostToA = new SecureChannel(sig, `${ROOM}|viewer-A`);
  const viewerA = new SecureChannel(sig, `${ROOM}|viewer-A`);
  const viewerB = new SecureChannel(sig, `${ROOM}|viewer-B`);

  const e1 = await hostToA.seal('h2v', { kind: 'sdp', sdp: { type: 'offer', sdp: 'v=0' } });
  assert.ok(!JSON.stringify(e1).includes('offer'), 'conteudo nao pode aparecer em claro');
  assert.deepEqual(await viewerA.open('h2v', e1), { kind: 'sdp', sdp: { type: 'offer', sdp: 'v=0' } });

  await assert.rejects(viewerA.open('h2v', e1), /replay/, 'mesma mensagem duas vezes');
  const e2 = await hostToA.seal('h2v', { kind: 'ice' });
  await assert.rejects(viewerB.open('h2v', e2), 'mensagem do A nao serve para o B');
  await assert.rejects(viewerA.open('v2h', e2), 'direcao trocada');
  await assert.rejects(viewerA.open('h2v', { v: 2, c: e2.c }), /envelope/);
});

test('sem a chave do link nao da para forjar sinalizacao (ataque man-in-the-middle)', async () => {
  const real = await deriveKeys(generateSessionKey(), ROOM);
  const atacante = await deriveKeys(generateSessionKey(), ROOM); // servidor/intermediario sem a chave
  const forjada = await new SecureChannel(atacante.sig, `${ROOM}|v`).seal('h2v', { kind: 'sdp', sdp: 'fingerprint do atacante' });
  await assert.rejects(new SecureChannel(real.sig, `${ROOM}|v`).open('h2v', forjada));
});
