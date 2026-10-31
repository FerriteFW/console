// src/lib/sitedata.ts (licensed sites and airports from data.ferritefw.dev): the columnar decode, grid squares, the
// tiles a circle touches (across a square's edge, a split square's subsquares, airports' level-2 fields), and the
// client over a fake server and cache (tests/e2e/fixtures/sitedata): cached tiles, a newer build offered not fetched,
// a failed source, the offline zip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createZip } from "../../src/lib/zip.ts";
import { MODE_UNKNOWN, SiteData, decodeTile, gridSquare, sha256Hex, tileSites, tilesFor, type Store, type TopIndex } from "../../src/lib/sitedata.ts";

const FIX = new URL("../e2e/fixtures/sitedata/", import.meta.url);
const BASE = "https://data.test";

test("decode: running sums from 0; degrees, half kHz, modes, mobile, categories", () => {
  const t = decodeTile({ n: ["a", "b"], c: [1, 0, 0], a: [4919000, 500, 0], o: [-12320000, 2000, -10], f: [313600, 4910, -2], m: [0, 1, 2], s: [0, 1, 0], k: [0, 4, 1] });
  assert.deepEqual([...t.lat], [49.19, 49.195, 49.195]);
  assert.deepEqual([...t.lon], [-123.2, -123.18, -123.1801]);
  assert.deepEqual([...t.f], [313600, 318510, 318508]);
  const s = tileSites("tafl", t);
  assert.deepEqual(s[1], { src: "tafl", name: "a", lat: 49.195, lon: -123.18, f: 318510, m: 1, mobile: true, type: "", k: 4 });
  assert.equal(s[0].name, "b");
  // `s` and `k` missing: every row 0.
  assert.deepEqual([...decodeTile({ n: ["x"], c: [0], a: [1], o: [1], f: [1], m: [3] }).s], [0]);
  assert.deepEqual([...decodeTile({ n: ["x"], c: [0], a: [1], o: [1], f: [1], m: [3] }).k], [0]);
  assert.throws(() => decodeTile({ n: ["x"], c: [0], a: [1], o: [1], f: [1], k: [0, 1] }), /column k/);
  assert.throws(() => decodeTile({ n: [], c: [0, 0], a: [1], o: [1, 1], f: [1, 1], m: [0, 0] }), /column a/);
});

test("decode: airports: no modes (unknown), uses from tn/t, -1 none", () => {
  const t = decodeTile({ n: ["CYVR"], c: [0, 0, 0], a: [4919000, 0, 0], o: [-12318000, 0, 0], f: [237400, 2600, 1], tn: ["TWR", "GND"], t: [0, 1, -1] });
  const s = tileSites("airports", t);
  assert.deepEqual(s.map((x) => [x.f / 2000, x.type, x.m]), [
    [118.7, "TWR", MODE_UNKNOWN],
    [120.0, "GND", MODE_UNKNOWN],
    [120.0005, "", MODE_UNKNOWN],
  ]);
  assert.throws(() => decodeTile({ n: ["x"], c: [0], a: [1], o: [1], f: [1], tn: ["TWR"], t: [0, 0] }), /column t/);
});

test("grid squares, 2, 4 and 6 characters", () => {
  assert.equal(gridSquare(49.1947, -123.1792, 2), "CN");
  assert.equal(gridSquare(45.4215, -75.6972, 2), "FN");
  assert.equal(gridSquare(49.1947, -123.1792), "CN89");
  assert.equal(gridSquare(49.1947, -123.1792, 6), "CN89je");
  assert.equal(gridSquare(45.4215, -75.6972, 6), "FN25dk");
  assert.equal(gridSquare(-33.9, 18.4), "JF96");
});

test("tiles: a small circle in one square; across an edge, both squares", () => {
  const idx = { tiles: { CN89: 1, CN88: 1, CN79: 1, FN25: 1 }, split: [] };
  assert.deepEqual(tilesFor(idx, 49.5, -123.0, 10), ["CN89"]);
  // 49.02 N is 2 km from CN88/CN89's edge (49 N).
  assert.deepEqual(tilesFor(idx, 49.02, -123.0, 10).sort(), ["CN88", "CN89"]);
  // -124 is CN79/CN89's edge; 30 km reaches over it (CN78 has no tile).
  assert.deepEqual(tilesFor(idx, 48.98, -123.9, 30).sort(), ["CN78", "CN79", "CN88", "CN89"].filter((t) => t in idx.tiles).sort());
});

test("tiles: a split square gives its subsquares in the box that exist", () => {
  const idx = { tiles: { CN89je: 6, CN89ke: 1, CN89kf: 1, CN89aa: 1, CN88: 1 }, split: ["CN89"] };
  // 2 km around CN89je's middle: only it.
  assert.deepEqual(tilesFor(idx, 49.1875, -123.2083, 2), ["CN89je"]);
  // 5 km reaches ke (east) and kf (north-east corner region); aa is far away; CN89 itself is never asked for.
  const got = tilesFor(idx, 49.205, -123.17, 5);
  assert.ok(got.includes("CN89je") && got.includes("CN89ke") && got.includes("CN89kf"), got.join());
  assert.ok(!got.includes("CN89aa") && !got.includes("CN89"));
  // 60 km from Vancouver also reaches CN88 (not split).
  assert.ok(tilesFor(idx, 49.1947, -123.1792, 60).includes("CN88"));
});

test("tiles: level 2 (airports): the 2-character fields the box touches", () => {
  const idx = { level: 2, tiles: { CN: 1, CO: 1, DN: 1, FN: 1 }, split: [] };
  // Vancouver, 50 km: CN only (120-140 W, 40-50 N).
  assert.deepEqual(tilesFor(idx, 49.1947, -123.1792, 50), ["CN"]);
  // 49.9 N is 11 km from CN/CO's edge (50 N): both.
  assert.deepEqual(tilesFor(idx, 49.9, -123.0, 20).sort(), ["CN", "CO"]);
  // -120 is CN/DN's edge; 30 km over it reaches DN; CM (south) has no tile.
  assert.deepEqual(tilesFor(idx, 40.1, -120.2, 30).sort(), ["CN", "DN"]);
  // Level 4 names are never asked of a level-2 index.
  assert.deepEqual(tilesFor({ ...idx, tiles: { CN89: 1 } }, 49.1947, -123.1792, 50), []);
});

/** A fake server over the fixtures (with build dates and zips as given) and a Map as the cache. */
function fake(opts: { build?: string; down?: boolean; zips?: Map<string, Uint8Array> } = {}) {
  const asked: string[] = [];
  const fetchFn = (async (u: string) => {
    asked.push(u.slice(BASE.length + 1));
    if (opts.down) throw new TypeError("Failed to fetch");
    const path = u.slice(BASE.length + 1);
    const zip = opts.zips?.get(path);
    if (zip) return new Response(zip.slice());
    let text: string;
    try {
      text = readFileSync(new URL(path, FIX), "utf8");
    } catch {
      return new Response("", { status: 404, statusText: "Not Found" });
    }
    if (opts.build && path.endsWith("/index.json")) text = text.replace(/"build_date":"[^"]*"/, `"build_date":"${opts.build}"`);
    return new Response(text);
  }) as unknown as typeof fetch;
  return { fetchFn, asked };
}
function memStore(): Store & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    match: async (k) => (map.has(k) ? new Response(map.get(k)) : undefined),
    put: async (k, r) => void map.set(k, await r.text()),
    delete: async (k) => map.delete(k),
    keys: async () => [...map.keys()].map((url) => ({ url })),
  };
}

test("client: tiles near Vancouver from both sources; kept in the cache; a newer build is followed", async () => {
  const store = memStore();
  const a = fake();
  const d = new SiteData({ base: BASE, fetch: a.fetchFn, store });
  const r = await d.near(["tafl", "fcc"], 49.1947, -123.1792, 50);
  assert.deepEqual(r.sources, ["tafl", "fcc"]);
  assert.deepEqual(r.failed, []);
  assert.equal(r.sites.length, 11);
  assert.ok(r.sites.some((s) => s.src === "fcc" && s.name === "point roberts" && s.f === 310320));
  assert.deepEqual(a.asked.filter((p) => !p.endsWith("index.json")).sort(), ["fcc/CN88.json", "tafl/CN89je.json", "tafl/CN89ke.json"]);
  assert.ok(store.map.has(`${BASE}/tafl/CN89je.json?build=2026-10-30`));

  // A new session, the server one build on (the site holds only its latest build): not saved whole, so the new
  // index is used, the old build's tiles go, and the new build's are fetched.
  const b = fake({ build: "2026-11-30" });
  const d2 = new SiteData({ base: BASE, fetch: b.fetchFn, store });
  const r2 = await d2.near(["tafl", "fcc"], 49.1947, -123.1792, 50);
  assert.equal(r2.sites.length, 11);
  assert.deepEqual(b.asked.filter((p) => !p.endsWith("index.json")).sort(), ["fcc/CN88.json", "tafl/CN89je.json", "tafl/CN89ke.json"]);
  assert.equal(d2.newer.has("tafl"), false);
  assert.equal((await d2.index("tafl")).build_date, "2026-11-30");
  assert.ok(!store.map.has(`${BASE}/tafl/CN89je.json?build=2026-10-30`));
  assert.ok(store.map.has(`${BASE}/tafl/CN89je.json?build=2026-11-30`));

  // Offline: what's kept still loads; what isn't fails with a clear message, per source.
  const c = fake({ down: true });
  const d3 = new SiteData({ base: BASE, fetch: c.fetchFn, store });
  const r3 = await d3.near(["tafl", "fcc"], 49.1947, -123.1792, 50);
  assert.equal(r3.sites.length, 11);
  const r4 = await d3.near(["tafl", "fcc"], 45.42, -75.7, 20);
  assert.equal(r4.failed.length, 1);
  assert.match(r4.failed[0].error, /Can't reach https:\/\/data\.test/);
});

test("client: nothing kept and offline: each source says why", async () => {
  const d = new SiteData({ base: BASE, fetch: fake({ down: true }).fetchFn, store: null });
  const r = await d.near(["tafl", "fcc"], 49.1947, -123.1792, 50);
  assert.equal(r.sites.length, 0);
  assert.deepEqual(r.failed.map((f) => f.src).sort(), ["fcc", "tafl"]);
});

/** The source's fixture files as its zip, and the top index with its size and SHA-256. */
async function zipOf(src: string) {
  const dir = new URL(`${src}/`, FIX);
  const entries = readdirSync(dir).map((f) => ({ name: `${src}/${f}`, data: readFileSync(new URL(f, dir)) }));
  const zip = new Uint8Array(await (await createZip(entries)).arrayBuffer());
  const top = JSON.parse(readFileSync(new URL("index.json", FIX), "utf8")) as TopIndex;
  const s = top.sources.find((x) => x.source === src)!;
  s.bundle_bytes = zip.length;
  s.bundle_sha256 = await sha256Hex(zip);
  return { zip, top: s };
}

test("download all: checked, unzipped into the cache, then read offline", async () => {
  const { zip, top } = await zipOf("tafl");
  const store = memStore();
  const seen: number[] = [];
  const d = new SiteData({ base: BASE, fetch: fake({ zips: new Map([["tafl.zip", zip]]) }).fetchFn, store });
  await d.downloadAll(top, (p) => seen.push(p.done));
  assert.equal(seen.at(-1), zip.length);
  assert.equal(await d.offline("tafl"), "2026-10-30");
  assert.ok(store.map.has(`${BASE}/tafl/FN25.json?build=2026-10-30`));
  assert.ok(store.map.has(`${BASE}/tafl/index.json`));

  const off = new SiteData({ base: BASE, fetch: fake({ down: true }).fetchFn, store });
  const r = await off.near(["tafl"], 45.42, -75.7, 20);
  assert.deepEqual(r.sites.map((s) => s.name), ["ottawa hydro"]);

  // Saved whole: a newer build on the server is only offered; the saved copy stays in use until Update.
  const later = new SiteData({ base: BASE, fetch: fake({ build: "2026-11-30" }).fetchFn, store });
  assert.equal((await later.index("tafl")).build_date, "2026-10-30");
  assert.equal(later.newer.get("tafl"), "2026-11-30");

  // A damaged download is refused, and what was kept stays.
  const bad = zip.slice();
  bad[40] ^= 0xff;
  const d2 = new SiteData({ base: BASE, fetch: fake({ zips: new Map([["tafl.zip", bad]]) }).fetchFn, store });
  await assert.rejects(d2.downloadAll(top), /checksum/);
  assert.equal(await d2.offline("tafl"), "2026-10-30");
});

test("client: airports (level 2) near Vancouver and Ottawa; saved whole, read offline", async () => {
  const store = memStore();
  const a = fake();
  const d = new SiteData({ base: BASE, fetch: a.fetchFn, store });
  const r = await d.near(["airports"], 49.1947, -123.1792, 50);
  assert.deepEqual(r.failed, []);
  assert.deepEqual(a.asked.filter((p) => !p.endsWith("index.json")), ["airports/CN.json"]);
  const cyvr = r.sites.filter((s) => s.name === "CYVR");
  assert.ok(cyvr.some((s) => s.f === 237400 && s.type === "TWR"), JSON.stringify(cyvr));
  assert.ok(r.sites.every((s) => s.m === MODE_UNKNOWN && s.f >= 216000 && s.f < 274000));

  const { zip, top } = await zipOf("airports");
  const kept = memStore();
  const d2 = new SiteData({ base: BASE, fetch: fake({ zips: new Map([["airports.zip", zip]]) }).fetchFn, store: kept });
  await d2.downloadAll(top);
  assert.ok(kept.map.has(`${BASE}/airports/FN.json?build=2026-10-30`));
  const off = new SiteData({ base: BASE, fetch: fake({ down: true }).fetchFn, store: kept });
  const r2 = await off.near(["airports"], 45.42, -75.7, 30);
  assert.deepEqual([...new Set(r2.sites.map((s) => s.name))], ["CYOW"]);
});
