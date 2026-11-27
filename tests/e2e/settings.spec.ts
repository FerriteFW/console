// Radio Settings through the bridge: read the settings record, change Key beep (a choice) and Beep volume (a level),
// write them (a backup kept in Console and the diff first, LINK-21.2), read back, then restore the backup saved from
// the dialog as a .ferrite (the restore path) and check both are back. Then Battery Save (no record carries it: the
// radio's dump, a set line) with Shared VHF, put back with the dialog's Put the radio back.
// On the radio both are put back even when a test fails.
import { type Page } from "@playwright/test";
import { connect, disconnect, expect, onRadio, openConsole, saveKept, shot, state, test } from "./helpers";

test.describe.configure({ mode: "serial" });

const long = () => (onRadio() ? 120_000 : 30_000);
const BEEP = "0 7 5 1 Key beep";
const VOL = "0 7 5 2 Beep volume";

let page: Page;
/** Key beep and Beep volume as read, and the first write's backup file (while the radio holds the edit). */
let was: { beep: string; vol: string } | null = null;
let backup: string | null = null;

const dialog = () => page.getByRole("dialog");
const beep = () => page.getByLabel(BEEP, { exact: true });
const vol = () => page.getByLabel(`${VOL} value`, { exact: true });
const values = () => state(page, (f) => Object.fromEntries(f.settings.view.groups.flatMap((g: any) => g.items.map((i: any) => [i.id, i.value]))));

async function readRadio() {
  await page.evaluate(() => ((window as any).__e2eBase = (window as any).ferrite.settings.base));
  await page.getByRole("button", { name: "Read from radio" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).ferrite.settings.base !== (window as any).__e2eBase), { timeout: long() }).toBe(true);
  await expect(page.getByRole("button", { name: "Read from radio" })).toBeEnabled({ timeout: long() });
}

/** Write to radio…: the backup kept (no download, LINK-21.2), saved from the dialog when `as` is given. */
async function startWrite(as?: string) {
  await page.getByRole("button", { name: "Write to radio…" }).click();
  await expect(dialog().locator('[data-k="kept"]')).toContainText("Backup kept in Console until it closes", { timeout: long() });
  return as ? saveKept(page, dialog(), as, "settings", long()) : null;
}

async function commitWrite(n: number, close = true) {
  await dialog().getByRole("button", { name: `Write ${n} ${n === 1 ? "change" : "changes"}` }).click();
  await expect(dialog()).toContainText("Read back: the radio holds these settings.", { timeout: long() });
  if (!close) return;
  await dialog().getByRole("button", { name: "Close" }).click();
  await expect(dialog()).toHaveCount(0);
}

/** The saved backup (.ferrite) into the editor with Open…, then written: the radio as it was. */
async function restore(path: string) {
  await page.locator('input[type=file][accept^=".json"]').setInputFiles(path);
  await expect(page.getByText(/^Loaded .*\.ferrite/)).toBeVisible();
  await startWrite();
  await commitWrite(2);
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await openConsole(page, "settings");
  await connect(page);
});

test.afterAll(async () => {
  if (backup) {
    try {
      if (await dialog().count()) await dialog().getByRole("button", { name: /^(Close|Cancel)$/ }).click();
      await restore(backup);
    } catch (e) {
      console.error(`couldn't put Key beep and Beep volume back (${backup}): ${(e as Error).message}`);
    }
  }
  await disconnect(page);
  await page.close();
});

test("read: the record as the radio's menu shows it", async ({}, info) => {
  await readRadio();
  await expect(page.getByRole("region", { name: "Display, sound, power" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Transmit" })).toBeVisible();
  // The radio's own option names; LINK-5's settings read only.
  await expect(page.getByLabel("0 7 1 Theme", { exact: true }).locator("option")).toHaveText(["Dark", "Daylight", "Night red", "Cyberpunk"]);
  await expect(beep().locator("option")).toHaveText(["Off", "On"]);
  const region = page.locator('[data-id="0 9 4"]');
  await expect(region).toContainText("Set on the radio, for safety");
  await expect(region.locator("select, input, button")).toHaveCount(0);
  // MENU 0 5's other settings are named, pointing at APRS Settings; Shared VHF in the radio's own words.
  await expect(page.getByRole("region", { name: "APRS" })).toContainText("On APRS Settings");
  await expect(page.getByRole("region", { name: "APRS" })).toContainText("Telemetry");
  await expect(page.getByLabel("0 5 9 7 Shared VHF", { exact: true }).locator("option")).toHaveText(["APRS first", "A·B first"]);
  // In neither record (the terminal's dump and set): Watch, Battery Save, the message sound.
  await expect(page.getByLabel("0 7 7 1 Battery Save", { exact: true })).toBeEnabled();
  await expect(page.getByLabel("0 1 1 Watch", { exact: true })).toBeEnabled();
  await expect(page.getByLabel("0 7 5 5 Message sound", { exact: true })).toBeEnabled();
  const v = await values();
  was = { beep: v["0 7 5 1"], vol: v["0 7 5 2"] };
  expect(["Off", "On"]).toContain(was.beep);
  await expect(beep()).toHaveValue(was.beep);
  console.log(`Key beep ${was.beep}, Beep volume ${was.vol}`);
  await page.getByRole("region", { name: "Display, sound, power" }).scrollIntoViewIfNeeded();
  await shot(page, info, "20-settings-read");
});

test("change and write: a backup first, the diff, then the write", async ({}, info) => {
  expect(was).not.toBeNull();
  const beepTo = was!.beep === "On" ? "Off" : "On";
  await beep().selectOption(beepTo);
  await expect(page.locator('[data-id="0 7 5 1"]')).toHaveClass(/changed/);
  // A level: one step (down from the top, else up).
  const up = was!.vol !== "High";
  await page.getByRole("button", { name: `${VOL} ${up ? "up" : "down"}` }).click();
  await expect(vol()).not.toHaveText(was!.vol);
  const volTo = (await vol().textContent())!;
  await expect(page.getByText("not written: 2 settings changed")).toBeVisible();
  await page.getByRole("region", { name: "Display, sound, power" }).scrollIntoViewIfNeeded();
  await shot(page, info, "21-settings-edited");
  const { path, file } = (await startWrite("settings-backup.ferrite"))!;
  expect(file.format).toBe("ferrite-console-settings");
  expect(file.settings[BEEP]).toBe(was!.beep);
  expect(file.settings[VOL]).toBe(was!.vol);
  // The diff: exactly the two, old to new.
  const items = dialog().locator("li");
  await expect(items).toHaveCount(2);
  const b = items.filter({ hasText: "0 7 5 1" });
  await expect(b.locator("s")).toHaveText(was!.beep);
  await expect(b.locator("b")).toHaveText(beepTo);
  const l = items.filter({ hasText: "0 7 5 2" });
  await expect(l.locator("s")).toHaveText(was!.vol);
  await expect(l.locator("b")).toHaveText(volTo);
  await shot(page, info, "22-settings-diff");
  backup = path;
  await commitWrite(2);
  await shot(page, info, "23-settings-written");
});

test("read back: the radio holds both; then the backup restores them", async ({}, info) => {
  expect(backup).not.toBeNull();
  await readRadio();
  const v = await values();
  expect(v["0 7 5 1"]).not.toBe(was!.beep);
  expect(v["0 7 5 2"]).not.toBe(was!.vol);
  await restore(backup!);
  backup = null;
  await readRadio();
  const back = await values();
  expect([back["0 7 5 1"], back["0 7 5 2"]]).toEqual([was!.beep, was!.vol]);
  await expect(beep()).toHaveValue(was!.beep);
  await page.getByRole("region", { name: "Display, sound, power" }).scrollIntoViewIfNeeded();
  await shot(page, info, "24-settings-restored");
});

test("a setting the settings record doesn't carry (Battery Save) with one it does (Shared VHF): both records written, read back, restored", async ({}, info) => {
  await readRadio();
  const v = await values();
  const bs = page.getByLabel("0 7 7 1 Battery Save", { exact: true });
  const vhf = page.getByLabel("0 5 9 7 Shared VHF", { exact: true });
  const bsTo = (await bs.locator("option").allTextContents()).find((o) => o !== v["0 7 7 1"])!;
  const vhfTo = v["0 5 9 7"] === "APRS first" ? "A·B first" : "APRS first";
  await bs.selectOption(bsTo);
  await vhf.selectOption(vhfTo);
  await expect(page.locator('[data-id="0 7 7 1"]')).toHaveClass(/changed/);
  await expect(page.locator('[data-id="0 5 9 7"]')).toHaveClass(/changed/);
  const { path, file } = (await startWrite("settings-term-backup.ferrite"))!;
  expect(file.extras["0 7 7 1"]).toBe(v["0 7 7 1"]);
  const items = dialog().locator("li");
  await expect(items).toHaveCount(2);
  await expect(items.filter({ hasText: "0 7 7 1" }).locator("b")).toHaveText(bsTo);
  await expect(items.filter({ hasText: "0 5 9 7" }).locator("b")).toHaveText(vhfTo);
  // Decision 347: Battery Save goes in the radio record (LINK-66), not as a set command.
  await expect(dialog()).not.toContainText("set command");
  await shot(page, info, "25-settings-term-diff");
  backup = path;
  await commitWrite(2, false);
  // The editor holds the read back.
  const after = await values();
  expect([after["0 7 7 1"], after["0 5 9 7"]]).toEqual([bsTo, vhfTo]);
  // LINK-21.2: Put the radio back writes the kept read: its diff, then the write.
  await dialog().getByRole("button", { name: "Put the radio back" }).click();
  await expect(dialog().locator("li")).toHaveCount(2, { timeout: long() });
  await commitWrite(2);
  backup = null;
  await readRadio();
  const back = await values();
  expect([back["0 7 7 1"], back["0 5 9 7"]]).toEqual([v["0 7 7 1"], v["0 5 9 7"]]);
  await page.getByRole("region", { name: "Display, sound, power" }).scrollIntoViewIfNeeded();
  await shot(page, info, "26-settings-term-restored");
});

test("LINK-21.4: a file whose region isn't the radio's: the rest is written, the region left as the radio has it", async ({}, info) => {
  // The radio journey (Nov 26, 2026): a backup opened onto a radio just reinstalled (no region yet) was refused
  // whole, as the radio keeps its region (LINK-26). Here the file's region differs the other way; the same rule.
  await readRadio();
  const v = await values();
  const region = v["0 9 4"];
  const beepTo = v["0 7 5 1"] === "On" ? "Off" : "On";
  await beep().selectOption(beepTo);
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save as…" }).click();
  const { readZip } = await import("../../src/lib/zip");
  const { readFileSync, writeFileSync } = await import("node:fs");
  const z = await readZip(readFileSync(await (await dl).path()));
  const file = JSON.parse(new TextDecoder().decode(z.get("settings.json")!));
  // The settings record's region byte (ferrite-app persist.rs's order: 0 not chosen, else 1 + REGION_LIST's index).
  const REGION_AT = 71;
  const rec: string = file.record;
  const codes = ["Not set", "United States", "Canada", "United Kingdom", "Europe", "Australia", "New Zealand", "Japan", "Other"];
  expect(codes[parseInt(rec.slice(REGION_AT * 2, REGION_AT * 2 + 2), 16)], "the record's region byte is where this test looks").toBe(region);
  const other = region === "United States" ? 2 : 1;
  file.record = rec.slice(0, REGION_AT * 2) + other.toString(16).padStart(2, "0") + rec.slice(REGION_AT * 2 + 2);
  const path = info.outputPath("other-region-settings.json");
  writeFileSync(path, JSON.stringify(file));
  await page.getByRole("button", { name: "Undo edits" }).click();
  await page.locator('input[type=file][accept^=".json"]').setInputFiles(path);
  await expect(page.getByText(/^Loaded other-region-settings\.json/)).toContainText("0 9 4 Region");
  await startWrite();
  await expect(dialog().locator('[data-k="radio-only"]')).toContainText("0 9 4 Region");
  await expect(dialog()).not.toContainText("would refuse or keep");
  await shot(page, info, "27-settings-radio-only");
  await commitWrite(1);
  await readRadio();
  const after = await values();
  expect([after["0 9 4"], after["0 7 5 1"]]).toEqual([region, beepTo]);
  // Put Key beep back.
  await beep().selectOption(v["0 7 5 1"]);
  await startWrite();
  await commitWrite(1);
});
