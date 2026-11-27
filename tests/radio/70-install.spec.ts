// Stage 70 (after stage 60 put the radio on stock): Install, as a new user does it. The Install wizard connects,
// loads its reader and backs up the whole radio (about 4 minutes), the backup is saved (kept in the run folder),
// then Ferrite goes on: the image FERRITE_RADIO_INSTALL_IMAGE, else the one Update uses (tx-bench: Dry TX on at
// power-on). Done: Console is connected to Ferrite as usual. The radio's channels and settings are stock's until
// stage 85 writes the run's backup back.
import { type Locator } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allowUnsigned, noSaveDialog, shot } from "../e2e/helpers";
import { expect, ferriteDir, nicfwMark, runDir, stockMark, stockRound, test, updateImage } from "./radio";

test.skip(!stockRound(), "Install follows Back to stock: FERRITE_RADIO_FLASH=1 FERRITE_RADIO_STOCK=1");
test.setTimeout(45 * 60_000);

test("install from stock: back up the whole radio, save it, install Ferrite", async ({ page }, info) => {
  expect(existsSync(stockMark()) && readFileSync(stockMark(), "utf8") !== "installed", "stage 60 put the radio on stock").toBe(true);
  const image = process.env.FERRITE_RADIO_INSTALL_IMAGE ?? updateImage();
  expect(existsSync(image), `the image to install: ${image}`).toBe(true);

  await noSaveDialog(page); // the backup is saved as a download the test keeps
  await page.goto(`/?bridge=${encodeURIComponent(process.env.FERRITE_E2E_BRIDGE!)}#install`);
  const wizard = page.getByRole("dialog", { name: "Install Ferrite" });
  await expect(wizard.getByRole("heading", { name: "Install Ferrite" })).toBeVisible();
  await allowUnsigned(page);
  await page.getByLabel("Ferrite file").setInputFiles(image); // the Install tab's Advanced: a file, not the bundled release
  // A development build of Console bundles no reader (the image that reads the flash for the backup): the one
  // FERRITE_RADIO_READER names, else ferrite's own (tools/mkbtf.sh reader), under the same Advanced.
  const reader = process.env.FERRITE_RADIO_READER ?? join(ferriteDir, "target", "ferrite-reader.btf");
  expect(existsSync(reader), `the reader image: ${reader} (tools/mkbtf.sh reader in ferrite)`).toBe(true);
  await page.getByLabel("Reader file").setInputFiles(reader);
  await expect(wizard.getByText("no reader image")).toHaveCount(0);
  await wizard.getByRole("button", { name: "Bridge" }).click();
  await expect(page.locator('[data-k="port"]')).toContainText("Bridge");
  await shot(page, info, "70-install-connected");

  // A radio that doesn't answer stock's updater nudge (nicFW) needs its bootloader by hand: Console waits a minute,
  // then says "No answer from the bootloader" with Try again. The owner power-cycles and tries again; so does this,
  // saying so loudly each time, until `done` shows (at most five tries).
  const PROMPT = "\n>>> Power-cycle the radio into its bootloader now: off, hold the two lower side keys, on.\n";
  async function byHand(done: Locator, ms: number) {
    const again = wizard.getByRole("button", { name: "Try again" });
    let told = false;
    for (let tries = 0, end = Date.now() + ms; Date.now() < end; ) {
      if (await done.isVisible()) return;
      const waiting = await wizard.getByText("Waiting for the bootloader").isVisible().catch(() => false);
      if (waiting && !told) console.log(PROMPT);
      told = waiting;
      if (await again.isVisible().catch(() => false)) {
        expect(++tries, "the bootloader answered within five tries").toBeLessThanOrEqual(5);
        console.log(`${PROMPT}(try ${tries + 1}: Console probes for a minute from now)`);
        await again.click();
        told = true;
      }
      await page.waitForTimeout(1000);
    }
    await expect(done).toBeVisible();
  }
  await wizard.getByRole("button", { name: "Back up the radio" }).click();
  const save = wizard.getByRole("button", { name: "Save the backup…" });
  await byHand(save, 15 * 60_000);
  await expect(wizard.locator('[data-k="verified"]')).toContainText("matches the radio's");
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 120_000 }), save.click()]);
  expect(dl.suggestedFilename()).toMatch(/^rt950pro-backup-[0-9A-Z]{20}-\d{8}-\d{6}(-[A-Z0-9]{4})?\.fbin$/);
  await dl.saveAs(join(runDir, dl.suggestedFilename()));
  await wizard.getByRole("button", { name: "I have saved it" }).click();
  await expect(wizard.locator('[data-k="saved"]')).toContainText("saved");
  await shot(page, info, "71-install-backed-up");
  // INST-10.1 (decision 457): stock's image carries the SSB patch and the backup takes it from the radio; nicFW's
  // doesn't, so Ferrite installs without it (stage 75 adds it from stock's .BTF).
  const ssb = wizard.locator('[data-k="ssb"]');
  if (existsSync(nicfwMark())) await expect(ssb).toContainText("No SSB patch found on the radio");
  else await expect(ssb).toContainText("Found the SSB patch on the radio");

  await wizard.getByRole("button", { name: "Install Ferrite" }).click();
  const done = page.getByRole("region", { name: "Installed" });
  await byHand(done, 20 * 60_000);
  await expect(done).toContainText("The radio runs Ferrite v", { timeout: 15 * 60_000 });
  await expect(done).toContainText("connected to it as usual", { timeout: 60_000 });
  writeFileSync(stockMark(), "installed"); // Ferrite again, on stock's data until stage 85 restores the run's
  await shot(page, info, "72-install-done");
});
