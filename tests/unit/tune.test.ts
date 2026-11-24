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
  // NAM, the airband's narrow AM (ferrite decision 447): the terminal's word is nam.
  const nam = { name: "CYVR TWR", hz: 118_700_000, mode: "NAM" as const };
  assert.equal(slotLine("C", nam), "slot C vfo 118.70000 nam txtone off rxtone off offset off");
  assert.equal(tuneSummary("C", nam), "Slot C: 118.7 NAM");
});

test("recent tunes: newest first, once each, ten at most; storage junk dropped", async () => {
  const { remember, readRecent } = await import("../../src/lib/tune.ts");
  const t = (hz: number, name = "X") => ({ name, hz, mode: "FM" as const });
  let list = [] as ReturnType<typeof t>[];
  for (let i = 0; i < 12; i++) list = remember(list, t(146_000_000 + i * 10_000));
  assert.equal(list.length, 10);
  assert.equal(list[0].hz, 146_110_000);
  list = remember(list, t(146_050_000, "again"));
  assert.equal(list[0].name, "again");
  assert.equal(list.filter((x) => x.hz === 146_050_000).length, 1);
  assert.deepEqual(readRecent('[{"name":"A","hz":146520000,"mode":"FM"},{"hz":-1},"x"]'), [{ name: "A", hz: 146_520_000, mode: "FM" }]);
  assert.deepEqual(readRecent('[{"name":"T","hz":118700000,"mode":"NAM"}]'), [{ name: "T", hz: 118_700_000, mode: "NAM" }]);
  assert.deepEqual(readRecent("not json"), []);
  assert.deepEqual(readRecent(null), []);
});

test("recent tunes: the detail line, and Add as channel's entry (repeater, airport, simplex)", async () => {
  const { tuneDetail, tuneItem, tuneMhz } = await import("../../src/lib/tune.ts");
  const rpt = { name: "VE7RHS", hz: 145_270_000, mode: "FM" as const, shiftHz: -600_000, txTone: "100.0", rxTone: "100.0", kind: "rpt" as const, pos: [49.2, -123.2] as [number, number] };
  assert.equal(tuneMhz(rpt), "145.27");
  assert.equal(tuneDetail(rpt), "FM · −600 kHz · T 100.0 · R 100.0");
  assert.deepEqual(tuneItem(rpt), { name: "VE7RHS", rx: 145.27, tx: 144.67, mode: "FM", power: "Low", rx_only: false, zone: "Repeaters", tone: "100.0", rx_tone: "100.0", pos: [49.2, -123.2] });
  const air = tuneItem({ name: "CYVR TOWER", hz: 118_700_000, mode: "AM", kind: "air" });
  assert.equal(air.rx_only, true);
  assert.equal(air.zone, "Airband");
  assert.equal(air.tx, null);
  const nam = tuneItem({ name: "CYVR TOWER", hz: 118_700_000, mode: "NAM", kind: "air" });
  assert.equal(nam.mode, "NAM");
  assert.equal(nam.rx_only, true);
  assert.equal(tuneItem({ name: "x", hz: 118_700_000, mode: "NAM" }).zone, "Airband");
  const lic = tuneItem({ name: "City Works", hz: 153_950_000, mode: "NFM", kind: "lic" });
  assert.equal(lic.zone, "Near me");
  assert.equal(lic.rx_tone, null);
});
