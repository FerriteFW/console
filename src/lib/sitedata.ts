/**
 * Licensed sites (Canada's TAFL, the US FCC's ULS) and airports (OurAirports) from the FerriteFW/data repo, published
 * at https://data.ferritefw.dev (its README's "Output" is the format). Each source is tiled by grid square (airports
 * by 2-character field: its index's `level`): a place and radius fetch only the tiles the circle's box touches. Tiles are decoded once and kept in memory, and kept in Cache
 * Storage (the browser's and the Tauri webview's) under their URL plus the source's build date, so the next visit
 * and offline use read them from there. A newer build date is offered as an update, never fetched by itself.
 * "Save for offline" fetches a source's whole zip, checks its SHA-256 and stores every tile.
 *
 * No Svelte here: the unit tests (tests/unit/sitedata.test.ts) run it under Node with a fake fetch and cache.
 */
import { readZip } from "./zip.ts";

/** The data's base URL: VITE_DATA_URL (a local server of data/out for development), else the published site. */
export const DATA_URL: string = ((import.meta as any).env?.VITE_DATA_URL as string | undefined)?.replace(/\/$/, "") || "https://data.ferritefw.dev";

/** A source as the top-level index.json lists it. */
export type TopSource = {
  source: string;
  title: string;
  source_date: string;
  licence: string;
  licence_url: string;
  attribution: string;
  rows: number;
  index: string;
  tiles: number;
  bundle: string;
  bundle_bytes: number;
  bundle_sha256: string;
};
export type TopIndex = { build_date: string; sources: TopSource[] };
/** `<source>/index.json`. */
export type SourceIndex = {
  source: string;
  title: string;
  source_date: string;
  build_date: string;
  licence: string;
  licence_url: string;
  attribution: string;
  format: string;
  /** The tiles' grid size: 2 (fields, `CN`) or 4 (squares, `CN89`, some split into `CN89kg`). 4 when missing. */
  level?: number;
  rows: number;
  tiles: Record<string, number>;
  split: string[];
};
/** A tile as published (`columnar-1`). `m` missing: every row unknown (airports); `tn`/`t`: the uses (airports); `k`
 * missing: every row's category 0 (airports, tiles from before it). */
export type TileJson = { n: string[]; c: number[]; a: number[]; o: number[]; f: number[]; m?: number[]; s?: number[]; tn?: string[]; t?: number[]; k?: number[] };
/** A decoded tile: columns, one entry per row. `f` in half kHz; `t` indexes `types` (-1: none). */
export type Tile = {
  names: string[];
  name: Uint32Array;
  lat: Float64Array;
  lon: Float64Array;
  f: Int32Array;
  m: Uint8Array;
  s: Uint8Array;
  types: string[];
  t: Int16Array;
  k: Uint8Array;
};

/** Modes (`m`): 0 analog FM under 14 kHz, 1 analog FM 16-20 kHz, 2 digital or data only (no longer published), 3 unknown. */
export const MODE_NFM = 0;
export const MODE_FM = 1;
export const MODE_DIGITAL = 2;
export const MODE_UNKNOWN = 3;

/** Categories (`k`), by code: the licensee's kind. */
export const CATEGORIES = ["Business", "Public safety", "Transit", "Utilities", "Marine", "Schools", "Government"] as const;
export const CAT_PUBLIC_SAFETY = 1;

/** One site and frequency (a licensed site's, an airport's). `type`: the frequency's use (airports: "TWR"), or "";
 * `k`: the category (CATEGORIES). */
export type Site = { src: string; name: string; lat: number; lon: number; f: number; m: number; mobile: boolean; type: string; k: number };

/** A tile's columns into rows: running sums of `a`, `o` and `f` from 0. */
export function decodeTile(t: TileJson): Tile {
  const n = t.c.length;
  for (const k of ["a", "o", "f", "m", "s", "t", "k"] as const) {
    const col = t[k];
    if (col && col.length !== n) throw new Error(`Bad tile: column ${k} has ${col.length} rows, not ${n}`);
  }
  const out: Tile = {
    names: t.n,
    name: new Uint32Array(n),
    lat: new Float64Array(n),
    lon: new Float64Array(n),
    f: new Int32Array(n),
    m: new Uint8Array(n),
    s: new Uint8Array(n),
    types: t.tn ?? [],
    t: new Int16Array(n),
    k: new Uint8Array(n),
  };
  let a = 0;
  let o = 0;
  let f = 0;
  for (let i = 0; i < n; i++) {
    a += t.a[i];
    o += t.o[i];
    f += t.f[i];
    out.name[i] = t.c[i];
    out.lat[i] = a / 1e5;
    out.lon[i] = o / 1e5;
    out.f[i] = f;
    out.m[i] = t.m ? t.m[i] : MODE_UNKNOWN;
    out.s[i] = t.s ? t.s[i] : 0;
    out.t[i] = t.t ? t.t[i] : -1;
    out.k[i] = t.k ? t.k[i] : 0;
  }
  return out;
}

/** A tile's rows as sites. */
export function tileSites(src: string, t: Tile): Site[] {
  const out: Site[] = new Array(t.f.length);
  for (let i = 0; i < t.f.length; i++) {
    const ty = t.t[i];
    out[i] = { src, name: t.names[t.name[i]] ?? "", lat: t.lat[i], lon: t.lon[i], f: t.f[i], m: t.m[i], mobile: t.s[i] === 1, type: ty >= 0 ? (t.types[ty] ?? "") : "", k: t.k[i] };
  }
  return out;
}

const A = 65;
const a = 97;

/** The 4-character grid square of a lon cell (0-179, 2 degrees) and lat cell (0-179, 1 degree). */
function square(lonCell: number, latCell: number): string {
  return (
    String.fromCharCode(A + Math.floor(lonCell / 10), A + Math.floor(latCell / 10)) + String(lonCell % 10) + String(latCell % 10)
  );
}

/** The grid square of a place, 2, 4 or 6 characters (`CN`, `CN89`, `CN89kg`). */
export function gridSquare(lat: number, lon: number, chars: 2 | 4 | 6 = 4): string {
  const x = Math.min(Math.max(lon + 180, 0), 359.999999);
  const y = Math.min(Math.max(lat + 90, 0), 179.999999);
  if (chars === 2) return String.fromCharCode(A + Math.floor(x / 20), A + Math.floor(y / 10));
  const sq = square(Math.floor(x / 2), Math.floor(y));
  if (chars === 4) return sq;
  return sq + String.fromCharCode(a + Math.floor((x % 2) * 12), a + Math.floor((y % 1) * 24));
}

/** The box around a circle: [south, west, north, east] in degrees (west > east never: clamped, no wrap). */
export function circleBox(lat: number, lon: number, radiusKm: number): [number, number, number, number] {
  const dlat = radiusKm / 110.574;
  const s = Math.max(lat - dlat, -90);
  const n = Math.min(lat + dlat, 90);
  const widest = Math.max(Math.abs(s), Math.abs(n));
  const cos = Math.cos((Math.min(widest, 89.9) * Math.PI) / 180);
  const dlon = radiusKm / (111.32 * cos);
  if (dlon >= 180) return [s, -180, n, 180];
  return [s, Math.max(lon - dlon, -180), n, Math.min(lon + dlon, 180)];
}

/**
 * The tiles of `index` a circle's box touches. Level 4 (the default): its 4-character squares that have a tile, and
 * for a square in `split`, the 6-character subsquares in the box that have one. Level 2: its 2-character fields
 * (20 by 10 degrees) that have a tile.
 */
export function tilesFor(index: Pick<SourceIndex, "tiles" | "split" | "level">, lat: number, lon: number, radiusKm: number): string[] {
  const [s, w, n, e] = circleBox(lat, lon, radiusKm);
  const split = new Set(index.split ?? []);
  const x0 = w + 180;
  const x1 = Math.min(e + 180, 359.999999);
  const y0 = s + 90;
  const y1 = Math.min(n + 90, 179.999999);
  const out: string[] = [];
  if (index.level === 2) {
    for (let fy = Math.floor(y0 / 10); fy <= Math.floor(y1 / 10); fy++) {
      for (let fx = Math.floor(x0 / 20); fx <= Math.floor(x1 / 20); fx++) {
        const f = String.fromCharCode(A + fx, A + fy);
        if (f in index.tiles) out.push(f);
      }
    }
    return out;
  }
  for (let lc = Math.floor(y0); lc <= Math.floor(y1); lc++) {
    for (let xc = Math.floor(x0 / 2); xc <= Math.floor(x1 / 2); xc++) {
      const sq = square(xc, lc);
      if (!split.has(sq)) {
        if (sq in index.tiles) out.push(sq);
        continue;
      }
      // Subsquares: 1/12 degree of longitude by 1/24 of latitude, clipped to the box.
      const i0 = Math.max(0, Math.floor((x0 - 2 * xc) * 12));
      const i1 = Math.min(23, Math.floor((x1 - 2 * xc) * 12));
      const j0 = Math.max(0, Math.floor((y0 - lc) * 24));
      const j1 = Math.min(23, Math.floor((y1 - lc) * 24));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const sub = sq + String.fromCharCode(a + i, a + j);
          if (sub in index.tiles) out.push(sub);
        }
      }
    }
  }
  return out;
}

/** The SHA-256 of bytes, as hex (Web Crypto). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const view = bytes.buffer instanceof ArrayBuffer ? (bytes as Uint8Array<ArrayBuffer>) : bytes.slice();
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", view));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The part of the Cache Storage API used here (a Cache, or a fake in the tests). */
export type Store = {
  match(key: string): Promise<Response | undefined>;
  put(key: string, r: Response): Promise<void>;
  delete(key: string): Promise<boolean>;
  keys(): Promise<readonly { url: string }[]>;
};

const CACHE_NAME = "ferrite-sitedata";

/** The browser's Cache Storage (also in the Tauri webview), or null where there is none (not a secure context). */
export async function openStore(): Promise<Store | null> {
  try {
    const c = (globalThis as any).caches as CacheStorage | undefined;
    if (!c) return null;
    const cache = await c.open(CACHE_NAME);
    return {
      match: (k) => cache.match(k),
      put: (k, r) => cache.put(k, r),
      delete: (k) => cache.delete(k),
      keys: () => cache.keys(),
    };
  } catch {
    return null;
  }
}

export type Progress = { done: number; total: number };

/** The tiles near a place, per source; with the sources that failed and why. */
export type NearResult = { sites: Site[]; sources: string[]; failed: { src: string; error: string }[] };

/**
 * The data client: indexes, tiles, the cache, updates and offline copies. `fetch` and the store are given, so the
 * tests can run it without a network.
 */
export class SiteData {
  readonly base: string;
  private fetch: typeof fetch;
  private store: Promise<Store | null>;
  private tiles = new Map<string, Promise<Tile>>();
  private indexes = new Map<string, Promise<SourceIndex>>();
  /** Newer build dates seen on the server, per source (the update the UI offers). */
  readonly newer = new Map<string, string>();

  constructor(opts: { base?: string; fetch?: typeof fetch; store?: Store | null } = {}) {
    this.base = (opts.base ?? DATA_URL).replace(/\/$/, "");
    this.fetch = opts.fetch ?? ((...args) => globalThis.fetch(...args));
    this.store = opts.store !== undefined ? Promise.resolve(opts.store) : openStore();
  }

  url(path: string): string {
    return `${this.base}/${path}`;
  }
  private indexKey(src: string) {
    return this.url(`${src}/index.json`);
  }
  private tileKey(src: string, build: string, tile: string) {
    return `${this.url(`${src}/${tile}.json`)}?build=${encodeURIComponent(build)}`;
  }
  private offlineKey(src: string) {
    return this.url(`${src}.zip`);
  }

  private async get(path: string): Promise<Response> {
    let r: Response;
    try {
      r = await this.fetch(this.url(path), { cache: "no-cache" });
    } catch {
      throw new Error(`Can't reach ${this.base} (offline, or not published yet)`);
    }
    if (!r.ok) throw new Error(`${this.url(path)}: ${r.status} ${r.statusText}`.trim());
    return r;
  }

  /** The top-level index (sizes and checksums of the zips): the server's, else the last one seen. */
  async top(): Promise<TopIndex> {
    const store = await this.store;
    const key = this.url("index.json");
    try {
      const text = await (await this.get("index.json")).text();
      const top = JSON.parse(text) as TopIndex;
      await store?.put(key, new Response(text)).catch(() => {});
      return top;
    } catch (e) {
      const hit = await store?.match(key);
      if (hit) return (await hit.json()) as TopIndex;
      throw e;
    }
  }

  /**
   * A source's index. A source saved whole for offline use keeps its saved index (its build date pins the tiles):
   * when the server has a newer build, `newer` says so, and the saved one stays in use until `update`. Any other
   * source follows the server's index (the site holds only the latest build: an older build's tiles are gone), and
   * the tiles kept from an older build are dropped; the kept index serves only when the server can't be reached.
   */
  index(src: string): Promise<SourceIndex> {
    let p = this.indexes.get(src);
    if (!p) {
      p = this.loadIndex(src);
      p.catch(() => this.indexes.delete(src));
      this.indexes.set(src, p);
    }
    return p;
  }

  private async loadIndex(src: string): Promise<SourceIndex> {
    const store = await this.store;
    const hit = await store?.match(this.indexKey(src));
    const kept = hit ? ((await hit.json()) as SourceIndex) : null;
    let server: { text: string; index: SourceIndex } | null = null;
    try {
      const text = await (await this.get(`${src}/index.json`)).text();
      server = { text, index: JSON.parse(text) as SourceIndex };
    } catch (e) {
      if (!kept) throw e;
    }
    if (server && (server.index.format !== "columnar-1" || ![undefined, 2, 4].includes(server.index.level))) {
      if (kept) return kept;
      throw new Error(`${src}: format ${server.index.format} (level ${server.index.level ?? 4}) is newer than this Console reads; update Console`);
    }
    if (kept && (!server || server.index.build_date === kept.build_date)) {
      this.newer.delete(src);
      return kept;
    }
    if (kept && (await this.offline(src)) === kept.build_date) {
      this.newer.set(src, server!.index.build_date);
      return kept;
    }
    this.newer.delete(src);
    await store?.put(this.indexKey(src), new Response(server!.text)).catch(() => {});
    if (kept) await this.dropTiles(src, server!.index.build_date);
    return server!.index;
  }

  /** Drop a source's tiles kept from any build but `build`. */
  private async dropTiles(src: string, build: string) {
    const store = await this.store;
    if (!store) return;
    const dir = this.url(`${src}/`);
    const keep = `?build=${encodeURIComponent(build)}`;
    for (const req of await store.keys()) {
      if (req.url.startsWith(dir) && req.url.includes("?build=") && !req.url.endsWith(keep)) await store.delete(req.url);
    }
  }

  /** A tile: from memory, else the cache, else the server (then kept in the cache). */
  tile(src: string, index: SourceIndex, tile: string): Promise<Tile> {
    const key = this.tileKey(src, index.build_date, tile);
    let p = this.tiles.get(key);
    if (!p) {
      p = this.loadTile(src, key, tile);
      p.catch(() => this.tiles.delete(key));
      this.tiles.set(key, p);
    }
    return p;
  }

  private async loadTile(src: string, key: string, tile: string): Promise<Tile> {
    const store = await this.store;
    const hit = await store?.match(key);
    if (hit) return decodeTile((await hit.json()) as TileJson);
    const text = await (await this.get(`${src}/${tile}.json`)).text();
    const t = decodeTile(JSON.parse(text) as TileJson);
    await store?.put(key, new Response(text)).catch(() => {});
    return t;
  }

  /** The sites of every source in the tiles a circle touches. A source that fails is listed, the others still load. */
  async near(sources: string[], lat: number, lon: number, radiusKm: number): Promise<NearResult> {
    const res: NearResult = { sites: [], sources: [], failed: [] };
    await Promise.all(
      sources.map(async (src) => {
        try {
          const index = await this.index(src);
          const names = tilesFor(index, lat, lon, radiusKm);
          const tiles = await Promise.all(names.map((t) => this.tile(src, index, t)));
          if (tiles.length) res.sources.push(src);
          for (const t of tiles) for (const s of tileSites(src, t)) res.sites.push(s);
        } catch (e) {
          res.failed.push({ src, error: (e as Error).message });
        }
      }),
    );
    res.sources.sort((x, y) => sources.indexOf(x) - sources.indexOf(y));
    return res;
  }

  /** The build date of the source's offline copy, if it was saved whole. */
  async offline(src: string): Promise<string | null> {
    const hit = await (await this.store)?.match(this.offlineKey(src));
    return hit ? hit.text() : null;
  }

  /** Whether there is somewhere to keep an offline copy. */
  async canKeep(): Promise<boolean> {
    return !!(await this.store);
  }

  /**
   * Save a whole source for offline use: its zip (`top`'s size and SHA-256), checked, unzipped, every tile and the
   * index into the cache. Replaces what the cache held for the source, so it also applies an update.
   */
  async downloadAll(top: TopSource, progress: (p: Progress) => void = () => {}): Promise<void> {
    const store = await this.store;
    if (!store) throw new Error("This browser can't keep data (no Cache Storage)");
    const src = top.source;
    const r = await this.get(top.bundle);
    const total = top.bundle_bytes || Number(r.headers.get("Content-Length") ?? 0);
    const parts: Uint8Array[] = [];
    let done = 0;
    if (r.body) {
      const reader = r.body.getReader();
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        parts.push(value);
        done += value.length;
        progress({ done, total });
      }
    } else {
      parts.push(new Uint8Array(await r.arrayBuffer()));
      done = parts[0].length;
    }
    const zip = new Uint8Array(done);
    let at = 0;
    for (const p of parts) {
      zip.set(p, at);
      at += p.length;
    }
    if (top.bundle_bytes && zip.length !== top.bundle_bytes) throw new Error(`${top.bundle}: ${zip.length} bytes, not ${top.bundle_bytes}`);
    if ((await sha256Hex(zip)) !== top.bundle_sha256.toLowerCase()) throw new Error(`${top.bundle}: the checksum doesn't match (a damaged download)`);
    const files = await readZip(zip);
    const dec = new TextDecoder();
    const indexBytes = files.get(`${src}/index.json`);
    if (!indexBytes) throw new Error(`${top.bundle}: no ${src}/index.json inside`);
    const indexText = dec.decode(indexBytes);
    const index = JSON.parse(indexText) as SourceIndex;
    await this.forget(src);
    for (const [name, bytes] of files) {
      const m = name.match(/^([^/]+)\/([A-Za-z]{2}(?:\d{2}(?:[a-x]{2})?)?)\.json$/);
      if (!m || m[1] !== src) continue;
      await store.put(this.tileKey(src, index.build_date, m[2]), new Response(dec.decode(bytes)));
    }
    await store.put(this.indexKey(src), new Response(indexText));
    await store.put(this.offlineKey(src), new Response(index.build_date));
    this.indexes.set(src, Promise.resolve(index));
    this.newer.delete(src);
  }

  /** Take the server's newer build: drop the source's kept tiles (they load again as needed) and its index. */
  async update(src: string): Promise<void> {
    await this.forget(src);
    this.indexes.delete(src);
    this.newer.delete(src);
  }

  /** Drop everything kept for a source, in memory and in the cache. */
  private async forget(src: string): Promise<void> {
    const prefix = this.url(`${src}/`);
    for (const k of [...this.tiles.keys()]) if (k.startsWith(prefix)) this.tiles.delete(k);
    const store = await this.store;
    if (!store) return;
    for (const req of await store.keys()) if (req.url.startsWith(prefix)) await store.delete(req.url);
    await store.delete(this.offlineKey(src));
  }
}
