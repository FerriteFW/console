// Small pieces of link.ts kept apart from the Rust core, so the unit tests reach them without the wasm.

/**
 * A request's answer, or null when none came in time (issue #92): the time-out starts with `arm`, once the request's
 * bytes are written, so a write that waits in a queue (the desktop shell's, the BLE pacing) doesn't eat the answer's
 * time. `register` gets the resolver the answer handler calls.
 */
export function answerTimer<T>(register: (resolve: (a: T | null) => void) => void): {
  got: Promise<T | null>;
  arm: (ms: number) => void;
} {
  let done: (a: T | null) => void = () => {};
  const got = new Promise<T | null>((resolve) => {
    done = resolve;
    register(resolve);
  });
  return { got, arm: (ms) => void setTimeout(() => done(null), ms) };
}

/**
 * LINK-50: what a STREAM answer with `seq` is to the stream whose request went with `start` and has `have` frames so
 * far: its next frame, a gap (a frame of its own missing: seqs ahead of the next), or a stray (seqs behind its
 * start, within half the seq space: a late frame of a stream before it, issue #95). Behind and ahead are told apart
 * by the distance from `start`, so a retried stream starts well past the one before ([`STREAM_RETRY_SKIP`]).
 */
export function streamFate(seq: number, start: number, have: number): "next" | "gap" | "stray" {
  const d = (seq - start + 256) % 256;
  if (d >= 128) return "stray";
  return d === have ? "next" : "gap";
}

/** Seqs skipped after a stream with a gap: its late frames then fall behind the next stream's start (issue #95).
 *  A stream is never near this long (a UI readback is a few pages), and the next one starts within 128 after it. */
export const STREAM_RETRY_SKIP = 64;

const BANG = 0x21;

/**
 * LINK-15.1: the BT module answers the speed unlock with `!!!!`, which isn't a frame: while armed, the first `!!!!`
 * is cut out of what arrives, wherever it falls in a read and when it is split across two (issue #95). A run of `!`
 * at a read's end waits for the next read (or `disarm`) to tell.
 */
export class UnlockStrip {
  private armed = false;
  private held = new Uint8Array();

  arm() {
    this.armed = true;
    this.held = new Uint8Array();
  }

  /** Stops looking; what was held back, to feed on. */
  disarm(): Uint8Array {
    this.armed = false;
    const h = this.held;
    this.held = new Uint8Array();
    return h;
  }

  /** The bytes to feed on from one read. */
  take(bytes: Uint8Array): Uint8Array {
    if (!this.armed) return bytes;
    const all = new Uint8Array(this.held.length + bytes.length);
    all.set(this.held);
    all.set(bytes, this.held.length);
    this.held = new Uint8Array();
    for (let i = 0; i + 4 <= all.length; i++) {
      if (all[i] === BANG && all[i + 1] === BANG && all[i + 2] === BANG && all[i + 3] === BANG) {
        this.armed = false;
        const out = new Uint8Array(all.length - 4);
        out.set(all.subarray(0, i));
        out.set(all.subarray(i + 4), i);
        return out;
      }
    }
    let k = all.length;
    while (k > 0 && all.length - k < 3 && all[k - 1] === BANG) k--;
    this.held = all.slice(k);
    return all.subarray(0, k);
  }
}
