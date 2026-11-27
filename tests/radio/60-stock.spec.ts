// Stage 60 (FERRITE_RADIO_STOCK=1 with FERRITE_RADIO_FLASH=1; never on the simulator): Back to stock, as a user
// leaving Ferrite: the radio's own backup (radios.toml's `backup`) and stock's firmware into the Back to stock card.
// Console can't tell the radio from a file called flash.bin, so it asks for the radio's ID: the test types it only
// when the radio's ID is the one radios.toml's `uid` says the backup belongs to. Then the radio runs stock: the Bluetooth check can't talk to it until
// Ferrite is back (stage 70) and its settings restored (stage 85).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { allowUnsigned, shot } from "../e2e/helpers";
import { expect, stockBtf, stockMark, stockRound, test } from "./radio";

test.skip(!stockRound(), "Back to stock flashes the radio: FERRITE_RADIO_FLASH=1 FERRITE_RADIO_STOCK=1");
test.setTimeout(20 * 60_000);

test("back to stock: the radio's backup and stock's firmware, the radio's ID typed", async ({ page, radio, oracle }, info) => {
  expect(existsSync(radio.backup), `the backup radios.toml names: ${radio.backup}`).toBe(true);
  expect(existsSync(stockBtf()), `stock firmware: ${stockBtf()}`).toBe(true);
  oracle.restart(); // the radio leaves Ferrite: the Bluetooth session goes with it

  await page.goto(`/?bridge=${encodeURIComponent(process.env.FERRITE_E2E_BRIDGE!)}#/restore`);
  await page.getByRole("button", { name: "Look around without a radio" }).click();
  const back = page.getByRole("region", { name: "Back to stock", exact: true });
  await back.getByRole("button", { name: "Bridge" }).click();
  await expect(page.locator('[data-k="port"]')).toContainText("Bridge");
  await allowUnsigned(page); // the development build's restorer is local and unsigned (UPD-27)
  await page.getByLabel("Backup file").setInputFiles({ name: basename(radio.backup), mimeType: "application/octet-stream", buffer: readFileSync(radio.backup) });
  await page.getByLabel("Stock firmware for Back to stock").setInputFiles(stockBtf());
  await expect(back.locator('[data-k="restore-block"]')).toHaveCount(0);
  // BACKUP-12.3: a .fbin keeps stock's menu icons, and they go back with it (a .bin has none: the tiles stay blank).
  if (radio.backup.endsWith(".fbin")) await expect(back.locator('[data-k="restore-icons"]')).toContainText("Kept with this backup");
  await shot(page, info, "60-stock-ready");

  await back.getByRole("button", { name: "Back to stock" }).click();
  // Decision 263: a backup Console can't place is refused, nothing written, until the radio's ID is typed.
  const confirm = back.getByRole("group", { name: "Confirm the radio" });
  const asked = await confirm.waitFor({ timeout: 60_000 }).then(() => true, () => false);
  if (asked) {
    await expect(back.getByRole("alert")).toContainText("Nothing was written");
    // The ID the owner wrote down for this backup (radios.toml's `uid`): typed only when the radio's matches it, so
    // the test never talks Console's check out of refusing another radio's backup.
    const shown = ((await confirm.locator("strong.mono").textContent()) ?? "").replaceAll(" ", "").toUpperCase();
    expect(radio.uid, `radios.toml [radios.${radio.name}] uid: this backup's radio ID (About), checked by hand`).toBeTruthy();
    expect(shown, "the radio on the cable is the one the backup is from").toBe(radio.uid.replaceAll(" ", "").toUpperCase());
    await confirm.getByLabel("This radio's ID").fill(shown.toLowerCase());
    await back.getByRole("button", { name: "Back to stock" }).click();
  }
  await expect(page.getByRole("region", { name: "Back on stock" })).toBeVisible({ timeout: 15 * 60_000 });
  writeFileSync(stockMark(), new Date().toISOString());
  await shot(page, info, "61-stock-done");
});
