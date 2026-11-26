// The Install wizard (#install) and Firmware › Back to stock (#/restore) against the bridge's fakes (tools/fakeboot.py): the bootloader, the reader's console
// and its dump (the Rust reader's fdumpz with coded chunks, BACKUP-9.6; hwtest's fdump), and Ferrite's STOCK_RESTORE; the simulator answers HELLO. The backup, saving it, the SSB patch
// from a synthetic stock file, the install; back to stock; the refusals. Never on a radio: Alex runs the radio checks
// by hand (docs/TESTING.md).
import { createZip, readZip } from "../../src/lib/zip";
import { type Page, type Route } from "@playwright/test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { allowUnsigned, expect, onRadio, shot, test } from "./helpers";

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
  await allowUnsigned(page); // the e2e build's reader, restorer and test firmware are local and unsigned (UPD-27)
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
  setMode({ flash: flashPath, corrupt_every: 37, cut_every: 53, marker: "55563835" + "FF".repeat(12) }); // stock's UV85 (BACKUP-12)
  await serveRelease(page);
  await open(page);
  await expect(page.locator('[data-k="release"]')).toContainText("Ferrite v9.8.7"); // the Install tab's Advanced
  await expect(step(page)).toHaveText("Back up");
  await shot(page, info, "70-install-start");

  await backUp(page);
  const b = wizard(page);
  await expect(b.locator('[data-k="uid"]')).not.toHaveText("not reported");
  await expect(b.locator('[data-k="verified"]')).toContainText("matches the radio's");
  await expect(b.locator('[data-k="marker"]')).toContainText("UV85"); // BACKUP-12.1: read with mdump
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
  expect(dl.suggestedFilename()).toMatch(/^rt950pro-backup-[0-9A-Z]{20}-\d{8}-\d{6}-UV85\.fbin$/); // the marker travels in the name
  // Decision 407: one zip, the SPI flash as spi.bin and a manifest (no icons.bin: the fake radio's area is erased).
  const z = await readZip(readFileSync(await dl.path()));
  const saved = Buffer.from(z.get("spi.bin")!);
  expect(saved.length).toBe(2 << 20);
  expect(sha(saved)).toBe(sha(flash));
  const mf = JSON.parse(new TextDecoder().decode(z.get("manifest.json")!));
  expect(mf).toMatchObject({ format: "ferrite-backup", version: 1, marker: "55563835" + "ff".repeat(12), icons: null });
  expect(mf.spi.sha256).toBe(sha(flash));
  expect(z.has("icons.bin")).toBe(false);
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

test("install: a refused reader says why on Back up before it is pressed (console#102)", async ({ page }) => {
  const flashPath = join(dir(), "flash.bin");
  writeFileSync(flashPath, chip());
  setMode({ flash: flashPath });
  await serveRelease(page);
  await open(page);
  await expect(step(page)).toHaveText("Back up");
  const go = wizard(page).getByRole("button", { name: "Back up the radio" });
  await expect(go).toBeEnabled();
  // Allow unsigned files off: the e2e build's unsigned reader is refused (UPD-27).
  await page.evaluate(async () => {
    const f = (window as any).ferrite;
    await f.firmware.setDevUnsigned(false);
    f.install.recheckFerrite();
  });
  await expect(wizard(page).locator('[data-k="reader-problem"]')).toContainText("Allow unsigned files");
  await expect(go).toBeDisabled();
  await allowUnsigned(page);
  await expect(wizard(page).locator('[data-k="reader-problem"]')).toHaveCount(0);
  await expect(go).toBeEnabled();
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
  await expect(b.locator('[data-k="saved"]')).toContainText(/saved: rt950pro-backup-[0-9A-Z]{20}-\d{8}-\d{6}\.fbin/);
  expect(await page.evaluate(() => (window as unknown as { __writes: number }).__writes)).toBe(1);
  expect(downloads).toBe(0);
  await expect(step(page)).toHaveText("SSB");
});

test("install: a copy that passes every chunk but not the radio's CRC is read again at 115200, and then kept", async ({ page }) => {
  // An Intel Mac's report (Nov 16, 2026): "SPI flash CRC" on the backup. The first read here differs by one byte.
  const flashPath = join(dir(), "flash.bin");
  writeFileSync(flashPath, chip());
  setMode({ flash: flashPath, wrong_first_dump: true });
  await serveRelease(page);
  // BACKUP-9.6 (Nov 25, 2026): both reads at the cable's 115200, High speed or not: no rate switch.
  await page.addInitScript(() => localStorage.setItem("ferrite-console-cable-high-speed", "on"));
  await open(page);
  await backUp(page);
  const d = dumpResult() as { z: boolean; rates: number[] };
  expect(d.z).toBe(true);
  expect(d.rates).toEqual([115200, 115200]);
  await expect(wizard(page).getByText(/read twice/)).toHaveCount(0);
});

test("install: a reader that answers \"?\" to the icons and nothing to fdump: the debug log says what it heard", async ({ page }) => {
  // Two Windows debug logs (Nov 17, 2026): icons "not read" in 0.2 s, then "no answer to fdump"; the log couldn't tell
  // a "?" from silence. Now each failed step logs the radio's last words.
  const flashPath = join(dir(), "flash.bin");
  writeFileSync(flashPath, chip());
  setMode({ flash: flashPath, garble_long: true });
  await serveRelease(page);
  await open(page);
  await wizard(page).getByRole("button", { name: "Back up the radio" }).click();
  await expect(wizard(page).getByText(/no answer to fdump/)).toBeVisible({ timeout: 90_000 });
  const log = (await page.evaluate(() => (window as any).ferrite.debugLines())).join("\n");
  expect(log).toMatch(/backup: icons reply ended, \d+ chars: first .*\?  \(help\)/);
  expect(log).toMatch(/backup: fdumpz at 115200: no answer; heard "/);
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
  await page.getByLabel("Backup file").setInputFiles({ name: "backup-BJ90.bin", mimeType: "application/octet-stream", buffer: flash });
  await page.getByLabel("Stock firmware for Back to stock").setInputFiles({ name: "stock.BTF", mimeType: "application/octet-stream", buffer: stockBtf });
  await expect(back.locator('[data-k="restore-block"]')).toHaveCount(0);
  await expect(back.locator('[data-k="restore-id"]')).toContainText("doesn't know which radio");
  await expect(back.locator('[data-k="restore-marker"]')).toContainText("BJ90 goes back"); // BACKUP-12: from the name
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
  // BACKUP-12.2: the stock image padded with 0xFF through 0x080F07FF (image 0xED800), the saved marker at 0xED000.
  const padded = Buffer.alloc(0xed800, 0xff);
  readFileSync(new URL("../../core/tests/fixtures/ssb-synthetic.bin", import.meta.url)).copy(padded);
  padded.write("BJ90", 0xed000, "latin1");
  const rs = results();
  expect(rs[rs.length - 1].sha256).toBe(sha(pack(padded)));
  expect(rs[rs.length - 1].blocks).toBe(951);
});

/** Stock's menu tiles as a radio that never had Ferrite holds them (BACKUP-12.3): 24 of 58 x 58, a flat background. */
function tiles(): Buffer {
  const b = Buffer.alloc(161_472);
  for (let t = 0, o = 0; t < 24; t++)
    for (let y = 0; y < 58; y++)
      for (let x = 0; x < 58; x++, o += 2) b.writeUInt16LE(x >= 16 && x < 42 && y >= 16 && y < 42 ? 0xf800 ^ t : 0x0841, o);
  return b;
}

test("menu icons: the backup reads stock's tiles and keeps them for back to stock", async ({ page }) => {
  // BACKUP-12.3 (ferrite decision 406): stock draws its main menu's tiles from MCU 0x08080000, which every Ferrite
  // image writes over; a stock .BTF doesn't bring them back (black, Nov 16, 2026).
  const flash = chip(false, 4);
  const flashPath = join(dir(), "flash.bin");
  writeFileSync(flashPath, flash);
  const icons = tiles();
  const iconsPath = join(dir(), "icons.bin");
  writeFileSync(iconsPath, icons);
  setMode({ flash: flashPath, icons: iconsPath });
  await serveRelease(page);
  await open(page);
  await backUp(page);
  await expect(wizard(page).locator('[data-k="icons"]')).toContainText("stock's, kept with this backup");
  // Decision 407: the saved .fbin carries them.
  const [dl] = await Promise.all([page.waitForEvent("download"), wizard(page).getByRole("button", { name: "Save the backup…" }).click()]);
  const z = await readZip(readFileSync(await dl.path()));
  expect(sha(Buffer.from(z.get("icons.bin")!))).toBe(sha(icons));
  expect(JSON.parse(new TextDecoder().decode(z.get("manifest.json")!)).icons.sha256).toBe(sha(icons));

});

test("menu icons: the marker's `dump: end` in a later read doesn't end the icon read", async ({ page }) => {
  // Two Windows logs and a Linux one (Nov 17, 2026): icons "not read" in 0.2 s, then "no answer to fdump". The marker's
  // reply came in two reads; its late `dump: end` finished the icon read at once, while the radio was still sending
  // the icons (35 s) and couldn't hear fdumpz.
  const flashPath = join(dir(), "flash.bin");
  writeFileSync(flashPath, chip(false, 4));
  const icons = tiles();
  const iconsPath = join(dir(), "icons.bin");
  writeFileSync(iconsPath, icons);
  setMode({ flash: flashPath, icons: iconsPath, split_marker: true });
  await serveRelease(page);
  await open(page);
  await backUp(page);
  await expect(wizard(page).locator('[data-k="icons"]')).toContainText("stock's, kept with this backup");
});

test("menu icons: back to stock puts an icons file's tiles back at 0x08080000", async ({ page }) => {
  const flash = chip(false, 4);
  const flashPath = join(dir(), "flash.bin");
  writeFileSync(flashPath, flash);
  setMode({ flash: flashPath });
  await serveRelease(page);
  await open(page, false, "restore");
  const back = card(page, "Back to stock");
  const icons = tiles();
  await page.getByLabel("Backup file").setInputFiles({ name: "backup-BJ90.bin", mimeType: "application/octet-stream", buffer: flash });
  await page.getByLabel("Stock firmware for Back to stock").setInputFiles({ name: "stock.BTF", mimeType: "application/octet-stream", buffer: stockBtf });
  await page.getByLabel("Menu icons file").setInputFiles({ name: "rt950pro-menu-icons-X.bin", mimeType: "application/octet-stream", buffer: icons });
  await expect(back.locator('[data-k="restore-icons"]')).toHaveText("From the icons file: they go back too.");
  await back.getByRole("button", { name: "Back to stock" }).click();
  const confirm = back.getByRole("group", { name: "Confirm the radio" });
  await expect(confirm).toBeVisible({ timeout: 20_000 });
  await confirm.getByLabel("This radio's ID").fill(HERE);
  await back.getByRole("button", { name: "Back to stock" }).click();
  await expect(page.getByRole("region", { name: "Back on stock" })).toBeVisible({ timeout: 120_000 });
  // The stock image padded through 0x080F07FF: the marker, and the tiles at image offset 0x7D000.
  const padded = Buffer.alloc(0xed800, 0xff);
  readFileSync(new URL("../../core/tests/fixtures/ssb-synthetic.bin", import.meta.url)).copy(padded);
  icons.copy(padded, 0x7d000);
  padded.write("BJ90", 0xed000, "latin1");
  const rs = results();
  expect(rs[rs.length - 1].sha256).toBe(sha(pack(padded)));
});

test("back to stock from one .fbin: the backup, the radio's ID and the menu icons from the file", async ({ page }) => {
  // Decision 407: no ID to type (the manifest's), the tiles back at 0x7D000, the marker from the manifest.
  const flash = chip(false, 4);
  const icons = tiles();
  const manifest = {
    format: "ferrite-backup",
    version: 1,
    radio_id: HERE,
    saved: "2026-11-16T20:00:00Z",
    console: "0.9.3",
    chip: "Zbit 5E4016, 4096 KB",
    spi: { file: "spi.bin", bytes: flash.length, sha256: sha(flash), crc32: "0" },
    marker: "55563835" + "ff".repeat(12),
    icons: { file: "icons.bin", bytes: icons.length, sha256: sha(icons) },
  };
  const file = Buffer.from(
    await (
      await createZip([
        { name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest)) },
        { name: "spi.bin", data: flash },
        { name: "icons.bin", data: icons },
      ])
    ).arrayBuffer(),
  );
  const flashPath = join(dir(), "flash.bin");
  writeFileSync(flashPath, flash);
  setMode({ flash: flashPath });
  await serveRelease(page);
  await open(page, false, "restore");
  const back = card(page, "Back to stock");
  await page.getByLabel("Backup file").setInputFiles({ name: "rt950pro-backup-X-20261116.fbin", mimeType: "application/zip", buffer: file });
  await page.getByLabel("Stock firmware for Back to stock").setInputFiles({ name: "stock.BTF", mimeType: "application/octet-stream", buffer: stockBtf });
  await expect(back.locator('[data-k="restore-icons"]')).toHaveText("Kept with this backup: they go back too.");
  await expect(back.locator('[data-k="restore-marker"]')).toContainText("UV85 goes back");
  await back.getByRole("button", { name: "Back to stock" }).click();
  await expect(page.getByRole("region", { name: "Back on stock" })).toBeVisible({ timeout: 120_000 });
  const padded = Buffer.alloc(0xed800, 0xff);
  readFileSync(new URL("../../core/tests/fixtures/ssb-synthetic.bin", import.meta.url)).copy(padded);
  icons.copy(padded, 0x7d000);
  padded.write("UV85", 0xed000, "latin1");
  const rs = results();
  expect(rs[rs.length - 1].sha256).toBe(sha(pack(padded)));
  // A damaged one is refused before anything: its spi.bin isn't the manifest's.
  const bad = Buffer.from(await (await createZip([{ name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest)) }, { name: "spi.bin", data: chip(false, 2) }])).arrayBuffer());
  await page.getByLabel("Backup file").setInputFiles({ name: "bad.fbin", mimeType: "application/zip", buffer: bad });
  await expect(back.locator('[data-k="restore-block"]')).toContainText("doesn't match its manifest");
});

test("menu icons: a file of them is taken for back to stock; a file that isn't them is refused", async ({ page }) => {
  setMode({ flash: join(dir(), "none.bin") });
  await serveRelease(page);
  await open(page, false, "restore");
  const back = card(page, "Back to stock");
  await expect(back.locator('[data-k="restore-icons"]')).toContainText("the tiles stay blank on stock");
  await expect(back.locator('[data-k="restore-icons-v030"]')).toContainText("RT_950Pro_ICON_V0.30_261117.BTF"); // Radtel's file carries them
  await page.getByLabel("Menu icons file").setInputFiles({ name: "code.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(161_472, 0x5a).map((x, i) => (x + i * 7) & 0xff) });
  await expect(back).toContainText("code.bin isn't stock's menu icons");
  await page.getByLabel("Menu icons file").setInputFiles({ name: "rt950pro-menu-icons-X.bin", mimeType: "application/octet-stream", buffer: tiles() });
  await expect(back.locator('[data-k="restore-icons"]')).toHaveText("From the icons file: they go back too.");
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
