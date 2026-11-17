// The serial-comms review (Nov 17, 2026): one lost frame on the plain cable failed a whole write. Writes that may go
// twice are sent once more, channel deletes too (a channel not there is nothing to do, LINK-41.2). Each case: the
// write finishes and reads back.
import { join } from "node:path";
import { type Page } from "@playwright/test";
import { connect, expect, openConsole, test } from "./helpers";

/** After `arm`, the `n`th thing of `dir` ("out": a request written, "in": an answer chunk) is dropped, once. */
async function lose(page: Page, dir: "out" | "in", n: number) {
  await page.evaluate(
    ([dir, n]) => {
      const w = window as any;
      const t = w.ferrite.radio.connectedLink.t;
      w.__lost = 0;
      let k = 0;
      if (dir === "out") {
        const orig = t.write.bind(t);
        t.write = (b: Uint8Array) => (w.__arm && ++k === n ? ((w.__arm = false), w.__lost++, Promise.resolve()) : orig(b));
      } else {
        const orig = t.onData;
        t.onData = (b: Uint8Array) => (w.__arm && ++k === n ? ((w.__arm = false), w.__lost++) : orig(b));
      }
    },
    [dir, n] as const,
  );
}

async function write(page: Page) {
  const toolbar = page.getByRole("toolbar", { name: "Channels" });
  const wd = page.getByRole("dialog", { name: "Write to the radio" });
  const dl = page.waitForEvent("download");
  await toolbar.getByRole("button", { name: /^Write to radio/ }).click();
  await dl;
  const go = wd.getByRole("button", { name: /^Write \d+ changes?$/ });
  await expect(go).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => ((window as any).__arm = true));
  await go.click();
  await expect(wd).toContainText("Read back: the radio holds the table.", { timeout: 60_000 });
  expect(await page.evaluate(() => (window as any).__lost)).toBe(1);
  await wd.getByRole("button", { name: "Close" }).click();
}

async function start(page: Page) {
  await openConsole(page, "channels");
  await connect(page);
  const toolbar = page.getByRole("toolbar", { name: "Channels" });
  await toolbar.getByRole("button", { name: "Read from radio" }).click();
  await expect.poll(() => page.evaluate(() => !!(window as any).ferrite.channels.base), { timeout: 30_000 }).toBe(true);
  await expect(toolbar.getByRole("button", { name: "Read from radio" })).toBeEnabled({ timeout: 30_000 });
  await page.locator('input[type=file][accept^=".csv"]').setInputFiles(join(import.meta.dirname, "fixtures", "repeaterbook-bc.csv"));
  const imp = page.getByRole("dialog", { name: "Import CHIRP CSV" });
  await imp.getByRole("radio", { name: "Add as new channels in a new zone" }).check();
  await imp.getByLabel("New zone name").fill("E2E lost");
  await imp.getByRole("button", { name: /^Import \d+/ }).click();
  await expect(imp).toHaveCount(0);
}

/** The new zone and its channels out of the table (deletes on the next write). */
async function removeZone(page: Page) {
  await page.evaluate(() => {
    const ch = (window as any).ferrite.channels;
    const t = ch.table;
    const zi = t.zones.findIndex((z: any) => z.name === "E2E lost");
    ch.table = { zones: t.zones.filter((_: any, i: number) => i !== zi), channels: t.channels.filter((c: any) => c.zone !== zi) };
  });
}

for (const dir of ["out", "in"] as const)
  for (const n of [1, 2, 3, 4]) {
    test(`lost ${dir === "out" ? "request" : "answer"} ${n}: writes and deletes go once more`, async ({ page }) => {
      await start(page);
      // The writes: BEGIN, the zone, the channels' frames: the nth thing lost.
      await lose(page, dir, n);
      await write(page);
      // The deletes: BEGIN, the deletes' frame: the nth (1 or 2) lost, its answer (done) or its request (not).
      await removeZone(page);
      await lose(page, dir, ((n - 1) % 2) + 1);
      await write(page);
      expect(await page.evaluate(() => (window as any).ferrite.channels.table.zones.some((z: any) => z.name === "E2E lost"))).toBe(false);
    });
  }
