// Fixed sets by region: data.ferritefw.dev's `fixed/<REGION>.json` (format `fixed-1`, the data repository's
// fixed/README.md): the radio's region's sets, then OTHER's (the same everywhere: international marine, aviation
// emergency, satellites). No Svelte here: tests/unit/fixedsets.test.ts runs it under Node.

export type FixedFreq = {
  /** The bundled list's channel number (its sets only). */
  number?: number;
  name: string;
  rx: number;
  tx: number;
  /** One short line (fixed-1). */
  note?: string;
  /** The bundled list's notes. */
  notes?: string;
  ctcss?: number;
  dcs?: number;
  rxOnly?: boolean;
};
export type Source = { title: string; url: string; date: string };
export type FixedSet = {
  /** fixed-1 only: unique across regions. */
  id?: string;
  name: string;
  displayName?: string;
  description: string;
  /** fixed-1: amateur, licence-free, marine, weather, aviation, rail, emergency, satellite, business. */
  category?: string;
  /** fixed-1: ISO 3166 codes when the set is for only part of the region ("DE", "US-AK"). */
  countries?: string[];
  defaultPower: string;
  defaultBandwidth: string;
  /** "AM" for airband (the core makes it NAM there); else ("Analog") NFM or FM by the bandwidth. */
  defaultMode?: string;
  rxOnly?: boolean;
  source?: Source[];
  frequencies: FixedFreq[];
};
export type Split = { country: string; what: string; sets: string[]; source: Source[] };
export type RegionFile = { format: string; region: string; name: string; built?: string; sets: FixedSet[]; splits: Split[] };

/** The radio's regions in its stored order (settings value 1 + index; 0 is "not set"). */
export const REGIONS = ["US", "CA", "UK", "EU", "AU", "NZ", "JP", "OTHER"] as const;
export type Region = (typeof REGIONS)[number];
export const REGION_NAMES: Record<Region, string> = {
  US: "United States",
  CA: "Canada",
  UK: "United Kingdom",
  EU: "Europe",
  AU: "Australia",
  NZ: "New Zealand",
  JP: "Japan",
  OTHER: "Other",
};
/** As the radio lists them: Canada first, then by name, Other last. */
export const REGION_ORDER: Region[] = ["CA", "AU", "EU", "JP", "NZ", "UK", "US", "OTHER"];
export const FORMAT = "fixed-1";

/** The radio's stored region (Info.region) as a code; null when it isn't set. */
export function radioRegion(n: number | null | undefined): Region | null {
  return n && n >= 1 && n <= REGIONS.length ? REGIONS[n - 1] : null;
}

// CEPT countries the EU file covers (its splits say where one differs).
const EUROPE = new Set(
  "AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IS IT LV LI LT LU MT NL NO PL PT RO SK SI ES SE CH".split(" "),
);

/** A first guess before a radio says: from the browser's language tag ("en-CA", "de-DE", "ja"). */
export function localeRegion(tag: string | undefined): Region {
  const parts = (tag ?? "").split(/[-_]/);
  const lang = parts[0]?.toLowerCase() ?? "";
  const country = parts.slice(1).find((p) => /^[A-Za-z]{2}$/.test(p))?.toUpperCase() ?? "";
  if (country === "US" || country === "CA" || country === "AU" || country === "NZ" || country === "JP") return country;
  if (country === "GB") return "UK";
  if (EUROPE.has(country)) return "EU";
  if (lang === "ja") return "JP";
  if (!country && ["de", "fr", "nl", "it", "es", "sv", "fi", "da", "nb", "nn", "pl", "pt", "cs"].includes(lang)) return "EU";
  return country ? "OTHER" : "US";
}

/** A region file's text, checked: its format and region. Throws when it isn't the one asked for. */
export function parseRegion(text: string, want: Region): RegionFile {
  const d = JSON.parse(text) as RegionFile;
  if (d?.format !== FORMAT) throw new Error(`fixed/${want}.json: format ${d?.format ?? "missing"}, wanted ${FORMAT}`);
  if (d.region !== want || !Array.isArray(d.sets)) throw new Error(`fixed/${want}.json: not ${want}'s sets`);
  return d;
}

/** What the Fixed tab lists: the region's sets, then OTHER's (once, when the region is OTHER). */
export function combine(region: RegionFile, other: RegionFile | null): FixedSet[] {
  return region.region === "OTHER" || !other ? [...region.sets] : [...region.sets, ...other.sets];
}

/** A set's key in lists: its id, else (the bundled list) its name. */
export const setKey = (s: FixedSet) => s.id ?? s.name;

/** The common airband set for Near me's airports: the bundled "Airband", else the region's own aviation set. */
export function airbandSet(sets: FixedSet[] | null | undefined): FixedSet | undefined {
  return sets?.find((s) => s.name === "Airband") ?? sets?.find((s) => s.category === "aviation" && !s.id?.startsWith("other-"));
}

/** The data repository's issue form for fixed sets (its .github/ISSUE_TEMPLATE/fixed-set.yml). */
export const CORRECTIONS = "https://github.com/FerriteFW/data/issues/new?template=fixed-set.yml";

/** The issue form with the region and, when it's about one set, the set filled in (only these: nothing personal). */
export function correctionUrl(region: Region, set?: FixedSet): string {
  const q = new URLSearchParams({ region });
  if (set) {
    q.set("set", setKey(set));
    q.set("title", `Fixed sets: ${set.displayName ?? set.name}`);
  } else q.set("title", `Fixed sets: ${REGION_NAMES[region]}`);
  return `${CORRECTIONS}&${q}`;
}
