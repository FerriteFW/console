// Add channels (the channel library): a fixed set into a new zone, written to the radio and read back; airports
// near a typed place as AM, RX-only rows; Canadian TAFL sites near it. The write test runs on the simulator only:
// on a radio it would add 22 channels (FERRITE_E2E_LIBRARY_WRITE=1 lets it, at your own risk).
import { type Page } from "@playwright/test";
import { connect, disconnect, expect, onRadio, openConsole, shot, state, test } from "./helpers";

let page: Page;
const lib = () => page.getByRole("dialog", { name: "Add channels" });
const writeDialog = () => page.getByRole("dialog", { name: "Write to the radio" });
const long = () => (onRadio() ? 120_000 : 30_000);
/** Vancouver airport. */
const PLACE = "49.1947, -123.1792";

async function readRadio() {
  await page.evaluate(() => ((window as any).__e2eBase = (window as any).ferrite.channels.base));
  await page.getByRole("button", { name: "Read from radio" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).ferrite.channels.base !== (window as any).__e2eBase), { timeout: long() }).toBe(true);
  await expect(page.getByRole("button", { name: "Read from radio" })).toBeEnabled({ timeout: long() });
}

async function openLibrary(tab: string) {
  await page.getByRole("button", { name: "Add channels…" }).click();
  await expect(lib()).toBeVisible();
  await lib().getByRole("tab", { name: new RegExp(`^${tab}`) }).click();
}

/** Each group its own page, connected and read (the groups can run on two workers, each with its own simulator). */
function hooks() {
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await openConsole(page, "channels");
    await connect(page);
    await readRadio();
  });
  test.afterAll(async () => {
    await disconnect(page);
    await page.close();
  });
}

test.describe.serial("write", () => {
  // Static (the radio's cable is named before the run), so a skipped group doesn't connect and read either.
  test.skip(!!process.env.FERRITE_E2E_SERIAL && !process.env.FERRITE_E2E_LIBRARY_WRITE, "adds 22 channels to the radio");
  hooks();

  test("fixed set: FRS into a new zone, written and read back", async ({}, info) => {
    const before = await state(page, (f) => ({ chs: f.channels.table.channels.length, zones: f.channels.table.zones.length }));
    await openLibrary("Fixed sets");
    await lib().getByRole("option", { name: /^FRS/ }).click();
    await expect(lib().getByRole("button", { name: "Add 22 channels" })).toBeEnabled();
    await expect(lib().getByLabel("New zone name")).toHaveValue("FRS");
    // A unique zone name: a run against a radio that already has an "FRS" zone still makes a new one.
    const zone = `FRS ${String(Date.now() % 10000).padStart(4, "0")}`;
    await lib().getByLabel("New zone name").fill(zone);
    await shot(page, info, "30-library-fixed");
    await lib().getByRole("button", { name: "Add 22 channels" }).click();
    await expect(lib()).toHaveCount(0);

    const after = await state(page, (f) => ({ chs: f.channels.table.channels.length, zones: f.channels.table.zones }));
    expect(after.chs).toBe(before.chs + 22);
    expect(after.zones.length).toBe(before.zones + 1);
    expect(after.zones.at(-1).name).toBe(zone);
    await expect(page.locator("tr.added")).toHaveCount(22);
    await expect(page.getByText("22 channels added from FRS, 1 new zone")).toBeVisible();
    await page.locator("tr.added").first().scrollIntoViewIfNeeded();
    await shot(page, info, "31-library-fixed-rows");

    // Write: backup, the diff (22 channels and the zone added), no problems.
    const dl = page.waitForEvent("download", { timeout: long() });
    await page.getByRole("button", { name: "Write to radio…" }).click();
    await dl;
    await expect(writeDialog()).toContainText("Backup saved", { timeout: long() });
    await expect(writeDialog().locator("h3.added")).toHaveText("Added (23)");
    await expect(writeDialog().locator("li", { hasText: zone })).toHaveCount(1);
    await shot(page, info, "32-library-fixed-diff");
    await writeDialog().getByRole("button", { name: /^Write \d+ changes$/ }).click();
    await expect(writeDialog()).toContainText("Read back: the radio holds the table.", { timeout: long() });
    await shot(page, info, "33-library-fixed-written");
    await writeDialog().getByRole("button", { name: "Close" }).click();

    // The radio holds them: in the new zone, NFM, 462.5625 first.
    await readRadio();
    const got = await state(page, (f) => {
      const zi = f.channels.table.zones.length - 1;
      return { zone: f.channels.table.zones[zi].name, chans: f.channels.table.channels.filter((c: any) => c.zone === zi) };
    });
    expect(got.zone).toBe(zone);
    expect(got.chans.length).toBe(22);
    expect(got.chans[0]).toMatchObject({ name: "FRS 1", rx: "462.56250", mode: "NFM" });
  });
});

// The airports group types the place the TAFL test uses.
test.describe.serial("near a place", () => {
  hooks();

  test("airports near a typed place: AM, RX-only rows", async ({}, info) => {
    const before = await state(page, (f) => f.channels.table.channels.length);
    await openLibrary("Airports");
    // From radio: the radio's GPS fix, else its fixed position; else it says so.
    await lib().getByRole("button", { name: "From radio" }).click();
    await expect(lib().getByText(/^From the radio's (GPS|fixed position)|no GPS fix and no fixed position/)).toBeVisible({ timeout: long() });
    console.log(`From radio: ${(await lib().locator(".place .sub, .banner").allTextContents()).join(" | ")}`);
    await lib().getByLabel("Place: latitude, longitude or grid square").fill(PLACE);
    await expect(lib().getByText("CN89")).toBeVisible();
    const cyvr = lib().getByRole("checkbox", { name: "CYVR", exact: true });
    await expect(cyvr).toBeVisible({ timeout: 20_000 });
    await cyvr.check();
    const add = lib().getByRole("button", { name: /^Add \d+ channels?$/ });
    const n = Number((await add.textContent())!.match(/\d+/)![0]);
    expect(n).toBeGreaterThan(2);
    await shot(page, info, "34-library-airports");
    await add.click();
    await expect(lib()).toHaveCount(0);

    const added = await state(page, (f) => f.channels.table.channels.filter((c: any) => c.name.startsWith("CYVR ")));
    expect(added.length).toBe(n);
    for (const c of added) {
      expect(c.mode).toBe("AM");
      expect(c.rx_only).toBe(true);
      expect(c.name.length).toBeLessThanOrEqual(16);
      expect(Number(c.rx)).toBeGreaterThanOrEqual(108);
      expect(Number(c.rx)).toBeLessThan(137);
    }
    expect(await state(page, (f) => f.channels.table.channels.length)).toBe(before + n);
    expect(await state(page, (f) => f.channels.table.zones.at(-1).name)).toBe("CYVR");
    const first = page.locator(`tr[data-n="${added[0].number}"]`);
    await expect(first).toHaveClass(/added/);
    await first.scrollIntoViewIfNeeded();
    await shot(page, info, "35-library-airport-rows");
  });

  test("TAFL: Canadian sites near the place, RX only", async ({}, info) => {
    await openLibrary("Canadian sites");
    await expect(lib().getByLabel("Filter TAFL entries")).toBeVisible({ timeout: 30_000 });
    await lib().getByLabel("Filter TAFL entries").fill("ferries");
    const group = lib().getByRole("checkbox", { name: /^Group / }).first();
    await expect(group).toBeVisible();
    await group.check();
    await shot(page, info, "36-library-tafl");
    const before = await state(page, (f) => f.channels.table.channels.length);
    await lib().getByRole("button", { name: /^Add \d+ entr(y|ies)$/ }).click();
    await expect(lib()).toHaveCount(0);
    const added = await state(page, (f) => f.channels.table.channels.slice(-200).filter((c: any) => c.rx_only && c.mode === "NFM"));
    expect(await state(page, (f) => f.channels.table.channels.length)).toBeGreaterThan(before);
    expect(added.length).toBeGreaterThan(0);
    await shot(page, info, "37-library-tafl-rows");
    // Leave the table as read (nothing of this test is written).
    await page.getByRole("button", { name: "Undo edits" }).click();
  });

  test("repeaters: says why not yet", async ({}, info) => {
    await openLibrary("Repeaters");
    await expect(lib()).toContainText("Repeaters: not yet");
    await shot(page, info, "38-library-repeaters");
    await lib().getByRole("button", { name: "Close" }).click();
  });
});
