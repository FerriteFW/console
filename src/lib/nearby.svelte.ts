// Add channels › Near me: the rows the lists show (List) and the map shows (Map), and the one set of picks both
// views share. What shows is the kinds switched on in the dialog's sidebar: Licensed, Airports, Repeaters, any of
// them, at least one (`kinds`, remembered in this browser); Canada and the US are sub-filters of Licensed. Add takes
// only the picks shown (its count is what the user can see); picks of a hidden kind stay picked for when it shows
// again. Picks are per frequency: a licensed entry (one per organization and frequency, `s|category|org|half kHz`,
// its nearest site's position and mode), an airport's frequency (`a|ICAO|lat|lon|kHz`) or a repeater's
// (`r|callsign|lat|lon|half kHz`). Organizations are the licensees' names grouped by the core (orgGroups) within each
// category. Add turns every pick into channels, each layer shaped its own way: licensed sites NFM or FM from the data
// (unknown as the "unknown mode" choice; digital only never shows: Ferrite has no digital modes), RX only by choice,
// merged per zone and frequency; airports AM, RX only always, named "CYVR TWR" (airportName); repeaters named by
// callsign, TX on the repeater's input (its offset), its tones, NFM or FM (repeaterMode); all with their positions
// (LINK-53) and the zone target (repeaters: one "Repeaters" zone).
import { library, type FixedSet } from "./library.svelte";
import { channels } from "./channels.svelte";
import { airportSites, repeaterSites, sites, Sites, type Near } from "./sites.svelte";
import { CATEGORIES, CAT_BUSINESS, CAT_PUBLIC_SAFETY, MODE_DIGITAL, MODE_FM, MODE_NFM } from "./sitedata";
import { airportName, airportType, libraryFixedItems, near, orgGroups, type LibraryItem } from "./core";
import { zoneName, type Target } from "./components/library/ZoneTarget.svelte";
import { toneWord } from "./tune";

/** A licensed entry: an organization's frequency, from its nearest site (`name`: that licensee); `sites`: how many share it. */
export type SiteEntry = { key: string; src: string; name: string; f: number; m: number; mobile: boolean; km: number; group: string; k: number; sites: number; pos: [number, number] };
/** A licensee's frequency at its nearest site (the map's markers), with the entry it picks (`key`). */
export type SiteRow = { key: string; src: string; name: string; f: number; m: number; mobile: boolean; km: number; group: string; k: number; pos: [number, number] };
export type AirportFreq = { key: string; khz: number; type: string };
export type Airport = { key: string; c: string; l: [number, number]; km: number; freqs: AirportFreq[] };
/** A repeater's frequency: output `f` and offset `d` in half kHz; tones to send (`te`) and that it sends (`td`). */
export type RepeaterFreq = { key: string; f: number; d: number; te: string; td: string; m: number };
export type Repeater = { key: string; c: string; l: [number, number]; km: number; freqs: RepeaterFreq[] };

/** Half kHz to MHz, 4 decimals (a trailing 0 dropped). */
export const mhz = (f: number) => (f / 2000).toFixed(4).replace(/0$/, "");
export const modeLabel = (m: number) => (m === MODE_NFM ? "NFM" : m === MODE_FM ? "FM" : "Mode ?");
/** The most rows a lookup keeps, nearest first (a big circle over a city has more): the lists and map say so when hit. */
export const SITE_CAP = 50_000;
export const AIRPORT_CAP = 2_000;
export const REPEATER_CAP = 5_000;
export const MOBILE = "A mobile's frequency: often a repeater's input, or the centre of a mobile area";

/** A repeater's offset as it reads: "+5 MHz", "−600 kHz", "simplex". */
export function offsetLabel(d: number): string {
  if (!d) return "simplex";
  const khz = Math.abs(d) / 2;
  const sign = d > 0 ? "+" : "−";
  return khz >= 1000 ? `${sign}${+(khz / 1000).toFixed(4)} MHz` : `${sign}${khz} kHz`;
}
/** A repeater's tones as they read: "T 100.0" (sent), "TSQL 100.0" (sent and received), "R 88.5" (received), both
 * apart ("T 100.0 · R 88.5"), or "no tone". DCS as "D023". */
export function toneLabel(te: string, td: string): string {
  if (te && te === td) return `TSQL ${te}`;
  const parts = [te ? `T ${te}` : "", td ? `R ${td}` : ""].filter(Boolean);
  return parts.length ? parts.join(" · ") : "no tone";
}
/** A repeater's mode: NFM where HearHam says so; else by the region's band plan, told roughly by longitude: NFM in
 * IARU Region 1 (Europe, Africa, the Middle East: 12.5 kHz channels), wide FM elsewhere (20-25 kHz). */
export const repeaterMode = (m: number, lon: number): "NFM" | "FM" => (m === MODE_NFM || (lon >= -30 && lon < 60) ? "NFM" : "FM");

/** A data set's result for the library's place and radius (not an earlier place's while the new one loads). */
function current(d: Sites): Near | null {
  const p = library.place;
  const n = d.near;
  return p && n && n.key === Sites.key(p.lat, p.lon, library.radius) ? n : null;
}

/** Near me's kinds: repeaters, licensed sites ("Business & public"), airports; the sidebar's order. */
export type Kind = "lic" | "air" | "rpt";
export const KINDS: Kind[] = ["rpt", "lic", "air"];
/** v2 (Oct 31, 2026): repeaters joined the default, so the choices kept before start over once. */
const KINDS_KEY = "ferrite.nearme.kinds.v2";
/** Licensed sites' categories in the order they show: public safety first, Business (the long tail) last. */
export const CAT_ORDER = [CAT_PUBLIC_SAFETY, ...CATEGORIES.map((_, k) => k).filter((k) => k !== CAT_PUBLIC_SAFETY && k !== CAT_BUSINESS), CAT_BUSINESS];
const CATS_KEY = "ferrite.nearme.catsoff";
function loadCatsOff(): Set<number> {
  try {
    const v = localStorage.getItem(CATS_KEY);
    if (v) return new Set((JSON.parse(v) as unknown[]).filter((x): x is number => typeof x === "number"));
  } catch {
    /* no storage, or not JSON: the default */
  }
  return new Set([CAT_BUSINESS]);
}
function loadKinds(): Set<Kind> {
  try {
    const v = localStorage.getItem(KINDS_KEY);
    if (v) {
      const k = (JSON.parse(v) as unknown[]).filter((x): x is Kind => KINDS.includes(x as Kind));
      if (k.length) return new Set(k);
    }
  } catch {
    /* no storage, or not JSON: the default */
  }
  return new Set(["rpt", "lic"]);
}

class Nearby {
  /** The kinds Near me shows, on the map and in the list (the sidebar's switches). */
  #kinds = $state<Set<Kind>>(loadKinds());
  get kinds(): ReadonlySet<Kind> {
    return this.#kinds;
  }
  /** Switch a kind on or off; the last one on stays on. */
  setKind(k: Kind, on: boolean) {
    const n = new Set(this.#kinds);
    if (on) n.add(k);
    else if (n.size > 1) n.delete(k);
    else return;
    this.#kinds = n;
    try {
      localStorage.setItem(KINDS_KEY, JSON.stringify(KINDS.filter((x) => n.has(x))));
    } catch {
      /* not kept: fine */
    }
  }
  toggleKind(k: Kind) {
    this.setKind(k, !this.#kinds.has(k));
  }
  /** Licensed sites' categories switched off (Business to start: over half the rows, most of the map's noise). */
  #catsOff = $state<Set<number>>(loadCatsOff());
  get catsOff(): ReadonlySet<number> {
    return this.#catsOff;
  }
  toggleCat(k: number) {
    const n = new Set(this.#catsOff);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    this.#catsOff = n;
    try {
      localStorage.setItem(CATS_KEY, JSON.stringify([...n]));
    } catch {
      /* not kept: fine */
    }
  }
  showLic = $derived(this.#kinds.has("lic"));
  showAir = $derived(this.#kinds.has("air"));
  showRpt = $derived(this.#kinds.has("rpt"));
  /** More than one kind shows (the list heads each kind). */
  multi = $derived(this.#kinds.size > 1);

  /** The search, shared by the list and the map: an organization, licensee or category name, an airport or its
   * frequency's use, a repeater's callsign, or the start of the MHz. It narrows what shows; picks stay picked. */
  query = $state("");
  #q = $derived(this.query.trim().toLowerCase());
  /** A licensed entry or row the search keeps. */
  matchSite = (e: { group: string; name: string; k: number; f: number }) => {
    const q = this.#q;
    return !q || e.group.toLowerCase().includes(q) || e.name.toLowerCase().includes(q) || !!CATEGORIES[e.k]?.toLowerCase().includes(q) || mhz(e.f).startsWith(q);
  };
  /** An airport frequency the search keeps (its airport's code, its use, or the start of the MHz). */
  matchAirport = (code: string, type: string, khz: number) => {
    const q = this.#q;
    return !q || code.toLowerCase().includes(q) || type.toLowerCase().includes(q) || (khz / 1000).toFixed(3).startsWith(q);
  };
  /** A repeater frequency the search keeps (its callsign, or the start of the MHz). */
  matchRepeater = (call: string, f: number) => {
    const q = this.#q;
    return !q || call.toLowerCase().includes(q) || mhz(f).startsWith(q);
  };

  picks = $state<Set<string>>(new Set());
  /** Licensed sites: RX only (other licensees' channels), the mode for an unknown one. */
  rxOnly = $state(true);
  mode = $state<"NFM" | "FM">("NFM");
  /** Airports: also the common airband frequencies (the fixed Airband set). */
  common = $state(false);
  target = $state<Target>({ kind: "each", name: "Near me", existing: 0 });
  /** Licensed sites' sources on or off (Canada, the US): the map and the list. */
  layers = $state<Record<string, boolean>>({ tafl: true, fcc: true });

  siteResult = $derived(current(sites));
  airportResult = $derived(current(airportSites));
  repeaterResult = $derived(current(repeaterSites));

  /** Licensed sites near the place, nearest first: the entries (one per organization and frequency) and the rows (one
   * per licensee and frequency). Digital only is left out: Ferrite has no digital modes (the data leaves it out too). */
  #sites = $derived.by((): { entries: SiteEntry[]; rows: SiteRow[]; capped: boolean } => {
    const d = this.siteResult;
    const p = library.place;
    if (!d || !p) return { entries: [], rows: [], capped: false };
    const all = near(p, library.radius, d.coords, SITE_CAP);
    const hits = all.filter(({ i }) => d.sites[i].m !== MODE_DIGITAL);
    // Each category's licensees, grouped as organizations.
    const names = new Map<number, Set<string>>();
    for (const { i } of hits) {
      const r = d.sites[i];
      let s = names.get(r.k);
      if (!s) names.set(r.k, (s = new Set()));
      s.add(r.name);
    }
    const org = new Map<string, string>();
    for (const [k, s] of names) {
      const list = [...s];
      orgGroups(list).forEach((g, j) => org.set(`${k}|${list[j]}`, g));
    }
    const entries = new Map<string, SiteEntry>();
    const rows = new Map<string, SiteRow>();
    for (const { i, km } of hits) {
      const r = d.sites[i];
      const group = org.get(`${r.k}|${r.name}`) ?? r.name;
      const key = `s|${r.k}|${group}|${r.f}`;
      const e = entries.get(key);
      if (e) e.sites++;
      else entries.set(key, { key, src: r.src, name: r.name, f: r.f, m: r.m, mobile: r.mobile, km, group, k: r.k, sites: 1, pos: [r.lat, r.lon] });
      const rk = `${r.name}|${r.f}`;
      if (!rows.has(rk)) rows.set(rk, { key, src: r.src, name: r.name, f: r.f, m: r.m, mobile: r.mobile, km, group, k: r.k, pos: [r.lat, r.lon] });
    }
    return { entries: [...entries.values()], rows: [...rows.values()], capped: all.length >= SITE_CAP };
  });
  siteAll = $derived(this.#sites.entries);
  /** The circle holds more licensed rows than a lookup keeps: only the nearest show. */
  siteCapped = $derived(this.#sites.capped);
  siteRows = $derived(this.#sites.rows);
  /** The entries the list shows: a source switched off goes too. */
  siteShown = $derived(this.siteAll.filter((e) => this.layers[e.src] !== false && !this.#catsOff.has(e.k)));
  /** Each category's entries near the place (its sources switched on), shown or not: the sidebar's counts. */
  catCounts = $derived.by(() => {
    const n = new Map<number, number>();
    for (const e of this.siteAll) if (this.layers[e.src] !== false) n.set(e.k, (n.get(e.k) ?? 0) + 1);
    return n;
  });

  /** Airports near the place (rows are one per frequency: here by name and position, frequencies in order). */
  airports = $derived.by((): Airport[] => {
    const p = library.place;
    const rows = this.airportResult?.sites ?? [];
    if (!p) return [];
    const by = new Map<string, Omit<Airport, "km">>();
    for (const r of rows) {
      const key = `${r.name}|${r.lat}|${r.lon}`;
      let a = by.get(key);
      if (!a) by.set(key, (a = { key, c: r.name, l: [r.lat, r.lon], freqs: [] }));
      const khz = r.f / 2;
      a.freqs.push({ key: `a|${key}|${khz}`, khz, type: airportType(r.type, Math.round(khz)) });
    }
    const list = [...by.values()];
    for (const a of list) a.freqs.sort((x, y) => x.khz - y.khz);
    const coords = new Float64Array(list.length * 2);
    list.forEach((a, i) => {
      coords[2 * i] = a.l[0];
      coords[2 * i + 1] = a.l[1];
    });
    return near(p, library.radius, coords, AIRPORT_CAP).map(({ i, km }) => ({ ...list[i], km }));
  });

  /** Repeaters near the place, nearest first (rows are one per frequency: here by callsign and position, frequencies
   * in order). */
  repeaters = $derived.by((): Repeater[] => {
    const p = library.place;
    const rows = this.repeaterResult?.sites ?? [];
    if (!p) return [];
    const by = new Map<string, Omit<Repeater, "km">>();
    for (const r of rows) {
      const key = `r|${r.name}|${r.lat}|${r.lon}`;
      let a = by.get(key);
      if (!a) by.set(key, (a = { key, c: r.name, l: [r.lat, r.lon], freqs: [] }));
      a.freqs.push({ key: `${key}|${r.f}`, f: r.f, d: r.d, te: r.te, td: r.td, m: r.m });
    }
    const list = [...by.values()];
    for (const a of list) a.freqs.sort((x, y) => x.f - y.f);
    const coords = new Float64Array(list.length * 2);
    list.forEach((a, i) => {
      coords[2 * i] = a.l[0];
      coords[2 * i + 1] = a.l[1];
    });
    return near(p, library.radius, coords, REPEATER_CAP).map(({ i, km }) => ({ ...list[i], km }));
  });

  /** The fixed set of airband frequencies not tied to one airport. */
  commonSet = $derived<FixedSet | undefined>(library.fixed?.find((s) => s.name === "Airband"));

  /** The picks Add takes: only those of the kinds (and sources) shown. */
  pickedSites = $derived(this.showLic ? this.siteShown.filter((e) => this.picks.has(e.key)) : []);
  pickedAirports = $derived(
    this.showAir ? this.airports.map((a) => ({ a, freqs: a.freqs.filter((q) => this.picks.has(q.key)) })).filter((x) => x.freqs.length) : [],
  );
  pickedRepeaters = $derived(
    this.showRpt ? this.repeaters.map((r) => ({ r, freqs: r.freqs.filter((q) => this.picks.has(q.key)) })).filter((x) => x.freqs.length) : [],
  );
  nCommon = $derived(this.showAir && this.common ? (this.commonSet?.frequencies.length ?? 0) : 0);
  /** Picks near the place that Add leaves out because their kind or source is hidden. */
  nHidden = $derived.by(() => {
    const sites = this.siteAll.filter((e) => this.picks.has(e.key)).length - this.pickedSites.length;
    let air = 0;
    for (const a of this.airports) for (const q of a.freqs) if (this.picks.has(q.key)) air++;
    for (const x of this.pickedAirports) air -= x.freqs.length;
    let rpt = 0;
    for (const r of this.repeaters) for (const q of r.freqs) if (this.picks.has(q.key)) rpt++;
    for (const x of this.pickedRepeaters) rpt -= x.freqs.length;
    return sites + air + rpt;
  });

  /** The channels Add makes from the picks (shown as its count). */
  items = $derived.by((): LibraryItem[] => {
    const zones = channels.table.zones;
    const t = this.target;
    const items: LibraryItem[] = [];
    // Licensed: one channel per zone and frequency, the licensees sharing it named on the first.
    const byZf = new Map<string, { e: SiteEntry; more: number; zone: string }>();
    for (const e of this.pickedSites) {
      const zone = zoneName(t, e.group, zones);
      const k = `${zone}|${e.f}`;
      const was = byZf.get(k);
      if (was) was.more++;
      else byZf.set(k, { e, more: 0, zone });
    }
    for (const { e, more, zone } of byZf.values()) {
      items.push({
        name: more ? `${e.name.slice(0, 12).trimEnd()} +${more}` : e.name,
        rx: e.f / 2000,
        mode: e.m === MODE_NFM ? "NFM" : e.m === MODE_FM ? "FM" : this.mode,
        power: "Low",
        rx_only: this.rxOnly,
        zone,
        pos: e.pos, // the site's licensed position (LINK-53: the channel's)
      });
    }
    // Airports: AM, RX only (Ferrite never transmits on airband); a type twice at one airport gets its frequency.
    for (const { a, freqs } of this.pickedAirports) {
      const seen = new Map<string, number>();
      for (const q of a.freqs) seen.set(q.type, (seen.get(q.type) ?? 0) + 1);
      for (const q of freqs) {
        items.push({
          name: airportName(a.c, q.type, Math.round(q.khz), (seen.get(q.type) ?? 0) > 1),
          rx: q.khz / 1000,
          mode: "AM",
          power: "Low",
          rx_only: true,
          zone: zoneName(t, a.c, zones),
          pos: a.l, // the airport's position (LINK-53: the channel's)
        });
      }
    }
    // Repeaters: TX on the input (the offset), the tone to send and the one it sends (none: no tone squelch).
    for (const { r, freqs } of this.pickedRepeaters) {
      for (const q of freqs) {
        items.push({
          name: r.c,
          rx: q.f / 2000,
          tx: (q.f + q.d) / 2000,
          mode: repeaterMode(q.m, r.l[1]),
          power: "Low",
          rx_only: false,
          zone: zoneName(t, "Repeaters", zones),
          tone: q.te ? toneWord(q.te) : null,
          rx_tone: q.td ? toneWord(q.td) : "off",
          pos: r.l, // the repeater's position (LINK-53: the channel's)
        });
      }
    }
    if (this.common && this.commonSet) {
      const set = $state.snapshot(this.commonSet) as FixedSet;
      items.push(...libraryFixedItems(set, set.frequencies.map((_, i) => i), zoneName(t, "Airband", zones)));
    }
    return items;
  });

  has(key: string) {
    return this.picks.has(key);
  }
  set(keys: string[], on: boolean) {
    const n = new Set(this.picks);
    for (const k of keys) {
      if (on) n.add(k);
      else n.delete(k);
    }
    this.picks = n;
  }
  toggle(key: string) {
    this.set([key], !this.picks.has(key));
  }
  clear() {
    this.picks = new Set();
  }

  /** Every pick shown (and the common set) into the table; those picks then clear (hidden ones stay). */
  add() {
    const s = this.pickedSites.length;
    const a = this.pickedAirports;
    const r = this.pickedRepeaters;
    const what = [
      s ? `licensed sites (${s} ${s === 1 ? "licence" : "licences"})` : "",
      a.length === 1 ? a[0].a.c : a.length ? `${a.length} airports` : "",
      this.nCommon && !a.length ? "common airband frequencies" : "",
      r.length === 1 ? r[0].r.c : r.length ? `${r.length} repeaters` : "",
    ].filter(Boolean);
    library.add($state.snapshot(this.items) as LibraryItem[], what.join(", "));
    this.set(
      [...this.pickedSites.map((e) => e.key), ...a.flatMap((x) => x.freqs.map((q) => q.key)), ...r.flatMap((x) => x.freqs.map((q) => q.key))],
      false,
    );
    if (this.nCommon) this.common = false;
  }
}

export const nearby = new Nearby();
