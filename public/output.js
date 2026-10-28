// =============================================================================
//  output.js — o que sai para quem assiste.
//  Um unico ponto controla a fonte de video (tela, imagens ou "pausado") e o
//  audio (volume e mudo). O AUDIO e uma trilha estavel (passa por um GainNode);
//  o VIDEO pode trocar de fonte e avisa por onVideoTrack para quem envia
//  (WebRTC usa replaceTrack; a retransmissao troca o leitor de quadros).
// =============================================================================
import { gainFor, fitRect } from './media-util.js';

const W = 1920, H = 1080;

function makeCanvasSource(draw, fps) {
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const stream = canvas.captureStream(fps);
  // Redesenha periodicamente: o navegador so gera quadros quando o canvas muda,
  // e quem entra depois precisa receber imagem.
  let tick = 0;
  const timer = setInterval(() => draw(ctx, ++tick), Math.round(1000 / fps));
  draw(ctx, 0);
  return { canvas, track: stream.getVideoTracks()[0], stop: () => { clearInterval(timer); stream.getTracks().forEach((t) => t.stop()); } };
}

function drawPaused(ctx, tick) {
  ctx.fillStyle = '#1a1f2b';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#e8eaf0';
  ctx.font = '600 72px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Transmissão pausada', W / 2, H / 2);
  ctx.font = '400 40px system-ui, sans-serif';
  ctx.fillStyle = '#9aa3b2';
  ctx.fillText('Volta em instantes' + '.'.repeat(1 + (tick % 3)), W / 2, H / 2 + 80);
}

export class Output {
  constructor({ onVideoTrack = () => {}, onChange = () => {} } = {}) {
    Object.assign(this, { onVideoTrack, onChange });
    this.volume = 100; this.muted = false; this.paused = false;
    this.source = null;          // 'screen' | 'images'
    this.screen = null;          // MediaStream da captura
    this.images = [];            // HTMLImageElement[]
    this.imageIndex = 0;
    this.stream = new MediaStream();   // fluxo estavel enviado a todos
  }

  // Precisa ser chamado a partir de um clique (regra do AudioContext).
  init() {
    if (this.ctx) return;
    // 48 kHz: taxa nativa do Opus (44,1 kHz, comum em PCs, nao e aceita pelo codificador).
    this.ctx = new AudioContext({ sampleRate: 48000 });
    this.gain = this.ctx.createGain();
    this.dest = this.ctx.createMediaStreamDestination();
    this.gain.connect(this.dest);
    this.audioTrack = this.dest.stream.getAudioTracks()[0];
    this.stream.addTrack(this.audioTrack);
    this._applyGain();
  }

  get videoTrack() { return this.stream.getVideoTracks()[0] || null; }
  get hasSourceAudio() { return !!this.screen?.getAudioTracks().length && this.source === 'screen'; }

  _setVideo(track) {
    const old = this.videoTrack;
    if (old === track) return;
    if (old) this.stream.removeTrack(old);
    if (track) this.stream.addTrack(track);
    this.onVideoTrack(track, old);
    this.onChange();
  }

  _applyGain() {
    if (this.gain) this.gain.gain.setTargetAtTime(gainFor(this), this.ctx.currentTime, 0.02);
  }

  _connectAudio(stream) {
    try { this.srcNode?.disconnect(); } catch {}
    this.srcNode = null;
    const a = stream?.getAudioTracks()[0];
    if (a) {
      this.srcNode = this.ctx.createMediaStreamSource(new MediaStream([a]));
      this.srcNode.connect(this.gain);
    }
  }

  // ---------------- fontes
  useScreen(stream) {
    this._stopScreen();
    this._stopImages();
    this.screen = stream;
    this.source = 'screen';
    this._connectAudio(stream);
    if (!this.paused) this._setVideo(stream.getVideoTracks()[0]);
    this.onChange();
  }

  useImages(images) {
    if (!images.length) return;
    this._stopScreen();
    this._connectAudio(null);
    this.images = images;
    this.imageIndex = 0;
    this.source = 'images';
    if (!this.imageSrc) {
      this.imageSrc = makeCanvasSource((ctx) => this._drawImage(ctx), 5);
    }
    if (!this.paused) this._setVideo(this.imageSrc.track);
    this.onChange();
  }

  addImages(images) {
    if (this.source !== 'images') return this.useImages(images);
    this.images.push(...images);
    this.onChange();
  }

  showImage(delta) {
    if (this.source !== 'images' || !this.images.length) return;
    this.imageIndex = (this.imageIndex + delta + this.images.length) % this.images.length;
    this.onChange();
  }

  _drawImage(ctx) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const img = this.images[this.imageIndex];
    if (!img) return;
    const r = fitRect(img.naturalWidth || img.width, img.naturalHeight || img.height, W, H);
    ctx.drawImage(img, r.x, r.y, r.w, r.h);
  }

  // ---------------- pausa / audio
  setPaused(p) {
    this.paused = !!p;
    if (this.paused) {
      if (!this.pauseSrc) this.pauseSrc = makeCanvasSource(drawPaused, 5);
      this._setVideo(this.pauseSrc.track);
    } else {
      this._setVideo(this.source === 'images' ? this.imageSrc.track : this.screen?.getVideoTracks()[0] || null);
    }
    this._applyGain();
    this.onChange();
  }

  setVolume(v) { this.volume = Math.max(0, Math.min(200, Math.round(v))); this._applyGain(); this.onChange(); }
  setMuted(m) { this.muted = !!m; this._applyGain(); this.onChange(); }

  // A trilha de video "real" da tela (para aplicar resolucao/quadros).
  get screenTrack() { return this.source === 'screen' ? this.screen?.getVideoTracks()[0] || null : null; }
  get sourceHeight() {
    if (this.paused || this.source === 'images') return H;
    return this.screenTrack?.getSettings().height || 0;
  }

  _stopScreen() { this.screen?.getTracks().forEach((t) => t.stop()); this.screen = null; }
  _stopImages() { this.imageSrc?.stop(); this.imageSrc = null; this.images = []; }

  stop() {
    this._stopScreen();
    this._stopImages();
    this.pauseSrc?.stop(); this.pauseSrc = null;
    this.stream.getTracks().forEach((t) => t.stop());
    try { this.ctx?.close(); } catch {}
  }
}

// Carrega arquivos de imagem escolhidos pelo usuario (sem enviar a lugar nenhum).
export function loadImageFiles(files) {
  return Promise.all([...files].filter((f) => f.type.startsWith('image/')).map((f) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = URL.createObjectURL(f);
  }))).then((list) => list.filter(Boolean));
}
