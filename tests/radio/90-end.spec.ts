// Stage 90: the radio ends as it began. Asked over Bluetooth, with Console gone from the cable: the same firmware,
// the same channel, zone and preset numbers, and the settings record byte for byte (setup.ts's start.json).
import { byteDiff, expect, startSnapshot, test } from "./radio";

test("the radio holds what it held before the run", async ({ oracle }) => {
  const was = startSnapshot();
  const h = await oracle.hello();
  expect(`${h.firmware} ${h.build}`).toBe(`${was.firmware} ${was.build}`);
  expect(await oracle.used("channel")).toEqual(was.channels);
  expect(await oracle.used("zone")).toEqual(was.zones);
  expect(await oracle.used("preset")).toEqual(was.presets);
  expect(byteDiff(was.settings, await oracle.settings())).toEqual([]);
});
