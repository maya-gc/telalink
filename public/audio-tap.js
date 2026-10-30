// AudioWorklet do TelaLink: entrega as amostras de som (para a retransmissao
// em navegadores sem MediaStreamTrackProcessor, como Firefox e Safari).
// Junta blocos de 128 amostras em pacotes de 20 ms (960 amostras a 48 kHz).
class TelaLinkTap extends AudioWorkletProcessor {
  constructor() { super(); this.parts = []; this.count = 0; }
  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      this.parts.push(input.map((ch) => ch.slice(0)));
      this.count += input[0].length;
      if (this.count >= 960) {
        const n = input.length;
        const chans = Array.from({ length: n }, (_, c) => {
          const out = new Float32Array(this.count);
          let o = 0;
          for (const p of this.parts) { out.set(p[c] || p[0], o); o += p[0].length; }
          return out;
        });
        this.port.postMessage(chans, chans.map((c) => c.buffer));
        this.parts = []; this.count = 0;
      }
    }
    return true;
  }
}
registerProcessor('telalink-tap', TelaLinkTap);
