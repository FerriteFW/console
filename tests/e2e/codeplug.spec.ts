// The .ferrite codeplug (docs/dev/codeplug-format.md): read the channels, edit one name (not written), Save as… a
// .ferrite (the download is a zip with a manifest), discard the edit, Open… the file: the table is the edited one
// again, shown as unwritten. And an older channels -backup.json still opens. Nothing is written to the radio.
import { type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connect, disconnect, expect, onRadio, openConsole, shot, shotsDir, state, test } from "./helpers";

test.describe.configure({ mode: "serial" });

let page: Page;
const toolbar = () => page.getByRole("toolbar", { name: "Channels" });
const file = (item: RegExp) => async () => {
  await toolbar().getByRole("button", { name: /^File/ }).click();
  await page.getByRole("menuitem", { name: item }).click();
};
const table = () => state(page, (f) => f.channels.table);

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await openConsole(page, "channels");
  await connect(page);
});

test.afterAll(async () => {
  // Unwritten changes dropped (nothing was written).
  if (await state(page, (f) => f.channels.pending)) await file(/^Discard unwritten changes/)();
  await disconnect(page);
  await page.close();
});

test("Save as… a .ferrite, discard, Open… it: the table back, unwritten", async ({}, info) => {
  // The page reads the radio by itself when it opens on a connected radio.
  await expect.poll(() => state(page, (f) => f.channels.base?.channels.length ?? 0), { timeout: onRadio() ? 120_000 : 30_000 }).toBeGreaterThan(0);
  await expect(toolbar().getByRole("button", { name: "Read from radio" })).toBeEnabled({ timeout: onRadio() ? 120_000 : 30_000 });
  const read = await table();
  const num: number = read.channels.at(-1).number;
  const input = page.locator(`tr[data-n="${num}"] input.name`);
  await input.fill("Codeplug e2e");
  await input.press("Tab");
  await expect.poll(() => state(page, (f) => f.channels.pending)).toBe(1);
  const edited = await table();

  const dl = page.waitForEvent("download");
  await file(/^Save as/)();
  const d = await dl;
  expect(d.suggestedFilename()).toMatch(/^[A-Za-z0-9-]+-\d{8}-\d{4}\.ferrite$/);
  const path = join(shotsDir(), `${onRadio() ? "radio" : "sim"}-codeplug.ferrite`);
  await d.saveAs(path);
  const bytes = readFileSync(path);
  expect([...bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  await expect(page.locator(".toast")).toContainText(`as ${d.suggestedFilename()}`);

  await file(/^Discard unwritten changes/)();
  await expect.poll(() => state(page, (f) => f.channels.pending)).toBe(0);
  expect(await table()).toEqual(read);

  await page.locator('input[type=file][accept^=".json"]').setInputFiles({ name: d.suggestedFilename(), mimeType: "application/zip", buffer: bytes });
  // The range presets ride along (their own part): loaded in place of the radio's, so nothing changes.
  const presets = await state(page, (f) => f.channels.presets.length as number);
  await expect(page.locator(".toast")).toContainText(
    `Loaded channels (${read.channels.length}) and zones (${read.zones.length}), range presets (${presets}) from ${d.suggestedFilename()}`,
  );
  expect(await table()).toEqual(edited);
  await expect.poll(() => state(page, (f) => f.channels.pending)).toBe(1);
  await expect(page.locator(".status .dirty")).toContainText("not written: 1 channel changed");
  await expect(page.getByRole("button", { name: /^Write to radio \(1 change\)/ })).toBeVisible();
  await shot(page, info, "80-codeplug-opened");
});

test("an older channels -backup.json still opens", async () => {
  const text = readFileSync(new URL("../../core/tests/fixtures/codeplug/channels.json", import.meta.url), "utf8");
  const name = "ferrite-VA7IF-20261030-141200-backup.json";
  await page.locator('input[type=file][accept^=".json"]').setInputFiles({ name, mimeType: "application/json", buffer: Buffer.from(text) });
  await expect(page.locator(".toast")).toContainText(`Loaded channels (3) and zones (2) from ${name}`);
  const t = await table();
  expect(t.channels.map((c: any) => c.name)).toEqual(["Calling 2 m", "North hill", "Calling 70 cm"]);
  expect(t.zones.map((z: any) => z.name)).toEqual(["Local", "Repeaters"]);
  await expect.poll(() => state(page, (f) => f.channels.pending)).toBeGreaterThan(0);
});

test("a zip that isn't a codeplug is refused", async () => {
  const before = await table();
  // An empty zip: just the end record.
  const empty = Buffer.alloc(22);
  empty.writeUInt32LE(0x06054b50, 0);
  await page.locator('input[type=file][accept^=".json"]').setInputFiles({ name: "photos.zip", mimeType: "application/zip", buffer: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), empty]) });
  await expect(page.locator(".banner")).toContainText("not a Ferrite codeplug");
  expect(await table()).toEqual(before);
});
