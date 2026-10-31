// Channels & Zones › Range presets (MENU 0 1 4, LINK-21's what 4) through the bridge: the radio's presets read with
// the channels, one edited and one added, written (a backup and the diff first) and read back; then put back (the
// added one deleted, the edit undone). A preset's skipped frequencies (SCAN-10) aren't on the link: the editor says
// so, and they stay with their preset (the radio keeps them). Simulator only: a test shouldn't rewrite a radio's
// presets.
import { type Page } from "@playwright/test";
import { connect, disconnect, expect, onRadio, openConsole, shot, state, test } from "./helpers";

let page: Page;
const long = () => (onRadio() ? 120_000 : 30_000);
const toolbar = () => page.getByRole("toolbar", { name: "Channels" });
const dialog = () => page.getByRole("dialog");
const list = () => page.getByRole("listbox", { name: "Range presets" });
const presets = () => state(page, (f) => f.channels.presets as { number: number; name: string; low: string; high: string; mode: string }[]);

async function readRadio() {
  await page.evaluate(() => ((window as any).__e2eBase = (window as any).ferrite.channels.basePresets));
  await toolbar().getByRole("button", { name: "Read from radio" }).click();
  const drop = page.getByRole("button", { name: "Read and discard" });
  if (await drop.isVisible()) await drop.click();
  await expect.poll(() => page.evaluate(() => (window as any).ferrite.channels.basePresets !== (window as any).__e2eBase), { timeout: long() }).toBe(true);
  await expect(toolbar().getByRole("button", { name: "Read from radio" })).toBeEnabled({ timeout: long() });
}

async function write(review?: () => Promise<void>) {
  const dl = page.waitForEvent("download", { timeout: long() });
  await toolbar().getByRole("button", { name: /^Write to radio/ }).click();
  await dl;
  await expect(dialog()).toContainText("Backup saved", { timeout: long() });
  await review?.();
  await dialog().getByRole("button", { name: /^Write \d+ changes?$/ }).click();
  await expect(dialog()).toContainText("Read back: the radio holds the table.", { timeout: long() });
  await dialog().getByRole("button", { name: "Close" }).click();
  await expect(dialog()).toHaveCount(0);
}

test.describe.serial("range presets", () => {
  test.skip(onRadio(), "rewrites the radio's range presets: simulator only");
  let first: Awaited<ReturnType<typeof presets>> = [];

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await openConsole(page, "channels?tab=presets");
    await connect(page);
    await readRadio();
    first = await presets();
  });

  test.afterAll(async () => {
    await disconnect(page);
    await page.close();
  });

  test("read with the channels, edited, added, written and read back", async ({}, info) => {
    await expect(page.getByRole("tab", { name: /^Range presets/ })).toHaveAttribute("aria-selected", "true");
    const n = first.length;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(16);
    await expect(list().getByRole("option")).toHaveCount(n);
    // The first one: a new name, and an end the radio refuses (across 64 MHz) shown before anything is sent.
    await list().getByRole("option").first().click();
    await page.getByLabel("Preset name").fill("E2E range");
    await page.getByLabel("Preset name").press("Tab");
    const low = first[0].low;
    await page.getByLabel("Start MHz").fill("50");
    await page.getByLabel("Start MHz").press("Tab");
    await page.getByLabel("End MHz").fill("70");
    await page.getByLabel("End MHz").press("Tab");
    await expect(page.getByRole("alert")).toContainText(/span (18|64) MHz/);
    await page.getByLabel("Start MHz").fill(low);
    await page.getByLabel("Start MHz").press("Tab");
    await page.getByLabel("End MHz").fill(first[0].high);
    await page.getByLabel("End MHz").press("Tab");
    await expect(page.getByRole("alert")).toHaveCount(0);
    // The skip list: the radio's, kept with the preset; the editor says so.
    await expect(page.getByRole("region", { name: "Range preset 1" })).toContainText("Skipped frequencies");
    await expect(page.getByRole("region", { name: "Range preset 1" })).toContainText("stay with this preset");
    // A new one at the end: 430-440 MHz, AM.
    await page.getByRole("button", { name: "+ Add" }).click();
    await expect(page.getByRole("heading", { name: `Range preset ${n + 1}` })).toBeVisible();
    await page.getByLabel("Preset name").fill("E2E new");
    await page.getByLabel("Preset name").press("Tab");
    await page.getByLabel("Start MHz").fill("430");
    await page.getByLabel("Start MHz").press("Tab");
    await page.getByLabel("End MHz").fill("440");
    await page.getByLabel("End MHz").press("Tab");
    await page.getByLabel("Mode").selectOption("AM");
    await expect(toolbar().getByRole("button", { name: "Write to radio (2 changes)" })).toBeVisible();
    await expect(page.locator("nav[aria-label=Sections] .badge")).toHaveText("2 unwritten");
    await shot(page, info, "presets-01-edited");
    await write(async () => {
      await expect(dialog().locator("li").filter({ hasText: "Preset 1" })).toContainText("E2E range");
      await expect(dialog().locator("li").filter({ hasText: `Preset ${n + 1}` })).toContainText("E2E new");
      await expect(dialog().getByRole("heading", { name: "Added (1)" })).toBeVisible();
    });
    // Read again: the radio holds both.
    await readRadio();
    const back = await presets();
    expect(back.length).toBe(n + 1);
    expect(back[0].name).toBe("E2E range");
    expect([back[n].name, back[n].low, back[n].high, back[n].mode]).toEqual(["E2E new", "430.00000", "440.00000", "AM"]);
  });

  test("put back: the added one deleted, the first renamed", async () => {
    const n = first.length;
    await list().getByRole("option").nth(n).click();
    await page.getByRole("button", { name: `Delete range preset ${n + 1}` }).click();
    await expect(page.getByText(`Deleted range preset ${n + 1}`)).toBeVisible();
    await list().getByRole("option").first().click();
    await page.getByLabel("Preset name").fill(first[0].name);
    await page.getByLabel("Preset name").press("Tab");
    await write(async () => {
      await expect(dialog().getByRole("heading", { name: "Deleted (1)" })).toBeVisible();
    });
    expect((await presets()).map((p) => p.name)).toEqual(first.map((p) => p.name));
  });
});
