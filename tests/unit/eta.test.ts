// src/lib/eta.ts: the progress bars' seconds left.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Eta, etaText } from "../../src/lib/eta.ts";

test("eta: nothing at first, then the rate so far", () => {
  const e = new Eta();
  assert.equal(e.left(0, 100, 0), null);
  assert.equal(e.left(10, 100, 1000), null); // under 2 s
  assert.equal(e.left(40, 100, 4000), 6); // 40 in 4 s: 60 more take 6 s
  assert.equal(e.left(100, 100, 10000), null); // done
});

test("eta: a new run starts over", () => {
  const e = new Eta();
  e.left(0, 100, 0);
  e.left(50, 100, 5000);
  assert.equal(e.left(0, 100, 6000), null); // went back
  assert.equal(e.left(20, 100, 10000), 16);
  assert.equal(e.left(5, 200, 11000), null); // a new total
});

test("eta: the text", () => {
  assert.equal(etaText(null), "");
  assert.equal(etaText(42), " · 42 s left");
});
