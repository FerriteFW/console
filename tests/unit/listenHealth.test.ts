// src/lib/listenHealth.ts: the dot by Listen (the radio's dropped blocks and the player's underruns, last 10 s).
import { test } from "node:test";
import assert from "node:assert/strict";
import { audioCounts, Health } from "../../src/lib/listenHealth.ts";

test("audio line: made and dropped read; none without the line", () => {
  assert.deepEqual(audioCounts({ made: 120, dropped: 3, waits: 0, clips: 0, peak: 900, gain: 4 }), { made: 120, dropped: 3 });
  assert.equal(audioCounts(undefined), null);
  assert.equal(audioCounts({ made: 5 }), null);
});

test("health: green with no new drops; amber with drops in the last 10 s, green again after", () => {
  const h = new Health();
  h.add(0, 40, 0); // the first reading is the baseline: old drops don't count
  assert.equal(h.state(0).tone, "ok");
  assert.match(h.state(0).text, /No blocks dropped in the last 10 s/);
  h.add(3000, 52, 0);
  assert.deepEqual(h.state(3000), { tone: "warn", text: "12 blocks dropped in the last 10 s" });
  h.add(6000, 52, 0);
  h.add(9000, 52, 0);
  assert.equal(h.state(9000).tone, "warn");
  h.add(14_000, 52, 0);
  assert.equal(h.state(14_000).tone, "ok");
});

test("health: a radio restart (the count went down) counts what it shows now", () => {
  const h = new Health();
  h.add(0, 100, 0);
  h.add(3000, 2, 0);
  assert.equal(h.recent(3000).dropped, 2);
});

test("health: the player's underruns turn it amber; no radio counts says so", () => {
  const h = new Health();
  h.add(0, null, 0);
  h.add(3000, null, 2);
  const s = h.state(3000);
  assert.equal(s.tone, "warn");
  assert.equal(s.text, "The radio doesn't report its audio counts · 2 gaps in the playback here");
});
