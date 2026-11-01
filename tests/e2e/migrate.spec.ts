// Finish the update (UPD-16, LINK-59 – LINK-62) end to end on the simulator: a radio whose firmware stores layout 3
// starts with its data in layout 2 (the simulator's `--flash`: core's own layout 2 chip, tests/e2e/fixtures/
// layout2-chip.bin, made by core/src/migrate.rs's e2e_fixture_is_the_built_chip: 1,000 channels, a 300-channel zone,
// settings, APRS, contacts, waypoints, heard and message rings, events). Console sees the layouts in HELLO, keeps the
// records alone, backs the old layout up over DATA_READ (and saves it), translates, writes it over DATA_WRITE,
// stamps, and connects again on layout 3 with everything there; and as part of an update (Firmware Update's wizard,
// the bridge's fake bootloader). Never on a radio: only Alex moves a radio's data, by hand.
import { type Page } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disconnect, expect, onRadio, openConsole, test } from "./helpers";
import { startBridge, type Bridges } from "./procs";

test.skip(onRadio(), "the simulator only");
// A thousand channels written over the bridge: about a minute.
test.setTimeout(240_000);

/** The simulator's kept flash ([`ferrite_sim::simcore::FLASH_IMAGE`]: 0 to the packet mailbox's end, then the event
 *  log: 0xD0000 bytes on layout 3) with the layout 2 chip at its place, 0x02C000. */
function layout2Image(): string {
  const chip = readFileSync(new URL("./fixtures/layout2-chip.bin", import.meta.url));
  const img = Buffer.alloc(0xd0000, 0xff);
  chip.copy(img, 0x2c000);
  const file = join(mkdtempSync(join(tmpdir(), "ferrite-layout2-")), "flash.img");
  writeFileSync(file, img);
  return file;
}

let b: Bridges;
test.beforeEach(async () => {
  b = await startBridge(undefined, ["--flash", layout2Image()]);
});
test.afterEach(async ({ page }) => {
  await page.keyboard.press("Escape");
  await disconnect(page);
  b?.stop();
});

const banner = (page: Page) => page.getByRole("alert", { name: "Finish the update" });

async function connectWaiting(page: Page, section: string) {
  await openConsole(page, section, b.url);
  await page.getByRole("button", { name: "Bridge", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Connected: Bridge", { timeout: 20_000 });
  // LINK-62: HELLO says layout 3 firmware, layout 2 chip: the banner, and the records left alone.
  await expect(banner(page)).toBeVisible();
  expect(await page.evaluate(() => (window as any).ferrite.radio.hello.layouts)).toEqual({ firmware: 3, chip: 2 });
}

/** The radio's channels and zones read back (the Channels table's read). */
async function readBack(page: Page) {
  await page.evaluate(() => (window as any).ferrite.channels.read());
  return page.evaluate(() => {
    const t = (window as any).ferrite.channels.base as { zones: { name: string }[]; channels: { number: number; name: string; zone: number | null }[] };
    return { zones: t.zones.map((z) => z.name), channels: t.channels.map((c) => [c.number, c.name, c.zone] as const) };
  });
}

test("finish the update: layout 2's data backed up, moved and stamped; the radio comes back on layout 3", async ({ page }) => {
  await connectWaiting(page, "channels");
  // UPD-16: no record read while the data waits (the Channels page's own read says why).
  await expect(page.locator(".banner").filter({ hasText: "finish the update first" })).toBeVisible({ timeout: 10_000 });

  await banner(page).getByRole("button", { name: "Finish the update…" }).click();
  const dialog = page.getByRole("dialog", { name: "Finish the update" });
  await expect(dialog).toContainText("layout 2");
  const download = page.waitForEvent("download", { timeout: 120_000 });
  await dialog.getByRole("button", { name: "Finish the update", exact: true }).click();
  await expect(dialog.getByRole("progressbar")).toBeVisible();
  // The backup is saved before anything is written: Console's copy file (magic FRLB).
  const file = await (await download).path();
  const bytes = readFileSync(file);
  expect(bytes.subarray(0, 4).toString("latin1")).toBe("FRLB");
  expect(bytes.length).toBeGreaterThan(0x61000);

  await expect(dialog.getByRole("region", { name: "Update finished" })).toBeVisible({ timeout: 200_000 });
  await expect(dialog.locator('[data-k="moved"]')).toContainText("1,000 channels");
  await expect(dialog.getByRole("list", { name: "Notes" })).toContainText("Repeaters 2");
  await dialog.getByRole("button", { name: "Close" }).click();

  // Connected again by itself, on layout 3: no banner, the records there.
  await expect(page.getByRole("status")).toContainText("Connected: Bridge", { timeout: 30_000 });
  await expect(banner(page)).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).ferrite.radio.hello.layouts)).toEqual({ firmware: 3, chip: 3 });
  const got = await readBack(page);
  expect(got.channels.length).toBe(1000);
  // Zone 5 was deleted on the radio (an empty record): it stays, unnamed, so the numbers after it keep theirs.
  expect(got.zones).toEqual(["Local", "Simplex", "Repeaters", "Air", "", "Last", "Repeaters 2"]);
  const rep = got.zones.indexOf("Repeaters");
  const rep2 = got.zones.indexOf("Repeaters 2");
  expect(rep).toBeGreaterThanOrEqual(0);
  expect(rep2).toBeGreaterThan(rep);
  // CHAN-35: the first 256 by number stay; the other 44 went to Repeaters 2.
  expect(got.channels.filter((c) => c[2] === rep).length).toBe(256);
  expect(got.channels.filter((c) => c[2] === rep2).length).toBe(44);
  expect(got.channels.find((c) => c[0] === 1)?.[1]).toBe("CH 0");

  // The moved radio takes writes again (its store mounted on layout 3; the unnamed zone kept as it was).
  await page.evaluate(() => (window as any).ferrite.channels.edit(1, "name", "Moved OK"));
  const toolbar = page.getByRole("toolbar", { name: "Channels" });
  const dl = page.waitForEvent("download");
  await toolbar.getByRole("button", { name: /^Write to radio/ }).click();
  await dl;
  const wd = page.getByRole("dialog", { name: "Write to the radio" });
  await wd.getByRole("button", { name: /^Write 1 change$/ }).click();
  await expect(wd).toContainText("Read back: the radio holds the table.", { timeout: 60_000 });
  await wd.getByRole("button", { name: "Close" }).click();
});

test("cut off while writing: nothing lost; Finish the update starts again from Console's copy", async ({ page }) => {
  await connectWaiting(page, "live");
  await banner(page).getByRole("button", { name: "Finish the update…" }).click();
  const dialog = page.getByRole("dialog", { name: "Finish the update" });
  await dialog.getByRole("checkbox").uncheck();
  await dialog.getByRole("button", { name: "Finish the update", exact: true }).click();
  // Some way into the writes, the cable goes (as if pulled).
  await expect(dialog.getByRole("progressbar", { name: "Written" })).toBeVisible({ timeout: 120_000 });
  await expect.poll(() => page.evaluate(() => (window as any).ferrite.radio.phase), { timeout: 5_000 }).toBe("updating");
  await page.waitForTimeout(1500);
  await page.evaluate(() => (window as any).ferrite.radio.disconnect());
  await expect(dialog.getByRole("alert", { name: "Finish the update error" })).toContainText("Nothing is lost", { timeout: 20_000 });
  await page.keyboard.press("Escape");
  // Connected again (the radio didn't restart: it says 3 and 255, half moved, now), the banner is still there, and the next try
  // starts from Console's copy, never from the half-written chip.
  if (await page.getByRole("button", { name: "Bridge", exact: true }).isVisible()) await page.getByRole("button", { name: "Bridge", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Connected: Bridge", { timeout: 30_000 });
  await expect(banner(page)).toBeVisible({ timeout: 10_000 });
  expect(await page.evaluate(() => (window as any).ferrite.radio.hello.layouts)).toEqual({ firmware: 3, chip: 255 });
  await banner(page).getByRole("button", { name: "Finish the update…" }).click();
  await expect(dialog.locator('[data-k="kept"]')).toContainText("Console has this radio's backup");
  await dialog.getByRole("button", { name: "Finish the update", exact: true }).click();
  await expect(dialog.getByRole("region", { name: "Update finished" })).toBeVisible({ timeout: 200_000 });
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("status")).toContainText("Connected: Bridge", { timeout: 30_000 });
  const got = await readBack(page);
  expect(got.channels.length).toBe(1000);
  expect(got.zones).toContain("Repeaters 2");
});

test("a power cut right after the stamp's answer: nothing lost; Try again finishes", async ({ page }) => {
  // Decision 339: the simulator queues the store's writes as the radio does, and its restart after the stamp is a
  // power cut (`--cut-restart`): the stamp the radio answered was never written. On Nov 1, 2026 that formatted clear.
  b.stop();
  b = await startBridge(undefined, ["--flash", layout2Image(), "--cut-restart"]);
  await connectWaiting(page, "live");
  await banner(page).getByRole("button", { name: "Finish the update…" }).click();
  const dialog = page.getByRole("dialog", { name: "Finish the update" });
  await dialog.getByRole("checkbox").uncheck();
  await dialog.getByRole("button", { name: "Finish the update", exact: true }).click();
  // The radio comes back waiting (half moved, never formatted): Console says so and keeps its copy.
  await expect(dialog.getByRole("alert", { name: "Finish the update error" })).toContainText("before its stamp was written", { timeout: 200_000 });
  await expect(dialog.getByRole("alert", { name: "Finish the update error" })).toContainText("Console has the backup");
  await page.keyboard.press("Escape");
  if (await page.getByRole("button", { name: "Bridge", exact: true }).isVisible()) await page.getByRole("button", { name: "Bridge", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Connected: Bridge", { timeout: 30_000 });
  await expect(banner(page)).toBeVisible({ timeout: 10_000 });
  expect(await page.evaluate(() => (window as any).ferrite.radio.hello.layouts)).toEqual({ firmware: 3, chip: 255 });
  // Try again: from Console's copy (the simulator's restarts are plain ones from now on).
  await banner(page).getByRole("button", { name: "Finish the update…" }).click();
  await expect(dialog.locator('[data-k="kept"]')).toContainText("Console has this radio's backup");
  await dialog.getByRole("button", { name: "Finish the update", exact: true }).click();
  await expect(dialog.getByRole("region", { name: "Update finished" })).toBeVisible({ timeout: 200_000 });
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("status")).toContainText("Connected: Bridge", { timeout: 30_000 });
  expect(await page.evaluate(() => (window as any).ferrite.radio.hello.layouts)).toEqual({ firmware: 3, chip: 3 });
  const got = await readBack(page);
  expect(got.channels.length).toBe(1000);
  expect(got.zones).toContain("Repeaters 2");
});

/** A tiny Ferrite-looking image packed as tools/btf.py packs (as firmware.spec's). */
function testBtf(kb = 24): Buffer {
  const img = Buffer.alloc(kb * 1024 - 1024 - 100);
  for (let i = 0; i < img.length; i++) img[i] = (i * 7 + 3) & 0xff;
  img.writeUInt32LE(0x20018000, 0);
  img.writeUInt32LE(0x08003201, 4);
  img.write("RT-950      ", 0x3e0, "latin1");
  img.write("RT-950      ", 0x7e0, "latin1");
  img.write("Ferrite terminal", 0x900, "latin1");
  img.write("\0v9.8.7\0", 0xa00, "latin1");
  const raw = Buffer.concat([img.subarray(0, 0x400), Buffer.alloc(0x400), img.subarray(0x400)]);
  return Buffer.concat([raw, Buffer.alloc((1024 - (raw.length % 1024)) % 1024, 0xff)]);
}

test("an update whose firmware stores another layout moves the data as part of it (one flow)", async ({ page }) => {
  writeFileSync(b.fakeboot!, JSON.stringify({ deaf_ms: 300 }));
  await connectWaiting(page, "firmware");
  await page.getByLabel("Firmware file").setInputFiles({ name: "test.btf", mimeType: "application/octet-stream", buffer: testBtf() });
  await page.getByRole("button", { name: /^(Update|Install again)…$/ }).click();
  const wizard = page.getByRole("dialog", { name: "Update Ferrite" });
  await wizard.getByRole("checkbox").uncheck(); // the backup kept in Console only (no download)
  await wizard.getByRole("button", { name: "Update", exact: true }).click();
  // The blocks, the restart, then (HELLO: layout 3 firmware, layout 2 chip) the move, without another click.
  await expect(wizard.getByRole("region", { name: "Finish the update" })).toBeVisible({ timeout: 60_000 });
  await expect(wizard.getByRole("region", { name: "Update done" })).toBeVisible({ timeout: 200_000 });
  await expect(wizard.locator('[data-k="moved"]')).toContainText("1,000 channels");
  await wizard.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("status")).toContainText("Connected: Bridge", { timeout: 30_000 });
  await expect(banner(page)).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).ferrite.radio.hello.layouts)).toEqual({ firmware: 3, chip: 3 });
});
