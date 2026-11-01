// Listen's health (the dot by Listen): blocks the radio dropped from its audio queue (the readback's `audio` line,
// LINK-13.4: cumulative since the radio started) and the times Console's own player ran dry (jitter.ts's
// underruns), over the last few seconds. Plain TypeScript: the unit tests run it.

/** How far back the dot looks. */
export const HEALTH_WINDOW_MS = 10_000;

/** The readback's `audio made=N dropped=N waits=N clips=N peak=N gain=N`, or null without one. */
export function audioCounts(kv: Record<string, string | number> | undefined | null): { made: number; dropped: number } | null {
  if (!kv || kv.made === undefined || kv.dropped === undefined) return null;
  const made = Number(kv.made);
  const dropped = Number(kv.dropped);
  return Number.isFinite(made) && Number.isFinite(dropped) ? { made, dropped } : null;
}

type Sample = { at: number; dropped: number; underruns: number };

export class Health {
  private rows: Sample[] = [];
  private lastDropped: number | null = null;
  private lastUnder: number | null = null;
  /** Whether the radio has reported its counts this session (older firmware or a quiet radio: no `audio` line). */
  radioCounts = false;

  /** A reading at `at` ms: the radio's cumulative `dropped` (null when it sent none) and the player's underruns. */
  add(at: number, dropped: number | null, underruns: number) {
    let d = 0;
    if (dropped !== null) {
      this.radioCounts = true;
      // A count that went down: the radio restarted; what it shows now is new.
      if (this.lastDropped !== null) d = dropped >= this.lastDropped ? dropped - this.lastDropped : dropped;
      this.lastDropped = dropped;
    }
    const u = this.lastUnder === null ? 0 : Math.max(0, underruns - this.lastUnder);
    this.lastUnder = underruns;
    this.rows.push({ at, dropped: d, underruns: u });
    while (this.rows.length && at - this.rows[0].at > HEALTH_WINDOW_MS) this.rows.shift();
  }

  /** Drops and underruns within the window ending at `now`. */
  recent(now: number): { dropped: number; underruns: number } {
    let dropped = 0;
    let underruns = 0;
    for (const r of this.rows) {
      if (now - r.at > HEALTH_WINDOW_MS) continue;
      dropped += r.dropped;
      underruns += r.underruns;
    }
    return { dropped, underruns };
  }

  /** The dot: "ok" (green) with nothing lost lately, else "warn" (amber); and its tooltip. */
  state(now: number): { tone: "ok" | "warn"; text: string } {
    const { dropped, underruns } = this.recent(now);
    const s = HEALTH_WINDOW_MS / 1000;
    const parts: string[] = [];
    if (this.radioCounts) parts.push(dropped ? `${dropped} block${dropped === 1 ? "" : "s"} dropped in the last ${s} s` : `No blocks dropped in the last ${s} s`);
    else parts.push("The radio doesn't report its audio counts");
    if (underruns) parts.push(`${underruns} gap${underruns === 1 ? "" : "s"} in the playback here`);
    return { tone: dropped || underruns ? "warn" : "ok", text: parts.join(" · ") };
  }

  reset() {
    this.rows = [];
    this.lastDropped = null;
    this.lastUnder = null;
    this.radioCounts = false;
  }
}
