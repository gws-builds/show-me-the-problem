// AudioWorklet: mono input -> 16 kHz signed 16-bit PCM in 80 ms chunks (1280 samples).
class Pcm16k extends AudioWorkletProcessor {
  constructor() { super(); this.ratio = sampleRate / 16000; this.pos = 0; this.out = new Int16Array(1280); this.n = 0; }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    // Average the input samples that fall into each 16 kHz output sample (cheap low-pass + decimate).
    for (let i = 0; i < ch.length; i++) {
      this.acc = (this.acc || 0) + ch[i]; this.cnt = (this.cnt || 0) + 1; this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const v = Math.max(-1, Math.min(1, this.acc / this.cnt)); this.acc = 0; this.cnt = 0;
        this.out[this.n++] = v * 0x7fff;
        if (this.n === this.out.length) { this.port.postMessage(this.out.buffer.slice(0)); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('pcm16k', Pcm16k);
