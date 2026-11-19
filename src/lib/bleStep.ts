// Bluetooth at 115200 losing data (LINK-15.1): the module holds about 160 bytes and passes them on as the radio link
// allows; at the edge of range the air resends, the module's buffer overruns, and long answers (the satellite list,
// a channel read) lose frames while short ones get through. 9600 leaves room for the resends. This decides when to
// step down: a loss is one lost frame, resync or unanswered request, and the retries one loss sets off (a resync,
// then the gap, then the request again) count once.

/** Losses closer together than this are one loss (its retries). */
export const SAME_LOSS_MS = 3_000;
/** This many losses ... */
export const STEP_AFTER = 2;
/** ... within this long: step down. */
export const WITHIN_MS = 60_000;

export class LossWatch {
  private times: number[] = [];
  private last = -Infinity;

  /** A loss at `now` (ms): true when Bluetooth should step down to 9600. */
  note(now: number): boolean {
    if (now - this.last < SAME_LOSS_MS) return false;
    this.last = now;
    this.times = [...this.times.filter((t) => now - t < WITHIN_MS), now];
    return this.times.length >= STEP_AFTER;
  }

  reset() {
    this.times = [];
    this.last = -Infinity;
  }
}
