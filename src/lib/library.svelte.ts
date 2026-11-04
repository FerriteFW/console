// The channel library ("Add channels"), ported from NeonPlug: fixed sets, and airports, licensed sites (Canada and
// the US) and amateur repeaters near a place. Fixed sets are in public/data/ (tools/library/README.md says where they come
// from). Airports, licensed sites and repeaters come tiled from data.ferritefw.dev (sites.svelte.ts, sitedata.ts). Turning entries into channels (numbers, zones, names,
// ferrite's own checks) is the core's (core/src/library.rs).
import { libraryAdd, parsePlace, slotTune, type LibraryAdded, type LibraryItem, type Place } from "./core";
import { activeSlotOf, radioPlace } from "./radioplace";
import { channels } from "./channels.svelte";
import { radio } from "./radio.svelte";
import { appFetch } from "./appfetch";
import { isTauri } from "./transport/native";
import { tuneSummary, type Tune } from "./tune";

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
  const r = await appFetch(url(name));
  if (!r.ok) throw new Error(`${name}: ${r.status} ${r.statusText}`);
  return (await r.json()) as T;
}

class Library {
  open = $state(false);
  tab = $state<"fixed" | "near">("fixed");
  fixed = $state<FixedSet[] | null>(null);
  error = $state("");
  /** The place for Near me (airports and licensed sites), as typed, and what it parses to. */
  placeText = $state("");
  placeFrom = $state("");
  get place(): Place | null {
    return this.placeText.trim() ? parsePlace(this.placeText) : null;
  }
  /** Radius in km. */
  radius = $state(50);
  /** Near me: the map (the default) or the list. */
  view = $state<"map" | "list">("map");
  /** Asking the radio or the browser for the place. */
  asking = $state<"" | "radio" | "browser">("");
  /** Why the browser's location didn't come (refused, unavailable): said calmly beside the place. */
  locNote = $state("");

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
    this.mode = "add";
    this.tab = tab;
    this.open = true;
  }

  /** "add" (Channels' Add channels) or "tune" (Live View's Tune from map: Near me's map, a click tunes the radio). */
  mode = $state<"add" | "tune">("add");
  /** A tune on its way to the radio. */
  tuning = $state(false);
  /** The last tune's confirmation ("Slot A: 146.94 FM ..."), for Live View to show a moment. */
  tuned = $state("");

  /** Live View's Tune from map: Near me's map, nothing else. */
  showTune() {
    this.error = "";
    this.mode = "tune";
    this.tab = "near";
    this.view = "map";
    this.open = true;
  }

  /**
   * A map frequency onto the radio's active slot as a VFO frequency (no channel saved): one terminal `slot` line over
   * the link (TERM-35, LINK-34), with the keypad's checks; a refusal shows its reason and the dialog stays open.
   * No radio: refused, nothing sent.
   */
  async tune(t: Tune): Promise<boolean> {
    const link = radio.connectedLink;
    if (!link) {
      this.error = "Connect to a radio first: tuning sets its frequency.";
      return false;
    }
    if (this.tuning) return false;
    this.tuning = true;
    this.error = "";
    try {
      const slot = await activeSlotOf(link);
      if (!slot) throw new Error("the radio didn't say which slot is active");
      // LINK-33 (decision 347): the binary SLOT, as the keypad would.
      await link.slot(slotTune("ABC".indexOf(slot), t.hz, t.mode, t.txTone || "", t.rxTone || "", t.shiftHz || 0));
      this.tuned = `Tuned ${tuneSummary(slot, t)}`;
      return true;
    } catch (e) {
      this.error = `Not tuned: ${(e as Error).message}`;
      return false;
    } finally {
      this.tuning = false;
    }
  }

  /**
   * The radio's place: its GPS fix (the terminal's `gps`: the last GGA) if it has one, else its fixed position
   * (`get 0 6 9`). Fills the place box; says where it came from.
   */
  async placeFromRadio(auto = false) {
    const link = radio.connectedLink;
    if (!auto) this.error = "";
    if (!link) {
      if (!auto) this.error = "Connect to a radio first, or type a place.";
      return;
    }
    if (this.asking) return;
    this.asking = "radio";
    const was = this.placeText;
    try {
      const r = await radioPlace(link);
      if (r) {
        // A place typed while the radio was asked wins.
        if (this.placeText !== was) return;
        this.placeText = `${r.place.lat.toFixed(4)}, ${r.place.lon.toFixed(4)}`;
        this.placeFrom = `From ${r.gps ? "the radio's GPS" : "the radio's fixed position"}`;
        this.locNote = "";
        return;
      }
      if (!auto) this.error = "The radio has no GPS fix and no fixed position (MENU 0 6 9). Type a place or a grid square.";
    } finally {
      this.asking = "";
    }
  }

  /**
   * This computer's location (the browser's), asked only when the person clicks "Use my location". Refused or
   * unavailable: a calm note, the place left as it was.
   */
  async placeFromBrowser() {
    this.locNote = "";
    const geo = typeof navigator !== "undefined" ? navigator.geolocation : undefined;
    if (!geo) {
      this.locNote = "This browser can't tell its location. Type a place or a grid square.";
      return;
    }
    this.asking = "browser";
    const was = this.placeText;
    try {
      const p = await new Promise<GeolocationPosition>((ok, no) => geo.getCurrentPosition(ok, no, { timeout: 15_000, maximumAge: 600_000 }));
      if (this.placeText !== was) return; // a place typed meanwhile wins
      this.placeText = `${p.coords.latitude.toFixed(4)}, ${p.coords.longitude.toFixed(4)}`;
      this.placeFrom = "From this computer's location";
    } catch (e) {
      const code = (e as GeolocationPositionError).code;
      this.locNote =
        code === 1
          ? "Location is off for Console (the browser asked and it was refused). Allow it in the browser's site settings, or type a place."
          : "Your location isn't available right now. Type a place or a grid square.";
    } finally {
      this.asking = "";
    }
  }

  /**
   * The maps' locate button: the radio's GPS fix (else its fixed position) when one is connected, else this
   * computer's location where the webview has one. True when a place came.
   */
  async locate(): Promise<boolean> {
    const was = this.placeText;
    if (radio.phase === "connected") {
      await this.placeFromRadio();
      if (this.placeText !== was || this.placeFrom.startsWith("From the radio")) return true;
    }
    if (!canLocate) return !!this.place;
    this.error = "";
    await this.placeFromBrowser();
    return this.placeText !== was || this.placeFrom === "From this computer's location";
  }

  /** Entries into the table (through the core's checks). The table's new rows show green until written. `split`: a
   *  zone's channels past 256 (CHAN-35) go on in a new zone (" 2", " 3"), else they're skipped. */
  add(items: LibraryItem[], what: string, split = true): LibraryAdded {
    const t = $state.snapshot(channels.table);
    const a = libraryAdd(items, t, split);
    channels.addLibrary(a, what);
    return a;
  }
}

/** This computer's location is there to ask for (the desktop app on macOS has none: wry doesn't pass WebKit's
 * geolocation through yet). */
export const canLocate = typeof navigator !== "undefined" && !!navigator.geolocation && !(isTauri() && /Mac/.test(navigator.userAgent));

export const library = new Library();
