// Listen (LINK-13.4, LINK-13.5): the radio's receive audio over the cable, played in the browser. Off at every
// connect and never remembered: it starts only when asked here. The radio's 12 kHz µ-law blocks (decoded by the
// core, ferrite's own coder) go to an AudioWorklet that keeps a jitter buffer (`jitter.ts`) and steps them up to the
// device's rate; a gap (a lost block, nothing heard) plays as silence.
import { audioDecode, P, parseUi } from "./core";
import { JITTER } from "./jitter";
import { audioCounts, Health } from "./listenHealth";
import { CAP_AUDIO, type Link } from "./link";
import { radio } from "./radio.svelte";

/** The jitter buffer (decision 331): play once this much is waiting; never keep more than the cap. */
const START_MS = 250;
const CAP_MS = 750;
/** An underrun this long is a real stop (the squelch closed): the buffer refills to START_MS before playing. */
const STOP_MS = 500;
/** The request again this often while listening: keeps the session active (a quiet one stops it, LINK-13.5). */
const RENEW_MS = 3000;
/** Nothing at all (not even a keep-alive) this long while on: listening was ended on the radio (LINK-13.5). */
const SILENT_MS = 3000;
/** How often the renewal and the silence are looked at. */
const TICK_MS = 1000;
/** The health dot's reading this often: the radio's audio counts (from Live View's readback when it's polling,
 *  else one short readback of its own) and the player's underruns. */
const HEALTH_MS = 3000;

const WORKLET = `${JITTER}
class Rx extends AudioWorkletProcessor {
  constructor(o) {
    super();
    const p = o.processorOptions;
    this.j = new Jitter(p.rate, sampleRate, p.start, p.cap, Math.round((sampleRate * p.stopMs) / 1000));
    this.port.onmessage = (e) => this.j.push(e.data);
    this.told = 0;
    this.calls = 0;
  }
  process(_in, out) {
    const o = out[0][0];
    this.j.pull(o);
    if (++this.calls >= 200 && this.j.gaps !== this.told) {
      this.calls = 0;
      this.told = this.j.gaps;
      this.port.postMessage(this.told);
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
  /** The dot by Listen: "ok" or "warn", and its tooltip; null until the first reading. */
  health = $state<{ tone: "ok" | "warn"; text: string } | null>(null);
  private healthy = new Health();
  private underruns = 0;
  private healthAt = 0;
  private reading = false;
  private link: Link | null = null;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private renew: ReturnType<typeof setInterval> | null = null;
  private quietAt = 0;
  /** When anything (a block or a keep-alive) last came, and whether `AUDIO` 1 was asked again since. */
  private anyAt = 0;
  private renewAt = 0;
  private retried = false;

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
        processorOptions: { rate, start: (rate * START_MS) / 1000, cap: (rate * CAP_MS) / 1000, stopMs: STOP_MS },
      });
      this.gain = this.ctx.createGain();
      this.node.port.onmessage = (e) => (this.underruns = Number(e.data) || 0);
      this.node.connect(this.gain).connect(this.ctx.destination);
      this.healthy.reset();
      this.underruns = 0;
      this.health = null;
      this.healthAt = 0;
      this.apply();
      this.link = link;
      link.onAudio = (p) => this.block(p);
      this.anyAt = this.renewAt = performance.now();
      this.retried = false;
      this.renew = setInterval(() => void this.tick(), TICK_MS);
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
    this.health = null;
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

  /** Each second while on: the renewal every RENEW_MS; and when nothing at all has come for SILENT_MS, `AUDIO` 1
   * asked again once, then Listen off with a note if still nothing (LINK-13.5, decision 331). */
  private async tick() {
    const link = this.link;
    if (!link || radio.connectedLink !== link) return void this.stop();
    const now = performance.now();
    if (now - this.anyAt >= SILENT_MS) {
      if (this.retried) return this.stopped("Listen stopped: the radio isn't sending audio");
      this.retried = true;
      this.anyAt = this.renewAt = now;
      try {
        await link.ok(P.msg.AUDIO, new Uint8Array([1]));
      } catch (e) {
        if (this.link === link) await this.stopped(`Listen stopped: ${(e as Error).message}`);
      }
      return;
    }
    if (now - this.renewAt >= RENEW_MS) {
      this.renewAt = now;
      void link.ask(P.msg.AUDIO, new Uint8Array([1])).catch(() => {});
    }
    if (now - this.healthAt >= HEALTH_MS && !this.reading) {
      this.healthAt = now;
      void this.readHealth(link);
    }
  }

  /** One health reading: Live View's latest readback when it's polling the screen, else a readback of the state
   *  only (a few hundred bytes every 3 s). */
  private async readHealth(link: Link) {
    this.reading = true;
    try {
      let ui = radio.ui;
      if (!radio.live || radio.liveByEvents || radio.busy || !ui) ui = parseUi(await link.uiText(0));
      if (this.link !== link) return;
      const c = audioCounts(ui.other.find((l) => l.kind === "audio")?.kv);
      const now = performance.now();
      this.healthy.add(now, c ? c.dropped : null, this.underruns);
      this.health = this.healthy.state(now);
    } catch {
      /* the next reading */
    } finally {
      this.reading = false;
    }
  }

  private async stopped(why: string) {
    await this.stop();
    this.error = why;
  }

  /** Volume and mute to the gain. */
  apply() {
    if (this.gain) this.gain.gain.value = this.muted ? 0 : this.volume;
  }

  private block(p: Uint8Array) {
    this.anyAt = performance.now();
    this.retried = false;
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
