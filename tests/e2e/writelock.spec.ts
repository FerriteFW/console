// Issue #33: a write of more than one WRITE_MANY frame over a cable whose writes are async and exclusive (Web Serial:
// one writer at a time). The bridge's own write returns at once, which is why the e2e never saw the second frame
// lost; here it behaves as Web Serial did before its queue: a write while one is going throws "locked". The write
// must still finish (the lost frame's recovery, which crashed with frames left unsent) and read back.
import { join } from "node:path";
import { connect, expect, openConsole, test } from "./helpers";

test("write: a lost second frame is recovered, never a crash (issue #33)", async ({ page }) => {
  await openConsole(page, "channels");
  await connect(page);
  const toolbar = page.getByRole("toolbar", { name: "Channels" });
  await toolbar.getByRole("button", { name: "Read from radio" }).click();
  await expect.poll(() => page.evaluate(() => !!(window as any).ferrite.channels.base), { timeout: 30_000 }).toBe(true);
  await expect(toolbar.getByRole("button", { name: "Read from radio" })).toBeEnabled({ timeout: 30_000 }); // the read done
  // 12 channels in a new zone: three frames of up to 5.
  await page.locator('input[type=file][accept^=".csv"]').setInputFiles(join(import.meta.dirname, "fixtures", "repeaterbook-bc.csv"));
  const imp = page.getByRole("dialog", { name: "Import CHIRP CSV" });
  await imp.getByRole("radio", { name: "Add as new channels in a new zone" }).check();
  await imp.getByLabel("New zone name").fill("E2E lock");
  await imp.getByRole("button", { name: /^Import \d+/ }).click();
  await expect(imp).toHaveCount(0);
  const wd = page.getByRole("dialog", { name: "Write to the radio" });
  await toolbar.getByRole("button", { name: /^Write to radio/ }).click();
  await expect(wd.getByRole("button", { name: /^Write \d+ changes?$/ })).toBeVisible({ timeout: 30_000 });
  // The cable as Web Serial was: async writes, one at a time, a second while one is going refused.
  await page.evaluate(() => {
    const t = (window as any).ferrite.radio.connectedLink.t;
    const orig = t.write.bind(t);
    let busy = false;
    (window as any).__locked = 0;
    t.write = async (b: Uint8Array) => {
      if (busy) {
        (window as any).__locked++;
        throw new TypeError("Cannot create writer when WritableStream is locked");
      }
      busy = true;
      try {
        await new Promise((r) => setTimeout(r, 5));
        await orig(b);
      } finally {
        busy = false;
      }
    };
  });
  await wd.getByRole("button", { name: /^Write \d+ changes?$/ }).click();
  await expect(wd).toContainText("Read back: the radio holds the table.", { timeout: 60_000 });
  expect(await page.evaluate(() => (window as any).__locked)).toBeGreaterThan(0); // the lost frame did happen
  expect(await page.evaluate(() => (window as any).ferrite.channels.error)).toBe("");
});
