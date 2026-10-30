// Channel positions (CHAN-2, LINK-53) through src/lib/core.ts's wrappers over the wasm core: typed as degrees or a
// grid square, shown to five decimals with the grid square, and as LINK-53's 8-byte records (0 bytes clears).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initSync } from "../../src/core-wasm/core.js";
import { parsePosition, positionFromRecord, positionRecord, positionView } from "../../src/lib/core.ts";

initSync({ module: readFileSync(new URL("../../src/core-wasm/core_bg.wasm", import.meta.url)) });

test("typed as degrees or a grid square, shown to five decimals with the grid square", () => {
  const p = parsePosition("45.4215, -75.6972");
  assert.deepEqual(p, { pos: [45.4215, -75.6972], text: "45.42150, -75.69720", grid: "FN25dk" });
  assert.deepEqual(parsePosition("45.4215,-75.6972").pos, [45.4215, -75.6972]);
  assert.deepEqual(parsePosition("45.42153272870819, -75.69718564455287").pos, [45.4215327, -75.6971856], "a map's copy, rounded to 1e-7");
  const g = parsePosition("fn25dk");
  assert.equal(g.grid, "FN25dk");
  assert.equal(g.text, "45.43750, -75.70833");
  assert.deepEqual(parsePosition(""), { pos: null, text: "", grid: "" });
  assert.deepEqual(parsePosition("none").pos, null);
  assert.throws(() => parsePosition("91, 0"), /latitude is -90 to 90/);
  assert.throws(() => parsePosition("FN2"), /grid square/);
  assert.equal(positionView([49.35, -123.07]).grid, "CN89li");
  assert.deepEqual(positionView(null), { pos: null, text: "", grid: "" });
});

test("LINK-53 records: 8 bytes little-endian in 1e-7 degree, 0 bytes to clear", () => {
  const r = positionRecord([45.4215, -75.6972]);
  assert.equal(r.length, 8);
  const d = new DataView(r.buffer, r.byteOffset, 8);
  assert.deepEqual([d.getInt32(0, true), d.getInt32(4, true)], [454215000, -756972000]);
  assert.deepEqual(positionFromRecord(r), [45.4215, -75.6972]);
  assert.equal(positionRecord(null).length, 0);
  assert.equal(positionFromRecord(new Uint8Array(7)), null);
});
