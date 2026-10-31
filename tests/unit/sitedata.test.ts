// src/lib/sitedata.ts (licensed sites from data.ferritefw.dev): the columnar decode, grid squares, the tiles a
// circle touches (across a square's edge, a split square's subsquares), and the client over a fake server and cache
// (tests/e2e/fixtures/sitedata): cached tiles, a newer build offered not fetched, a failed source, the offline zip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createZip } from "../../src/lib/zip.ts";
import { SiteData, decodeTile, gridSquare, sha256Hex, tileSites, tilesFor, type Store, type TopIndex } from "../../src/lib/sitedata.ts";

const FIX = new URL("../e2e/fixtures/sitedata/", import.meta.url);
const BASE = "https://data.test";

test("decode: running sums from 0; degrees, half kHz, modes, mobile", () => {
  const t = decodeTile({ n: ["a", "b"], c: [1, 0, 0], a: [4919000, 500, 0], o: [-12320000, 2000, -10], f: [313600, 4910, -2], m: [0, 1, 2], s: [0, 1, 0] });
  assert.deepEqual([...t.lat], [49.19, 49.195, 49.195]);
  assert.deepEqual([...t.lon], [-123.2, -123.18, -123.1801]);
  assert.deepEqual([...t.f], [313600, 318510, 318508]);
  const s = tileSites("tafl", t);
  assert.deepEqual(s[1], { src: "tafl", name: "a", lat: 49.195, lon: -123.18, f: 318510, m: 1, mobile: true });
  assert.equal(s[0].name, "b");
  // `s` missing: every row 0.
  assert.deepEqual([...decodeTile({ n: ["x"], c: [0], a: [1], o: [1], f: [1], m: [3] }).s], [0]);
  assert.throws(() => decodeTile({ n: [], c: [0, 0], a: [1], o: [1, 1], f: [1, 1], m: [0, 0] }), /column a/);
});

test("grid squares, 4 and 6 characters", () => {
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

test("client: tiles near Vancouver from both sources; kept in the cache; a newer build is offered, not fetched", async () => {
  const store = memStore();
  const a = fake();
  const d = new SiteData({ base: BASE, fetch: a.fetchFn, store });
  const r = await d.near(["tafl", "fcc"], 49.1947, -123.1792, 50);
  assert.deepEqual(r.sources, ["tafl", "fcc"]);
  assert.deepEqual(r.failed, []);
  assert.equal(r.sites.length, 8);
  assert.ok(r.sites.some((s) => s.src === "fcc" && s.name === "point roberts" && s.f === 310320));
  assert.deepEqual(a.asked.filter((p) => !p.endsWith("index.json")).sort(), ["fcc/CN88.json", "tafl/CN89je.json", "tafl/CN89ke.json"]);
  assert.ok(store.map.has(`${BASE}/tafl/CN89je.json?build=2026-10-30`));

  // A new session, the server one build on: the kept index and tiles stay in use, the update is only offered.
  const b = fake({ build: "2026-11-30" });
  const d2 = new SiteData({ base: BASE, fetch: b.fetchFn, store });
  const r2 = await d2.near(["tafl", "fcc"], 49.1947, -123.1792, 50);
  assert.equal(r2.sites.length, 8);
  assert.deepEqual(b.asked.sort(), ["fcc/index.json", "tafl/index.json"]);
  assert.equal(d2.newer.get("tafl"), "2026-11-30");
  assert.equal((await d2.index("tafl")).build_date, "2026-10-30");

  // Update: the old tiles go; the next look fetches the new build's.
  await d2.update("tafl");
  assert.ok(![...store.map.keys()].some((k) => k.includes("/tafl/CN89")));
  await d2.near(["tafl"], 49.1947, -123.1792, 50);
  assert.ok(store.map.has(`${BASE}/tafl/CN89je.json?build=2026-11-30`));
  assert.equal(d2.newer.has("tafl"), false);

  // Offline: what's kept still loads; what isn't fails with a clear message, per source.
  const c = fake({ down: true });
  const d3 = new SiteData({ base: BASE, fetch: c.fetchFn, store });
  const r3 = await d3.near(["tafl", "fcc"], 49.1947, -123.1792, 50);
  assert.equal(r3.sites.length, 8);
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

  // A damaged download is refused, and what was kept stays.
  const bad = zip.slice();
  bad[40] ^= 0xff;
  const d2 = new SiteData({ base: BASE, fetch: fake({ zips: new Map([["tafl.zip", bad]]) }).fetchFn, store });
  await assert.rejects(d2.downloadAll(top), /checksum/);
  assert.equal(await d2.offline("tafl"), "2026-10-30");
});
