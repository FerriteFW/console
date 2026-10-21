// Tools > Firmware Update against the simulator and the bridge's fake bootloader (tools/fakeboot.py): the file
// checks, REBOOT (LINK-24), the probes, every block, the reconnect; a NAK'd block and Resume; REBOOT refused busy.
// Never on a radio: only Alex flashes, by hand (docs/TESTING.md).
import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { connect, disconnect, onRadio, openConsole, shot } from "./helpers";

const mode = process.env.FERRITE_E2E_FAKEBOOT ?? "";
test.skip(onRadio() || !mode, "the fake bootloader runs on the simulator only");
test.afterEach(async ({ page }) => disconnect(page));

const resultPath = () => join(dirname(mode), "mode.result.json");
function setMode(m: Record<string, unknown>) {
  writeFileSync(mode, JSON.stringify({ deaf_ms: 300, ...m }));
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

async function pickFile(page: Page, name: string, buffer: Buffer) {
  await page.getByLabel("Firmware file").setInputFiles({ name, mimeType: "application/octet-stream", buffer });
}

const fact = (page: Page, k: string) => page.locator(`[data-k="${k}"]`);

test("firmware: a whole update through the fake bootloader, then connected again", async ({ page }, info) => {
  setMode({});
  const btf = testBtf(24);
  await openConsole(page, "firmware");
  await connect(page);
  await pickFile(page, "ferrite-test.btf", btf);
  await expect(page.getByRole("region", { name: "File check" })).toContainText("Checks passed");
  await expect(fact(page, "version")).toHaveText("v9.8.7");
  await expect(fact(page, "blocks")).toHaveText("24");
  await shot(page, info, "60-firmware-checked");

  await page.getByRole("button", { name: "Update firmware…" }).click();
  const confirm = page.getByRole("group", { name: "Confirm update" });
  await expect(confirm.locator('[data-k="now"]')).toHaveText(/^v\d+\.\d+\.\d+/);
  await expect(confirm.locator('[data-k="new"]')).toHaveText("v9.8.7");
  await shot(page, info, "61-firmware-confirm");
  await confirm.getByRole("button", { name: "Install" }).click();
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

test("firmware: files the checks refuse can't be installed", async ({ page }, info) => {
  await openConsole(page, "firmware");
  await connect(page);
  const refused = page.getByRole("alert", { name: "File refused" });

  await pickFile(page, "stock.btf", testBtf(8, { ferrite: false }));
  await expect(refused).toContainText("not a Ferrite image");
  await expect(page.getByRole("button", { name: "Update firmware…" })).toHaveCount(0);

  await pickFile(page, "broken.btf", testBtf(8, { tag: false }));
  await expect(refused).toContainText("Firmware Error!");
  await shot(page, info, "63-firmware-refused");

  await pickFile(page, "tiny.btf", Buffer.from("not a firmware file"));
  await expect(refused).toContainText("too short");

  await pickFile(page, "ferrite.bin", testBtf(8));
  await expect(page.getByRole("alert", { name: "Update error" })).toContainText("not a .btf file");
  await expect(page.getByRole("button", { name: "Update firmware…" })).toHaveCount(0);
});

test("firmware: a refused block leaves the radio in the bootloader; Resume finishes without REBOOT", async ({ page }, info) => {
  setMode({ nak_block: 5 });
  const btf = testBtf(16);
  await openConsole(page, "firmware");
  await connect(page);
  await pickFile(page, "ferrite-test.btf", btf);
  await page.getByRole("button", { name: "Update firmware…" }).click();
  await page.getByRole("button", { name: "Install" }).click();

  const err = page.getByRole("alert", { name: "Update error" });
  await expect(err).toContainText("Block 6 of 16: flash write failed", { timeout: 30_000 });
  await expect(err).toContainText("stays in the bootloader");
  await expect(page.getByRole("status")).toContainText("Firmware Update holds");
  await shot(page, info, "64-firmware-nak");

  await page.getByRole("button", { name: "Resume" }).click();
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
  await page.getByRole("button", { name: "Update firmware…" }).click();
  await page.getByRole("button", { name: "Install" }).click();
  await expect(page.getByRole("alert", { name: "Update error" })).toContainText("Block 3 of 12", { timeout: 30_000 });
  await page.getByRole("button", { name: "Give up and disconnect" }).click();
  await expect(page.getByRole("status")).toContainText("Disconnected");

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
  await page.getByRole("button", { name: "Update firmware…" }).click();
  await page.getByRole("button", { name: "Install" }).click();
  await expect(page.getByRole("alert", { name: "Update error" })).toContainText("transmitting");
  await expect(page.getByRole("status")).toContainText("Connected: Bridge", { timeout: 20_000 });
  expect(existsSync(resultPath())).toBe(false);
  setMode({});
});
