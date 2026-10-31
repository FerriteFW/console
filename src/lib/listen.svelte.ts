// Listen (LINK-13.4, LINK-13.5): the radio's receive audio over the cable, played in the browser. Off at every
// connect and never remembered: it starts only when asked here. The radio's 12 kHz µ-law blocks (decoded by the
// core, ferrite's own coder) go to an AudioWorklet that keeps a jitter buffer and steps them up to the device's rate;
// a gap (nothing heard, a lost block) plays as silence.
import { audioDecode, P } from "./core";
import { CAP_AUDIO, type Link } from "./link";
import { radio } from "./radio.svelte";

/** The jitter buffer: play once this much is waiting; never keep more than the cap (older audio is dropped). */
const START_MS = 150;
const CAP_MS = 600;
/** The request again this often while listening: keeps the session active (a quiet one stops it, LINK-13.5). */
const RENEW_MS = 3000;

const WORKLET = `
class Rx extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.rate = o.processorOptions.rate; this.start = o.processorOptions.start; this.cap = o.processorOptions.cap;
    this.buf = new Float32Array(this.cap * 2); this.r = 0; this.n = 0; this.pos = 0; this.playing = false;
    this.port.onmessage = (e) => {
      const s = e.data;
      if (this.n + s.length > this.cap) { const drop = this.n + s.length - this.cap; this.r = (this.r + drop) % this.buf.length; this.n -= drop; }
      for (let i = 0; i < s.length; i++) this.buf[(this.r + this.n + i) % this.buf.length] = s[i];
      this.n += s.length;
    };
  }
  process(_in, out) {
    const o = out[0][0];
    const step = this.rate / sampleRate;
    if (!this.playing && this.n >= this.start) this.playing = true;
    for (let i = 0; i < o.length; i++) {
      if (!this.playing || this.n < 2) { o[i] = 0; this.playing = false; continue; }
      const a = this.buf[this.r], b = this.buf[(this.r + 1) % this.buf.length];
      o[i] = a + (b - a) * this.pos;
      this.pos += step;
      while (this.pos >= 1 && this.n >= 2) { this.pos -= 1; this.r = (this.r + 1) % this.buf.length; this.n--; }
    }
    for (let c = 1; c < out[0].length; c++) out[0][c].set(o);
    return true;
  }
}
registerProcessor("ferrite-rx", Rx);
`;

class Listen {
  on = $state(false);
  starting = $state(false);
  volume = $state(0.8);
  muted = $state(false);
  /** The slot heard in the last block (A, B, C), or "" while nothing is heard. */
  slot = $state("");
  /** What the last block was (LINK-13.4, decision 290): a slot's receiver, the broadcast on `slot`, or HF mode. */
  kind = $state<"slot" | "bcast" | "hf">("slot");
  error = $state("");
  private link: Link | null = null;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private renew: ReturnType<typeof setInterval> | null = null;
  private quietAt = 0;

  /** Whether this connection can listen: the cable, a radio that offers `AUDIO`. */
  get available(): boolean {
    const l = radio.connectedLink;
    return !!l && radio.kind === "cable" && (l.caps & CAP_AUDIO) !== 0;
  }

  async start() {
    const link = radio.connectedLink;
    if (!link || !this.available || this.on || this.starting) return;
    this.starting = true;
    this.error = "";
    try {
      const rest = await link.ok(P.msg.AUDIO, new Uint8Array([1]));
      const rate = rest[0] | (rest[1] << 8);
      this.ctx = new AudioContext();
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
      await this.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      this.node = new AudioWorkletNode(this.ctx, "ferrite-rx", {
        outputChannelCount: [1],
        processorOptions: { rate, start: (rate * START_MS) / 1000, cap: (rate * CAP_MS) / 1000 },
      });
      this.gain = this.ctx.createGain();
      this.node.connect(this.gain).connect(this.ctx.destination);
      this.apply();
      this.link = link;
      link.onAudio = (p) => this.block(p);
      this.renew = setInterval(() => {
        if (radio.connectedLink !== this.link) return void this.stop();
        void this.link?.ask(P.msg.AUDIO, new Uint8Array([1])).catch(() => {});
      }, RENEW_MS);
      this.on = true;
    } catch (e) {
      this.error = (e as Error).message;
      await this.stop();
    } finally {
      this.starting = false;
    }
  }

  /** Stops listening: the radio told when still connected, the audio closed. */
  async stop() {
    const link = this.link;
    this.on = false;
    this.slot = "";
    if (this.renew) clearInterval(this.renew);
    this.renew = null;
    if (link) link.onAudio = () => {};
    this.link = null;
    this.node?.disconnect();
    this.node = null;
    this.gain = null;
    const ctx = this.ctx;
    this.ctx = null;
    await ctx?.close().catch(() => {});
    if (link && radio.connectedLink === link) await link.ask(P.msg.AUDIO, new Uint8Array([0])).catch(() => {});
  }

  /** Volume and mute to the gain. */
  apply() {
    if (this.gain) this.gain.gain.value = this.muted ? 0 : this.volume;
  }

  private block(p: Uint8Array) {
    if (p.length <= 4) {
      if (performance.now() - this.quietAt > 500) this.slot = ""; // a keep-alive: nothing heard
      return;
    }
    this.slot = p[2] < 3 ? "ABC"[p[2]] : "";
    this.kind = p[3] & 2 ? "bcast" : p[3] & 4 ? "hf" : "slot";
    this.quietAt = performance.now();
    const s = audioDecode(p);
    const f = new Float32Array(s.length);
    for (let i = 0; i < s.length; i++) f[i] = s[i] / 32768;
    this.node?.port.postMessage(f, [f.buffer]);
  }
}

export const listen = new Listen();
