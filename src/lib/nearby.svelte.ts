// Add channels "near a place": the rows Airports and Licensed sites show (List) and the "near me" map shows (Map),
// and the one set of picks both views share. Picks are per frequency: a licensed entry (`s|name|half kHz`, its
// nearest site) or an airport's frequency (`a|ICAO|lat|lon|kHz`). Add turns every pick into channels, each layer
// shaped its own way: licensed sites NFM or FM from the data (digital and unknown as the "unknown mode" choice), RX
// only by choice, merged per zone and frequency; airports AM, RX only always, named "CYVR TWR" (airportName); both
// with their positions (LINK-53) and the zone target.
import { library, type FixedSet } from "./library.svelte";
import { channels } from "./channels.svelte";
import { airportSites, sites, Sites, type Near } from "./sites.svelte";
import { MODE_DIGITAL, MODE_FM, MODE_NFM } from "./sitedata";
import { airportName, airportType, libraryFixedItems, near, taflGroups, type LibraryItem } from "./core";
import { zoneName, type Target } from "./components/library/ZoneTarget.svelte";

export type SiteEntry = { key: string; src: string; name: string; f: number; m: number; mobile: boolean; km: number; group: string; pos: [number, number] };
export type AirportFreq = { key: string; khz: number; type: string };
export type Airport = { key: string; c: string; l: [number, number]; km: number; freqs: AirportFreq[] };

/** Half kHz to MHz, 4 decimals (a trailing 0 dropped). */
export const mhz = (f: number) => (f / 2000).toFixed(4).replace(/0$/, "");
export const modeLabel = (m: number) => (m === MODE_NFM ? "NFM" : m === MODE_FM ? "FM" : m === MODE_DIGITAL ? "Digital" : "Mode ?");
export const MOBILE = "A mobile's frequency: often a repeater's input, or the centre of a mobile area";

/** A data set's result for the library's place and radius (not an earlier place's while the new one loads). */
function current(d: Sites): Near | null {
  const p = library.place;
  const n = d.near;
  return p && n && n.key === Sites.key(p.lat, p.lon, library.radius) ? n : null;
}

class Nearby {
  picks = $state<Set<string>>(new Set());
  /** Licensed sites: RX only (other licensees' channels), digital only shown, the mode for an unknown one. */
  rxOnly = $state(true);
  digital = $state(false);
  mode = $state<"NFM" | "FM">("NFM");
  /** Airports: also the common airband frequencies (the fixed Airband set). */
  common = $state(false);
  target = $state<Target>({ kind: "each", name: "Near me", existing: 0 });
  /** The map's layers on or off, by source. */
  layers = $state<Record<string, boolean>>({ tafl: true, fcc: true, airports: true });

  siteResult = $derived(current(sites));
  airportResult = $derived(current(airportSites));

  /** Licensed entries near the place, one per name and frequency (the nearest), grouped; digital ones too. */
  siteAll = $derived.by((): SiteEntry[] => {
    const d = this.siteResult;
    const p = library.place;
    if (!d || !p) return [];
    const seen = new Set<string>();
    const out: Omit<SiteEntry, "group">[] = [];
    for (const { i, km } of near(p, library.radius, d.coords, 5000)) {
      const r = d.sites[i];
      const key = `s|${r.name}|${r.f}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, src: r.src, name: r.name, f: r.f, m: r.m, mobile: r.mobile, km, pos: [r.lat, r.lon] });
    }
    const groups = taflGroups(out.map((e) => e.name));
    return out.map((e, k) => ({ ...e, group: groups[k] }));
  });
  nDigital = $derived(this.siteAll.filter((e) => e.m === MODE_DIGITAL).length);
  /** What shows: digital only hidden unless asked for. */
  siteEntries = $derived(this.digital ? this.siteAll : this.siteAll.filter((e) => e.m !== MODE_DIGITAL));

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
    return near(p, library.radius, coords, 300).map(({ i, km }) => ({ ...list[i], km }));
  });

  /** The fixed set of airband frequencies not tied to one airport. */
  commonSet = $derived<FixedSet | undefined>(library.fixed?.find((s) => s.name === "Airband"));

  pickedSites = $derived(this.siteEntries.filter((e) => this.picks.has(e.key)));
  pickedAirports = $derived(
    this.airports.map((a) => ({ a, freqs: a.freqs.filter((q) => this.picks.has(q.key)) })).filter((x) => x.freqs.length),
  );
  nCommon = $derived(this.common ? (this.commonSet?.frequencies.length ?? 0) : 0);

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

  /** Every pick (and the common set) into the table; the picks then clear. */
  add() {
    const s = this.pickedSites.length;
    const a = this.pickedAirports;
    const what = [
      s ? `licensed sites (${s} ${s === 1 ? "licence" : "licences"})` : "",
      a.length === 1 ? a[0].a.c : a.length ? `${a.length} airports` : "",
      this.nCommon && !a.length ? "common airband frequencies" : "",
    ].filter(Boolean);
    library.add($state.snapshot(this.items) as LibraryItem[], what.join(", "));
    this.picks = new Set();
    this.common = false;
  }
}

export const nearby = new Nearby();
