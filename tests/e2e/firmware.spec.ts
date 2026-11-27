// Firmware › Update (the page, then the Check → Update → Done wizard) against the simulator and the bridge's fake bootloader (tools/fakeboot.py): the file
// checks, REBOOT (LINK-24), the probes, every block, the reconnect; a NAK'd block and Resume; REBOOT refused busy.
// Never on a radio: only Alex flashes, by hand (docs/TESTING.md).
import { type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "../../src/lib/zip";
import { allowUnsigned, closeWelcome, connect, disconnect, expect, onRadio, openConsole, shot, test } from "./helpers";

// The worker's bridge sets the mode file once its fixture has run, so it is read when a test runs.
const modeFile = () => process.env.FERRITE_E2E_FAKEBOOT ?? "";
test.skip(onRadio(), "the fake bootloader runs on the simulator only");
// The wizard closes with Esc once nothing is running (a finished or refused update), then the cable is let go.
test.afterEach(async ({ page }) => {
  await page.keyboard.press("Escape");
  await disconnect(page);
});

const resultPath = () => join(dirname(modeFile()), "mode.result.json");
function setMode(m: Record<string, unknown>) {
  writeFileSync(modeFile(), JSON.stringify({ deaf_ms: 300, ...m }));
  if (existsSync(resultPath())) rmSync(resultPath());
}
const result = () => JSON.parse(readFileSync(resultPath(), "utf8"));

/** A tiny Ferrite-looking image packed as tools/btf.py packs (zero key, 0xFF to whole blocks). */
function testBtf(kb = 24, opts: { ferrite?: boolean; tag?: boolean } = {}): Buffer {
  const img = Buffer.alloc(kb * 1024 - 1024 - 100);
  for (let i = 0; i < img.length; i++) img[i] = (i * 7 + 3) & 0xff;
  img.writeUInt32LE(0x20018000, 0);
  img.writeUInt32LE(0x08003201, 4);
  img.write("RT-950      ", 0x3e0, "latin1");
  img.write(opts.tag === false ? "XX-950      " : "RT-950      ", 0x7e0, "latin1");
  if (opts.ferrite !== false) img.write("Ferrite terminal", 0x900, "latin1");
  img.write("\0v9.8.7\0", 0xa00, "latin1");
  const raw = Buffer.concat([img.subarray(0, 0x400), Buffer.alloc(0x400), img.subarray(0x400)]);
  return Buffer.concat([raw, Buffer.alloc((1024 - (raw.length % 1024)) % 1024, 0xff)]);
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const ferrite = fileURLToPath(new URL("../../../ferrite", import.meta.url));

/** An SPI part as ferrite-core's `part` writes it: its 32-byte header (magic, format 1, the build ID, length, CRC). */
function part(magic: string, body: Buffer, build: string): Buffer {
  const h = Buffer.alloc(32);
  h.write(magic, 0, "latin1");
  h.writeUInt16LE(1, 4);
  h.write(build, 8, "latin1");
  h.writeUInt32LE(body.length, 24);
  h.writeUInt32LE(crc32(body) >>> 0, 28);
  return Buffer.concat([h, body]);
}

/** An unsigned `.ffw` (a local build's), packed by ferrite's own tools/ffw.py: the image and two small parts, or
 * the image alone (`parts` false). */
function testFfw(btf: Buffer, parts = true): Buffer {
  const d = mkdtempSync(join(tmpdir(), "ferrite-ffw-"));
  const build = "e2e0001";
  writeFileSync(join(d, "x.btf"), btf);
  if (parts) {
    writeFileSync(join(d, "text-en.bin"), part("FTXT", Buffer.from("\x01\x00\x00\x00\x08\x00\x00\x02hi", "latin1"), build));
    writeFileSync(join(d, "logo.bin"), part("FLGO", Buffer.alloc(300, 0x5a), build));
    writeFileSync(join(d, "parts.json"), JSON.stringify([
      { file: "text-en.bin", magic: "FTXT", addr: 0x090000, max: 0x10000 },
      { file: "logo.bin", magic: "FLGO", addr: 0x240000, max: 0x8000 },
    ]));
  }
  const r = spawnSync("python3", [`${ferrite}/tools/ffw.py`, "pack", join(d, "x.ffw"), "--btf", join(d, "x.btf"), ...(parts ? ["--parts", d] : []), "--kind", "tx", "--build", build, "--version", "9.8.7"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffw.py: ${r.stderr}`);
  const b = readFileSync(join(d, "x.ffw"));
  rmSync(d, { recursive: true, force: true });
  return b;
}

async function pickFile(page: Page, name: string, buffer: Buffer) {
  await page.getByLabel("Firmware file").setInputFiles({ name, mimeType: "application/octet-stream", buffer });
}
/** UPD-28: Update takes a .ffw by hand; the flash tests' images go in one with no parts (the image alone). */
const pickImage = (page: Page, name: string, btf: Buffer) => pickFile(page, name.replace(/\.btf$/i, ".ffw"), testFfw(btf, false));

const fact = (page: Page, k: string) => page.locator(`[data-k="${k}"]`);
/** The page's button: "Install again…" when the radio already has that version (the e2e build bundles one). */
const updateButton = (page: Page) => page.getByRole("button", { name: /^(Update|Install again)…$/ });
const wizard = (page: Page) => page.getByRole("dialog", { name: "Update Ferrite" });
/** The page's Update button, after its power-cycle box when a radio on 0.9.4 or earlier asks for one (the simulator
 * says v0.9.4 until the release). */
async function pressUpdate(page: Page) {
  const box = page.locator('[data-k="power-cycled"]');
  if (await box.count()) await box.check();
  await updateButton(page).click();
}
/** The page's Update button, then the wizard's Update: the update starts. */
async function update(page: Page) {
  await pressUpdate(page);
  await wizard(page).getByRole("button", { name: "Update", exact: true }).click();
}

/** A one-second video (ffmpeg), for the update video's place; null without ffmpeg. */
function tinyMp4(): Buffer | null {
  const out = join(mkdtempSync(join(tmpdir(), "vid-")), "v.mp4");
  const r = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=navy:s=320x180:d=1", "-pix_fmt", "yuv420p", "-y", out]);
  return r.status === 0 && existsSync(out) ? readFileSync(out) : null;
}

test("firmware: a whole update through the fake bootloader, then connected again", async ({ page }, info) => {
  setMode({});
  const btf = testBtf(24);
  // The update's feature video (ferritefw.dev's list names it): a short clip here, so it shows while the update runs
  const clip = tinyMp4();
  await page.route("**/video/index.json", (route) => route.fulfill({ json: { update: "clip", videos: [] } }));
  await page.route("**/video/clip.jpg", (route) => route.abort());
  if (clip) await page.route("**/video/clip.mp4", (route) => route.fulfill({ body: clip, contentType: "video/mp4" }));
  else await page.route("**/video/clip.mp4", (route) => route.abort());
  await openConsole(page, "firmware");
  await allowUnsigned(page); // local, unsigned images (UPD-27)
  await connect(page);
  await pickImage(page, "ferrite-test.btf", btf);
  await expect(fact(page, "version")).toHaveText("v9.8.7");
  await expect(fact(page, "blocks")).toHaveText("24");
  // No .minisig: someone's own build, allowed.
  await expect(fact(page, "signature")).toHaveText("Not signed: not a Ferrite release");
  await shot(page, info, "60-firmware-checked");

  await pressUpdate(page);
  const w = wizard(page);
  await expect(w.locator('[data-k="now"]')).toHaveText(/^v\d+\.\d+\.\d+/);
  await expect(w.locator('[data-k="new"]')).toHaveText("v9.8.7");
  await shot(page, info, "61-firmware-confirm");
  await w.getByRole("button", { name: "Update", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Firmware Update holds");
  // The feature video plays while it runs (hidden when it can't load: no ffmpeg here, or offline)
  const video = page.locator('[data-k="update-video"]');
  if (clip) {
    await expect(video).toBeVisible();
    await shot(page, info, "61b-firmware-video");
  } else await expect(video).toHaveCount(0);

  const done = page.getByRole("region", { name: "Update done" });
  await expect(done).toBeVisible({ timeout: 45_000 });
  await expect(video).toHaveCount(0); // gone when done
  await expect(done.locator('[data-k="after"]')).toHaveText(/^v\d+\.\d+\.\d+/);
  await expect(done).toContainText("The file said v9.8.7"); // the simulator keeps its own version
  await expect(page.getByRole("status")).toContainText("Connected: Bridge");
  await shot(page, info, "62-firmware-done");

  const r = result();
  expect(r.errors).toEqual([]);
  expect(r.blocks).toBe(24);
  expect(r.count).toBe(23);
  expect(r.sha256).toBe(sha(btf));
});

test("firmware: Add SSB on a radio without the patch: a file with none, and one with a patch Ferrite doesn't know, send nothing", async ({ page }) => {
  // INST-10.2 (decision 457): the radio says it holds no patch (SSB_WRITE CHECK, LINK-73). The tests have only
  // synthetic records (never the real patch), whose hash isn't the known one: Console refuses them before sending.
  setMode({});
  await openConsole(page, "firmware");
  await connect(page);
  const card = page.getByRole("region", { name: "SSB" });
  await expect(card.locator('[data-k="ssb-held"]')).toContainText("no SSB yet");
  const pick = (name: string, buffer: Buffer) => page.getByLabel("Stock firmware for SSB").setInputFiles({ name, mimeType: "application/octet-stream", buffer });
  await pick("ferrite-test.btf", testBtf(24));
  await expect(card.locator('[data-k="ssb-error"]')).toContainText("No SSB patch in ferrite-test.btf");
  const raw = readFileSync(new URL("../../core/tests/fixtures/ssb-synthetic.bin", import.meta.url));
  const packed = Buffer.concat([raw.subarray(0, 0x400), Buffer.alloc(0x400), raw.subarray(0x400)]);
  await pick("RT_950Pro_test.BTF", Buffer.concat([packed, Buffer.alloc((1024 - (packed.length % 1024)) % 1024, 0xff)]));
  await expect(card.locator('[data-k="ssb-error"]')).toContainText("not the one Ferrite knows");
  await expect(card.locator('[data-k="ssb-held"]')).toContainText("no SSB yet");
});

test("firmware: a radio older than the bundled release gets a link to Update in the top bar; the same or newer none", async ({ page }) => {
  setMode({});
  let bundled = "v9.8.7";
  await page.route("**/firmware/manifest.json*", (route) => route.fulfill({ json: { ferrite: { version: bundled, file: "x.btf", sha256: "00" } } }));
  await openConsole(page, "live");
  await connect(page);
  const link = page.locator('[data-k="newer"]');
  await expect(link).toHaveText("v9.8.7 available");
  await expect(link).toHaveAttribute("href", "#/firmware");
  await link.click();
  await expect(page.getByRole("heading", { name: "Update Ferrite" })).toBeVisible();
  await disconnect(page);
  bundled = "v0.0.1"; // older than any radio: nothing to say
  await page.reload();
  await closeWelcome(page);
  await connect(page);
  await expect(page.locator(".strip")).toBeVisible();
  await expect(link).toHaveCount(0);
});

test("firmware: the bundled release, checked by its SHA-256 (Ferrite to the next from the browser)", async ({ page }) => {
  setMode({});
  const btf = testBtf(24);
  let served = btf;
  await page.route("**/firmware/**", (route) => {
    const name = route.request().url().split("/firmware/")[1].split("?")[0];
    if (name === "manifest.json") return route.fulfill({ json: { ferrite: { version: "v9.8.7", file: "ferrite-rel.btf", sha256: sha(btf) } } });
    return name === "ferrite-rel.btf" ? route.fulfill({ body: served, contentType: "application/octet-stream" }) : route.fulfill({ status: 404 });
  });
  await openConsole(page, "firmware");
  await allowUnsigned(page); // local, unsigned images (UPD-27)
  await connect(page);
  // The page names the bundled release; the wizard loads and checks it.
  await expect(fact(page, "latest")).toHaveText("v9.8.7");
  await pressUpdate(page);
  await expect(wizard(page).locator('[data-k="new"]')).toHaveText("v9.8.7");
  await expect(wizard(page).getByRole("button", { name: "Update", exact: true })).toBeEnabled();
  await wizard(page).getByRole("button", { name: "Cancel" }).click();
  served = testBtf(25); // the file on the server isn't the one the manifest names
  await page.getByText("Advanced: install an update file (.ffw)").click();
  await page.getByRole("button", { name: "Back to the latest release" }).click();
  await expect(page.getByRole("alert", { name: "Update error" })).toContainText("doesn't match its checksum");
});

test("firmware: files the checks refuse can't be installed; a bare .btf isn't taken at all (UPD-28)", async ({ page }, info) => {
  await openConsole(page, "firmware");
  await allowUnsigned(page); // the images go in unsigned .ffws: their own checks refuse them (UPD-27 aside)
  await connect(page);
  const refused = page.getByRole("alert", { name: "File refused" });

  await pickImage(page, "stock.btf", testBtf(8, { ferrite: false }));
  await expect(refused).toContainText("not a Ferrite image");
  await expect(updateButton(page)).toBeDisabled();

  await pickImage(page, "broken.btf", testBtf(8, { tag: false }));
  await expect(refused).toContainText("Firmware Error!");
  await shot(page, info, "63-firmware-refused");

  await pickImage(page, "tiny.btf", Buffer.from("not a firmware file"));
  await expect(refused).toContainText("too short");

  // UPD-28: a bare .btf by hand is refused before any check (people used it to go back to stock or to an old
  // release, and for SSB): the message names where each goes. Even a good Ferrite image.
  const err = page.getByRole("alert", { name: "Update error" });
  await pickFile(page, "ferrite-test.btf", testBtf(8));
  await expect(err).toContainText("Update installs only a Ferrite update file (.ffw)");
  await expect(err).toContainText("Back to stock");
  await expect(err).toContainText("Add SSB");
  await expect(fact(page, "version")).toHaveCount(0); // never checked, never taken: Update offers only the bundled release
  await pickFile(page, "RT_950Pro_V0.30.BTF", testBtf(8, { ferrite: false }));
  await expect(err).toContainText("RT_950Pro_V0.30.BTF is a bare firmware image");
  await expect(fact(page, "version")).toHaveCount(0);

  // Not a firmware file at all: refused before the checks.
  await pickFile(page, "ferrite.bin", testBtf(8));
  await expect(err).toContainText("not a Ferrite update file (.ffw)");
});

test("firmware: a refused block leaves the radio in the bootloader; Resume finishes without REBOOT", async ({ page }, info) => {
  setMode({ nak_block: 5 });
  const btf = testBtf(16);
  await openConsole(page, "firmware");
  await allowUnsigned(page); // local, unsigned images (UPD-27)
  await connect(page);
  await pickImage(page, "ferrite-test.btf", btf);
  await update(page);

  const err = page.getByRole("alert", { name: "Update error" });
  await expect(err).toContainText("Block 6 of 16: flash write failed", { timeout: 30_000 });
  await expect(err).toContainText("stays in the bootloader");
  await expect(page.getByRole("status")).toContainText("Firmware Update holds");
  await shot(page, info, "64-firmware-nak");

  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("region", { name: "Update done" })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole("status")).toContainText("Connected: Bridge");
  const r = result();
  expect(r.naked).toBe(true);
  expect(r.errors).toEqual([]);
  expect(r.blocks).toBe(16);
  expect(r.sha256).toBe(sha(btf));
});

test("firmware: after giving up, the cable opened as it is finds the radio waiting in the bootloader", async ({ page }, info) => {
  setMode({ nak_block: 2 });
  const btf = testBtf(12);
  await openConsole(page, "firmware");
  await allowUnsigned(page); // local, unsigned images (UPD-27)
  await connect(page);
  await pickImage(page, "ferrite-test.btf", btf);
  await update(page);
  await expect(page.getByRole("alert", { name: "Update error" })).toContainText("Block 3 of 12", { timeout: 30_000 });
  await page.getByRole("button", { name: "Give up and disconnect" }).click();
  await expect(page.getByRole("status")).toContainText("Disconnected");
  await page.keyboard.press("Escape"); // nothing running: the wizard closes

  // A new session with no HELLO: only a radio already in update mode (E5) goes on.
  const recover = page.getByRole("region", { name: "Recover" });
  await expect(recover).toContainText("waiting in the bootloader");
  await shot(page, info, "65-firmware-recover");
  await recover.getByRole("button", { name: "Resume over the bridge" }).click();
  await expect(page.getByRole("region", { name: "Update done" })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole("status")).toContainText("Connected: Bridge");
  const r = result();
  expect(r.errors).toEqual([]);
  expect(r.blocks).toBe(12);
  expect(r.sha256).toBe(sha(btf));
});

test("firmware: REBOOT refused busy (transmitting) says so and keeps the connection", async ({ page }) => {
  setMode({ reboot: "busy" });
  await openConsole(page, "firmware");
  await allowUnsigned(page); // local, unsigned images (UPD-27)
  await connect(page);
  await pickImage(page, "ferrite-test.btf", testBtf(8));
  await update(page);
  await expect(page.getByRole("alert", { name: "Update error" })).toContainText("transmitting");
  await expect(page.getByRole("status")).toContainText("Connected: Bridge", { timeout: 20_000 });
  expect(existsSync(resultPath())).toBe(false);
  setMode({});
});

test("firmware: a .ffw: unsigned only with the developer option; the image, then its SPI parts by raw writes (UPD-21)", async ({ page }, info) => {
  test.setTimeout(150_000); // the image, its parts, and two restarts
  setMode({});
  const btf = testBtf(16);
  await openConsole(page, "firmware");
  await connect(page);
  await page.getByText("Advanced: install an update file (.ffw)").click();
  await pickFile(page, "ferrite-test.ffw", testFfw(btf));
  // A local build's file: refused until the developer option is on, then checked again.
  await expect(page.getByRole("alert", { name: "Update error" })).toContainText("unsigned");
  await page.getByLabel("Allow unsigned files").check();
  await expect(fact(page, "version")).toHaveText("v9.8.7");
  await expect(fact(page, "signature")).toHaveText("Not signed: not a Ferrite release");
  await expect(fact(page, "parts")).toContainText("text-en.bin");
  await shot(page, info, "63-firmware-ffw-checked");
  await update(page);
  const done = page.getByRole("region", { name: "Update done" });
  await expect(done).toBeVisible({ timeout: 120_000 });
  // The parts went in (not a passing message to catch: without compression they are quick).
  const parts = await page.evaluate(() => [(window as any).ferrite.firmware.partsDone, (window as any).ferrite.firmware.partsTotal]);
  expect(parts[1]).toBeGreaterThan(0);
  expect(parts[0]).toBe(parts[1]);
  await expect(page.getByRole("status")).toContainText("Connected: Bridge");
  const r = result();
  expect(r.errors).toEqual([]);
  expect(r.sha256).toBe(sha(btf));
});

test("firmware: SPI parts cut part way leave the radio half moved (255); installing again finishes it with no data move", async ({ page }) => {
  // An Intel Mac's update (Nov 17, 2026): the parts' raw writes stopped answering; the radio then said 255 and
  // "Finish the update" asked for a copy of data that was never moved. The mark says the writes began from this
  // layout, so the update goes straight to the parts, whose stamp clears it.
  test.setTimeout(240_000);
  setMode({});
  const btf = testBtf(16);
  await openConsole(page, "firmware");
  await connect(page);
  await page.getByText("Advanced: install an update file (.ffw)").click();
  await page.getByLabel("Allow unsigned files").check();
  await pickFile(page, "ferrite-test.ffw", testFfw(btf));
  // The cable drops everything Console sends for 20 s once the parts are being written.
  await page.evaluate(() => {
    const w = window as any;
    const t = w.ferrite.radio.connectedLink.t;
    const orig = t.write.bind(t);
    t.write = (b: Uint8Array) => (w.__cutUntil && performance.now() < w.__cutUntil ? Promise.resolve() : orig(b));
  });
  await update(page);
  // Some of the parts' raw writes go through first (his log: 44 answered), then the cut.
  await expect.poll(() => page.evaluate(() => (window as any).ferrite.firmware.partsDone), { timeout: 90_000, intervals: [50] }).toBeGreaterThan(3);
  await page.evaluate(() => ((window as any).__cutUntil = performance.now() + 20_000));
  await expect(wizard(page)).toContainText("its SPI parts didn't go in", { timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => (window as any).ferrite.radio.hello?.layouts?.chip), { timeout: 20_000 }).toBe(255);
  await wizard(page).getByRole("button", { name: "Close" }).click();
  // Install again: no data move (it would need a copy), the parts, the stamp: the radio's layouts agree again.
  await update(page);
  await expect(page.getByRole("region", { name: "Update done" })).toBeVisible({ timeout: 120_000 });
  await expect.poll(() => page.evaluate(() => (window as any).ferrite.radio.hello?.layouts?.chip), { timeout: 20_000 }).toBe(3);
});

test("firmware: one frame lost in the SPI parts: a resync and the parts go on (no stall on compression)", async ({ page }) => {
  // The Intel Mac's update (Nov 17, 2026): one DATA_WRITE lost; the tries after it, compressed against windows now
  // apart, went unread. data() resyncs (HELLO) before trying again.
  test.setTimeout(240_000);
  setMode({});
  const btf = testBtf(16);
  await openConsole(page, "firmware");
  await connect(page);
  await page.getByText("Advanced: install an update file (.ffw)").click();
  await page.getByLabel("Allow unsigned files").check();
  await pickFile(page, "ferrite-test.ffw", testFfw(btf));
  await page.evaluate(() => {
    const w = window as any;
    const t = w.ferrite.radio.connectedLink.t;
    const orig = t.write.bind(t);
    t.write = (b: Uint8Array) => (w.__dropOne ? ((w.__dropOne = false), (w.__dropped = true), Promise.resolve()) : orig(b));
  });
  await update(page);
  await expect.poll(() => page.evaluate(() => (window as any).ferrite.firmware.partsDone), { timeout: 90_000, intervals: [50] }).toBeGreaterThan(3);
  await page.evaluate(() => ((window as any).__dropOne = true));
  await expect(page.getByRole("region", { name: "Update done" })).toBeVisible({ timeout: 120_000 });
  expect(await page.evaluate(() => (window as any).__dropped)).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).ferrite.radio.hello?.layouts?.chip)).toBe(3);
});

test("firmware: a radio on 0.9.4 or earlier is turned off and on before Update (some radios' memory chips stick)", async ({ page }, info) => {
  setMode({});
  await openConsole(page, "firmware");
  await connect(page);
  const warn = page.locator('[data-k="power-cycle"]');
  const radioSays = (await page.locator('[data-k="now"]').first().textContent()) ?? "";
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(radioSays.trim());
  const older = !!m && (Number(m[1]) * 1e6 + Number(m[2]) * 1e3 + Number(m[3])) < 9005;
  if (!older) {
    await expect(warn).toHaveCount(0); // 0.9.5 and later: no warning
    return;
  }
  await expect(warn).toBeVisible();
  await expect(warn).toContainText("Turn the radio off and on before updating.");
  await expect(updateButton(page)).toBeDisabled();
  await shot(page, info, "66-firmware-power-cycle");
  await page.locator('[data-k="power-cycled"]').check();
  await expect(updateButton(page)).toBeEnabled();
});

test("firmware: an update video that can't load shows nothing, and the update goes on", async ({ page }) => {
  setMode({});
  await page.route("**/video/index.json", (route) => route.abort()); // offline: no list, no video
  await openConsole(page, "firmware");
  await allowUnsigned(page); // a local, unsigned test image (UPD-27)
  await connect(page);
  await pickImage(page, "ferrite-test.btf", testBtf(24));
  await update(page);
  await expect(page.getByRole("status")).toContainText("Firmware Update holds");
  await expect(page.locator('[data-k="update-video"]')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByRole("region", { name: "Update done" })).toBeVisible({ timeout: 45_000 });
});

test("firmware: the update video's Hide hides it for this update", async ({ page }) => {
  setMode({});
  const clip = tinyMp4();
  test.skip(!clip, "needs ffmpeg for a clip");
  await page.route("**/video/index.json", (route) => route.fulfill({ json: { update: "clip", videos: [] } }));
  await page.route("**/video/clip.jpg", (route) => route.abort());
  await page.route("**/video/clip.mp4", (route) => route.fulfill({ body: clip!, contentType: "video/mp4" }));
  await openConsole(page, "firmware");
  await allowUnsigned(page); // a local, unsigned test image (UPD-27)
  await connect(page);
  await pickImage(page, "ferrite-test.btf", testBtf(24));
  await update(page);
  const video = page.locator('[data-k="update-video"]');
  await expect(video).toBeVisible();
  await video.getByRole("button", { name: "Hide" }).click();
  await expect(video).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Update done" })).toBeVisible({ timeout: 45_000 });
});
