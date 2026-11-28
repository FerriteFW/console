// src/lib/batteryGuard.ts: the battery check before Update and Back to stock (decision 477, console#127).
import { test } from "node:test";
import assert from "node:assert/strict";
import { batteryAllows, batteryCheck } from "../../src/lib/batteryGuard.ts";

test("UPD-29: 50% and over goes ahead", () => {
  assert.deepEqual(batteryCheck(50, "updating"), { level: "ok", pct: 50 });
  assert.deepEqual(batteryCheck(100, "updating"), { level: "ok", pct: 100 });
  assert.equal(batteryAllows(batteryCheck(80, "updating"), false), true);
});

test("UPD-29: 30% to 49% warns and goes ahead only when asked", () => {
  for (const p of [30, 42, 49]) {
    const c = batteryCheck(p, "updating");
    assert.equal(c.level, "warn", `${p}%`);
    assert.equal(batteryAllows(c, false), false);
    assert.equal(batteryAllows(c, true), true);
  }
  const c = batteryCheck(42, "updating");
  assert.ok("text" in c && c.text.includes("42%") && c.text.includes("50%"));
});

test("UPD-29: below 30% is refused, whatever the owner says", () => {
  for (const p of [0, 25, 29]) {
    const c = batteryCheck(p, "going back to stock");
    assert.equal(c.level, "refuse", `${p}%`);
    assert.equal(batteryAllows(c, true), false);
  }
  const c = batteryCheck(25, "going back to stock");
  assert.ok("text" in c && c.text.includes("25%") && c.text.includes("going back to stock"));
});

test("UPD-29: an unread battery gives the advice and holds nothing", () => {
  for (const p of [null, undefined, NaN]) {
    const c = batteryCheck(p, "updating");
    assert.equal(c.level, "unknown");
    assert.equal(batteryAllows(c, false), true);
  }
});

test("UPD-29: a fraction rounds (29.6 is 30)", () => {
  assert.equal(batteryCheck(29.6, "updating").level, "warn");
  assert.equal(batteryCheck(49.4, "updating").level, "warn");
});
