// Stage 62 (FERRITE_RADIO_NICFW=1, after stage 60 put the radio on stock): the radio as a user coming from nicFW has
// it. nicFW goes on as its users put it on, through the stock bootloader (ferrite's flash.py: stock's own updater's
// nudge restarts it, no power cycle), with stock's menu icons from the radio's .fbin kept in place, as on a radio that
// never had Ferrite. Not Console's part: the stage only sets up stage 70 (Install from nicFW: no SSB patch found)
// and stage 75 (Firmware › Add SSB from stock's .BTF).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ferriteDir, expect, nicfwBtf, nicfwMark, nicfwRound, python, stockMark, test } from "./radio";

test.skip(!nicfwRound(), "the nicFW detour: FERRITE_RADIO_FLASH=1 FERRITE_RADIO_STOCK=1 FERRITE_RADIO_NICFW=1");
test.setTimeout(10 * 60_000);

test("nicFW: the radio as a nicFW user's, stock's menu icons kept", async ({ radio }) => {
  expect(existsSync(stockMark()) && readFileSync(stockMark(), "utf8") !== "installed", "stage 60 put the radio on stock").toBe(true);
  expect(existsSync(nicfwBtf()), `nicFW's image: ${nicfwBtf()}`).toBe(true);
  expect(radio.backup.endsWith(".fbin"), "a .fbin backup (it keeps stock's menu icons)").toBe(true);
  const r = spawnSync(python(), [`${ferriteDir}/tools/flash.py`, "--wait", "120", radio.cable, nicfwBtf(), "--backup", radio.backup], { encoding: "utf8", timeout: 8 * 60_000 });
  const out = `${r.stdout}${r.stderr}`;
  console.log(out.trim().split("\n").slice(-3).join("\n"));
  expect(r.status, out).toBe(0);
  expect(out).toContain(`menu icons: from ${radio.backup}`);
  writeFileSync(nicfwMark(), new Date().toISOString());
});
