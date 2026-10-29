// Desenha um QR code (para abrir o link no celular) num <canvas>.
// Usa a biblioteca qrcode-generator (MIT), copiada sem alteracoes em /vendor.
import qrcode from './vendor/qrcode.js';

export function qrMatrix(text, level = 'M') {
  const q = qrcode(0, level);          // 0 = tamanho automatico
  q.addData(text, 'Byte');
  q.make();
  const n = q.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => q.isDark(r, c)));
}

export function drawQr(canvas, text, { margin = 4 } = {}) {
  const m = qrMatrix(text);
  const n = m.length + margin * 2;
  const scale = Math.max(2, Math.floor(Math.min(canvas.width, canvas.height) / n));
  const size = n * scale;
  canvas.width = size; canvas.height = size;
  const g = canvas.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, size, size);     // QR sempre escuro sobre claro (leitura)
  g.fillStyle = '#000000';
  m.forEach((row, r) => row.forEach((dark, c) => { if (dark) g.fillRect((c + margin) * scale, (r + margin) * scale, scale, scale); }));
  return m.length;
}
