// Decision 385: a radio whose HELLO says another link protocol (Ferrite 0.8.4 says 3) is only updated. The bridge's
// test hook makes the simulator's HELLO answers say 3 until REBOOT; Console keeps the connection, says the radio's
// Ferrite is too old, offers nothing but Firmware › Update, and the update through the fake bootloader brings it
// back as a usual connection. Never on a radio.
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { connect, disconnect, expect, onRadio, openConsole, shot, state, test } from "./helpers";

test.skip(onRadio(), "the HELLO hook and the fake bootloader run on the simulator only");
test.afterEach(async ({ page }) => {
  await page.keyboard.press("Escape");
  await disconnect(page);
});

const modeFile = () => process.env.FERRITE_E2E_FAKEBOOT ?? "";

/** A tiny Ferrite-looking image packed as tools/btf.py packs (as firmware.spec.ts's). */
function testBtf(kb = 16): Buffer {
  const img = Buffer.alloc(kb * 1024 - 1024 - 100);
  for (let i = 0; i < img.length; i++) img[i] = (i * 7 + 3) & 0xff;
  img.writeUInt32LE(0x20018000, 0);
  img.writeUInt32LE(0x08003201, 4);
  img.write("RT-950      ", 0x3e0, "latin1");
  img.write("RT-950      ", 0x7e0, "latin1");
  img.write("Ferrite terminal", 0x900, "latin1");
  img.write("\0v9.8.7\0", 0xa00, "latin1");
  const raw = Buffer.concat([img.subarray(0, 0x400), Buffer.alloc(0x400), img.subarray(0x400)]);
  return Buffer.concat([raw, Buffer.alloc((1024 - (raw.length % 1024)) % 1024, 0xff)]);
}

test("protocol: an old radio is only updated, then connects as usual", async ({ page }, info) => {
  writeFileSync(modeFile(), JSON.stringify({ deaf_ms: 300 }));
  const result = join(dirname(modeFile()), "mode.result.json");
  if (existsSync(result)) rmSync(result);
  await openConsole(page, "live");
  // The hook is for the bridge's next session: set from this one, then connect again.
  await connect(page);
  expect(await page.evaluate(() => (window as any).ferrite.radio.bridgeControl({ hello_protocol: 3 }))).toBe(true);
  await disconnect(page);

  await page.getByRole("button", { name: "Bridge", exact: true }).click();
  const why = page.getByRole("alert", { name: "Update needed" });
  await expect(why).toContainText("too old for this Console", { timeout: 20_000 });
  await expect(why.getByRole("link", { name: "Update the radio" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText(/Bridge.*: update the radio/);
  // Nothing but the update: no Live View, no records' link, no INFO.
  expect(await state(page, (f) => [f.radio.phase, f.radio.hello?.protocol, f.radio.connectedLink, f.radio.info, f.radio.ui])).toEqual([
    "outdated",
    3,
    null,
    null,
    null,
  ]);
  await page.goto(page.url().replace(/#.*$/, "#/channels"));
  await expect(page.getByRole("button", { name: "Read from radio" })).toBeDisabled();
  await shot(page, info, "70-protocol-outdated");

  await why.getByRole("link", { name: "Update the radio" }).click();
  await page.getByLabel("Firmware file").setInputFiles({ name: "ferrite-test.btf", mimeType: "application/octet-stream", buffer: testBtf() });
  await page.getByRole("button", { name: /^(Update|Install again)…$/ }).click();
  const w = page.getByRole("dialog", { name: "Update Ferrite" });
  await expect(w.locator('[data-k="now"]')).toHaveText(/^v?\d+\.\d+\.\d+/);
  await w.getByRole("button", { name: "Update", exact: true }).click();
  await expect(page.getByRole("region", { name: "Update done" })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole("status")).toContainText("Connected: Bridge");
  await expect(page.getByRole("alert", { name: "Update needed" })).toHaveCount(0);
  expect(await state(page, (f) => [f.radio.phase, f.radio.hello?.protocol])).toEqual(["connected", 1]);
});
