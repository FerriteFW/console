// Station graphs (decision 397): the radio keeps only each heard station's latest values (APRS-4), so Console keeps
// what it sees while connected (a read or a live event) on this computer: per station a sample when something
// changed, up to 3 days and 300 samples, in localStorage. Graphed on APRS › Heard stations.
import { aprsWx, type Station } from "./core";

export type Sample = { t: number; speed: number | null; alt: number | null; temp: number | null; wind: number | null; gust: number | null; hum: number | null; hpa: number | null; rain: number | null };

const KEY = "ferrite.history.v1";
const KEEP_MS = 3 * 86_400_000;
const PER_STATION = 300;

const same = (a: Sample, b: Sample) => (Object.keys(a) as (keyof Sample)[]).every((k) => k === "t" || a[k] === b[k]);

class History {
  /** Per callsign (upper case), oldest first. */
  byCall = $state<Record<string, Sample[]>>({});
  #saveAt = 0;

  constructor() {
    try {
      const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
      if (raw) this.byCall = JSON.parse(raw);
    } catch {
      /* none kept, or storage off */
    }
  }

  /** A station as read or heard at `at` (ms; null: unknown, not recorded). */
  record(s: Station, at: number | null) {
    if (at === null) return;
    const w = s.symbol === 3 || /^\d{3}\/\d{3}/.test(s.comment) ? aprsWx(s.comment) : null;
    const x: Sample = { t: at, speed: s.speed, alt: s.alt_m, temp: w?.temp_c ?? null, wind: w?.wind_kmh ?? null, gust: w?.gust_kmh ?? null, hum: w?.hum ?? null, hpa: w?.hpa ?? null, rain: w?.rain_mm ?? null };
    if (x.speed === null && x.alt === null && !w) return; // nothing to graph
    const call = s.call.toUpperCase();
    const list = this.byCall[call] ?? [];
    const last = list[list.length - 1];
    // the same report read again (a refresh) or nothing new: not another point
    if (last && (Math.abs(last.t - x.t) < 30_000 || (same(last, x) && x.t - last.t < 600_000))) return;
    const cut = x.t - KEEP_MS;
    this.byCall = { ...this.byCall, [call]: [...list.filter((p) => p.t >= cut && p.t < x.t), x].slice(-PER_STATION) };
    this.save();
  }

  /** Written at most every 5 s. */
  private save() {
    const now = Date.now();
    if (now - this.#saveAt < 5000) {
      setTimeout(() => this.save(), 5000 - (now - this.#saveAt));
      return;
    }
    this.#saveAt = now;
    try {
      const cut = now - KEEP_MS;
      const kept: Record<string, Sample[]> = {};
      for (const [c, l] of Object.entries(this.byCall)) {
        const f = l.filter((p) => p.t >= cut);
        if (f.length) kept[c] = f;
      }
      localStorage.setItem(KEY, JSON.stringify(kept));
    } catch {
      /* storage full or off: kept for this session only */
    }
  }

  of(call: string): Sample[] {
    return this.byCall[call.toUpperCase()] ?? [];
  }

  forget() {
    this.byCall = {};
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* none */
    }
  }
}

export const history = new History();
