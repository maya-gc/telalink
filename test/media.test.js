// Testes do formato dos pacotes da retransmissao e do detector de tela preta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSessionKey, deriveKeys } from '../public/crypto.js';
import {
  encodePlain, decodePlain, packPacket, unpackPacket, meanLuma, isBlackFrame,
  BlackScreenDetector, KIND_VIDEO, KIND_AUDIO,
} from '../public/media-util.js';
import { fitSize } from '../public/relay.js';

const keys = await deriveKeys(generateSessionKey(), 'sala');

test('conteudo: ida e volta com e sem meta', () => {
  const data = crypto.getRandomValues(new Uint8Array(1000));
  const a = decodePlain(encodePlain({ seq: 7, timestamp: 1_234_567_890_123, duration: 33_333, meta: { codec: 'vp8', w: 1920, h: 1080 }, data }));
  assert.deepEqual({ ...a, data: [...a.data] }, { seq: 7, timestamp: 1_234_567_890_123, duration: 33_333, meta: { codec: 'vp8', w: 1920, h: 1080 }, data: [...data] });
  const b = decodePlain(encodePlain({ seq: 0, timestamp: 0, data: new Uint8Array(0) }));
  assert.equal(b.meta, null);
  assert.equal(b.data.length, 0);
});

test('pacote: servidor so enxerga tipo e "e quadro-chave"; resto e cifrado', async () => {
  const marker = new TextEncoder().encode('SEGREDO-DA-TELA-'.repeat(20));
  const pkt = await packPacket(keys.media, { kind: KIND_VIDEO, isKey: true, seq: 1, timestamp: 5, meta: { codec: 'vp8', w: 2, h: 2 }, data: marker });
  assert.equal(pkt[0], KIND_VIDEO);
  assert.equal(pkt[1], 1);
  assert.ok(!Buffer.from(pkt).toString('latin1').includes('SEGREDO'), 'conteudo vazou em claro');
  assert.ok(!Buffer.from(pkt).toString('latin1').includes('vp8'), 'meta vazou em claro');
  const back = await unpackPacket(keys.media, pkt);
  assert.equal(back.kind, KIND_VIDEO);
  assert.equal(back.isKey, true);
  assert.deepEqual(back.data, marker);
});

test('pacote: trocar o cabecalho (ex.: marcar delta como chave) e detectado', async () => {
  const pkt = await packPacket(keys.media, { kind: KIND_AUDIO, seq: 1, timestamp: 5, data: new Uint8Array(10) });
  const bad = pkt.slice(); bad[1] = 1;
  await assert.rejects(unpackPacket(keys.media, bad));
  const bad2 = pkt.slice(); bad2[0] = KIND_VIDEO;
  await assert.rejects(unpackPacket(keys.media, bad2));
  const other = await deriveKeys(generateSessionKey(), 'sala');
  await assert.rejects(unpackPacket(other.media, pkt), 'chave errada');
});

test('pacote: tipo desconhecido e lixo sao recusados', async () => {
  await assert.rejects(unpackPacket(keys.media, new Uint8Array(100).fill(9)), /tipo/);
  await assert.rejects(unpackPacket(keys.media, new Uint8Array(5)), /curto/);
});

test('fitSize: limita a 1920x1080 mantendo proporcao e dimensoes pares', () => {
  assert.deepEqual(fitSize(1920, 1080), { w: 1920, h: 1080 });
  assert.deepEqual(fitSize(3840, 2160), { w: 1920, h: 1080 });
  assert.deepEqual(fitSize(2560, 1600), { w: 1728, h: 1080 });
  assert.deepEqual(fitSize(1281, 721), { w: 1280, h: 720 });
  const r = fitSize(5120, 1440);
  assert.ok(r.w <= 1920 && r.h <= 1080 && r.w % 2 === 0 && r.h % 2 === 0);
});

const frame = (fn, w = 64, h = 36) => {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { const [r, g, b] = fn(i); d.set([r, g, b, 255], i * 4); }
  return d;
};

test('tela preta: detecta tela apagada, nao confunde com cena escura com detalhes', () => {
  assert.equal(meanLuma(frame(() => [255, 255, 255])), 255);
  assert.ok(isBlackFrame(frame(() => [0, 0, 0])));
  assert.ok(isBlackFrame(frame(() => [2, 2, 3])), 'quase preto uniforme');
  assert.ok(!isBlackFrame(frame((i) => (i % 50 === 0 ? [200, 200, 200] : [0, 0, 0]))), 'filme escuro com legenda/detalhe');
  assert.ok(!isBlackFrame(frame(() => [40, 40, 40])), 'cinza escuro');
});

test('tela preta: so avisa depois de 4 amostras seguidas e avisa quando volta', () => {
  const det = new BlackScreenDetector({ samples: 4 });
  const black = frame(() => [0, 0, 0]);
  const ok = frame((i) => [i % 255, 100, 50]);
  assert.equal(det.push(black), null);
  assert.equal(det.push(black), null);
  assert.equal(det.push(ok), null, 'uma imagem boa zera a contagem');
  for (let i = 0; i < 3; i++) assert.equal(det.push(black), null);
  assert.equal(det.push(black), true, 'quarta seguida: avisa');
  assert.equal(det.push(black), null, 'nao repete o aviso');
  assert.equal(det.push(ok), false, 'imagem voltou');
});
