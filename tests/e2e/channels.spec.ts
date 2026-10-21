// Channels & Zones through the bridge: read, edit one channel's name and write it (backup and diff first), read it
// back, put it back, and a CHIRP CSV export and import round trip. On the radio (FERRITE_E2E_CHANNEL) the edited
// channel is a scratch one, and its name is put back even when a test fails.
import { expect, test, type Download, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connect, disconnect, onRadio, openConsole, shot, shotsDir, state } from "./helpers";

test.describe.configure({ mode: "serial" });

let page: Page;
/** The channel the tests edit, its name as read, and the name written (while it is on the radio). */
let num = 0;
let original = "";
let written: string | null = null;

const row = () => page.locator(`tr[data-n="${num}"]`);
const dialog = () => page.getByRole("dialog");

async function readRadio() {
  // Done when the read set is a new one (the button can still look enabled before the read starts).
  await page.evaluate(() => ((window as any).__e2eBase = (window as any).ferrite.channels.base));
  await page.getByRole("button", { name: "Read from radio" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).ferrite.channels.base !== (window as any).__e2eBase), {
      timeout: onRadio() ? 120_000 : 30_000,
    })
    .toBe(true);
  await expect(page.getByRole("button", { name: "Read from radio" })).toBeEnabled({ timeout: onRadio() ? 120_000 : 30_000 });
  await expect.poll(() => state(page, (f) => f.channels.table.channels.length)).toBeGreaterThan(0);
}

const nameOnTable = () => state(page, (f) => f.channels.table.channels.map((c: any) => [c.number, c.name]));

async function setName(name: string) {
  const input = row().locator("input.name");
  await input.fill(name);
  await input.press("Tab"); // the change event
}

async function save(d: Download, as?: string) {
  const path = join(shotsDir(), `${onRadio() ? "radio" : "sim"}-${as ?? d.suggestedFilename()}`);
  await d.saveAs(path);
  return path;
}

/** Write to radio...: the backup downloads, the review shows. Returns the backup's path. */
async function startWrite() {
  const dl = page.waitForEvent("download", { timeout: onRadio() ? 120_000 : 30_000 });
  await page.getByRole("button", { name: "Write to radio…" }).click();
  const backup = await dl;
  expect(backup.suggestedFilename()).toMatch(/^ferrite-.*-backup\.json$/);
  const path = await save(backup);
  await expect(dialog()).toContainText("Backup saved", { timeout: onRadio() ? 120_000 : 30_000 });
  return path;
}

async function commitWrite() {
  await dialog().getByRole("button", { name: /^Write \d+ changes?$/ }).click();
  await expect(dialog()).toContainText("Read back: the radio holds the table.", { timeout: onRadio() ? 120_000 : 30_000 });
}

async function closeWrite() {
  await dialog().getByRole("button", { name: /^(Close|Cancel)$/ }).click();
  await expect(dialog()).toHaveCount(0);
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await openConsole(page, "channels");
  await connect(page);
});

test.afterAll(async () => {
  // The radio's channel back as it was, whatever failed on the way.
  if (written !== null && original !== written) {
    try {
      if (await dialog().count()) await closeWrite();
      await readRadio();
      await setName(original);
      await startWrite();
      await commitWrite();
      await closeWrite();
    } catch (e) {
      console.error(`channel ${num}: couldn't put its name back to "${original}": ${(e as Error).message}`);
    }
  }
  await disconnect(page);
  await page.close();
});

test("read: zones and channels as INFO counts them", async ({}, info) => {
  await readRadio();
  const [chs, zones, want] = await state(page, (f) => [f.channels.table.channels.length, f.channels.table.zones.length, f.radio.info]);
  expect(chs).toBe(want.channels);
  expect(zones).toBe(want.zones);
  const env = process.env.FERRITE_E2E_CHANNEL;
  // A bridge on a real cable (whatever the env says): never pick a channel to edit by ourselves.
  const label = await state(page, (f) => f.radio.label as string);
  if (!env && !label.includes("simulator")) throw new Error(`${label}: set FERRITE_E2E_CHANNEL to a scratch channel`);
  const all = await nameOnTable();
  num = env ? Number(env) : Math.max(...all.map(([n]) => n as number));
  const hit = all.find(([n]) => n === num);
  expect(hit, `channel ${num} is on the radio`).toBeTruthy();
  original = hit![1] as string;
  console.log(`editing channel ${num} ("${original}")`);
  await row().scrollIntoViewIfNeeded();
  await shot(page, info, "10-read");
});

test("edit and write: a backup first, the diff, then the write", async ({}, info) => {
  const name = `E2E ${String(Date.now() % 100000).padStart(5, "0")}`;
  await setName(name);
  await expect(row()).toHaveClass(/changed|edit|dirty/);
  await shot(page, info, "11-edited");
  const backup = await startWrite();
  // The backup holds the radio as it was: the old name.
  const file = JSON.parse(readFileSync(backup, "utf8"));
  expect(file.format).toBe("ferrite-console-channels");
  expect(JSON.stringify(file)).toContain(JSON.stringify(original));
  // The diff: exactly this channel, its name old to new.
  const item = dialog().locator("li", { hasText: `Ch ${num}` });
  await expect(item).toHaveCount(1);
  await expect(item.locator("b")).toHaveText(name);
  if (original) await expect(item.locator("s")).toHaveText(original);
  await expect(dialog().getByRole("button", { name: "Write 1 change" })).toBeEnabled();
  await shot(page, info, "12-diff");
  written = name;
  await commitWrite();
  await shot(page, info, "13-written");
  await closeWrite();
});

test("read back: the radio holds the new name; then it is put back", async ({}, info) => {
  expect(written).not.toBeNull();
  await readRadio();
  expect((await nameOnTable()).find(([n]) => n === num)?.[1]).toBe(written);
  await row().scrollIntoViewIfNeeded();
  await shot(page, info, "14-read-back");
  await setName(original);
  await startWrite();
  await commitWrite();
  await closeWrite();
  written = null;
  await readRadio();
  expect((await nameOnTable()).find(([n]) => n === num)?.[1]).toBe(original);
  await shot(page, info, "15-put-back");
});

test("CHIRP: export, import that file (merge), nothing to write", async ({}, info) => {
  await readRadio();
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export" }).click();
  const csv = await save(await dl, "export.csv");
  const text = readFileSync(csv, "utf8");
  expect(text.split(/\r?\n/)[0]).toMatch(/^Location,Name,Frequency,Duplex,Offset,Tone,/);
  const count = await state(page, (f) => f.channels.table.channels.length);
  await page.locator('input[type=file][accept^=".csv"]').setInputFiles(csv);
  await expect(dialog()).toBeVisible();
  await shot(page, info, "16-chirp-import");
  await dialog().getByRole("button", { name: /^Import \d+$/ }).click();
  await expect(dialog()).toHaveCount(0);
  expect(await state(page, (f) => f.channels.table.channels.length)).toBe(count);
  await startWrite();
  await expect(dialog()).toContainText("Nothing to write: the radio already holds the table.");
  await shot(page, info, "17-chirp-nothing-to-write");
  await closeWrite();
});
