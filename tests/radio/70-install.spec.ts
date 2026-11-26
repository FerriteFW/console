// Stage 70 (after stage 60 put the radio on stock): Install, as a new user does it. The Install wizard connects,
// loads its reader and backs up the whole radio (about 4 minutes), the backup is saved (kept in the run folder),
// then Ferrite goes on: the image FERRITE_RADIO_INSTALL_IMAGE, else the one Update uses (tx-bench: Dry TX on at
// power-on). Done: Console is connected to Ferrite as usual. The radio's channels and settings are stock's until
// stage 85 writes the run's backup back.
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { allowUnsigned, shot } from "../e2e/helpers";
import { expect, runDir, stockMark, stockRound, test, updateImage } from "./radio";

test.skip(!stockRound(), "Install follows Back to stock: FERRITE_RADIO_FLASH=1 FERRITE_RADIO_STOCK=1");
test.setTimeout(25 * 60_000);

test("install from stock: back up the whole radio, save it, install Ferrite", async ({ page }, info) => {
  expect(existsSync(stockMark()), "stage 60 put the radio on stock").toBe(true);
  const image = process.env.FERRITE_RADIO_INSTALL_IMAGE ?? updateImage();
  expect(existsSync(image), `the image to install: ${image}`).toBe(true);

  await page.goto(`/?bridge=${encodeURIComponent(process.env.FERRITE_E2E_BRIDGE!)}#install`);
  const wizard = page.getByRole("dialog", { name: "Install Ferrite" });
  await expect(wizard.getByRole("heading", { name: "Install Ferrite" })).toBeVisible();
  await allowUnsigned(page);
  await page.getByLabel("Ferrite file").setInputFiles(image); // the Install tab's Advanced: a file, not the bundled release
  await wizard.getByRole("button", { name: "Bridge" }).click();
  await expect(page.locator('[data-k="port"]')).toContainText("Bridge");
  await shot(page, info, "70-install-connected");

  await wizard.getByRole("button", { name: "Back up the radio" }).click();
  const save = wizard.getByRole("button", { name: "Save the backup…" });
  await expect(save).toBeVisible({ timeout: 10 * 60_000 });
  await expect(wizard.locator('[data-k="verified"]')).toContainText("matches the radio's");
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 120_000 }), save.click()]);
  expect(dl.suggestedFilename()).toMatch(/^rt950pro-backup-[0-9A-Z]{20}-\d{8}-\d{6}(-[A-Z0-9]{4})?\.fbin$/);
  await dl.saveAs(join(runDir, dl.suggestedFilename()));
  await wizard.getByRole("button", { name: "I have saved it" }).click();
  await expect(wizard.locator('[data-k="saved"]')).toContainText("saved");
  await shot(page, info, "71-install-backed-up");

  await wizard.getByRole("button", { name: "Install Ferrite" }).click();
  const done = page.getByRole("region", { name: "Installed" });
  await expect(done).toContainText("The radio runs Ferrite v", { timeout: 15 * 60_000 });
  await expect(done).toContainText("connected to it as usual", { timeout: 60_000 });
  rmSync(stockMark());
  await shot(page, info, "72-install-done");
});
