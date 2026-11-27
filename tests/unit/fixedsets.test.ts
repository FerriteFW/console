// Fixed sets by region (data.ferritefw.dev's fixed/): the radio's region code, the language guess, a region file
// through the data client (kept for offline use), and the list the Fixed tab shows (the region's sets, then OTHER's).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SiteData, type Store } from "../../src/lib/sitedata.ts";
import { airbandSet, combine, correctionUrl, localeRegion, parseRegion, radioRegion, setKey } from "../../src/lib/fixedsets.ts";

const BASE = "https://data.test";
const fixture = (r: string) => readFileSync(new URL(`../e2e/fixtures/sitedata/fixed/${r}.json`, import.meta.url), "utf8");

function memStore(): Store {
  const map = new Map<string, string>();
  return {
    match: async (k) => (map.has(k) ? new Response(map.get(k)) : undefined),
    put: async (k, r) => void map.set(k, await r.text()),
    delete: async (k) => map.delete(k),
    keys: async () => [...map.keys()].map((url) => ({ url })),
  };
}

test("the radio's stored region: 1-8 in the radio's order, 0 not set", () => {
  assert.equal(radioRegion(1), "US");
  assert.equal(radioRegion(2), "CA");
  assert.equal(radioRegion(8), "OTHER");
  assert.equal(radioRegion(0), null);
  assert.equal(radioRegion(9), null);
  assert.equal(radioRegion(undefined), null);
});

test("a first guess from the browser's language", () => {
  assert.equal(localeRegion("en-CA"), "CA");
  assert.equal(localeRegion("fr-CA"), "CA");
  assert.equal(localeRegion("en-GB"), "UK");
  assert.equal(localeRegion("de-DE"), "EU");
  assert.equal(localeRegion("de"), "EU");
  assert.equal(localeRegion("ja"), "JP");
  assert.equal(localeRegion("en-AU"), "AU");
  assert.equal(localeRegion("pt-BR"), "OTHER");
  assert.equal(localeRegion("en"), "US");
  assert.equal(localeRegion(undefined), "US");
});

test("a region file: checked, then the region's sets before OTHER's", () => {
  const us = parseRegion(fixture("US"), "US");
  const other = parseRegion(fixture("OTHER"), "OTHER");
  assert.throws(() => parseRegion(fixture("US"), "CA"), /not CA/);
  assert.throws(() => parseRegion('{"format":"fixed-9","region":"US","sets":[]}', "US"), /format/);
  const sets = combine(us, other);
  assert.equal(sets.length, us.sets.length + other.sets.length);
  assert.equal(setKey(sets[0]), us.sets[0].id);
  assert.ok(sets.some((s) => s.id === "other-marine-vhf"));
  assert.equal(combine(other, other).length, other.sets.length);
  assert.equal(new Set(sets.map(setKey)).size, sets.length, "ids are unique");
  assert.equal(airbandSet(sets)?.category, "aviation");
  assert.ok(!airbandSet(sets)?.id?.startsWith("other-"), "the region's own airband set, not the emergency one");
  assert.equal(airbandSet([{ name: "Airband", description: "", defaultPower: "Low", defaultBandwidth: "25kHz", frequencies: [] }])?.name, "Airband");
});

test("a region file from the server, kept; the kept copy when the server is down", async () => {
  let down = false;
  const asked: string[] = [];
  const fetchFn = (async (u: string) => {
    asked.push(u);
    if (down) throw new TypeError("Failed to fetch");
    return u === `${BASE}/fixed/US.json` ? new Response(fixture("US")) : new Response("", { status: 404 });
  }) as typeof fetch;
  const client = new SiteData({ base: BASE, fetch: fetchFn, store: memStore() });
  const a = await client.fixed("US");
  assert.equal(a.kept, false);
  assert.deepEqual(asked, [`${BASE}/fixed/US.json`]);
  down = true;
  const b = await client.fixed("US");
  assert.equal(b.kept, true);
  assert.equal(b.text, a.text);
  await assert.rejects(client.fixed("CA"), /Can't reach/);
});

test("the correction link: the issue form with the region and the set filled in", () => {
  const us = parseRegion(fixture("US"), "US");
  const u = new URL(correctionUrl("US", us.sets[0]));
  assert.equal(u.origin + u.pathname, "https://github.com/FerriteFW/data/issues/new");
  assert.equal(u.searchParams.get("template"), "fixed-set.yml");
  assert.equal(u.searchParams.get("region"), "US");
  assert.equal(u.searchParams.get("set"), us.sets[0].id);
  assert.match(u.searchParams.get("title") ?? "", /^Fixed sets: /);
  const r = new URL(correctionUrl("EU"));
  assert.equal(r.searchParams.get("set"), null);
  assert.equal(r.searchParams.get("title"), "Fixed sets: Europe");
});
