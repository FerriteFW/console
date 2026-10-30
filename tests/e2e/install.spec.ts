// The Install wizard (#install) and Firmware › Back to stock (#/restore) against the bridge's fakes (tools/fakeboot.py): the bootloader, the reader's console
// and its dump (the Rust reader's fdumpz with coded chunks, BACKUP-9.6; hwtest's fdump), and Ferrite's STOCK_RESTORE; the simulator answers HELLO. The backup, saving it, the SSB patch
// from a synthetic stock file, the install; back to stock; the refusals. Never on a radio: Alex runs the radio checks
// by hand (docs/TESTING.md).
import { type Page, type Route } from "@playwright/test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, onRadio, shot, test } from "./helpers";

test.skip(onRadio(), "the fakes run on the simulator only");
test.setTimeout(150_000);

// A test can end with a fake holding the cable (the reader after a backup, the bootloader after a restore): the next
// test on this worker gets the simulator back.
test.afterEach(async ({ page }) => {
  await page.goto("about:blank");
  const url = process.env.FERRITE_E2E_BRIDGE!;
  for (let tries = 0; tries < 20; tries++) {
    const ok = await new Promise<boolean>((done) => {
      const ws = new WebSocket(url);
      ws.onmessage = (m) => {
        if (typeof m.data !== "string") return;
        const msg = JSON.parse(m.data);
        if (msg.bridge) ws.send(JSON.stringify({ reset_fake: true }));
        else if (msg.reset) {
          ws.close();
          done(true);
        }
      };
      ws.onerror = () => done(false);
      ws.onclose = () => done(false);
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 250)); // the page's connection is still closing
  }
  throw new Error("the bridge's fake didn't reset");
});

const modeFile = () => process.env.FERRITE_E2E_FAKEBOOT ?? "";
const dir = () => dirname(modeFile());
const results = () => JSON.parse(readFileSync(join(dir(), "mode.results.json"), "utf8"));
const dumpResult = () => JSON.parse(readFileSync(join(dir(), "mode.dump.json"), "utf8"));
const restoreResult = () => JSON.parse(readFileSync(join(dir(), "mode.restore.json"), "utf8"));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function setMode(m: Record<string, unknown>) {
  writeFileSync(modeFile(), JSON.stringify({ deaf_ms: 300, ...m }));
  for (const f of ["mode.result.json", "mode.results.json", "mode.restore.json", "mode.dump.json"]) if (existsSync(join(dir(), f))) rmSync(join(dir(), f));
}

/** A chip: noise, a non-blank calibration sector, a stretch of text (fdumpz's DEFLATE chunks) and one erased
 * (fdumpz's erased chunks), the update area erased (or holding a pending update). 2 MB (the reader takes 2, 4 or 8)
 * keeps the tests light; a pending update needs the 4 MB one. */
function chip(pending = false, mb = pending ? 4 : 2): Buffer {
  const b = Buffer.alloc(mb << 20);
  let s = 0x2545f491;
  for (let i = 0; i < b.length; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    b[i] = s & 0xff;
  }
  b.write("CH 042 145.4950 FM 12.5k Ferrite ".repeat(4096), 0x100000, "latin1");
  b.fill(0xff, 0x1c0000, 0x1e0000);
  if (mb >= 4) b.fill(0xff, 0x300000);
  if (pending) b.writeUInt16BE(0x5aa5, 0x300000);
  return b;
}

/** Packed as tools/btf.py packs (zero key: the text stays plain): 1 KB key block after 0x400, 0xFF to whole blocks. */
function pack(img: Buffer): Buffer {
  const raw = Buffer.concat([img.subarray(0, 0x400), Buffer.alloc(0x400), img.subarray(0x400)]);
  return Buffer.concat([raw, Buffer.alloc((1024 - (raw.length % 1024)) % 1024, 0xff)]);
}

function image(len: number, mark: string, version = "v9.8.7"): Buffer {
  const img = Buffer.alloc(len);
  for (let i = 0; i < len; i++) img[i] = (i * 7 + 3) & 0xff;
  img.writeUInt32LE(0x20018000, 0);
  img.writeUInt32LE(0x08003201, 4);
  img.write("RT-950      ", 0x3e0, "latin1");
  img.write("RT-950      ", 0x7e0, "latin1");
  img.write(mark, 0x900, "latin1");
  img.write(`\0${version}\0`, 0xa00, "latin1");
  return img;
}

const ferriteBtf = pack(image(24 * 1024 - 1124, "Ferrite terminal"));
/** The Rust reader (ferrite decision 264): fdump and fdumpz in its help; hwtest's has fdump only. */
const readerBtf = pack(image(12 * 1024, "fdump <addr> <len> [baud]\r\nfdumpz <addr> <len> [baud]", "v0.0.1"));
const hwtestBtf = pack(image(12 * 1024, "fdump <addr> <len> [baud]", "v0.0.1"));
/** The synthetic stock image of core/tests/fixtures (a run of patch records, nothing of Radtel's). */
const stockBtf = pack(readFileSync(new URL("../../core/tests/fixtures/ssb-synthetic.bin", import.meta.url)));

/** The bundled release, served to the page (the real one comes from scripts/bundle-firmware.mjs). */
async function serveRelease(page: Page, badSum = false, reader = readerBtf) {
  const files: Record<string, Buffer> = { "ferrite-test.btf": ferriteBtf, "reader-test.btf": reader };
  await page.route("**/firmware/**", (route: Route) => {
    const name = route.request().url().split("/firmware/")[1].split("?")[0];
    if (name === "manifest.json")
      return route.fulfill({
        json: {
          ferrite: { version: "v9.8.7", file: "ferrite-test.btf", sha256: badSum ? "00".repeat(32) : sha(ferriteBtf) },
          reader: { version: "reader", file: "reader-test.btf", sha256: sha(reader) },
        },
      });
    const b = files[name];
    return b ? route.fulfill({ body: b, contentType: "application/octet-stream" }) : route.fulfill({ status: 404 });
  });
}

/** The simulator's radio ID (sim/src/fake.rs; fakeboot's START answer says the same) and another radio's. */
const HERE = "R28JM FRR1S 27V4T WPTH0";
const named = (uid: string) => `rt950pro-backup-${uid.replaceAll(" ", "")}-20261022.bin`;

/** `picker`: a stand-in for Chrome's save dialog that counts its writes; otherwise none (the download). `at`: the
 * Install wizard (#install) or the Back to stock page. */
async function open(page: Page, picker = false, at: "install" | "restore" = "install") {
  await page.addInitScript((fake) => {
    const w = window as unknown as Record<string, unknown>;
    if (!fake) {
      Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true });
      return;
    }
    w.__writes = 0;
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: async (o: { suggestedName: string }) => {
        let data = new Blob();
        return {
          name: o.suggestedName,
          createWritable: async () => ({
            write: async (b: Blob) => {
              w.__writes = (w.__writes as number) + 1;
              data = b;
            },
            close: async () => {},
          }),
          getFile: async () => new File([data], o.suggestedName),
        };
      },
    });
  }, picker);
  if (at === "install") {
    await page.goto(`/?bridge=${encodeURIComponent(process.env.FERRITE_E2E_BRIDGE!)}#install`);
    await expect(wizard(page).getByRole("heading", { name: "Install Ferrite" })).toBeVisible();
    await wizard(page).getByRole("button", { name: "Bridge" }).click();
  } else {
    await page.goto(`/?bridge=${encodeURIComponent(process.env.FERRITE_E2E_BRIDGE!)}#/restore`);
    await page.getByRole("button", { name: "Look around without a radio" }).click();
    await card(page, "Back to stock").getByRole("button", { name: "Bridge" }).click();
  }
  await expect(page.locator('[data-k="port"]')).toContainText("Bridge");
}

const card = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const wizard = (page: Page) => page.getByRole("dialog", { name: "Install Ferrite" });
/** The wizard's step on screen (Connect, Back up, SSB, Install, Done). */
const step = (page: Page) => wizard(page).locator('[aria-current="step"]');

async function backUp(page: Page) {
  await wizard(page).getByRole("button", { name: "Back up the radio" }).click();
  await expect(wizard(page).getByRole("button", { name: "Save the backup…" })).toBeVisible({ timeout: 90_000 });
}

test("install: back up, save, SSB from the stock file, install with the patch", async ({ page }, info) => {
  const flash = chip();
  const flashPath = join(dir(), "flash.bin");
  writeFileSync(flashPath, flash);
  setMode({ flash: flashPath, corrupt_every: 37, cut_every: 53 });
  await serveRelease(page);
  await open(page);
  await expect(page.locator('[data-k="release"]')).toContainText("Ferrite v9.8.7"); // the Install tab's Advanced
  await expect(step(page)).toHaveText("Back up");
  await shot(page, info, "70-install-start");

  await backUp(page);
  const b = wizard(page);
  await expect(b.locator('[data-k="uid"]')).not.toHaveText("not reported");
  await expect(b.locator('[data-k="verified"]')).toContainText("matches the radio's");
  // The Rust reader's fdumpz: every kind of chunk crossed (erased, DEFLATE inflated by the browser, raw).
  const dump = dumpResult();
  expect(dump.z).toBe(true);
  expect(dump.kinds["1"]).toBeGreaterThan(0);
  expect(dump.kinds["4"]).toBeGreaterThan(0);
  expect(dump.kinds["0"]).toBeGreaterThan(0);
  // Nothing else until the file is saved (BACKUP-2).
  await expect(step(page)).toHaveText("Back up");
  await expect(b.getByRole("button", { name: "Install Ferrite" })).toHaveCount(0);
  await shot(page, info, "71-install-backup");

  const [dl] = await Promise.all([page.waitForEvent("download"), b.getByRole("button", { name: "Save the backup…" }).click()]);
  expect(dl.suggestedFilename()).toMatch(/^rt950pro-backup-[0-9A-Z]{20}-\d{8}\.bin$/);
  const saved = readFileSync(await dl.path());
  expect(saved.length).toBe(2 << 20);
  expect(sha(saved)).toBe(sha(flash));
  await b.getByRole("button", { name: "I have saved it" }).click();
  await expect(b.locator('[data-k="saved"]')).toContainText("saved");
  await expect(step(page)).toHaveText("SSB");

  await page.getByLabel("Stock firmware file").setInputFiles({ name: "RT_950Pro_test.BTF", mimeType: "application/octet-stream", buffer: stockBtf });
  await expect(page.locator('[data-k="ssb"]')).toContainText("1200 records");
  await expect(page.locator('[data-k="ssb"]')).toContainText("not one Ferrite knows");
  await b.getByRole("button", { name: "Continue" }).click();

  await expect(step(page)).toHaveText("Install");
  await expect(b).toContainText("with your SSB patch");
  await expect(b.locator('[data-k="release"]')).toHaveText("Ferrite v9.8.7");
  await b.getByRole("button", { name: "Install Ferrite" }).click();
  await expect(page.getByRole("region", { name: "Installed" })).toContainText("The radio runs Ferrite v", { timeout: 60_000 });
  // Done updating: the cable is Console's usual connection again, not held by Install (Alex, Oct 22).
  await expect(page.getByRole("region", { name: "Installed" })).toContainText("connected to it as usual", { timeout: 20_000 });
  await shot(page, info, "72-install-done");

  const rs = results();
  expect(rs.length).toBe(2);
  expect(rs[0].reader).toBe(true);
  expect(rs[0].sha256).toBe(sha(readerBtf));
  expect(rs[0].errors).toEqual([]);
  expect(rs[1].reader).toBe(false);
  expect(rs[1].errors).toEqual([]);
  expect(rs[1].blocks).toBeGreaterThan(ferriteBtf.length / 1024 + 9); // the patch (9.6 KB) is in it
});

test("install: Chrome's save dialog saves the backup once and reads it back", async ({ page }) => {
  const flashPath = join(dir(), "flash.bin");
  writeFileSync(flashPath, chip());
  setMode({ flash: flashPath, corrupt_every: 97 });
  await serveRelease(page, false, hwtestBtf); // hwtest's reader: plain fdump
  await open(page, true);
  await backUp(page);
  expect(dumpResult().z).toBe(false);
  const b = wizard(page);
  let downloads = 0;
  page.on("download", () => downloads++);
  await b.getByRole("button", { name: "Save the backup…" }).click();
  await expect(b.locator('[data-k="saved"]')).toContainText(/saved: rt950pro-backup-[0-9A-Z]{20}-\d{8}\.bin/);
  expect(await page.evaluate(() => (window as unknown as { __writes: number }).__writes)).toBe(1);
  expect(downloads).toBe(0);
  await expect(step(page)).toHaveText("SSB");
});

test("install: a pending phone update is refused after the backup; a bad checksum isn't used", async ({ page }) => {
  const flashPath = join(dir(), "flash-pending.bin");
  writeFileSync(flashPath, chip(true));
  setMode({ flash: flashPath, no_fdumpz: true }); // a reader that answers `?` to fdumpz: plain fdump instead
  await serveRelease(page, true);
  await open(page);
  const w = wizard(page);
  await expect(page.getByText("doesn't match its checksum").first()).toBeAttached();
  await backUp(page);
  await expect(w).toContainText("A stock phone or Bluetooth update is waiting");
  expect(dumpResult().z).toBe(false);
  const [dl] = await Promise.all([page.waitForEvent("download"), w.getByRole("button", { name: "Save the backup…" }).click()]);
  await dl.path();
  // Once: the button is gone, only "Download again" downloads again (a second file was finding 2 of Oct 22).
  await expect(w.getByRole("button", { name: "Save the backup…" })).toHaveCount(0);
  await expect(w.getByRole("button", { name: "Download again" })).toBeVisible();
  // Proving the save by picking the file again works too.
  await page.getByLabel("Saved backup").setInputFiles({ name: "saved.bin", mimeType: "application/octet-stream", buffer: chip(true) });
  await expect(w.locator('[data-k="saved"]')).toContainText("saved.bin");
  await w.getByRole("button", { name: "Skip" }).click();
  await expect(w.locator('[data-k="install-block"]')).toContainText("update is waiting");
  await expect(w.getByRole("button", { name: "Install Ferrite" })).toBeDisabled();
  expect(results().length).toBe(1); // the reader only
});

test("back to stock: the backup into Ferrite's ranges, never calibration or the update area, then the stock file (a renamed backup needs the radio's ID typed)", async ({ page }, info) => {
  const flash = chip(false, 4); // 4 MB: the update area is there to be left alone
  const flashPath = join(dir(), "flash.bin");
  writeFileSync(flashPath, flash);
  setMode({ flash: flashPath });
  await serveRelease(page);
  await open(page, false, "restore");
  const back = card(page, "Back to stock");
  await expect(back.locator('[data-k="restore-block"]')).toHaveText("Drop in your backup.");
  await page.getByLabel("Backup file").setInputFiles({ name: "backup.bin", mimeType: "application/octet-stream", buffer: flash });
  await page.getByLabel("Stock firmware for Back to stock").setInputFiles({ name: "stock.BTF", mimeType: "application/octet-stream", buffer: stockBtf });
  await expect(back.locator('[data-k="restore-block"]')).toHaveCount(0);
  await expect(back.locator('[data-k="restore-id"]')).toContainText("doesn't know which radio");
  // Decision 263: Console doesn't know this file's radio: refused before anything stops, until the ID is typed.
  await back.getByRole("button", { name: "Back to stock" }).click();
  await expect(back.getByRole("alert")).toContainText("can't tell which radio", { timeout: 20_000 });
  await expect(back.getByRole("alert")).toContainText("Nothing was written");
  expect(existsSync(join(dir(), "mode.restore.json"))).toBe(false); // START never went
  const confirm = back.getByRole("group", { name: "Confirm the radio" });
  await expect(confirm).toContainText(HERE);
  await confirm.getByLabel("This radio's ID").fill(HERE.toLowerCase().replaceAll(" ", ""));
  await shot(page, info, "73-restore-ready");
  await back.getByRole("button", { name: "Back to stock" }).click();
  await expect(page.getByRole("region", { name: "Back on stock" })).toBeVisible({ timeout: 120_000 });
  await shot(page, info, "74-restore-done");

  const r = restoreResult();
  expect(r.errors).toEqual([]);
  expect(r.equal).toBe(true);
  expect(r.cal_untouched).toBe(true);
  expect(r.update_untouched).toBe(true);
  expect(r.erased).toBe((0x76000 - 0x2c000 + 0x20000) / 4096);
  const rs = results();
  expect(rs[rs.length - 1].sha256).toBe(sha(stockBtf));
});

test("back to stock: another radio's backup is refused though its calibration is the same", async ({ page }) => {
  const flashPath = join(dir(), "flash.bin");
  writeFileSync(flashPath, chip());
  setMode({ flash: flashPath });
  await serveRelease(page);
  await open(page, false, "restore");
  // Byte-identical calibration (as on Alex's two radios, Oct 22): only the ID tells them apart (decision 263).
  await page.getByLabel("Backup file").setInputFiles({ name: named("248H2 49248 H24CS K6CSG"), mimeType: "application/octet-stream", buffer: chip() });
  await expect(card(page, "Back to stock").locator('[data-k="restore-id"]')).toContainText("248H2 49248 H24CS K6CSG");
  await page.getByLabel("Stock firmware for Back to stock").setInputFiles({ name: "stock.BTF", mimeType: "application/octet-stream", buffer: stockBtf });
  await card(page, "Back to stock").getByRole("button", { name: "Back to stock" }).click();
  await expect(card(page, "Back to stock").getByRole("alert")).toContainText("from another radio (ID 248H2", { timeout: 20_000 });
  await expect(card(page, "Back to stock").getByRole("alert")).toContainText("Nothing was written");
  await expect(card(page, "Back to stock").getByRole("group", { name: "Confirm the radio" })).toHaveCount(0);
  expect(existsSync(join(dir(), "mode.restore.json"))).toBe(false); // START never went
});

test("back to stock: a damaged backup (calibration differs) is refused before anything is written", async ({ page }) => {
  const flashPath = join(dir(), "flash.bin");
  writeFileSync(flashPath, chip());
  setMode({ flash: flashPath });
  await serveRelease(page);
  await open(page, false, "restore");
  const other = chip();
  other.fill(0x11, 0xf000, 0x10000);
  await page.getByLabel("Backup file").setInputFiles({ name: named(HERE), mimeType: "application/octet-stream", buffer: other });
  await page.getByLabel("Stock firmware for Back to stock").setInputFiles({ name: "stock.BTF", mimeType: "application/octet-stream", buffer: stockBtf });
  await card(page, "Back to stock").getByRole("button", { name: "Back to stock" }).click();
  await expect(card(page, "Back to stock").getByRole("alert")).toContainText("calibration sector doesn't match", { timeout: 20_000 });
  await expect(card(page, "Back to stock").getByRole("alert")).toContainText("Nothing was written");
  const r = restoreResult();
  expect(r.erased + r.programmed).toBe(0);
});
