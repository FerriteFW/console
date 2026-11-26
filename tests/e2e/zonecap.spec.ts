// CHAN-35: a zone holds 256 channels at most. A 300-line CHIRP file imported as new channels goes into two new zones
// ("<name> 1" with 256, "<name> 2" with 44), is written (the radio takes it) and read back; moving another channel
// into the full zone is refused with the reason, and the editors mark it full. On a simulator of its own (300
// channels written), never on a radio.
import { disconnect, expect, onRadio, openConsole, state, test } from "./helpers";
import { startBridge, type Bridges } from "./procs";

test.skip(onRadio(), "the simulator only");
test.setTimeout(120_000);

let b: Bridges;
test.beforeEach(async () => {
  b = await startBridge();
});
test.afterEach(async ({ page }) => {
  await page.keyboard.press("Escape");
  await disconnect(page);
  b?.stop();
});

/** A CHIRP CSV of `n` NFM channels from 440 MHz in 12.5 kHz steps, numbered from 1 (they clash with the table's). */
function csv(n: number): Buffer {
  const head = "Location,Name,Frequency,Duplex,Offset,Tone,rToneFreq,cToneFreq,DtcsCode,DtcsPolarity,RxDtcsCode,CrossMode,Mode,TStep,Skip,Power,Comment,URCALL,RPT1CALL,RPT2CALL,DVCODE";
  const rows = Array.from({ length: n }, (_, i) => `${i + 1},R${i + 1},${(440 + i * 0.0125).toFixed(6)},,0.000000,,88.5,88.5,023,NN,023,Tone->Tone,NFM,12.50,,Low,,,,,`);
  return Buffer.from([head, ...rows].join("\r\n") + "\r\n");
}

test("a 300-channel import splits over two zones of 256 and 44; written, read back; a 257th refused", async ({ page }) => {
  await openConsole(page, "channels", b.url);
  await page.getByRole("button", { name: "Bridge", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Connected: Bridge", { timeout: 20_000 });
  const toolbar = page.getByRole("toolbar", { name: "Channels" });
  await expect(toolbar.getByRole("button", { name: "Read from radio" })).toBeEnabled({ timeout: 30_000 });
  const before = await state(page, (f) => ({ zones: f.channels.table.zones.length as number, channels: f.channels.table.channels.length as number }));

  await page.locator('input[type=file][accept^=".csv"]').setInputFiles({ name: "Big list.csv", mimeType: "text/csv", buffer: csv(300) });
  const imp = page.getByRole("dialog", { name: "Import CHIRP CSV" });
  await imp.getByRole("radio", { name: /new zone/ }).check();
  await imp.getByLabel("New zone name").fill("Big list");
  await expect(imp).toContainText("in 2 new zones, 'Big list 1' to 'Big list 2' (a zone holds 256)");
  await imp.getByRole("button", { name: "Import 300" }).click();
  const t = await state(page, (f) => f.channels.table as { zones: { name: string }[]; channels: { number: number; zone: number | null }[] });
  const z1 = t.zones.findIndex((z) => z.name === "Big list 1");
  const z2 = t.zones.findIndex((z) => z.name === "Big list 2");
  expect([z1, z2]).toEqual([before.zones, before.zones + 1]);
  expect(t.channels.filter((c) => c.zone === z1).length).toBe(256);
  expect(t.channels.filter((c) => c.zone === z2).length).toBe(44);

  // Write: the radio takes both zones (the plan's order never overfills one), and the read back matches.
  await toolbar.getByRole("button", { name: /^Write to radio/ }).click();
  const wd = page.getByRole("dialog", { name: "Write to the radio" });
  await wd.getByRole("button", { name: /^Write \d+ changes?$/ }).click();
  await expect(wd).toContainText("Read back: the radio holds the table.", { timeout: 60_000 });
  await wd.getByRole("button", { name: "Close" }).click();
  expect(await state(page, (f) => f.channels.base.channels.length as number)).toBe(before.channels + 300);

  // A channel from elsewhere into the full zone: refused, said why; the row's zone list marks the zone full.
  const other = t.channels.find((c) => c.zone !== z1 && c.zone !== z2)!.number;
  const why = await page.evaluate(([n, z]) => (window as any).ferrite.channels.moveToZone([n], z), [other, z1] as const);
  expect(why).toContain(`Zone ${z1 + 1} Big list 1 is full (256 channels at most)`);
  await expect(page.locator(".banner").filter({ hasText: "is full (256 channels at most)" })).toBeVisible();
  expect(await state(page, (f) => f.channels.dirty.count as number)).toBe(0);
  const option = page.getByRole("combobox", { name: "Zone", exact: true }).first().locator("option", { hasText: "Big list 1 (full)" });
  await expect(option).toHaveCount(1);
});
