// Stage 90: the radio ends as it began. Asked over Bluetooth, with Console gone from the cable: the same firmware,
// the same channel, zone and preset numbers, and the settings record byte for byte (setup.ts's start.json). After a
// stock round (stage 85 restored the settings) the PIN's bytes may differ: a settings write keeps the radio's PIN
// (LINK-26), so a reinstalled radio has its own until the owner sets it again; they're printed, not failed.
import { existsSync } from "node:fs";
import { byteDiff, expect, restoredMark, startSnapshot, test } from "./radio";

/** The settings record's PIN (pin_mode, pin, pin_len, pin_misses, pin_wait: ferrite-app persist.rs's order). */
const PIN_BYTES = [80, 87];

test("the radio holds what it held before the run", async ({ oracle }) => {
  const was = startSnapshot();
  const h = await oracle.hello();
  expect(`${h.firmware} ${h.build}`).toBe(`${was.firmware} ${was.build}`);
  expect(await oracle.used("channel")).toEqual(was.channels);
  expect(await oracle.used("zone")).toEqual(was.zones);
  expect(await oracle.used("preset")).toEqual(was.presets);
  let diff = byteDiff(was.settings, await oracle.settings());
  if (existsSync(restoredMark())) {
    const pin = diff.filter((d) => { const at = Number(d.split(":")[0]); return at >= PIN_BYTES[0] && at <= PIN_BYTES[1]; });
    if (pin.length) console.log(`after the stock round, the PIN's bytes are the radio's own (LINK-26): ${pin.join(", ")}`);
    diff = diff.filter((d) => !pin.includes(d));
  }
  expect(diff).toEqual([]);
});
