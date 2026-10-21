// The channel library ("Add channels"), ported from NeonPlug: fixed sets, airports near a place, and Canadian
// licensed sites (TAFL) near a place. The data is in public/data/ (tools/library/README.md says where it comes
// from); the airport and TAFL files are big, so each loads only when its tab first opens. Turning entries into
// channels (numbers, zones, names, ferrite's own checks) is the core's (core/src/library.rs).
import { libraryAdd, parsePlace, type LibraryAdded, type LibraryItem, type Place } from "./core";
import { channels } from "./channels.svelte";
import { radio } from "./radio.svelte";

export type FixedFreq = { number: number; name: string; rx: number; tx: number; notes?: string; ctcss?: number; dcs?: number };
export type FixedSet = {
  name: string;
  displayName?: string;
  description: string;
  defaultPower: string;
  defaultBandwidth: string;
  rxOnly?: boolean;
  frequencies: FixedFreq[];
};
/** An airport as airports.json holds it: ICAO, [lat, lon], VHF frequencies in kHz with a type code. */
export type Airport = { c: string; l: [number, number]; f: (number | [number, string])[] | [number, string] | number };
/** A TAFL entry: a short licensee name, [lat, lon], the frequency in kHz. */
export type Tafl = { c: string; l: [number, number]; f: number };

export type Loaded<T> = { rows: T[]; coords: Float64Array };
type Load = { label: string; done: number; total: number };

const url = (name: string) => `${import.meta.env.BASE_URL}data/${name}`;

/** A JSON file from public/data, with progress (bytes). */
async function fetchJson<T>(name: string, progress: (p: Load) => void): Promise<T> {
  const r = await fetch(url(name));
  if (!r.ok || !r.body) throw new Error(`${name}: ${r.status} ${r.statusText}`);
  const total = Number(r.headers.get("Content-Length") ?? 0);
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let done = 0;
  for (;;) {
    const { done: end, value } = await reader.read();
    if (end) break;
    parts.push(value);
    done += value.length;
    progress({ label: `Loading ${name}`, done, total });
  }
  const all = new Uint8Array(done);
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  return JSON.parse(new TextDecoder().decode(all)) as T;
}

function withCoords<T extends { l: [number, number] }>(rows: T[]): Loaded<T> {
  const coords = new Float64Array(rows.length * 2);
  rows.forEach((r, i) => {
    coords[2 * i] = r.l[0];
    coords[2 * i + 1] = r.l[1];
  });
  return { rows, coords };
}

class Library {
  open = $state(false);
  tab = $state<"fixed" | "airports" | "tafl" | "repeaters">("fixed");
  fixed = $state<FixedSet[] | null>(null);
  airports = $state.raw<Loaded<Airport> | null>(null);
  tafl = $state.raw<Loaded<Tafl> | null>(null);
  loading = $state<Load | null>(null);
  error = $state("");
  /** The place for Airports and TAFL, as typed, and what it parses to. */
  placeText = $state("");
  placeFrom = $state("");
  get place(): Place | null {
    return this.placeText.trim() ? parsePlace(this.placeText) : null;
  }
  /** Radius in km. */
  radius = $state(50);

  private pending = new Map<string, Promise<unknown>>();

  private once<T>(key: string, f: () => Promise<T>): Promise<T> {
    let p = this.pending.get(key) as Promise<T> | undefined;
    if (!p) {
      p = f().finally(() => (this.loading = null));
      p.catch(() => this.pending.delete(key));
      this.pending.set(key, p);
    }
    return p;
  }

  async loadFixed() {
    if (this.fixed) return;
    try {
      this.fixed = await this.once("fixed", () => fetchJson<FixedSet[]>("fixed-channels.json", () => {}));
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  async loadAirports() {
    if (this.airports) return;
    try {
      const rows = await this.once("airports", () => fetchJson<Airport[]>("airports.json", (p) => (this.loading = p)));
      this.airports = withCoords(rows);
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  async loadTafl() {
    if (this.tafl) return;
    try {
      const rows = await this.once("tafl", () => fetchJson<Tafl[]>("tafl.json", (p) => (this.loading = p)));
      this.tafl = withCoords(rows);
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  show(tab: Library["tab"] = this.tab) {
    this.error = "";
    this.tab = tab;
    this.open = true;
  }

  /**
   * The radio's place: its GPS fix (the terminal's `gps`: the last GGA) if it has one, else its fixed position
   * (`get 0 6 9`). Fills the place box; says where it came from.
   */
  async placeFromRadio() {
    const link = radio.connectedLink;
    this.error = "";
    if (!link) {
      this.error = "Connect to a radio first, or type a place.";
      return;
    }
    for (const [cmd, what] of [
      ["gps", "the radio's GPS"],
      ["get 0 6 9", "the radio's fixed position"],
    ] as const) {
      try {
        const text = await link.cmd(cmd);
        const p = parsePlace(text);
        if (p) {
          this.placeText = `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`;
          this.placeFrom = `From ${what}`;
          return;
        }
      } catch {
        /* the next one */
      }
    }
    this.error = "The radio has no GPS fix and no fixed position (MENU 0 6 9). Type a place or a grid square.";
  }

  /** Entries into the table (through the core's checks). The table's new rows show green until written. */
  add(items: LibraryItem[], what: string): LibraryAdded {
    const t = $state.snapshot(channels.table);
    const a = libraryAdd(items, t);
    channels.addLibrary(a, what);
    return a;
  }
}

export const library = new Library();
