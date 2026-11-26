// Stage 80 (FERRITE_RADIO_FLASH=1; never on the simulator): Firmware Update, as a user updating Ferrite: the image
// (FERRITE_RADIO_IMAGE, else ferrite's tx-bench build) into the Firmware page, Update, the wizard's Update. Console
// reboots the radio into its bootloader, sends the image, and connects again. The radio then answers with that build
// over Bluetooth, and nothing it held was lost (when no stock round ran: else stage 85 restores it first).
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { allowUnsigned, connect, openConsole, shot } from "../e2e/helpers";
import { byteDiff, expect, flashing, startSnapshot, stockRound, test, updateImage } from "./radio";

test.skip(!flashing(), "Update flashes the radio: FERRITE_RADIO_FLASH=1");
test.setTimeout(20 * 60_000);

test("update: the image goes on, Console connects again, the radio keeps what it held", async ({ page, oracle }, info) => {
  const image = updateImage();
  expect(existsSync(image), `the update image: ${image} (tools/mkbtf.sh tx-bench in ferrite)`).toBe(true);
  await openConsole(page, "firmware");
  await allowUnsigned(page); // a local build: unsigned (UPD-27)
  await connect(page, 30_000);
  await page.getByLabel("Firmware file").setInputFiles({ name: basename(image), mimeType: "application/octet-stream", buffer: readFileSync(image) });
  await expect(page.locator('[data-k="signature"]')).toHaveText("Not signed: not a Ferrite release");
  await shot(page, info, "80-update-checked");

  const box = page.locator('[data-k="power-cycled"]');
  if (await box.count()) await box.check();
  await page.getByRole("button", { name: /^(Update|Install again)…$/ }).click();
  const wizard = page.getByRole("dialog", { name: "Update Ferrite" });
  await wizard.getByRole("button", { name: "Update", exact: true }).click();
  oracle.restart(); // the radio restarts: a new Bluetooth session after
  const done = page.getByRole("region", { name: "Update done" });
  await expect(done).toBeVisible({ timeout: 15 * 60_000 });
  await expect(page.getByRole("status")).toContainText("Connected: Bridge", { timeout: 60_000 });
  await shot(page, info, "81-update-done");

  // Over Bluetooth (on again once the radio's settings are back: always, unless a stock round left stock's).
  if (stockRound()) return; // stage 85 restores the settings, then stage 90 checks
  const was = startSnapshot();
  const h = await oracle.hello();
  const consoleSays = await page.evaluate(() => (window as any).ferrite.radio.info?.build?.name);
  expect(h.build).toBe(consoleSays);
  expect(await oracle.used("channel")).toEqual(was.channels);
  expect(await oracle.used("zone")).toEqual(was.zones);
  expect(byteDiff(was.settings, await oracle.settings())).toEqual([]);
});
