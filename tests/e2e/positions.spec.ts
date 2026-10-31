// Channel positions (CHAN-2, LINK-53): set in the side panel as degrees or a grid square, written (WRITE_MANY of
// what 7 after the channel records) and read back; cleared, written, read back gone. Imports carry them: a
// RepeaterBook CSV with Latitude/Longitude, and the library's airports. On the radio (FERRITE_E2E_CHANNEL) the edited
// channel is a scratch one, and its position is put back even when a test fails.
import { type Page } from "@playwright/test";
import { join } from "node:path";
import { connect, disconnect, expect, onRadio, openConsole, shot, state, test } from "./helpers";
import { serveData } from "./sitedata";

let page: Page;
const long = () => (onRadio() ? 120_000 : 30_000);
const toolbar = () => page.getByRole("toolbar", { name: "Channels" });
const wd = () => page.getByRole("dialog", { name: "Write to the radio" });
const panel = () => page.getByRole("complementary", { name: `Channel ${num}` });
const row = () => page.locator(`tr[data-n="${num}"]`);
const posOf = (n: number): Promise<[number, number] | null> =>
  page.evaluate((n) => (window as any).ferrite.channels.table.channels.find((c: any) => c.number === n)?.pos ?? null, n);

/** The channel the tests edit, its position as read, and whether the radio may hold another one now. */
let num = 0;
let original: [number, number] | null = null;
let touched = false;

async function readRadio() {
  await page.evaluate(() => ((window as any).__e2eBase = (window as any).ferrite.channels.base));
  await toolbar().getByRole("button", { name: "Read from radio" }).click();
  const drop = page.getByRole("button", { name: "Read and discard" });
  if (await drop.isVisible()) await drop.click();
  await expect.poll(() => page.evaluate(() => (window as any).ferrite.channels.base !== (window as any).__e2eBase), { timeout: long() }).toBe(true);
  await expect(toolbar().getByRole("button", { name: "Read from radio" })).toBeEnabled({ timeout: long() });
  await expect.poll(() => state(page, (f) => f.channels.table.channels.length)).toBeGreaterThan(0);
}

/** Write to radio: backup, review; then the write and its read back. */
async function write(check?: () => Promise<void>) {
  const dl = page.waitForEvent("download", { timeout: long() });
  await toolbar().getByRole("button", { name: /^Write to radio/ }).click();
  await dl;
  await expect(wd()).toContainText("Backup saved", { timeout: long() });
  await expect(wd().getByTestId("positions-skipped")).toHaveCount(0); // the simulator's firmware stores them
  await check?.();
  await wd().getByRole("button", { name: /^Write \d+ changes?$/ }).click();
  await expect(wd()).toContainText("Read back: the radio holds the table.", { timeout: long() });
  await wd().getByRole("button", { name: "Close" }).click();
  await expect(wd()).toHaveCount(0);
}

async function openPanel() {
  await row().scrollIntoViewIfNeeded();
  await row().getByRole("button", { name: `Details for channel ${num}` }).click();
  await expect(panel()).toBeVisible();
}

async function typePosition(text: string) {
  const input = panel().getByLabel("Channel position");
  await input.fill(text);
  await input.press("Tab"); // the change event
}

test.describe.serial("set, write, clear", () => {
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    await openConsole(page, "channels");
    await connect(page);
  });

  test.afterAll(async () => {
    // The radio's channel back as it was, whatever failed on the way.
    if (touched) {
      try {
        if (await wd().count()) await wd().getByRole("button", { name: /^(Close|Cancel)$/ }).click();
        await readRadio();
        if (JSON.stringify(await posOf(num)) !== JSON.stringify(original)) {
          await openPanel();
          await typePosition(original ? original.join(", ") : "");
          await write();
        }
      } catch (e) {
        console.error(`channel ${num}: couldn't put its position back: ${(e as Error).message}`);
      }
    }
    await disconnect(page);
    await page.close();
  });

  test("set in the panel (degrees), the marker and grid square show; written and read back", async ({}, info) => {
    await readRadio();
    const env = process.env.FERRITE_E2E_CHANNEL;
    const label = await state(page, (f) => f.radio.label as string);
    if (!env && !label.includes("simulator")) throw new Error(`${label}: set FERRITE_E2E_CHANNEL to a scratch channel`);
    const all = await state(page, (f) => f.channels.table.channels.map((c: any) => c.number as number));
    num = env ? Number(env) : Math.max(...all);
    original = await posOf(num);
    await openPanel();

    // A bad one: said inline, nothing changed.
    await typePosition("95, 10");
    await expect(panel().getByRole("alert")).toContainText("latitude is -90 to 90");
    expect(await posOf(num)).toEqual(original);

    await typePosition("45.4215,-75.6972");
    expect(await posOf(num)).toEqual([45.4215, -75.6972]);
    await expect(panel().getByLabel("Channel position")).toHaveValue("45.42150, -75.69720");
    await expect(panel().getByTestId("position-grid")).toHaveText("📍 Grid square FN25dk");
    await expect(row().locator(".pin")).toHaveAttribute("title", "Position 45.42150, -75.69720 (FN25dk)");
    await expect(row()).toHaveClass(/changed/);
    await expect(page.getByText(/1 unwritten/)).toBeVisible();
    await shot(page, info, "60-position-set");

    touched = true;
    await write(async () => {
      const item = wd().locator("li", { hasText: `Ch ${num}` });
      await expect(item).toHaveCount(1);
      await expect(item.locator(".f")).toHaveText(/position .* → 45\.42150, -75\.69720 \(FN25dk\)/);
      await expect(wd().getByRole("button", { name: "Write 1 change" })).toBeEnabled();
      await shot(page, info, "61-position-diff");
    });
    await readRadio();
    expect(await posOf(num)).toEqual([45.4215, -75.6972]);
    await expect(row().locator(".pin")).toHaveCount(1);
  });

  test("a grid square, then Clear: written, read back gone", async ({}, info) => {
    await openPanel();
    await typePosition("FN25dk");
    const grid = (await posOf(num))!;
    // The subsquare's centre, by ferrite's own grid code (1e-7 degree).
    expect(grid[0]).toBeCloseTo(45.4375, 6);
    expect(grid[1]).toBeCloseTo(-75.70833, 5);
    await panel().getByRole("button", { name: "Clear the position" }).click();
    expect(await posOf(num)).toBeNull();
    await expect(row().locator(".pin")).toHaveCount(0);
    // Undo brings the grid square's back; once more the cleared one is what goes.
    await toolbar().getByRole("button", { name: "↶ Undo" }).click();
    await expect.poll(() => posOf(num)).toEqual(grid);
    await panel().getByRole("button", { name: "Clear the position" }).click();
    await write(async () => {
      await expect(wd().locator("li", { hasText: `Ch ${num}` }).locator(".f")).toHaveText(/position 45\.42150, -75\.69720 \(FN25dk\) → –/);
    });
    await readRadio();
    expect(await posOf(num)).toBeNull();
    await expect(row().locator(".pin")).toHaveCount(0);
    await shot(page, info, "62-position-cleared");
    if (!original) touched = false;
  });
});

test.describe.serial("imports carry positions", () => {
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await openConsole(page, "channels");
  });
  test.afterAll(async () => {
    await page.close();
  });

  test("RepeaterBook CSV with Latitude and Longitude", async ({}, info) => {
    await page.locator('input[type=file][accept^=".csv"]').setInputFiles(join(import.meta.dirname, "fixtures", "repeaterbook-latlon.csv"));
    const imp = page.getByRole("dialog", { name: "Import CHIRP CSV" });
    await expect(imp).toContainText("3 channels.");
    await imp.getByRole("button", { name: /^Import 3/ }).click();
    await expect(imp).toHaveCount(0);
    const t = await state(page, (f) => f.channels.table.channels.map((c: any) => [c.name, c.pos ?? null]));
    expect(t).toEqual([
      ["Ottawa", [45.4215296, -75.6971931]],
      ["Kanata", [45.3088, -75.8987]],
      ["Gatineau", null],
    ]);
    await expect(page.locator("tr .pin")).toHaveCount(2);
    await shot(page, info, "63-position-csv");
  });

  test("library: airports carry the airport's position", async () => {
    await serveData(page);
    await page.getByRole("button", { name: "Add from library…" }).first().click();
    const lib = page.getByRole("dialog", { name: "Add channels" });
    await lib.getByRole("tab", { name: /^Airports/ }).click();
    await lib.getByLabel("Place: latitude, longitude or grid square").fill("49.1947, -123.1792");
    const cyvr = lib.getByRole("checkbox", { name: "CYVR", exact: true });
    await expect(cyvr).toBeVisible({ timeout: 20_000 });
    await cyvr.check();
    await lib.getByRole("button", { name: /^Add \d+ channels?$/ }).click();
    await expect(lib).toHaveCount(0);
    const added = await state(page, (f) => f.channels.table.channels.filter((c: any) => c.name.startsWith("CYVR ")));
    expect(added.length).toBeGreaterThan(2);
    for (const c of added) {
      expect(c.pos[0]).toBeCloseTo(49.19, 1);
      expect(c.pos[1]).toBeCloseTo(-123.18, 1);
    }
  });
});
