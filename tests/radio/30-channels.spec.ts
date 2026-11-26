// Stage 30: Channels & Zones. A user adds a channel in Console (+ Add channel, a name, an RX frequency), writes it;
// the radio, asked over Bluetooth, holds that record. Renamed and written: the radio has the new name. Deleted and
// written: the radio holds nothing there. The radio's channel numbers end as they began. Deleted even when a step
// fails. RX only on the bench frequency; nothing here keys the radio.
import { type Page } from "@playwright/test";
import { connect, disconnect, openConsole, shot, state } from "../e2e/helpers";
import { expect, startSnapshot, test } from "./radio";

test.describe.configure({ mode: "serial" });

const RX = "446.47500";
const RX_UNITS = 44_647_500; // the record's 10 Hz units
const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, "");
let page: Page;
let num = 0;
let onRadio = false;

const dialog = () => page.getByRole("dialog");
const toolbar = () => page.getByRole("toolbar", { name: "Channels" });
const row = () => page.locator(`tr[data-n="${num}"]`);

async function readRadio() {
  await page.evaluate(() => ((window as any).__e2eBase = (window as any).ferrite.channels.base));
  await toolbar().getByRole("button", { name: "Read from radio" }).click();
  const drop = page.getByRole("button", { name: "Read and discard" });
  if (await drop.isVisible()) await drop.click();
  await expect.poll(() => page.evaluate(() => (window as any).ferrite.channels.base !== (window as any).__e2eBase), { timeout: 180_000 }).toBe(true);
  await expect(toolbar().getByRole("button", { name: "Read from radio" })).toBeEnabled({ timeout: 180_000 });
}

async function write(n: number) {
  await toolbar().getByRole("button", { name: /^Write to radio/ }).click();
  await expect(dialog()).toContainText("Backup kept in Console until it closes", { timeout: 180_000 });
  await dialog().getByRole("button", { name: `Write ${n} ${n === 1 ? "change" : "changes"}` }).click();
  await expect(dialog()).toContainText("Read back: the radio holds the table.", { timeout: 180_000 });
  await dialog().getByRole("button", { name: "Close" }).click();
  await expect(dialog()).toHaveCount(0);
}

async function remove() {
  await row().getByRole("checkbox", { name: `Select channel ${num}` }).check();
  await page.getByRole("region", { name: "Selected channels" }).getByRole("button", { name: "Delete 1" }).click();
  await expect(row()).toHaveCount(0);
  await write(1);
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await openConsole(page, "channels");
  await connect(page, 30_000);
});

test.afterAll(async ({ oracle }) => {
  if (onRadio) {
    try {
      if (await dialog().count()) await dialog().getByRole("button", { name: /^(Close|Cancel)$/ }).click();
      await readRadio();
      if (await oracle.channel(num)) await remove();
    } catch (e) {
      console.error(`couldn't delete channel ${num}: ${(e as Error).message}`);
    }
  }
  await disconnect(page);
  await page.close();
});

test("read: Console's table holds the channels the radio holds", async ({ oracle }, info) => {
  await readRadio();
  const inConsole = await state(page, (f) => f.channels.table.channels.map((c: any) => c.number as number));
  expect(inConsole.sort((a, b) => a - b)).toEqual(await oracle.used("channel"));
  await shot(page, info, "30-channels-read");
});

test("add: a new channel in Console is on the radio after Write", async ({ oracle }, info) => {
  const nums = () => state(page, (f) => f.channels.table.channels.map((c: any) => c.number as number));
  const had = new Set(await nums());
  await page.getByRole("button", { name: "+ Add channel" }).click();
  // The number Console gave it (the first free one, not always the last)
  num = (await nums()).find((n) => !had.has(n))!;
  expect(num).toBeGreaterThan(0);
  expect(await oracle.channel(num)).toBeNull(); // a free number on the radio too
  const name = `E2E ${stamp}`;
  await row().getByLabel("Name").fill(name);
  await row().getByLabel("Name").press("Tab");
  await row().getByLabel("RX MHz").fill(RX);
  await row().getByLabel("RX MHz").press("Tab");
  await shot(page, info, "31-channel-added");
  await write(1);
  onRadio = true;
  const c = await oracle.channel(num);
  expect(c?.name).toBe(name);
  expect(c?.rx).toBe(RX_UNITS);
});

test("edit: a rename in Console is on the radio after Write", async ({ oracle }, info) => {
  const name = `E2E ${stamp} B`;
  await row().getByLabel("Name").fill(name);
  await row().getByLabel("Name").press("Tab");
  await write(1);
  expect((await oracle.channel(num))?.name).toBe(name);
  await shot(page, info, "32-channel-renamed");
});

test("delete: gone from the radio after Write; its numbers as they began", async ({ oracle }) => {
  await remove();
  onRadio = false;
  expect(await oracle.channel(num)).toBeNull();
  expect(await oracle.used("channel")).toEqual(startSnapshot().channels);
});
