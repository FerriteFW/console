// Listen's recorder: the decoded 12 kHz 16-bit mono blocks into a WAV, kept in time by the clock (a gap, a lost
// block or nothing heard, is written as silence, so a minute recorded plays as a minute). Plain TypeScript: the
// unit tests run it.

/** At most this long (then it stops and saves by itself). */
export const RECORD_MAX_MS = 60 * 60_000;
/** Behind the clock by more than this, silence fills up to it (smaller lags are the blocks' own jitter). */
const SLACK_MS = 400;

export class WavRecorder {
  private chunks: Int16Array[] = [];
  /** Samples written. */
  samples = 0;
  readonly startedAt: number;
  readonly rate: number;

  constructor(rate: number, now: number) {
    this.rate = rate;
    this.startedAt = now;
  }

  /** Where the clock says the recording should be by `now`, in samples. */
  private due(now: number) {
    return Math.floor(((now - this.startedAt) * this.rate) / 1000);
  }

  /** Silence up to where the clock says, when the blocks fell behind by more than the slack. */
  private fill(now: number, coming: number) {
    const behind = this.due(now) - coming - this.samples;
    if (behind > (SLACK_MS * this.rate) / 1000) this.silence(behind);
  }

  private silence(n: number) {
    while (n > 0) {
      const k = Math.min(n, this.rate * 10);
      this.chunks.push(new Int16Array(k));
      this.samples += k;
      n -= k;
    }
  }

  /** A block heard at `now`. */
  push(s: Int16Array, now: number) {
    if (!s.length) return;
    this.fill(now, s.length);
    this.chunks.push(s.slice());
    this.samples += s.length;
  }

  /** The WAV's size now, bytes (header included). */
  get bytes() {
    return 44 + this.samples * 2;
  }

  /** The WAV, padded with silence to `now` if the end was quiet. */
  finish(now: number): Blob {
    this.fill(now, 0);
    return new Blob([wavHeader(this.rate, this.samples), ...this.chunks.map((c) => new Uint8Array(c.buffer, c.byteOffset, c.byteLength))], { type: "audio/wav" });
  }
}

/** A 44-byte RIFF/WAVE header for 16-bit mono PCM. */
export function wavHeader(rate: number, samples: number): Uint8Array {
  const b = new Uint8Array(44);
  const v = new DataView(b.buffer);
  const tag = (at: number, s: string) => [...s].forEach((c, i) => (b[at + i] = c.charCodeAt(0)));
  tag(0, "RIFF");
  v.setUint32(4, 36 + samples * 2, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, "data");
  v.setUint32(40, samples * 2, true);
  return b;
}

/** "listen-2026-10-31-1432.wav". */
export function wavName(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `listen-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.wav`;
}

/** "0:42", "12:05", "1:00:00". */
export function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const p = (n: number) => String(n).padStart(2, "0");
  return m >= 60 ? `${Math.floor(m / 60)}:${p(m % 60)}:${p(s % 60)}` : `${m}:${p(s % 60)}`;
}

/** "1.4 MB", "820 kB". */
export function size(bytes: number): string {
  return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} kB`;
}
