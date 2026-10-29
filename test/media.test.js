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

import { QUALITY, captureConstraints, senderEncoding, gainFor, fitRect, inviteText, qualityPreset, BITRATE_OPTIONS, maxKbpsFor,
  degradationFor, withBitrateHints, orderCodecs, adaptBitrate, relayHeightFor, qualityText } from '../public/media-util.js';
import { QUALITIES as QUALITY_KEYS_SERVER, BITRATES as BITRATES_SERVER } from '../src/settings.js';

test('qualidade: predefinicoes ate 4K e restricoes de captura coerentes', () => {
  assert.deepEqual(Object.keys(QUALITY), ['auto', 'original', 'qhd', 'alta', 'media', 'economica']);
  assert.deepEqual(QUALITY_KEYS_SERVER, Object.keys(QUALITY), 'servidor e pagina aceitam as mesmas qualidades');
  assert.deepEqual(captureConstraints('economica', 15), { height: { max: 480 }, frameRate: { ideal: 15, max: 15 } }, 'so a altura: a proporcao da tela e mantida');
  assert.equal(captureConstraints('original', 60).height.max, 2160);
  assert.equal(captureConstraints('alta', 60).frameRate.max, 60);
  assert.equal(captureConstraints('inexistente', 999).height.max, 1080, 'valor desconhecido cai no automatico');
  assert.equal(captureConstraints('auto', 999).frameRate.max, 30);
  assert.equal(qualityPreset('nada'), QUALITY.auto);
  for (const q of Object.values(QUALITY)) assert.ok(q.startKbps >= 1000 && q.startKbps <= q.maxKbps, 'comeca com banda alta, abaixo do teto');
});

test('qualidade: envio sempre tem teto de banda e reduz escala so quando a fonte e maior', () => {
  assert.deepEqual(senderEncoding('media', 30, 1080), { maxFramerate: 30, maxBitrate: 4_000_000, scaleResolutionDownBy: 1.5 });
  assert.deepEqual(senderEncoding('media', 30, 720), { maxFramerate: 30, maxBitrate: 4_000_000, scaleResolutionDownBy: 1 }, 'captura ja em 720p: nao encolhe de novo');
  assert.deepEqual(senderEncoding('auto', 60, 720), { maxFramerate: 60, maxBitrate: 12_000_000, scaleResolutionDownBy: 1 }, '60 qps ganham +50% de banda');
  assert.equal(senderEncoding('economica', 30, 2160).scaleResolutionDownBy, 4.5);
  assert.equal(senderEncoding('original', 30, 2160).scaleResolutionDownBy, 1);
  assert.equal(senderEncoding('original', 30, 2160, { limitMbps: 4 }).maxBitrate, 4_000_000, 'limite do usuario manda');
  assert.equal(maxKbpsFor('alta', { limitMbps: 7 }), 8000, 'limite fora da lista e ignorado');
  assert.deepEqual(BITRATE_OPTIONS, BITRATES_SERVER);
});

test('qualidade: o que cortar primeiro quando falta internet', () => {
  assert.equal(degradationFor('auto', 'motion'), 'balanced');
  assert.equal(degradationFor('auto', 'detail'), 'maintain-resolution');
  assert.equal(degradationFor('alta', 'motion'), 'maintain-resolution', 'resolucao escolhida pelo usuario e mantida');
});

const SDP = ['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=1',
  'm=video 9 UDP/TLS/RTP/SAVPF 96 97 98 99', 'a=rtpmap:96 VP8/90000', 'a=rtpmap:97 rtx/90000', 'a=fmtp:97 apt=96',
  'a=rtpmap:98 VP9/90000', 'a=fmtp:98 profile-id=0;x-google-max-bitrate=100', 'a=rtpmap:99 red/90000', ''].join('\r\n');

test('SDP: banda inicial e maxima em todos os codecs de video (e so neles)', () => {
  const out = withBitrateHints(SDP, { startKbps: 4000, maxKbps: 8000 });
  const lines = out.split('\r\n');
  assert.ok(lines.includes('a=fmtp:96 x-google-start-bitrate=4000;x-google-max-bitrate=8000'), 'VP8 sem fmtp ganha uma linha');
  assert.ok(lines.includes('a=fmtp:98 profile-id=0;x-google-start-bitrate=4000;x-google-max-bitrate=8000'), 'VP9: mantem parametros e troca o teto antigo');
  assert.ok(lines.includes('a=fmtp:97 apt=96'), 'rtx intocado');
  assert.ok(lines.includes('a=fmtp:111 minptime=10;useinbandfec=1'), 'audio intocado');
  assert.ok(!lines.some((l) => l.startsWith('a=fmtp:99')), 'red intocado');
  assert.equal(lines.indexOf('a=fmtp:96 x-google-start-bitrate=4000;x-google-max-bitrate=8000'), lines.indexOf('a=rtpmap:96 VP8/90000') + 1);
  assert.equal(withBitrateHints(out, { startKbps: 4000, maxKbps: 8000 }), out, 'aplicar duas vezes nao duplica');
});

test('codecs: hardware primeiro; sem hardware, VP9 > H.264 > VP8; auxiliares no fim', () => {
  const c = (mimeType, sdpFmtpLine = '') => ({ mimeType, sdpFmtpLine });
  const list = [c('video/VP8'), c('video/rtx'), c('video/H264', 'profile-level-id=42e01f'), c('video/H264', 'profile-level-id=640c1f'), c('video/VP9'), c('video/AV1')];
  const names = (l) => l.map((x) => `${x.mimeType.split('/')[1]}${/640c/.test(x.sdpFmtpLine) ? '-high' : ''}`);
  assert.deepEqual(names(orderCodecs(list)), ['VP9', 'H264-high', 'H264', 'VP8', 'AV1', 'rtx']);
  assert.deepEqual(names(orderCodecs(list, new Set(['video/h264']))), ['H264-high', 'H264', 'VP9', 'VP8', 'AV1', 'rtx']);
  assert.deepEqual(names(orderCodecs(list, new Set(['video/av1', 'video/vp9']))).slice(0, 2), ['VP9', 'AV1']);
});

test('retransmissao: banda adaptativa (reduz rapido, sobe devagar) e resolucao conforme a banda', () => {
  assert.equal(adaptBitrate(8e6, { buffered: 2e6, maxBps: 8e6 }), 5.6e6);
  assert.equal(adaptBitrate(8e6, { buffered: 5e5, maxBps: 8e6 }), 7.2e6);
  assert.equal(adaptBitrate(4e6, { buffered: 0, maxBps: 8e6 }), 4.32e6);
  assert.equal(adaptBitrate(8e6, { buffered: 0, maxBps: 8e6 }), 8e6, 'nunca passa do teto');
  assert.equal(adaptBitrate(6e5, { buffered: 5e6, maxBps: 8e6 }), 5e5, 'nunca abaixo do minimo');
  assert.equal(adaptBitrate(5e6, { buffered: 2e5, maxBps: 8e6 }), 5e6, 'zona estavel');
  assert.deepEqual([20e6, 8e6, 4e6, 2e6, 1e6].map(relayHeightFor), [2160, 1440, 1080, 720, 480]);
});

test('texto de qualidade para o painel e quem assiste', () => {
  assert.equal(qualityText({ height: 1080, fps: 29.6, bps: 6_240_000 }), '1080p · 30 qps · 6,2 Mbps');
  assert.equal(qualityText({ height: 720 }), '720p');
  assert.equal(qualityText(), '');
});

test('volume: 0 a 200%, mudo e pausa silenciam', () => {
  assert.equal(gainFor({ volume: 100 }), 1);
  assert.equal(gainFor({ volume: 200 }), 2);
  assert.equal(gainFor({ volume: 500 }), 2, 'teto de 200%');
  assert.equal(gainFor({ volume: -10 }), 0);
  assert.equal(gainFor({ volume: 100, muted: true }), 0);
  assert.equal(gainFor({ volume: 100, paused: true }), 0);
});

test('imagens: encaixe sem distorcer (retrato e paisagem)', () => {
  assert.deepEqual(fitRect(1920, 1080, 1920, 1080), { x: 0, y: 0, w: 1920, h: 1080 });
  assert.deepEqual(fitRect(1080, 1920, 1920, 1080), { x: 656, y: 0, w: 608, h: 1080 });
  assert.deepEqual(fitRect(4000, 1000, 1920, 1080), { x: 0, y: 300, w: 1920, h: 480 });
});

test('convite: link e PIN prontos para colar', () => {
  assert.equal(inviteText('https://x/view?room=1#k=abc', '123456'), 'Assista minha tela pelo TelaLink:\nhttps://x/view?room=1#k=abc\nPIN: 123456');
});
