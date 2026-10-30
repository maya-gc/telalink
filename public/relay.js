// =============================================================================
//  relay.js — retransmissao pelo link (funciona onde a pagina abre).
// -----------------------------------------------------------------------------
//  Quando a conexao direta (WebRTC) nao e possivel — VPN que desliga WebRTC,
//  rede de empresa que bloqueia UDP, NAT de operadora —, o video e o audio
//  viajam pela mesma conexao https/wss que ja carrega a pagina (porta 443).
//
//  Host:        captura -> VideoEncoder(VP8)/AudioEncoder(Opus) -> AES-256-GCM
//               -> WebSocket binario -> servidor (so repassa, nao decifra)
//  Espectador:  WebSocket -> AES-256-GCM -> VideoDecoder/AudioDecoder -> tela/som
// =============================================================================
import { packPacket, unpackPacket, KIND_VIDEO, KIND_AUDIO, adaptBitrate, relayHeightFor } from './media-util.js';

const MAX_W = 1920;
const MAX_H = 1080;
const KEY_INTERVAL_MS = 3000;
const OPUS_RATES = new Set([8000, 12000, 16000, 24000, 48000]);

// Codecs da retransmissao, do melhor para o mais compativel. Os dois primeiros
// so sao usados se o PC tiver codificador por HARDWARE (placa de video):
// imagem melhor com pouco processador. Depois, por software: VP8 (Chrome, Edge,
// Brave, Firefox) e H.264/VP9 (Safari, que nem sempre codifica VP8).
const AVC = { avc: { format: 'annexb' } };
export const RELAY_CODECS = [
  { codec: 'avc1.640034', label: 'H.264', hardwareAcceleration: 'prefer-hardware', ...AVC },
  { codec: 'vp09.00.51.08', label: 'VP9', hardwareAcceleration: 'prefer-hardware' },
  { codec: 'vp8', label: 'VP8', hardwareAcceleration: 'no-preference' },
  { codec: 'avc1.42e034', label: 'H.264', hardwareAcceleration: 'no-preference', ...AVC },
  { codec: 'vp09.00.51.08', label: 'VP9', hardwareAcceleration: 'no-preference' },
];
const VP8 = RELAY_CODECS[2];
// Codecs (texto) que um espectador consegue decodificar.
export async function decodableCodecs() {
  if (typeof globalThis.VideoDecoder?.isConfigSupported !== 'function') return [];
  const out = [];
  for (const codec of [...new Set(RELAY_CODECS.map((c) => c.codec))]) {
    try { if ((await VideoDecoder.isConfigSupported({ codec, codedWidth: 1920, codedHeight: 1080 })).supported) out.push(codec); } catch {}
  }
  return out;
}

// allowed: lista de codecs que TODOS os espectadores decodificam (null = sem restricao).
export async function pickRelayCodec({ width = 1920, height = 1080, bitrate = 8_000_000, framerate = 30, allowed = null } = {}, candidates = RELAY_CODECS) {
  const list = allowed ? candidates.filter((c) => allowed.includes(c.codec)) : candidates;
  if (typeof globalThis.VideoEncoder?.isConfigSupported !== 'function') return null;
  for (const c of list) {
    try {
      const { codec, hardwareAcceleration, avc } = c;
      const r = await VideoEncoder.isConfigSupported({ codec, hardwareAcceleration, ...(avc ? { avc } : {}), width, height, bitrate, framerate, latencyMode: 'realtime' });
      if (r.supported) return c;
    } catch {}
  }
  return null;
}

const even = (n) => Math.max(2, Math.floor(n / 2) * 2);
export function fitSize(w, h, maxW = MAX_W, maxH = MAX_H) {
  const s = Math.min(1, maxW / w, maxH / h);
  return { w: even(w * s), h: even(h * s) };
}

// ----------------------------------------------------------------- HOST
export class RelaySender {
  constructor({ stream, mediaKey, ws, previewVideo, bitrate = 8_000_000, maxH = MAX_H, fps = 30, autoRes = false, codec = null, audioContext = null, onError = () => {} }) {
    Object.assign(this, { stream, mediaKey, ws, previewVideo, bitrate, maxH, fps, autoRes, onError, audioContext });
    this.allowed = null;                   // codecs que todos os espectadores decodificam
    this.targetBitrate = bitrate;          // teto escolhido; this.bitrate = banda atual (adaptativa)
    this.codec = codec;                    // definido em start() se nao vier pronto
    this.rate = { frames: 0, bytes: 0, t: 0, fps: 0, bps: 0 };
    this.running = false;
    this.vseq = 0; this.aseq = 0;
    this.forceKey = true;
    this.lastKey = 0;
    this.sendChain = Promise.resolve();
    this.stats = { videoPackets: 0, audioPackets: 0, bytes: 0 };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.forceKey = true;
    const ready = this.codec ? Promise.resolve(this.codec) : pickRelayCodec({ bitrate: this.targetBitrate, framerate: this.fps, allowed: this.allowed });
    ready.then((c) => {
      this.codec ||= c;
      if (!this.codec) return this.onError(new Error('nenhum codec de video disponivel para a retransmissao neste navegador'));
      if (this.running) this._startVideo();
    });
    this._startAudio();
    // A cada segundo: ajusta a banda pela fila de envio (aumenta devagar, reduz rapido).
    this.adaptTimer = setInterval(() => this._adapt(), 1000);
  }

  _adapt() {
    const r = this.rate, now = performance.now();
    if (r.t) { const dt = (now - r.t) / 1000; r.fps = r.frames / dt; r.bps = (r.bytes * 8) / dt; }
    r.t = now; r.frames = 0; r.bytes = 0;
    const next = adaptBitrate(this.bitrate, { buffered: this.ws.bufferedAmount, maxBps: this.targetBitrate });
    if (Math.abs(next - this.bitrate) / this.bitrate >= 0.07) {
      this.bitrate = next;
      this.reconfigure = true;             // muda so a banda: sem forcar quadro-chave
    }
  }

  // Resolucao maxima atual (no automatico, acompanha a banda disponivel).
  get effectiveMaxH() { return this.autoRes ? Math.min(this.maxH, relayHeightFor(this.bitrate)) : this.maxH; }

  // Qualidade enviada agora (para o painel).
  quality() {
    return { width: this.vcfg?.width || 0, height: this.vcfg?.height || 0, fps: this.rate.fps, bps: this.rate.bps, codec: this.codec?.label || null, limit: this.bitrate < this.targetBitrate * 0.8 ? 'bandwidth' : null };
  }

  requestKeyframe() { this.forceKey = true; }

  // Um espectador nao decodifica o codec atual (ex.: Safari): escolhe outro que todos aceitem.
  async setAllowedCodecs(list) {
    this.allowed = list && list.length ? list : null;
    if (!this.codec || !this.allowed || this.allowed.includes(this.codec.codec)) return;
    const c = await pickRelayCodec({ bitrate: this.targetBitrate, framerate: this.fps, allowed: this.allowed });
    if (c) { this.codec = c; this.forceKey = true; }        // proximo quadro reconfigura o codificador
    else this.onError(new Error('os espectadores nao tem um codec de video em comum com este navegador'));
  }

  setBitrate(bps) {
    this.targetBitrate = bps;
    this.bitrate = bps;
    this.reconfigure = true;
  }

  // Muda resolucao maxima/banda/quadros durante a transmissao.
  setQuality({ maxH = this.maxH, bitrate = this.targetBitrate, fps = this.fps, autoRes = this.autoRes } = {}) {
    this.maxH = maxH; this.fps = fps; this.autoRes = autoRes;
    this.setBitrate(bitrate);
  }

  // Troca a fonte de video (tela, imagem, pausa) sem parar a retransmissao.
  replaceVideoTrack(track) {
    if (!this.running) return;
    try { this.vreader?.cancel(); } catch {}
    this.vreader = null;
    if (this.rvfcHandle && this.previewVideo?.cancelVideoFrameCallback) this.previewVideo.cancelVideoFrameCallback(this.rvfcHandle);
    this.forceKey = true;
    if (track) this._attachVideo(track);
  }

  stop() {
    this.running = false;
    clearInterval(this.adaptTimer); clearInterval(this.pollTimer);
    try { this.tapNode?.disconnect(); this.tapSource?.disconnect(); } catch {}
    for (const r of [this.vreader, this.areader]) try { r?.cancel(); } catch {}
    for (const e of [this.venc, this.aenc]) try { if (e && e.state !== 'closed') e.close(); } catch {}
    this.venc = this.aenc = null;
    this.vcfg = null;
    if (this.rvfcHandle && this.previewVideo?.cancelVideoFrameCallback) this.previewVideo.cancelVideoFrameCallback(this.rvfcHandle);
  }

  _send(packetPromise) {
    // Mantem a ordem dos pacotes mesmo com a cifragem assincrona.
    this.sendChain = this.sendChain.then(async () => {
      const pkt = await packetPromise;
      if (this.ws.readyState === 1) { this.ws.send(pkt); this.stats.bytes += pkt.length; if (pkt[0] === KIND_VIDEO) this.rate.bytes += pkt.length; }
    }).catch((err) => this.onError(err));
  }

  // ---------------- video
  _startVideo() {
    const track = this.stream.getVideoTracks()[0];
    if (!track) return;
    this._makeEncoder();
    this._attachVideo(track);
  }

  _makeEncoder() {
    this.venc = new VideoEncoder({
      output: (chunk) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        const isKey = chunk.type === 'key';
        this.stats.videoPackets++;
        this._send(packPacket(this.mediaKey, {
          kind: KIND_VIDEO, isKey, seq: this.vseq++, timestamp: chunk.timestamp, duration: chunk.duration || 0,
          meta: isKey ? { codec: this.vcfg?.codec, w: this.vcfg?.width, h: this.vcfg?.height } : null, data,
        }));
      },
      error: (e) => {
        // Codificador falhou (ex.: placa de video recusou): volta ao VP8, que funciona sempre.
        this.onError(e);
        this.vcfg = null; this.forceKey = true;
        if (this.codec !== VP8 && (!this.allowed || this.allowed.includes('vp8'))) this.codec = VP8;
        if (this.running) this._makeEncoder();
      },
    });
  }

  _attachVideo(track) {
    if (typeof globalThis.MediaStreamTrackProcessor === 'function') {
      const proc = new MediaStreamTrackProcessor({ track });
      const reader = proc.readable.getReader();
      this.vreader = reader;
      const pump = async () => {
        while (this.running && this.vreader === reader) {
          const { value: frame, done } = await reader.read();
          if (done) break;
          if (this.vreader !== reader) { frame.close(); break; }
          this._encodeFrame(frame);
        }
      };
      pump().catch((e) => { if (this.vreader === reader) this.onError(e); });
    } else if (this.previewVideo?.requestVideoFrameCallback) {
      // Firefox e Safari (sem MediaStreamTrackProcessor na pagina): copia cada
      // quadro novo do <video> de pre-visualizacao.
      const tick = () => {
        if (!this.running) return;
        try { this._encodeFrame(new VideoFrame(this.previewVideo, { timestamp: Math.round(performance.now() * 1000) })); } catch {}
        this.rvfcHandle = this.previewVideo.requestVideoFrameCallback(tick);
      };
      this.rvfcHandle = this.previewVideo.requestVideoFrameCallback(tick);
    } else if (this.previewVideo) {
      // Ultimo recurso: copia do <video> no ritmo de quadros escolhido.
      clearInterval(this.pollTimer);
      this.pollTimer = setInterval(() => {
        if (!this.running) return clearInterval(this.pollTimer);
        if (this.previewVideo.readyState < 2) return;
        try { this._encodeFrame(new VideoFrame(this.previewVideo, { timestamp: Math.round(performance.now() * 1000) })); } catch {}
      }, Math.round(1000 / this.fps));
    } else {
      this.onError(new Error('navegador sem suporte a captura de quadros para a retransmissao'));
    }
  }

  _encodeFrame(frame) {
    try {
      if (!this.running || !this.venc || this.venc.state === 'closed' || !this.codec) return;
      const maxH = this.effectiveMaxH;
      const { w, h } = fitSize(frame.displayWidth, frame.displayHeight, Math.round(maxH * 2.4), maxH);
      // Limita quadros por segundo conforme a qualidade escolhida.
      const nowMs = performance.now();
      if (!this.forceKey && this.lastFrameAt && nowMs - this.lastFrameAt < 1000 / this.fps - 4) return;
      this.lastFrameAt = nowMs;
      const sizeChanged = !this.vcfg || this.vcfg.width !== w || this.vcfg.height !== h || this.vcfg.codec !== this.codec.codec;
      if (sizeChanged || this.reconfigure) {
        const { codec, hardwareAcceleration, avc } = this.codec;
        this.vcfg = { codec, hardwareAcceleration, ...(avc ? { avc } : {}), width: w, height: h, bitrate: this.bitrate, framerate: this.fps, latencyMode: 'realtime' };
        this.venc.configure(this.vcfg);
        this.reconfigure = false;
        if (sizeChanged) this.forceKey = true;
      }
      const congested = this.ws.bufferedAmount > 4 * 1024 * 1024;
      if (this.venc.encodeQueueSize > 2 || (congested && !this.forceKey)) return; // descarta quadro
      let input = frame;
      if (w !== frame.displayWidth || h !== frame.displayHeight) {
        const canvas = this._scaleCanvas ||= new OffscreenCanvas(w, h);
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
        canvas.getContext('2d').drawImage(frame, 0, 0, w, h);
        input = new VideoFrame(canvas, { timestamp: frame.timestamp });
      }
      const now = performance.now();
      const keyFrame = this.forceKey || now - this.lastKey > KEY_INTERVAL_MS;
      if (keyFrame) { this.forceKey = false; this.lastKey = now; }
      this.venc.encode(input, { keyFrame });
      this.rate.frames++;
      if (input !== frame) input.close();
    } finally {
      frame.close();
    }
  }

  // ---------------- audio
  //  Chrome/Edge/Brave: MediaStreamTrackProcessor. Firefox/Safari: AudioWorklet
  //  (le as amostras do som) -> AudioData -> AudioEncoder (Opus).
  _startAudio() {
    const track = this.stream.getAudioTracks()[0];
    if (!track || typeof globalThis.AudioEncoder !== 'function') return;
    if (typeof globalThis.MediaStreamTrackProcessor !== 'function') return this._startAudioWorklet(track);
    let acfg = null;
    this.aenc = new AudioEncoder({
      output: (chunk) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        this.stats.audioPackets++;
        this._send(packPacket(this.mediaKey, {
          kind: KIND_AUDIO, isKey: true, seq: this.aseq++, timestamp: chunk.timestamp, duration: chunk.duration || 0,
          meta: { sr: acfg.sampleRate, ch: acfg.numberOfChannels }, data,
        }));
      },
      error: (e) => this.onError(e),
    });
    const proc = new MediaStreamTrackProcessor({ track });
    this.areader = proc.readable.getReader();
    const pump = async () => {
      while (this.running) {
        const { value: ad, done } = await this.areader.read();
        if (done) break;
        try {
          if (!this.aenc || this.aenc.state === 'closed') continue;
          if (!acfg) {
            if (!OPUS_RATES.has(ad.sampleRate)) { this.onError(new Error(`taxa de audio ${ad.sampleRate} nao suportada`)); continue; }
            acfg = { codec: 'opus', sampleRate: ad.sampleRate, numberOfChannels: Math.min(2, ad.numberOfChannels), bitrate: 128_000 };
            this.aenc.configure(acfg);
          }
          if (this.ws.bufferedAmount < 4 * 1024 * 1024) this.aenc.encode(ad);
        } finally { ad.close(); }
      }
    };
    pump().catch((e) => this.onError(e));
  }

  _makeAudioEncoder(acfg) {
    const enc = new AudioEncoder({
      output: (chunk) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        this.stats.audioPackets++;
        this._send(packPacket(this.mediaKey, {
          kind: KIND_AUDIO, isKey: true, seq: this.aseq++, timestamp: chunk.timestamp, duration: chunk.duration || 0,
          meta: { sr: acfg.sampleRate, ch: acfg.numberOfChannels }, data,
        }));
      },
      error: (e) => this.onError(e),
    });
    enc.configure(acfg);
    return enc;
  }

  async _startAudioWorklet(track) {
    const ctx = this.audioContext;
    if (!ctx?.audioWorklet || typeof globalThis.AudioWorkletNode !== 'function' || typeof globalThis.AudioData !== 'function') return;
    try {
      if (!ctx.__telalinkTap) { await ctx.audioWorklet.addModule('/audio-tap.js'); ctx.__telalinkTap = true; }
      if (!this.running) return;
      const acfg = { codec: 'opus', sampleRate: ctx.sampleRate, numberOfChannels: 2, bitrate: 128_000 };
      if (!OPUS_RATES.has(acfg.sampleRate)) return this.onError(new Error(`taxa de audio ${acfg.sampleRate} nao suportada`));
      const sup = await AudioEncoder.isConfigSupported(acfg).catch(() => ({ supported: false }));
      if (!sup.supported) return;
      this.aenc = this._makeAudioEncoder(acfg);
      this.tapSource = ctx.createMediaStreamSource(new MediaStream([track]));
      this.tapNode = new AudioWorkletNode(ctx, 'telalink-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      const silent = ctx.createGain(); silent.gain.value = 0;          // so mantem o no ativo (nao toca nada)
      this.tapSource.connect(this.tapNode).connect(silent).connect(ctx.destination);
      let t = 0;
      this.tapNode.port.onmessage = ({ data: chans }) => {
        if (!this.running || !this.aenc || this.aenc.state !== 'configured' || !chans?.length) return;
        const frames = chans[0].length;
        const planar = new Float32Array(frames * 2);
        planar.set(chans[0], 0);
        planar.set(chans[1] || chans[0], frames);
        const ad = new AudioData({ format: 'f32-planar', sampleRate: ctx.sampleRate, numberOfFrames: frames, numberOfChannels: 2, timestamp: t, data: planar });
        t += Math.round((frames / ctx.sampleRate) * 1e6);
        try { if (this.ws.bufferedAmount < 4 * 1024 * 1024) this.aenc.encode(ad); } finally { ad.close(); }
      };
    } catch (e) { this.onError(e); }
  }
}

// ----------------------------------------------------------------- ESPECTADOR
export class RelayReceiver {
  constructor({ mediaKey, canvas, ws, audioCtx = null, volume = 1, onError = () => {} }) {
    Object.assign(this, { mediaKey, canvas, ws, audioCtx, onError });
    if (audioCtx) {
      this.gain = audioCtx.createGain();
      this.gain.gain.value = volume;
      this.gain.connect(audioCtx.destination);
    }
    this.ctx2d = canvas.getContext('2d');
    this.lastSeq = { [KIND_VIDEO]: -1, [KIND_AUDIO]: -1 };
    this.gotKey = false;
    this.playAt = 0;
    this.stats = { framesDecoded: 0, audioDecoded: 0, rejected: 0, dropped: 0, bytes: 0 };
  }

  async handle(bytes) {
    let pkt;
    this.stats.bytes += bytes.byteLength || bytes.length || 0;
    try { pkt = await unpackPacket(this.mediaKey, bytes); }
    catch { this.stats.rejected++; return; }          // adulterado ou chave errada: ignora
    // Anti-replay: descarta pacote repetido ou atrasado (seq sempre cresce).
    if (pkt.seq <= this.lastSeq[pkt.kind] && this.lastSeq[pkt.kind] - pkt.seq < 0x7fffffff) { this.stats.dropped++; return; }
    this.lastSeq[pkt.kind] = pkt.seq;
    if (pkt.kind === KIND_VIDEO) this._video(pkt);
    else this._audio(pkt);
  }

  _needKey() {
    this.gotKey = false;
    this.ws.json?.({ type: 'relay-need-key' });
  }

  _video(pkt) {
    if (pkt.isKey && pkt.meta) {
      const cfg = pkt.meta;
      if (!this.vdec || this.vdec.state === 'closed' || !this.vcfg || this.vcfg.codec !== cfg.codec || this.vcfg.w !== cfg.w || this.vcfg.h !== cfg.h) {
        try { if (this.vdec && this.vdec.state !== 'closed') this.vdec.close(); } catch {}
        this.vdec = new VideoDecoder({
          output: (frame) => {
            try {
              if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
                this.canvas.width = frame.displayWidth; this.canvas.height = frame.displayHeight;
              }
              this.ctx2d.drawImage(frame, 0, 0);
              this.stats.framesDecoded++;
            } finally { frame.close(); }
          },
          error: (e) => { this.onError(e); this.vdec = null; this._needKey(); },
        });
        this.vdec.configure({ codec: cfg.codec, codedWidth: cfg.w, codedHeight: cfg.h, optimizeForLatency: true });
        this.vcfg = cfg;
      }
      this.gotKey = true;
    }
    if (!this.gotKey || !this.vdec || this.vdec.state !== 'configured') return;
    if (!pkt.isKey && this.vdec.decodeQueueSize > 8) { this.stats.dropped++; this._needKey(); return; } // PC lento
    try {
      this.vdec.decode(new EncodedVideoChunk({ type: pkt.isKey ? 'key' : 'delta', timestamp: pkt.timestamp, duration: pkt.duration || undefined, data: pkt.data }));
    } catch (e) { this.onError(e); this._needKey(); }
  }

  _audio(pkt) {
    if (!this.audioCtx || typeof globalThis.AudioDecoder !== 'function' || !pkt.meta) return;
    if (!this.adec || this.adec.state === 'closed') {
      this.adec = new AudioDecoder({
        output: (ad) => { try { this._play(ad); } finally { ad.close(); } },
        error: (e) => { this.onError(e); this.adec = null; },
      });
      this.adec.configure({ codec: 'opus', sampleRate: pkt.meta.sr, numberOfChannels: pkt.meta.ch });
    }
    try {
      this.adec.decode(new EncodedAudioChunk({ type: 'key', timestamp: pkt.timestamp, duration: pkt.duration || undefined, data: pkt.data }));
    } catch (e) { this.onError(e); }
  }

  _play(ad) {
    const ctx = this.audioCtx;
    const buf = ctx.createBuffer(ad.numberOfChannels, ad.numberOfFrames, ad.sampleRate);
    for (let c = 0; c < ad.numberOfChannels; c++) {
      const plane = new Float32Array(ad.numberOfFrames);
      ad.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
      buf.copyToChannel(plane, c);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain || ctx.destination);
    const now = ctx.currentTime;
    // Pequeno buffer (~150 ms) absorve variacoes da rede sem atrasar demais.
    if (this.playAt < now + 0.03 || this.playAt > now + 0.6) this.playAt = now + 0.15;
    src.start(this.playAt);
    this.playAt += buf.duration;
    this.stats.audioDecoded++;
  }

  setVolume(v) { if (this.gain) this.gain.gain.value = Math.max(0, Math.min(1, v)); }

  close() {
    for (const d of [this.vdec, this.adec]) try { if (d && d.state !== 'closed') d.close(); } catch {}
    this.vdec = this.adec = null;
  }
}
