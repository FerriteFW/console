// The channel library ("Add channels"), ported from NeonPlug: fixed sets, airports near a place, and licensed sites
// (Canada and the US) near a place. Fixed sets are in public/data/ (tools/library/README.md says where they come
// from). Airports and licensed sites come tiled from data.ferritefw.dev (sites.svelte.ts, sitedata.ts). Turning entries into channels (numbers, zones, names,
// ferrite's own checks) is the core's (core/src/library.rs).
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
  /** "AM" for airband; else ("Analog") NFM or FM by the bandwidth. */
  defaultMode?: string;
  rxOnly?: boolean;
  frequencies: FixedFreq[];
};

const url = (name: string) => `${import.meta.env.BASE_URL}data/${name}`;

/** A JSON file from public/data. */
async function fetchJson<T>(name: string): Promise<T> {
  const r = await fetch(url(name));
  if (!r.ok) throw new Error(`${name}: ${r.status} ${r.statusText}`);
  return (await r.json()) as T;
}

class Library {
  open = $state(false);
  tab = $state<"fixed" | "airports" | "sites" | "repeaters">("fixed");
  fixed = $state<FixedSet[] | null>(null);
  error = $state("");
  /** The place for Airports and licensed sites, as typed, and what it parses to. */
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
      p = f();
      p.catch(() => this.pending.delete(key));
      this.pending.set(key, p);
    }
    return p;
  }

  async loadFixed() {
    if (this.fixed) return;
    try {
      this.fixed = await this.once("fixed", () => fetchJson<FixedSet[]>("fixed-channels.json"));
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
