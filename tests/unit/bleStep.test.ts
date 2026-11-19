// src/lib/bleStep.ts: when Bluetooth at 115200 steps down to 9600 (losses at the edge of range).
import { test } from "node:test";
import assert from "node:assert/strict";
import { LossWatch, SAME_LOSS_MS, WITHIN_MS } from "../../src/lib/bleStep.ts";

test("ble step: one loss alone doesn't step down", () => {
  const w = new LossWatch();
  assert.equal(w.note(1000), false);
});

test("ble step: a loss's own retries (a resync, the gap, the ask again) count once", () => {
  const w = new LossWatch();
  assert.equal(w.note(1000), false);
  assert.equal(w.note(1200), false);
  assert.equal(w.note(1000 + SAME_LOSS_MS - 1), false);
});

test("ble step: two losses within a minute step down", () => {
  const w = new LossWatch();
  assert.equal(w.note(1000), false);
  assert.equal(w.note(9000), true);
});

test("ble step: losses a minute or more apart don't", () => {
  const w = new LossWatch();
  assert.equal(w.note(1000), false);
  assert.equal(w.note(1000 + WITHIN_MS), false);
  assert.equal(w.note(1000 + 2 * WITHIN_MS + 1), false);
});

test("ble step: the log's pattern (a gap every 7-9 s while reading) steps down on the second", () => {
  // A user's Bluetooth debug log (Windows, Nov 18): resync, GAP, read again, about every 8 s.
  const w = new LossWatch();
  const at = [29_154, 29_688, 36_914, 38_328];
  assert.deepEqual(
    at.map((t) => w.note(t)),
    [false, false, true, false], // the fourth is the third's own gap
  );
});

test("ble step: reset starts the count over", () => {
  const w = new LossWatch();
  w.note(1000);
  w.reset();
  assert.equal(w.note(9000), false);
});
