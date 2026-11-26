// Stage 85 (only after a stock round, stages 60-70): the run's backup back on the radio, as a user restoring after a
// reinstall: everything.ferrite (stage 50) opened on Radio Settings and written, then on Channels & Zones and written.
// The radio answers over Bluetooth again (its Bluetooth setting is back), and stage 90 checks it holds what it began
// with.
import { type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { connect, disconnect, openConsole, shot } from "../e2e/helpers";
import { everythingFile, expect, startSnapshot, stockRound, test } from "./radio";

test.skip(!stockRound(), "only after Back to stock and Install: FERRITE_RADIO_FLASH=1 FERRITE_RADIO_STOCK=1");
test.setTimeout(15 * 60_000);

/** The open page's Write to radio…: the backup kept, every change written, read back. */
async function writeAll(page: Page, holds: string) {
  const dialog = page.getByRole("dialog");
  await page.getByRole("button", { name: /^Write to radio/ }).click();
  await expect(dialog).toContainText("Backup kept in Console until it closes", { timeout: 180_000 });
  await dialog.getByRole("button", { name: /^Write \d+ changes?$/ }).click();
  await expect(dialog).toContainText(`Read back: the radio holds ${holds}`, { timeout: 600_000 });
  await dialog.getByRole("button", { name: "Close" }).click();
}

test("restore: the run's backup written back, settings then channels", async ({ page, oracle }, info) => {
  expect(existsSync(everythingFile()), "stage 50's backup").toBe(true);
  await openConsole(page, "settings");
  await connect(page, 60_000);
  // A fresh Ferrite on stock's data may first ask to finish setting up its storage: that's for Alex, by hand.
  await expect(page.getByRole("alert", { name: "Finish the update" })).toHaveCount(0);
  await page.getByRole("button", { name: "Read from radio" }).click();
  await expect(page.getByRole("button", { name: "Read from radio" })).toBeEnabled({ timeout: 120_000 });
  await page.locator('input[type=file][accept^=".json"]').setInputFiles(everythingFile());
  await expect(page.getByText(/^Loaded .*\.ferrite/)).toBeVisible();
  await writeAll(page, "these settings");
  await shot(page, info, "85-restore-settings");

  await page.getByRole("link", { name: /^Channels & Zones/ }).click();
  const toolbar = page.getByRole("toolbar", { name: "Channels" });
  await toolbar.getByRole("button", { name: "Read from radio" }).click();
  const drop = page.getByRole("button", { name: "Read and discard" });
  if (await drop.isVisible()) await drop.click();
  await expect(toolbar.getByRole("button", { name: "Read from radio" })).toBeEnabled({ timeout: 180_000 });
  await page.locator('input[type=file][accept^=".json"]').setInputFiles(everythingFile());
  await expect(page.locator(".toast", { hasText: "Loaded" })).toBeVisible({ timeout: 30_000 });
  await writeAll(page, "the table");
  await shot(page, info, "86-restore-channels");
  await disconnect(page);

  // Bluetooth is back on with the settings: the radio answers for itself.
  oracle.restart();
  expect(await oracle.used("channel")).toEqual(startSnapshot().channels);
});
