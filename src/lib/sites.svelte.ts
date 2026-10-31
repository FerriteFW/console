// Data from data.ferritefw.dev (through sitedata.ts) for the channel library's tabs: licensed sites (Canada's TAFL and
// the US FCC's ULS), airports (OurAirports) and repeaters (HearHam). Per kind: the rows near the library's place, the sources' attribution
// and dates, updates the server offers, and each source's offline copy ("Save for offline"). One client for all,
// so the indexes and tiles are fetched and kept once.
import { untrack } from "svelte";
import { SiteData, type NearResult, type Site, type TopIndex, type TopSource } from "./sitedata.ts";

/** Short names for the sources the data repo publishes; another source shows its title. */
const NAMES: Record<string, string> = { tafl: "Canada", fcc: "US", airports: "Airports", repeaters: "Repeaters" };
const client = new SiteData();

export const sourceName = (src: string, title = src) => NAMES[src] ?? title;

export type Near = NearResult & { coords: Float64Array; key: string };

export class Sites {
  client = client;
  top = $state.raw<TopIndex | null>(null);
  /** Why the top index didn't load (offline, not published yet). */
  topError = $state("");
  near = $state.raw<Near | null>(null);
  loading = $state(false);
  /** Newer build dates on the server, per source: offered as "Update channel data". */
  newer = $state<Record<string, string>>({});
  /** Each source's offline copy: its build date, or null. */
  offline = $state<Record<string, string | null>>({});
  canKeep = $state(false);
  /** A download running: the source and its bytes. */
  saving = $state<{ src: string; done: number; total: number } | null>(null);
  saveError = $state("");

  private seq = 0;
  private last: [number, number, number] | null = null;
  private started: Promise<void> | null = null;

  /**
   * `known`: this tab's sources (the data repo publishes others for other tabs), also what to ask for when the top
   * index can't be read (the cache may still hold their tiles).
   */
  constructor(readonly known: string[]) {}

  get sources(): string[] {
    return this.top?.sources.map((s) => s.source).filter((s) => this.known.includes(s)) ?? this.known;
  }
  /** This tab's sources as the top index lists them (the footer's). */
  get listed(): TopSource[] {
    return this.top?.sources.filter((s) => this.known.includes(s.source)) ?? [];
  }
  source(src: string): TopSource | undefined {
    return this.top?.sources.find((s) => s.source === src);
  }

  /** The top index and what the cache holds; once (again after a failure, by `retry`). */
  start(): Promise<void> {
    this.started ??= (async () => {
      this.canKeep = await this.client.canKeep();
      try {
        this.top = await this.client.top();
        this.topError = "";
      } catch (e) {
        this.topError = (e as Error).message;
      }
      const off: Record<string, string | null> = {};
      for (const s of this.sources) off[s] = await this.client.offline(s).catch(() => null);
      this.offline = off;
    })();
    return this.started;
  }

  retry() {
    this.started = null;
    this.again();
  }

  /** The key `look` gives its result, for a place and radius (the tab shows a result only for its own). */
  static key(lat: number, lon: number, radius: number) {
    return `${lat},${lon},${radius}`;
  }

  /** Look again at the last place (after a retry, an update or a save). */
  private again() {
    this.near = null;
    if (this.last) this.look(...this.last);
  }

  /**
   * The sites within `radius` km's box of a place, from every source that has tiles there. Called from the tab's
   * effect: reads no state the effect would then depend on.
   */
  look(lat: number, lon: number, radius: number) {
    return untrack(() => this.lookNow(lat, lon, radius));
  }

  private async lookNow(lat: number, lon: number, radius: number) {
    const key = Sites.key(lat, lon, radius);
    this.last = [lat, lon, radius];
    if (this.near?.key === key) return;
    const n = ++this.seq;
    this.loading = true;
    try {
      await this.start();
      const r = await this.client.near(this.sources, lat, lon, radius);
      if (n !== this.seq) return;
      const coords = new Float64Array(r.sites.length * 2);
      r.sites.forEach((s: Site, i: number) => {
        coords[2 * i] = s.lat;
        coords[2 * i + 1] = s.lon;
      });
      this.near = { ...r, coords, key };
      this.newer = Object.fromEntries(this.client.newer);
    } finally {
      if (n === this.seq) this.loading = false;
    }
  }

  /** Save a whole source for offline use (the zip, checked); also how a saved source takes an update. */
  async save(src: string) {
    const top = this.source(src);
    if (!top || this.saving) return;
    this.saveError = "";
    this.saving = { src, done: 0, total: top.bundle_bytes };
    try {
      await this.client.downloadAll(top, (p) => (this.saving = { src, ...p }));
      this.offline = { ...this.offline, [src]: await this.client.offline(src) };
      this.newer = Object.fromEntries(this.client.newer);
      this.again(); // the saved copy may be a newer build
    } catch (e) {
      this.saveError = `${sourceName(src, top.title)}: ${(e as Error).message}`;
    } finally {
      this.saving = null;
    }
  }

  /** Take a newer build: a saved source downloads again whole; else its kept tiles go and load again as needed. */
  async update(src: string) {
    if (this.offline[src]) {
      this.started = null; // the top index again: the new zip's size and checksum
      await this.start();
      return this.save(src);
    }
    await this.client.update(src);
    this.newer = Object.fromEntries(this.client.newer);
    this.again();
  }
}

/** Licensed sites (the Licensed sites tab). */
export const sites = new Sites(["tafl", "fcc"]);
/** Airports (the Airports tab). */
export const airportSites = new Sites(["airports"]);
/** Amateur repeaters (Near me's Repeaters). */
export const repeaterSites = new Sites(["repeaters"]);
