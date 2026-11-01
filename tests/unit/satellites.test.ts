// Satellite mode in Console (SAT-9, SAT-15, SAT-18): sats.json through the data client (fetched, kept in the cache,
// the kept copy used when the server can't be reached), the elements' age colours and the declination's text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SiteData, type Store } from "../../src/lib/sitedata.ts";
import { ageDays, ageLevel, declText } from "../../src/lib/satage.ts";

const BASE = "https://data.test";
const FILE = readFileSync(new URL("../e2e/fixtures/satellites/sats.json", import.meta.url), "utf8");

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

test("SAT-15: sats.json from the server, kept for offline use; the kept copy when the server is down", async () => {
  const store = memStore();
  const asked: string[] = [];
  let down = false;
  const fetchFn = (async (u: string) => {
    asked.push(u);
    if (down) throw new TypeError("Failed to fetch");
    return u === `${BASE}/satellites/sats.json` ? new Response(FILE) : new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  const d = new SiteData({ base: BASE, fetch: fetchFn, store });
  const a = await d.sats();
  assert.equal(a.kept, false);
  assert.equal(JSON.parse(a.text).format, "satellites-1");
  assert.deepEqual(asked, [`${BASE}/satellites/sats.json`]);
  assert.ok(store.map.has(`${BASE}/satellites/sats.json`));
  down = true;
  const b = await d.sats();
  assert.equal(b.kept, true);
  assert.equal(b.text, a.text);
  // Nothing kept and no server: the error says so.
  await assert.rejects(new SiteData({ base: BASE, fetch: fetchFn, store: memStore() }).sats(), /Can't reach/);
});

test("SAT-9: the elements' age: amber past 7 days (3 for the ISS), red past 30", () => {
  const now = 1_793_541_600;
  const d = (days: number) => now - days * 86400;
  assert.equal(ageLevel(27607, d(7), now), 0);
  assert.equal(ageLevel(27607, d(7.5), now), 1);
  assert.equal(ageLevel(25544, d(3.5), now), 1, "the ISS");
  assert.equal(ageLevel(25544, d(3), now), 0);
  assert.equal(ageLevel(27607, d(31), now), 2);
  assert.equal(ageLevel(27607, now + 3600, now), 0, "an epoch ahead of the clock");
  assert.equal(ageDays(d(2.9), now), 2);
});

test("SAT-18: the declination as text, east positive", () => {
  assert.equal(declText(156), "15.6° E");
  assert.equal(declText(-130), "13.0° W");
  assert.equal(declText(0), "0.0° E");
  assert.equal(declText(null), "none");
});
