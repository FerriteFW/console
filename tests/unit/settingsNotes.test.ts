// src/lib/settingsNotes.ts: Radio Settings' reasons on the read-only rows (LINK-5, LINK-7, TX-48.2) and the rows that
// link to the page that edits them (range presets, MENU 0 1 4 and 0 1 5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { present, RADIO_ONLY, readonlyReason } from "../../src/lib/settingsNotes.ts";
import type { SettingItem, SettingsGroup } from "../../src/lib/core.ts";

const item = (path: string, name: string, kind: SettingItem["kind"] = "readonly", note = RADIO_ONLY): SettingItem => ({
  id: path,
  path,
  name,
  sub: "",
  help: "",
  value: "x",
  changed: false,
  kind,
  choices: [],
  hint: "",
  note: kind === "readonly" ? note : "",
});

test("each deliberate read-only setting says why, in one line", () => {
  const why = (name: string) => readonlyReason({ name, note: RADIO_ONLY });
  assert.match(why("Region"), /for safety/);
  assert.match(why("Extend TX"), /for safety/);
  assert.match(why("PIN lock"), /PIN never goes over the link/);
  assert.match(why("Change PIN"), /PIN never goes over the link/);
  assert.match(why("Cable port"), /cut this connection/);
  assert.match(why("KISS TNC"), /cut this connection/);
  for (const n of ["Region", "Extend TX", "PIN lock", "Cable port", "KISS TNC", "Channel-only mode"]) assert.ok(!why(n).includes("\n") && why(n).length < 110, n);
  // Another note (not read, a region rule) stays the core's.
  assert.equal(readonlyReason({ name: "Battery Save", note: "not read from the radio" }), "not read from the radio");
});

test("0 1 4 and 0 1 5 link to the range presets; Dry TX says what it is", () => {
  const groups: SettingsGroup[] = [
    { path: "0 1", name: "Watch and scan", items: [item("0 1 2", "Resume", "pick"), item("0 1 6", "Advanced", "pick")], note: "Shown on the radio only: Range presets, Skip list." },
    { path: "0 8", name: "Transmit", items: [item("0 8 8 4", "Extend TX")], note: "Shown on the radio only: Dry TX." },
    { path: "0 9", name: "System", items: [item("0 9 4", "Region")], note: "Shown on the radio only: SSB patch, About, Calibration." },
  ];
  const [scan, tx, sys] = present(groups, 4);
  assert.deepEqual(scan.items.map((i) => i.path), ["0 1 2", "0 1 4", "0 1 5", "0 1 6"]);
  assert.equal(scan.note, "");
  const p = scan.items[1];
  assert.equal(p.kind, "link");
  assert.equal(p.href, "#/channels?tab=presets");
  assert.equal(p.value, "Edit 4 presets");
  assert.equal(scan.items[2].href, "#/channels?tab=presets");
  assert.deepEqual(tx.items.map((i) => [i.path, i.kind]), [["", "link"], ["0 8 8 4", "readonly"], ["0 8 8 5", "readonly"]]);
  assert.equal(tx.items[0].href, "#/settings-dtmf");
  assert.equal(tx.items[0].value, "Edit them", "DTMF memories not read");
  assert.equal(present(groups, 4, 2)[1].items[0].value, "Edit 2 memories");
  // After the dialer's own settings, under their heading.
  const dial: SettingsGroup[] = [{ path: "0 8", name: "Transmit", items: [{ ...item("0 8 5 3", "Speed", "pick"), sub: "DTMF" }, item("0 8 8 4", "Extend TX")], note: "" }];
  assert.deepEqual(present(dial, null)[0].items.map((i) => [i.name, i.sub]), [["Speed", "DTMF"], ["DTMF memories", "DTMF"], ["Extend TX", ""]]);
  assert.match(tx.items[2].note, /only the radio turns it off/);
  assert.match(tx.items[1].note, /for safety/);
  assert.equal(sys.note, "Shown on the radio only: SSB patch, About, Calibration.");
  assert.match(present(groups, null)[0].items[1].value, /^Edit/);
});
