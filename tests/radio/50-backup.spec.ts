// Stage 50: Back up everything. Channels › File › Back up everything… reads the whole radio over the link into one
// .ferrite (channels, zones, presets, settings, APRS settings, lists), kept as the run's everything.ferrite; opened
// again, it matches the radio: nothing to write. After a stock round (stage 60) stage 85 writes it back.
import { copyFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { connect, disconnect, openConsole, shot, state } from "../e2e/helpers";
import { everythingFile, expect, startSnapshot, test } from "./radio";

test("back up everything: one .ferrite with every part; opened again, nothing to write", async ({ page }, info) => {
  const toolbar = page.getByRole("toolbar", { name: "Channels" });
  await openConsole(page, "channels");
  await connect(page, 30_000);
  await toolbar.getByRole("button", { name: /^File/ }).click();
  const dl = page.waitForEvent("download", { timeout: 300_000 });
  await page.getByRole("menuitem", { name: /^Back up everything/ }).click();
  const d = await dl;
  expect(d.suggestedFilename()).toMatch(/\.ferrite$/);
  copyFileSync(await d.path(), everythingFile());
  await expect(page.locator(".toast", { hasText: d.suggestedFilename() })).toBeVisible({ timeout: 60_000 });
  await shot(page, info, "50-backup-everything");

  const { readZip } = await import("../../src/lib/zip");
  const z = await readZip(readFileSync(everythingFile()));
  for (const part of ["channels", "settings", "aprs"]) expect(z.has(`${part}.json`), `${part}.json in the backup`).toBe(true);
  const chans = JSON.parse(new TextDecoder().decode(z.get("channels.json")!));
  const numbers = (chans.channels ?? chans.table?.channels ?? []).map((c: { number: number }) => c.number).sort((a: number, b: number) => a - b);
  expect(numbers).toEqual(startSnapshot().channels);

  // Opened in Console: the channels as the radio holds them, nothing to write.
  await toolbar.getByRole("button", { name: "Read from radio" }).click();
  await expect(toolbar.getByRole("button", { name: "Read from radio" })).toBeEnabled({ timeout: 180_000 });
  await page.locator('input[type=file][accept^=".json"]').setInputFiles(everythingFile());
  await expect(page.locator(".toast", { hasText: "Loaded" })).toBeVisible({ timeout: 30_000 });
  expect(await state(page, (f) => f.channels.pending)).toBe(0);
  await disconnect(page);
});
