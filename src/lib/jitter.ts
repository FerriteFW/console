// Listen's jitter buffer (LINK-13.5, decision 331), as plain JavaScript source: the AudioWorklet runs it (a worklet
// is its own module, so it takes the text), and the unit tests evaluate the same text.
//
// - Starts playing once `start` samples wait; never keeps more than `cap` (on overflow it drops back to `start`, so
//   a slow sound card can't let the delay grow past the cap).
// - A short underrun (a lost or late block) plays as silence, the last sample faded out over a few ms, and the next
//   block plays as soon as it comes: no waiting for `start` again.
// - Only after `stop` output samples of underrun (a real stop: the squelch closed, keep-alives only) does it wait to
//   refill to `start` before playing again.
export const JITTER = `
class Jitter {
  constructor(rate, outRate, start, cap, stop) {
    this.step = rate / outRate; this.start = start; this.cap = cap; this.stop = stop;
    this.buf = new Float32Array(cap + 1); this.r = 0; this.n = 0; this.pos = 0;
    this.playing = false; this.dry = 0; this.last = 0; this.underruns = 0;
  }
  push(s) {
    const len = this.buf.length;
    for (let i = 0; i < s.length; i++) {
      if (this.n === len) { this.r = (this.r + 1) % len; this.n--; }
      this.buf[(this.r + this.n) % len] = s[i];
      this.n++;
    }
    if (this.n > this.cap) { const drop = this.n - this.start; this.r = (this.r + drop) % len; this.n -= drop; }
  }
  pull(o) {
    const len = this.buf.length;
    if (!this.playing && this.n >= this.start) { this.playing = true; this.dry = 0; }
    for (let i = 0; i < o.length; i++) {
      if (this.playing && this.n >= 2) {
        const a = this.buf[this.r], b = this.buf[(this.r + 1) % len];
        o[i] = this.last = a + (b - a) * this.pos;
        this.pos += this.step;
        while (this.pos >= 1 && this.n >= 2) { this.pos -= 1; this.r = (this.r + 1) % len; this.n--; }
        this.dry = 0;
        continue;
      }
      if (this.playing && this.dry === 0) this.underruns++;
      this.last *= 0.995;
      o[i] = this.last;
      if (this.playing && ++this.dry >= this.stop) this.playing = false;
    }
  }
}
`;
