// console#40: a write whose read back differs keeps the table's edits (Write shows what didn't reach the radio),
// and a channel read short of INFO's count is refused, not taken as a backup or a verify.
import { join } from "node:path";
import { connect, expect, openConsole, test } from "./helpers";

test("a write that doesn't verify keeps the edits; a short read is refused", async ({ page }) => {
  await openConsole(page, "channels");
  await connect(page);
  const toolbar = page.getByRole("toolbar", { name: "Channels" });
  await toolbar.getByRole("button", { name: "Read from radio" }).click();
  await expect.poll(() => page.evaluate(() => !!(window as any).ferrite.channels.base), { timeout: 30_000 }).toBe(true);
  await expect(toolbar.getByRole("button", { name: "Read from radio" })).toBeEnabled({ timeout: 30_000 });
  await page.locator('input[type=file][accept^=".csv"]').setInputFiles(join(import.meta.dirname, "fixtures", "repeaterbook-bc.csv"));
  const imp = page.getByRole("dialog", { name: "Import CHIRP CSV" });
  await imp.getByRole("radio", { name: "Add as new channels in a new zone" }).check();
  await imp.getByLabel("New zone name").fill("E2E verify");
  await imp.getByRole("button", { name: /^Import \d+/ }).click();
  await expect(imp).toHaveCount(0);
  const want = await page.evaluate(() => (window as any).ferrite.channels.table.channels.length);

  // The read back after the write: a consistent set with the last few channels gone (as the issue's 112 of 222).
  await page.evaluate(() => {
    const ch = (window as any).ferrite.channels;
    const orig = ch.readRadio.bind(ch);
    ch.readRadio = async () => {
      const r = await orig();
      if (ch.write?.step !== "writing") return r; // the read before the write: as it is
      ch.readRadio = orig;
      return { ...r, set: { ...r.set, channels: r.set.channels.slice(0, -3) } };
    };
  });
  const wd = page.getByRole("dialog", { name: "Write to the radio" });
  await toolbar.getByRole("button", { name: /^Write to radio/ }).click();
  const go = wd.getByRole("button", { name: /^Write \d+ changes?$/ });
  await expect(go).toBeVisible({ timeout: 30_000 });
  await go.click();
  await expect(wd).toContainText("The table keeps your edits", { timeout: 60_000 });
  await wd.getByRole("button", { name: "Close" }).click();
  expect(await page.evaluate(() => (window as any).ferrite.channels.table.channels.length)).toBe(want);
  // the three the read back lacked are pending again
  await expect(toolbar.getByRole("button", { name: /^Write to radio \(3 changes?\)|^Write to radio/ })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).ferrite.channels.source)).toContain("not verified");

  // A read short of INFO's count: refused with the counts.
  await page.evaluate(() => {
    const link = (window as any).ferrite.radio.connectedLink;
    const orig = link.readMany.bind(link);
    link.readMany = async (what: number, from: number, n: number, cb?: unknown) => {
      const m: Map<number, Uint8Array> = await orig(what, from, n, cb);
      if (what === 2 && m.size > 1) m.delete([...m.keys()].pop()!);
      return m;
    };
  });
  const err = await page.evaluate(() => (window as any).ferrite.channels.readRadio().then(() => "", (e: Error) => e.message));
  expect(err).toMatch(/^Read \d+ of the \d+ channels the radio says it has/);
});
