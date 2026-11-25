// src/lib/prewrite.ts (LINK-21.2, console#43): the read a write makes first is kept in memory, the newest few per
// kind, as .ferrite parts (what Put the radio back loads and Save this backup… saves); keeping one writes no file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { KEEP, Prewrite } from "../../src/lib/prewrite.ts";

test("LINK-21.2: a write's read is kept, the newest per kind found, with its parts as read", () => {
  const p = new Prewrite();
  const at = new Date(2026, 10, 25, 1, 41, 10);
  const s = p.keep("settings", { settings: '{"format":"ferrite-console-settings"}' }, "Cable", at);
  const c = p.keep("channels", { channels: "{}", presets: "{}" }, "Cable");
  assert.equal(p.newest("settings"), s);
  assert.equal(p.newest("channels"), c);
  assert.equal(p.newest("aprs"), null);
  assert.deepEqual(s.parts, { settings: '{"format":"ferrite-console-settings"}' });
  assert.equal(s.at, at);
  assert.equal(s.radio, "Cable");
  assert.equal(p.get(c.id), c);
});

test("LINK-21.2: a later write's read is the newest; only KEEP per kind stay, other kinds untouched", () => {
  const p = new Prewrite();
  const other = p.keep("quick", { quick: "q" }, "BT");
  const ids = Array.from({ length: KEEP + 2 }, (_, i) => p.keep("settings", { settings: `s${i}` }, "Cable").id);
  assert.equal(p.newest("settings")!.parts.settings, `s${KEEP + 1}`);
  const kept = p.all().filter((k) => k.kind === "settings");
  assert.equal(kept.length, KEEP);
  assert.deepEqual(
    kept.map((k) => k.id),
    ids.slice(-KEEP),
  );
  assert.equal(p.newest("quick"), other);
  assert.equal(p.get(ids[0]), null);
});

test("LINK-21.2: keeping a read downloads nothing (no DOM touched)", () => {
  // No window or document in Node: keep() must not reach for either (the old backup made an <a download>).
  const g = globalThis as unknown as { document?: unknown; window?: unknown };
  assert.equal(g.document, undefined);
  assert.equal(g.window, undefined);
  const p = new Prewrite();
  assert.doesNotThrow(() => p.keep("waypoints", { waypoints: "w" }, "Cable"));
});
