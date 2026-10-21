// APRS settings through the bridge (LINK-43): the APRS record as MENU 0 5 shows it, a choice changed, a typed value
// refused with the radio's reason, the write (backup first, the diff, the read back), then the backup restored.
// On a radio the backup is written back even when a step fails.
import { type Page } from "@playwright/test";
import { join } from "node:path";
import { connect, disconnect, expect, onRadio, openConsole, shot, shotsDir, state, test } from "./helpers";

test.describe.configure({ mode: "serial" });

const long = () => (onRadio() ? 120_000 : 30_000);
const POWER = "0 5 5 4 Power";
const FREQ = "0 5 7 1 Frequency";

let page: Page;
let backup: string | null = null;
const dialog = () => page.getByRole("dialog");
const value = (id: string) =>
  page.evaluate((x) => (window as any).ferrite.aprsSettings.view?.items.find((i: any) => i.id === x)?.value as string, id);

async function startWrite() {
  const dl = page.waitForEvent("download", { timeout: long() });
  await page.getByRole("button", { name: "Write to radio…" }).click();
  const d = await dl;
  expect(d.suggestedFilename()).toMatch(/^ferrite-.*-aprs-backup\.json$/);
  const path = join(shotsDir(), `${onRadio() ? "radio" : "sim"}-${d.suggestedFilename()}`);
  await d.saveAs(path);
  await expect(dialog()).toContainText("Backup saved", { timeout: long() });
  return path;
}

async function commitWrite(n: number) {
  await dialog().getByRole("button", { name: `Write ${n} ${n === 1 ? "change" : "changes"}` }).click();
  await expect(dialog()).toContainText("Read back: the radio holds these APRS settings.", { timeout: long() });
  await dialog().getByRole("button", { name: "Close" }).click();
  await expect(dialog()).toHaveCount(0);
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await openConsole(page, "aprs-settings");
  await connect(page);
});

test.afterAll(async () => {
  if (backup) {
    try {
      if (await dialog().count()) await dialog().getByRole("button", { name: /^(Close|Cancel)$/ }).click();
      await page.locator('input[type=file][accept^=".json"]').setInputFiles(backup);
      await startWrite();
      await commitWrite(1);
    } catch (e) {
      console.error(`couldn't put the APRS power back (${backup}): ${(e as Error).message}`);
    }
  }
  await disconnect(page);
  await page.close();
});

test("read: the APRS record as MENU 0 5 shows it", async ({}, info) => {
  await expect.poll(() => state(page, (f) => !!f.aprsSettings.view), { timeout: long() }).toBe(true);
  for (const name of ["My station", "Beacon", "Path", "Radio", "Digipeat"]) await expect(page.getByRole("region", { name })).toBeVisible();
  await expect(page.getByLabel(POWER, { exact: true })).toBeVisible();
  await expect(page.getByLabel(FREQ, { exact: true })).toBeVisible();
  // APRS mode is the settings record's (Radio Settings), not here
  await expect(page.getByLabel("0 5 3 APRS mode", { exact: true })).toHaveCount(0);
  await shot(page, info, "aprs-settings-01-read");
});

test("change: a choice is the menu's, a refused value the radio's reason", async ({}, info) => {
  const was = await value("0 5 5 4");
  const to = was === "High" ? "Mid" : "High";
  await page.getByLabel(POWER, { exact: true }).selectOption(to);
  await expect.poll(() => value("0 5 5 4")).toBe(to);
  await expect(page.locator('[data-id="0 5 5 4"]')).toHaveClass(/changed/);
  await page.getByLabel(FREQ, { exact: true }).fill("500");
  await page.getByLabel(FREQ, { exact: true }).press("Enter");
  await page.getByLabel(FREQ, { exact: true }).blur();
  await expect(page.locator('[data-id="0 5 7 1"] .err')).toBeVisible();
  await shot(page, info, "aprs-settings-02-changed");
});

test("write: backup first, the diff, then the read back; the backup restores", async ({}, info) => {
  backup = await startWrite();
  await expect(dialog()).toContainText("Power");
  await shot(page, info, "aprs-settings-03-diff");
  await commitWrite(1);
  const after = await value("0 5 5 4");
  await page.locator('input[type=file][accept^=".json"]').setInputFiles(backup);
  await expect(page.getByText(/^Loaded .*aprs-backup\.json/)).toBeVisible();
  await startWrite();
  await commitWrite(1);
  backup = null;
  expect(await value("0 5 5 4")).not.toBe(after);
});
