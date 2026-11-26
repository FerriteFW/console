// Stage 40: Add from library and zones. A user adds the FRS fixed set (22 channels) into a new zone and writes it;
// the radio, asked over Bluetooth, holds 22 more channels and one more zone, the channels in that zone, FRS 1 on
// 462.5625. Then the 22 are picked by the zone filter and deleted, the zone deleted, and written: the radio's
// numbers are as they began. Removed again even when a step fails. Receive only: nothing here keys the radio.
import { type Page } from "@playwright/test";
import { connect, disconnect, openConsole, shot, state } from "../e2e/helpers";
import { expect, startSnapshot, test, type Oracle } from "./radio";

test.describe.configure({ mode: "serial" });

const zone = `E2E FRS ${String(Date.now() % 10000).padStart(4, "0")}`;
let page: Page;
let written = false;
/** The new zone's number as the radio counts them (index + 1 in Console's table). */
let zoneNum = 0;

const dialog = () => page.getByRole("dialog");
const toolbar = () => page.getByRole("toolbar", { name: "Channels" });
const lib = () => page.getByRole("dialog", { name: "Add channels" });

async function readRadio() {
  await page.evaluate(() => ((window as any).__e2eBase = (window as any).ferrite.channels.base));
  await toolbar().getByRole("button", { name: "Read from radio" }).click();
  const drop = page.getByRole("button", { name: "Read and discard" });
  if (await drop.isVisible()) await drop.click();
  await expect.poll(() => page.evaluate(() => (window as any).ferrite.channels.base !== (window as any).__e2eBase), { timeout: 180_000 }).toBe(true);
  await expect(toolbar().getByRole("button", { name: "Read from radio" })).toBeEnabled({ timeout: 180_000 });
}

async function write() {
  await toolbar().getByRole("button", { name: /^Write to radio/ }).click();
  await expect(dialog()).toContainText("Backup kept in Console until it closes", { timeout: 180_000 });
  await dialog().getByRole("button", { name: /^Write \d+ changes?$/ }).click();
  await expect(dialog()).toContainText("Read back: the radio holds the table.", { timeout: 180_000 });
  await dialog().getByRole("button", { name: "Close" }).click();
  await expect(dialog()).toHaveCount(0);
}

/** The test's zone and its channels deleted in Console, then written. */
async function removeAll() {
  await page.getByRole("tab", { name: /^Channels/ }).click();
  const filter = page.getByLabel("Show zone");
  const value = await filter.locator("option", { hasText: zone }).getAttribute("value");
  await filter.selectOption(value!);
  await page.getByRole("checkbox", { name: "Select every channel shown" }).check();
  await page.getByRole("region", { name: "Selected channels" }).getByRole("button", { name: /^Delete \d+$/ }).click();
  await filter.selectOption("all");
  await page.getByRole("tab", { name: /^Zones/ }).click();
  const zi = await state(page, (f) => f.channels.table.zones.length - 1);
  await page.getByRole("listbox", { name: "Zones" }).getByRole("option").nth(zi).click();
  await page.getByRole("button", { name: `Delete zone ${zi + 1}`, exact: true }).click();
  await expect(page.getByText(new RegExp(`^Deleted zone ${zi + 1} "${zone}"`))).toBeVisible();
  await page.getByRole("tab", { name: /^Channels/ }).click();
  await write();
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await openConsole(page, "channels");
  await connect(page, 30_000);
  await readRadio();
});

test.afterAll(async ({ oracle }) => {
  if (written) {
    try {
      if (await dialog().count()) await dialog().getByRole("button", { name: /^(Close|Cancel)$/ }).click();
      await readRadio();
      if ((await oracle.used("zone")).length > startSnapshot().zones.length) await removeAll();
    } catch (e) {
      console.error(`couldn't remove the zone ${zone} and its channels: ${(e as Error).message}`);
    }
  }
  await disconnect(page);
  await page.close();
});

/** The channels in the radio's zone `n` (its records' zone field), asked one by one over Bluetooth. */
async function inZone(oracle: Oracle, n: number) {
  const out: { n: number; name: string; rx: number }[] = [];
  for (const c of await oracle.used("channel")) {
    const r = await oracle.channel(c);
    if (r && r.zone === n) out.push(r);
  }
  return out;
}

test("library: FRS into a new zone, written; the radio holds 22 channels in it", async ({ oracle }, info) => {
  const before = startSnapshot();
  await page.getByRole("button", { name: "Add from library…" }).click();
  await lib().getByRole("tab", { name: /^Fixed sets/ }).click();
  await lib().getByRole("option", { name: /^FRS/ }).click();
  await lib().getByLabel("New zone name").fill(zone);
  await lib().getByRole("button", { name: "Add 22 channels" }).click();
  await expect(lib()).toHaveCount(0);
  await shot(page, info, "40-library-added");
  await write();
  written = true;
  zoneNum = await state(page, (f) => f.channels.table.zones.length);

  const zones = await oracle.used("zone");
  expect(zones.length).toBe(before.zones.length + 1);
  expect((await oracle.used("channel")).length).toBe(before.channels.length + 22);
  // The radio counts zones from 0 (Console's zone N is the radio's N - 1): the one number that's new.
  const newest = zones.find((z) => !before.zones.includes(z))!;
  const got = await inZone(oracle, newest);
  expect(got.length).toBe(22);
  const first = got.sort((a, b) => a.n - b.n)[0];
  expect(first.name).toBe("FRS 1");
  expect(first.rx).toBe(46_256_250);
  console.log(`zone ${zoneNum} "${zone}" (radio's ${newest}): 22 channels from ${first.n}`);
});

test("zones: the channels and the zone deleted and written; the radio as it began", async ({ oracle }, info) => {
  await removeAll();
  written = false;
  const was = startSnapshot();
  expect(await oracle.used("zone")).toEqual(was.zones);
  expect(await oracle.used("channel")).toEqual(was.channels);
  await shot(page, info, "41-library-removed");
});
