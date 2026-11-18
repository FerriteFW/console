// About's "Save debug info" (Nov 16, 2026: users' write failures came with too little to go on): after a channel read,
// the file names Console's version, the connection and the radio, and its log holds the link's requests with their
// answers and times.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { closeWelcome, connect, expect, openConsole, shotsDir, test } from "./helpers";

test("debug info: version, connection, the link's log", async ({ page }) => {
  await openConsole(page, "channels");
  await connect(page);
  await page.getByRole("toolbar", { name: "Channels" }).getByRole("button", { name: "Read from radio" }).click();
  await expect.poll(() => page.evaluate(() => !!(window as any).ferrite.channels.base), { timeout: 30_000 }).toBe(true);
  await page.goto(page.url().replace(/#.*$/, "#/about"));
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save debug info…" }).click();
  const d = await dl;
  expect(d.suggestedFilename()).toMatch(/^ferrite-console-debug-\d{8}-\d{4}\.txt$/);
  const path = join(shotsDir(), `debug-${Date.now()}.txt`);
  await d.saveAs(path);
  const text = readFileSync(path, "utf8");
  expect(text).toMatch(/^Ferrite Console \d+\.\d+\.\d+ \(web\)/);
  expect(text).toContain("== connection");
  expect(text).toMatch(/phase connected, cable Bridge/);
  expect(text).toMatch(/radio as read: \d+ channels, \d+ zones/);
  // The link's requests: the opening HELLO and the channel read, each with its answer and time.
  expect(text).toMatch(/link HELLO #\d+ \d+ B: status 0 in \d+ ms/);
  expect(text).toMatch(/link READ_MANY what 2 0-\d+: \d+ frames, \d+ records in \d+ ms/);
  await expect(page.getByRole("status").filter({ hasText: "Saved as ferrite-console-debug-" })).toBeVisible();
});

test("debug info: the previous session's log survives a restart", async ({ page }) => {
  await openConsole(page, "channels");
  await connect(page);
  // Console closed and opened again (a reload is a new session): the first session's link lines are the previous log.
  await page.reload();
  await closeWelcome(page);
  await page.goto(page.url().replace(/#.*$/, "#/about"));
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save debug info…" }).click();
  const path = join(shotsDir(), `debug-prev-${Date.now()}.txt`);
  await (await dl).saveAs(path);
  const text = readFileSync(path, "utf8");
  const [now, prev] = text.split("== log of the previous session");
  expect(prev).toMatch(/link HELLO #\d+ \d+ B: status 0 in \d+ ms/);
  expect(now).not.toMatch(/link HELLO/);
});

test("radio crash: the readback's restart line shows on About and goes in the debug info (SAFE-8.2)", async ({ page }) => {
  await openConsole(page, "live");
  await connect(page);
  await expect.poll(() => page.evaluate(() => !!(window as any).ferrite.radio.ui)).toBe(true);
  // The simulator doesn't crash: its readback, with the line a radio sends after a fault.
  await page.evaluate(() => {
    const r = (window as any).ferrite.radio;
    r.setUi({ ...r.ui, lines: [...r.ui.lines, "restart after=fault pc=0x8023abc in_a_row=2"] });
  });
  await expect(page.locator('[data-k="radio-crash"]')).toHaveCount(0); // not on the main pages
  await page.goto(page.url().replace(/#.*$/, "#/about"));
  const note = page.locator('[data-k="radio-crash"]');
  await expect(note).toContainText("crash at 0x8023abc (2 in a row");
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save debug info…" }).click();
  const path = join(shotsDir(), `debug-crash-${Date.now()}.txt`);
  await (await dl).saveAs(path);
  const text = readFileSync(path, "utf8");
  expect(text).toMatch(/radio crash \(SAFE-8\.2\): \{"after":"fault","pc":"0x8023abc","inARow":2/);
  expect(text).toMatch(/radio: restarted after a fault at pc=0x8023abc \(2 in a row\)/);
});
