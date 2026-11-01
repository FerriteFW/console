// The progress bars' time left: the rate since this run's first progress, in whole seconds. A new run (the total
// changed, or the count went back) starts over; nothing is shown for the first 2 s or before any progress.
export class Eta {
  private t0 = 0;
  private d0 = 0;
  private total = -1;
  private last = -1;

  /** Seconds left, or null while there's too little to judge (or it's done). */
  left(done: number, total: number, now = performance.now()): number | null {
    if (total !== this.total || done < this.last) {
      this.total = total;
      this.t0 = now;
      this.d0 = done;
    }
    this.last = done;
    const did = done - this.d0;
    const secs = (now - this.t0) / 1000;
    if (total <= 0 || did <= 0 || secs < 2 || done >= total) return null;
    return Math.ceil(((total - done) * secs) / did);
  }
}

/** "· 42 s left", or nothing. */
export const etaText = (s: number | null) => (s === null ? "" : ` · ${s} s left`);
