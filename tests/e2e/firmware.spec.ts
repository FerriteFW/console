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
import { connect, disconnect, expect, onRadio, openConsole, shot, test } from "./helpers";

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

/** An unsigned `.ffw` (a local build's), packed by ferrite's own tools/ffw.py: the image and two small parts. */
function testFfw(btf: Buffer): Buffer {
  const d = mkdtempSync(join(tmpdir(), "ferrite-ffw-"));
  const build = "e2e0001";
  writeFileSync(join(d, "x.btf"), btf);
  writeFileSync(join(d, "text-en.bin"), part("FTXT", Buffer.from("\x01\x00\x00\x00\x08\x00\x00\x02hi", "latin1"), build));
  writeFileSync(join(d, "logo.bin"), part("FLGO", Buffer.alloc(300, 0x5a), build));
  writeFileSync(join(d, "parts.json"), JSON.stringify([
    { file: "text-en.bin", magic: "FTXT", addr: 0x090000, max: 0x10000 },
    { file: "logo.bin", magic: "FLGO", addr: 0x240000, max: 0x8000 },
  ]));
  const r = spawnSync("python3", [`${ferrite}/tools/ffw.py`, "pack", join(d, "x.ffw"), "--btf", join(d, "x.btf"), "--parts", d, "--kind", "tx", "--build", build, "--version", "9.8.7"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffw.py: ${r.stderr}`);
  const b = readFileSync(join(d, "x.ffw"));
  rmSync(d, { recursive: true, force: true });
  return b;
}

async function pickFile(page: Page, name: string, buffer: Buffer) {
  await page.getByLabel("Firmware file").setInputFiles({ name, mimeType: "application/octet-stream", buffer });
}

const fact = (page: Page, k: string) => page.locator(`[data-k="${k}"]`);
/** The page's button: "Install again…" when the radio already has that version (the e2e build bundles one). */
const updateButton = (page: Page) => page.getByRole("button", { name: /^(Update|Install again)…$/ });
const wizard = (page: Page) => page.getByRole("dialog", { name: "Update Ferrite" });
/** The page's Update button, then the wizard's Update: the update starts. */
async function update(page: Page) {
  await updateButton(page).click();
  await wizard(page).getByRole("button", { name: "Update", exact: true }).click();
}

test("firmware: a whole update through the fake bootloader, then connected again", async ({ page }, info) => {
  setMode({});
  const btf = testBtf(24);
  await openConsole(page, "firmware");
  await connect(page);
  await pickFile(page, "ferrite-test.btf", btf);
  await expect(fact(page, "version")).toHaveText("v9.8.7");
  await expect(fact(page, "blocks")).toHaveText("24");
  // No .minisig: someone's own build, allowed.
  await expect(fact(page, "signature")).toHaveText("Not signed: not a Ferrite release");
  await shot(page, info, "60-firmware-checked");

  await updateButton(page).click();
  const w = wizard(page);
  await expect(w.locator('[data-k="now"]')).toHaveText(/^v\d+\.\d+\.\d+/);
  await expect(w.locator('[data-k="new"]')).toHaveText("v9.8.7");
  await shot(page, info, "61-firmware-confirm");
  await w.getByRole("button", { name: "Update", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Firmware Update holds");

  const done = page.getByRole("region", { name: "Update done" });
  await expect(done).toBeVisible({ timeout: 45_000 });
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
  await connect(page);
  // The page names the bundled release; the wizard loads and checks it.
  await expect(fact(page, "latest")).toHaveText("v9.8.7");
  await updateButton(page).click();
  await expect(wizard(page).locator('[data-k="new"]')).toHaveText("v9.8.7");
  await expect(wizard(page).getByRole("button", { name: "Update", exact: true })).toBeEnabled();
  await wizard(page).getByRole("button", { name: "Cancel" }).click();
  served = testBtf(25); // the file on the server isn't the one the manifest names
  await page.getByText("Advanced: install a file (.ffw or .btf)").click();
  await page.getByRole("button", { name: "Back to the bundled release" }).click();
  await expect(page.getByRole("alert", { name: "Update error" })).toContainText("doesn't match its checksum");
});

test("firmware: files the checks refuse can't be installed", async ({ page }, info) => {
  await openConsole(page, "firmware");
  await connect(page);
  const refused = page.getByRole("alert", { name: "File refused" });

  await pickFile(page, "stock.btf", testBtf(8, { ferrite: false }));
  await expect(refused).toContainText("not a Ferrite image");
  await expect(updateButton(page)).toBeDisabled();

  await pickFile(page, "broken.btf", testBtf(8, { tag: false }));
  await expect(refused).toContainText("Firmware Error!");
  await shot(page, info, "63-firmware-refused");

  await pickFile(page, "tiny.btf", Buffer.from("not a firmware file"));
  await expect(refused).toContainText("too short");

  // A .minisig that doesn't verify with Ferrite's key (the core's throwaway test key): refused like a failed check.
  const minisig = readFileSync(join(import.meta.dirname, "../../core/tests/fixtures/signed-test.btf.minisig"));
  await page.getByLabel("Firmware file").setInputFiles([
    { name: "ferrite-test.btf", mimeType: "application/octet-stream", buffer: testBtf(8) },
    { name: "ferrite-test.btf.minisig", mimeType: "text/plain", buffer: minisig },
  ]);
  await expect(refused).toContainText("Bad signature: the signature is from another key, not Ferrite's");
  await expect(fact(page, "signature")).toHaveText("Doesn't verify");
  await expect(updateButton(page)).toBeDisabled();

  // Not a .btf at all: refused before the checks; Update would offer only the bundled release, never this file.
  await pickFile(page, "ferrite.bin", testBtf(8));
  await expect(page.getByRole("alert", { name: "Update error" })).toContainText("not a .ffw or .btf file");
});

test("firmware: a refused block leaves the radio in the bootloader; Resume finishes without REBOOT", async ({ page }, info) => {
  setMode({ nak_block: 5 });
  const btf = testBtf(16);
  await openConsole(page, "firmware");
  await connect(page);
  await pickFile(page, "ferrite-test.btf", btf);
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
  await connect(page);
  await pickFile(page, "ferrite-test.btf", btf);
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
  await connect(page);
  await pickFile(page, "ferrite-test.btf", testBtf(8));
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
  await page.getByText("Advanced: install a file (.ffw or .btf)").click();
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
  await expect(wizard(page)).toContainText(/SPI parts|Writing|Stamping/, { timeout: 60_000 });
  await expect(done).toBeVisible({ timeout: 80_000 });
  await expect(page.getByRole("status")).toContainText("Connected: Bridge");
  const r = result();
  expect(r.errors).toEqual([]);
  expect(r.sha256).toBe(sha(btf));
});
