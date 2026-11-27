// Stage 85 (only after a stock round, stages 60-70): the run's backup back on the radio, as a user restoring after a
// reinstall: everything.ferrite (stage 50) opened on Radio Settings and written while the radio still waits in its
// first-run Setup (the region left to the radio: LINK-21.4), then on Channels & Zones and written; then Setup
// finished on the radio.
// The radio answers over Bluetooth again (its Bluetooth setting is back), and stage 90 checks it holds what it began
// with.
import { type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { connect, disconnect, openConsole, screenId, shot, state } from "../e2e/helpers";
import { everythingFile, expect, restoredMark, startSnapshot, stockMark, stockRound, test } from "./radio";

test.skip(!stockRound(), "only after Back to stock and Install: FERRITE_RADIO_FLASH=1 FERRITE_RADIO_STOCK=1");
test.setTimeout(15 * 60_000);

/** The open page's Write to radio…: the backup kept, every change written, read back. */
async function writeAll(page: Page, holds: string, radioOnly?: string) {
  const dialog = page.getByRole("dialog");
  await page.getByRole("button", { name: /^Write to radio/ }).click();
  await expect(dialog).toContainText("Backup kept in Console until it closes", { timeout: 180_000 });
  // LINK-21.4: what only the radio changes stays the radio's, said so, and the rest is written.
  if (radioOnly) await expect(dialog.locator('[data-k="radio-only"]')).toContainText(radioOnly);
  await dialog.getByRole("button", { name: /^Write \d+ changes?$/ }).click();
  await expect(dialog).toContainText(`Read back: the radio holds ${holds}`, { timeout: 600_000 });
  await dialog.getByRole("button", { name: "Close" }).click();
}

/** The radio's first-run Setup as Live View draws it (LINK-19.5: its texts; Live View's updates over the cable carry
 *  no `setup` or `row` lines): the screen, "N of 8", the heading, and every drawn text (to see a key land). */
const setupNow = (page: Page) =>
  state(page, (f) => {
    const ui = f.radio.ui;
    const t = (ui?.lines ?? []).filter((l) => l.startsWith("t ")).join("\n");
    const n = /" ?(\d+) of (\d+)"/.exec(t);
    const head = /,2,[0-9a-f]+,-,"([^"]+)"/.exec(t);
    return { id: ui?.screen?.id ?? null, page: n ? Number(n[1]) : null, head: head?.[1] ?? null, t };
  });

/** Setup's Region list, top to bottom (ferrite-app settings: REGION_ORDER over REGION_LIST). */
const SETUP_REGIONS = ["Canada", "Australia", "Europe", "Japan", "New Zealand", "United Kingdom", "United States", "Other"];

/** The Region the run's backup holds (its settings.json: settings, "0 9 4 Region"). */
function backupRegion(): string {
  const j = JSON.parse(execFileSync("unzip", ["-p", everythingFile(), "settings.json"], { encoding: "utf8" }));
  const r = j.settings?.["0 9 4 Region"];
  if (typeof r !== "string") throw new Error("the run's backup names no Region");
  return r;
}

test("restore: the run's backup written back, settings then channels", async ({ page, oracle }, info) => {
  expect(existsSync(everythingFile()), "stage 50's backup").toBe(true);
  await openConsole(page, "settings");
  await connect(page, 60_000);
  // A fresh Ferrite on stock's data may first ask to finish setting up its storage: that's for Alex, by hand.
  await expect(page.getByRole("alert", { name: "Finish the update" })).toHaveCount(0);
  // Just installed: the radio waits in its first-run Setup, with no region yet (LINK-21.4's case).
  const inSetup = (await screenId(page)) === "Setup";
  await page.getByRole("button", { name: "Read from radio" }).click();
  await expect(page.getByRole("button", { name: "Read from radio" })).toBeEnabled({ timeout: 120_000 });
  await page.locator('input[type=file][accept^=".json"]').setInputFiles(everythingFile());
  await expect(page.getByText(/^Loaded .*\.ferrite/).first()).toBeVisible();
  await writeAll(page, "these settings", inSetup ? "Region" : undefined);
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
  rmSync(stockMark(), { force: true }); // the stock round is over: the next run takes its own start
  writeFileSync(restoredMark(), new Date().toISOString()); // stage 90: the PIN is the radio's own now
});

// Then, as the owner does at the radio after the restore (the install chapter): OK through its first-run Setup,
// choosing the backup's Region on its page (Region changes only on the radio: LINK-5, LINK-26); every other page
// shows what the restore wrote, and OK keeps it. Done with Live View's keys (the radio's own keys, over the link).
test("setup: the radio's first-run Setup finished, the backup's Region chosen", async ({ page }, info) => {
  expect(existsSync(everythingFile()), "stage 50's backup").toBe(true);
  const region = backupRegion();
  await openConsole(page, "live");
  await connect(page, 60_000);
  await expect.poll(async () => (await setupNow(page)).id, { timeout: 30_000 }).not.toBeNull();
  if ((await setupNow(page)).id !== "Setup") test.skip(true, "the radio isn't in Setup: nothing to finish");
  const down = SETUP_REGIONS.indexOf(region);
  expect(down, `${region} is one of Setup's regions`).toBeGreaterThanOrEqual(0);
  // From wherever Setup is: BACK to its first page, then OK page by page; on Region, DOWN to the backup's (the list
  // opens on its first row with no region chosen) and OK chooses it.
  for (let i = 0; i < 10 && (await setupNow(page)).page !== 1; i++) {
    const s = await setupNow(page);
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await setupNow(page)).t, { timeout: 15_000 }).not.toBe(s.t);
  }
  for (let i = 0; i < 12; i++) {
    const s = await setupNow(page);
    if (s.id !== "Setup") break;
    if (s.head === "Region") {
      for (let d = 0; d < down; d++) {
        const before = (await setupNow(page)).t;
        await page.keyboard.press("ArrowDown");
        await expect.poll(async () => (await setupNow(page)).t, { timeout: 15_000 }).not.toBe(before);
      }
      await shot(page, info, "85-setup-region");
    }
    await page.keyboard.press("Enter");
    await expect.poll(async () => { const n = await setupNow(page); return n.id !== "Setup" || n.page !== s.page; }, { timeout: 15_000 }).toBe(true);
  }
  await expect.poll(async () => (await setupNow(page)).id, { timeout: 15_000 }).not.toBe("Setup");
  await shot(page, info, "85-setup-done");
  await disconnect(page);
});
