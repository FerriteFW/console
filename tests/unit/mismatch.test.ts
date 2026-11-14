// src/lib/mismatch.ts: a radio on another link protocol (decision 385) is only updated; which side is behind.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mismatch } from "../../src/lib/mismatch.ts";

test("mismatch: none on the same protocol", () => {
  assert.equal(mismatch(1, 1, "0.8.5", "0.8.5"), null);
});

test("mismatch: Ferrite 0.8.4 (protocol 3) is too old for a protocol 1 Console", () => {
  const m = mismatch(3, 1, "0.8.4", "0.8.5")!;
  assert.equal(m.radioOld, true);
  assert.match(m.text, /Ferrite 0\.8\.4, too old for this Console/);
  assert.match(m.text, /Update the radio/);
});

test("mismatch: a newer radio asks for a newer Console", () => {
  const m = mismatch(2, 1, "0.9.1", "0.8.5")!;
  assert.equal(m.radioOld, false);
  assert.match(m.text, /Update Console/);
});

test("mismatch: versions that don't tell (dev builds, same number) blame the radio", () => {
  assert.equal(mismatch(3, 1, "0.8.4", "0.8.4")!.radioOld, true);
  assert.equal(mismatch(3, 1, "0.8.4-dirty", "dev")!.radioOld, true);
  assert.match(mismatch(3, 1, "", "dev")!.text, /Ferrite unknown/);
});
