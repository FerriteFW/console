// APRS settings through the bridge (LINK-43): the APRS record as MENU 0 5 shows it, a choice changed, a typed value
// refused with the radio's reason, the write (the backup kept first, LINK-21.2, the diff, the read back), then the
// backup restored (saved from the dialog as a .ferrite, opened, written); and
// MENU 0 5's settings no record carries (telemetry, Mic-E, the comment: the radio's dump and set lines) the same way.
// On a radio the backup is written back even when a step fails.
import { type Page } from "@playwright/test";
import { connect, disconnect, expect, onRadio, openConsole, saveKept, shot, state, test } from "./helpers";

test.describe.configure({ mode: "serial" });

const long = () => (onRadio() ? 120_000 : 30_000);
const POWER = "0 5 6 3 Power";
const FREQ = "0 5 4 Frequency";

let page: Page;
let backup: string | null = null;
const dialog = () => page.getByRole("dialog");
const value = (id: string) =>
  page.evaluate((x) => (window as any).ferrite.aprsSettings.view?.items.find((i: any) => i.id === x)?.value as string, id);

/** Write to radio…: the backup kept (no download, LINK-21.2); saved from the dialog as `as` when given (its path). */
async function startWrite(as?: string): Promise<string> {
  await page.getByRole("button", { name: "Write to radio…" }).click();
  await expect(dialog().locator('[data-k="kept"]')).toContainText("Backup kept in Console until it closes", { timeout: long() });
  if (!as) return "";
  const { path, file } = await saveKept(page, dialog(), as, "aprs", long());
  expect(file.format).toBe("ferrite-console-aprs");
  return path;
}

/** `n` changes written (any number when not given: putting a backup back after a failure). */
async function commitWrite(n?: number) {
  const name = n === undefined ? /^Write \d+ changes?$/ : `Write ${n} ${n === 1 ? "change" : "changes"}`;
  await dialog().getByRole("button", { name }).click();
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
      await commitWrite();
    } catch (e) {
      console.error(`couldn't put the APRS settings back (${backup}): ${(e as Error).message}`);
    }
  }
  await disconnect(page);
  await page.close();
});

test("read: the APRS record as MENU 0 5 shows it", async ({}, info) => {
  await expect.poll(() => state(page, (f) => !!f.aprsSettings.view), { timeout: long() }).toBe(true);
  for (const name of ["My station", "Beacon", "Digipeat", "Advanced"]) await expect(page.getByRole("region", { name })).toBeVisible();
  await expect(page.getByLabel(POWER, { exact: true })).toBeVisible();
  await expect(page.getByLabel(FREQ, { exact: true })).toBeVisible();
  // APRS mode is the settings record's (Radio Settings), not here
  await expect(page.getByLabel("0 5 3 APRS mode", { exact: true })).toHaveCount(0);
  // MENU 0 5's settings no record carries, read with the radio's dump: here, in menu order.
  for (const id of ["0 5 5 2 Symbol", "0 5 5 3 Comment", "0 5 6 4 Telemetry"]) await expect(page.getByLabel(id, { exact: true })).toBeEnabled();
  for (const id of ["0 5 5 6 Ambiguity", "0 5 5 7 Mic-E", "0 5 9 3 TX delay", "0 5 9 4 TX level"])
    await expect(page.getByRole("group", { name: id, exact: true })).toBeVisible();
  await expect(page.getByLabel("0 5 6 4 Telemetry", { exact: true }).locator("option")).toHaveText(["Off", "On"]);
  // APRS-50.1 (0.8.5): the beacon text rate, from the record's last byte
  await expect(page.getByLabel("0 5 6 5 Text rate", { exact: true }).locator("option")).toHaveText(["All", "1/2", "1/4", "1/8"]);
  // the settings record's MENU 0 5 settings, named from the core
  await expect(page.getByText(/^In Radio Settings \(the settings record\): 0 5 3 APRS mode, .*0 5 9 7 Shared VHF, 0 5 9 8 Decode log\.$/)).toBeVisible();
  await shot(page, info, "aprs-settings-01-read");
});

test("change: a choice is the menu's, a refused value the radio's reason", async ({}, info) => {
  const was = await value("0 5 6 3");
  const to = was === "High" ? "Mid" : "High";
  await page.getByLabel(POWER, { exact: true }).selectOption(to);
  await expect.poll(() => value("0 5 6 3")).toBe(to);
  await expect(page.locator('[data-id="0 5 6 3"]')).toHaveClass(/changed/);
  await page.getByLabel(FREQ, { exact: true }).fill("500");
  await page.getByLabel(FREQ, { exact: true }).press("Enter");
  await page.getByLabel(FREQ, { exact: true }).blur();
  await expect(page.locator('[data-id="0 5 4"] .err')).toBeVisible();
  await shot(page, info, "aprs-settings-02-changed");
});

test("write: backup first, the diff, then the read back; the backup restores", async ({}, info) => {
  backup = await startWrite("aprs-backup.ferrite");
  await expect(dialog()).toContainText("Power");
  await shot(page, info, "aprs-settings-03-diff");
  await commitWrite(1);
  const after = await value("0 5 6 3");
  await page.locator('input[type=file][accept^=".json"]').setInputFiles(backup);
  await expect(page.getByText(/^Loaded .*aprs-.*backup\.ferrite/)).toBeVisible();
  await startWrite();
  await commitWrite(1);
  backup = null;
  expect(await value("0 5 6 3")).not.toBe(after);
});

test("in the record since decision 347: telemetry, Mic-E and the comment, written with it, read back, restored", async ({}, info) => {
  const was = { tel: await value("0 5 6 4"), mice: await value("0 5 5 7"), comment: await value("0 5 5 3") };
  const telTo = was.tel === "On" ? "Off" : "On";
  const comment = page.getByLabel("0 5 5 3 Comment", { exact: true });
  const commentTo = was.comment === "Ferrite e2e, 73" ? "Ferrite e2e, 88" : "Ferrite e2e, 73";
  await page.getByLabel("0 5 6 4 Telemetry", { exact: true }).selectOption(telTo);
  const up = was.mice !== "Priority";
  await page.getByRole("button", { name: `0 5 5 7 Mic-E ${up ? "up" : "down"}` }).click();
  await expect.poll(() => value("0 5 5 7")).not.toBe(was.mice);
  const miceTo = await value("0 5 5 7");
  await comment.fill(commentTo);
  await comment.press("Enter");
  await expect.poll(() => value("0 5 5 3")).toBe(commentTo);
  // longer than the radio's 40 characters: refused here
  await comment.fill("x".repeat(41));
  await comment.press("Enter");
  await expect(page.locator('[data-id="0 5 5 3"] .err')).toBeVisible();
  expect(await value("0 5 5 3")).toBe(commentTo);
  for (const id of ["0 5 6 4", "0 5 5 7", "0 5 5 3"]) await expect(page.locator(`[data-id="${id}"]`)).toHaveClass(/changed/);
  await shot(page, info, "aprs-settings-04-term-changed");
  backup = await startWrite("aprs-term-backup.ferrite");
  const items = dialog().locator("li");
  await expect(items).toHaveCount(3);
  await expect(items.filter({ hasText: "0 5 6 4" }).locator("b")).toHaveText(telTo);
  await expect(items.filter({ hasText: "0 5 5 3" }).locator("b")).toHaveText(commentTo);
  await expect(dialog()).not.toContainText("set command");
  await shot(page, info, "aprs-settings-05-term-diff");
  await commitWrite(3);
  // read back from the radio: the record
  await page.getByRole("button", { name: "Read from radio" }).click();
  await expect(page.getByRole("button", { name: "Read from radio" })).toBeEnabled({ timeout: long() });
  expect([await value("0 5 6 4"), await value("0 5 5 7"), await value("0 5 5 3")]).toEqual([telTo, miceTo, commentTo]);
  // the backup puts them back
  await page.locator('input[type=file][accept^=".json"]').setInputFiles(backup);
  await expect(page.getByText(/^Loaded .*aprs-.*backup\.ferrite/)).toBeVisible();
  await startWrite();
  await commitWrite(3);
  backup = null;
  expect([await value("0 5 6 4"), await value("0 5 5 7"), await value("0 5 5 3")]).toEqual([was.tel, was.mice, was.comment]);
  await shot(page, info, "aprs-settings-06-term-restored");
});
