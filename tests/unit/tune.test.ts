// src/lib/tune.ts: Live View's "Tune from map" line for the terminal's `slot` (TERM-35).
import { test } from "node:test";
import assert from "node:assert/strict";
import { activeSlot, slotLine, toneWord, tuneSummary } from "../../src/lib/tune.ts";

test("tune: the active slot from the slot list", () => {
  assert.equal(activeSlot('A  vfo 146.52000 mode=NFM\nB* ch 12 "Club" 145.23000\nC  aprs 144.39000'), "B");
  assert.equal(activeSlot("A* vfo 446.00000"), "A");
  assert.equal(activeSlot("A  vfo 446.00000\nB  vfo 146.52000"), null);
});

test("tune: a repeater's shift and tones, DCS with its N", () => {
  const t = { name: "VE7RPT", hz: 146_940_000, mode: "FM" as const, shiftHz: -600_000, txTone: "100.0", rxTone: toneWord("D023") };
  assert.equal(slotLine("A", t), "slot A vfo 146.94000 fm txtone 100.0 rxtone D023N offset -0.60000");
  assert.equal(tuneSummary("A", t), "Slot A: 146.94 FM −600 kHz, T 100.0 · R D023N");
  assert.equal(slotLine("B", { ...t, hz: 444_100_000, shiftHz: 5_000_000 }), "slot B vfo 444.10000 fm txtone 100.0 rxtone D023N offset +5.00000");
});

test("tune: simplex and airband clear what the slot had", () => {
  const air = { name: "CYVR TWR", hz: 118_700_000, mode: "AM" as const };
  assert.equal(slotLine("C", air), "slot C vfo 118.70000 am txtone off rxtone off offset off");
  assert.equal(tuneSummary("C", air), "Slot C: 118.7 AM");
  assert.equal(slotLine("A", { name: "x", hz: 153_012_500, mode: "NFM" }), "slot A vfo 153.01250 nfm txtone off rxtone off offset off");
});
