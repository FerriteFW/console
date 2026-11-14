// CHIRP CSV import as new channels in a new zone, for two files (tests/e2e/fixtures/): a CHIRP "Export to CSV" from
// a radio (Location from 0, every column, a WFM and a DV row CHIRP includes) and RepeaterBook's CHIRP download
// (invented southern BC repeaters with fictional callsigns, frequencies on the BC band plan). Each: read the radio,
// import into a new zone at free numbers, write (backup and diff first), read back, then delete the zone and its
// channels, write, and read back: the radio ends as it started. Safe on a radio: the tests add only their own zone
// (a unique name) and its channels, and afterAll takes them off again when a step fails.
import { type Page } from "@playwright/test";
import { join } from "node:path";
import { connect, disconnect, expect, onRadio, openConsole, shot, shotsDir, state, test } from "./helpers";

const long = () => (onRadio() ? 120_000 : 30_000);
const fixture = (name: string) => join(import.meta.dirname, "fixtures", name);
/** JSON with keys sorted (the core's objects come in either order). */
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

type Want = { name: string; rx: string; duplex?: string; offset?: string; tx_tone?: string; rx_tone?: string; mode?: string; power?: string; skip?: boolean; rx_only?: boolean };

/** The numbers the import takes (the dialog's rule): after the highest when they fit, else the first free run, else the free ones from 1. */
function numbersFor(used: number[], n: number): number[] {
  const u = new Set(used);
  const fits = (s: number) => s + n - 1 <= 4000 && Array.from({ length: n }, (_, k) => s + k).every((k) => !u.has(k));
  const run = (s: number) => Array.from({ length: n }, (_, k) => s + k);
  const after = used.length ? Math.max(...used) + 1 : 1;
  if (fits(after)) return run(after);
  for (let s = 1; s <= 4000; s++) if (fits(s)) return run(s);
  return Array.from({ length: 4000 }, (_, k) => k + 1).filter((k) => !u.has(k)).slice(0, n);
}
const rangeText = (nums: number[]) => {
  const out: string[] = [];
  for (let i = 0; i < nums.length; ) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(i === j ? `${nums[i]}` : `${nums[i]}-${nums[j]}`);
    i = j + 1;
  }
  return out.join(", ");
};

const FILES: { file: string; tag: string; skipped: number; notes: RegExp[]; want: Want[] }[] = [
  {
    file: "chirp-radio-export.csv",
    tag: "CHIRP",
    skipped: 1, // the DV row; WFM is a channel mode and imports (BCR-33)
    notes: [/line 11: mode DV.*skipped/],
    want: [
      { name: "CALL 2M", rx: "146.52000", duplex: "", tx_tone: "off", rx_tone: "off", mode: "FM", power: "High" },
      { name: "NSHORE", rx: "146.94000", duplex: "-", offset: "0.60000", tx_tone: "127.3", rx_tone: "off" },
      { name: "BURNABY", rx: "147.36000", duplex: "+", offset: "0.60000", tx_tone: "100.0", rx_tone: "100.0" },
      { name: "SURREY", rx: "145.29000", duplex: "-", tx_tone: "110.9", power: "Low", skip: true },
      { name: "CALL 70CM", rx: "446.00000", mode: "NFM", power: "Low" },
      { name: "DCS RPT", rx: "443.25000", duplex: "+", offset: "5.00000", tx_tone: "D023N", rx_tone: "D023N", mode: "FM" },
      { name: "DCS REV", rx: "442.70000", tx_tone: "D754I", rx_tone: "D754N", mode: "NFM" },
      { name: "SAT UP", rx: "145.80000", duplex: "split", offset: "437.80000", skip: true },
      { name: "CBC VAN", rx: "88.10000", mode: "WFM" },
      { name: "WX VAN", rx: "162.55000", rx_only: true, skip: true, power: "Low" },
      { name: "SIMPLEX 2", rx: "147.55500", duplex: "", power: "Low" },
    ],
  },
  {
    file: "repeaterbook-bc.csv",
    tag: "RB",
    skipped: 0,
    notes: [],
    want: [
      { name: "Vancouver", rx: "146.94000", duplex: "-", offset: "0.60000", tx_tone: "127.3", rx_tone: "off", mode: "FM", power: "High" },
      { name: "Burnaby", rx: "147.36000", duplex: "+", tx_tone: "100.0" },
      { name: "North Vancouver", rx: "145.13000", duplex: "-", tx_tone: "94.8" },
      { name: "Coquitlam", rx: "146.68000", tx_tone: "156.7", rx_tone: "156.7" },
      { name: "Surrey", rx: "147.00000", duplex: "+", tx_tone: "110.9" },
      { name: "Abbotsford", rx: "146.76000", tx_tone: "103.5" },
      { name: "Squamish", rx: "147.08000", tx_tone: "123.0" },
      { name: "Vancouver", rx: "443.77500", duplex: "+", offset: "5.00000", tx_tone: "156.7" },
      { name: "Richmond", rx: "442.32500", tx_tone: "D047N", rx_tone: "D047N" },
      { name: "Langley", rx: "444.90000", tx_tone: "100.0", rx_tone: "100.0" },
      { name: "Maple Ridge", rx: "443.05000", tx_tone: "131.8" },
      { name: "Chilliwack", rx: "442.07500", duplex: "+", tx_tone: "118.8", mode: "FM", power: "High" },
    ],
  },
];

for (const fx of FILES) {
  test.describe.serial(`import ${fx.file}`, () => {
    let page: Page;
    /** The table as first read: the radio must end like this. */
    let first = "";
    /** The new zone's name (unique per run), and whether it may be on the radio (cleanup needed). */
    const zone = `E2E ${fx.tag} ${String(Date.now() % 10000).padStart(4, "0")}`;
    let onIt = false;
    /** The numbers the import took, and the rows as the table held them before the write. */
    let nums: number[] = [];
    let added: unknown[] = [];

    const imp = () => page.getByRole("dialog", { name: "Import CHIRP CSV" });
    const wd = () => page.getByRole("dialog", { name: "Write to the radio" });
    const table = () => state(page, (f) => f.channels.table);
    const toolbar = () => page.getByRole("toolbar", { name: "Channels" });

    async function readRadio() {
      await page.evaluate(() => ((window as any).__e2eBase = (window as any).ferrite.channels.base));
      await toolbar().getByRole("button", { name: "Read from radio" }).click();
      // Unwritten changes (a failed step): the page asks first.
      const drop = page.getByRole("button", { name: "Read and discard" });
      if (await drop.isVisible()) await drop.click();
      await expect.poll(() => page.evaluate(() => (window as any).ferrite.channels.base !== (window as any).__e2eBase), { timeout: long() }).toBe(true);
      await expect(toolbar().getByRole("button", { name: "Read from radio" })).toBeEnabled({ timeout: long() });
    }

    /** Write to radio: the backup downloads (kept in the shots folder), the review shows. */
    async function startWrite(as: string) {
      const dl = page.waitForEvent("download", { timeout: long() });
      await toolbar().getByRole("button", { name: /^Write to radio/ }).click();
      const backup = await dl;
      expect(backup.suggestedFilename()).toMatch(/^ferrite-.*-backup\.json$/);
      await backup.saveAs(join(shotsDir(), `${onRadio() ? "radio" : "sim"}-${as}`));
      await expect(wd()).toContainText("Backup saved", { timeout: long() });
    }

    async function commitWrite() {
      await wd().getByRole("button", { name: /^Write \d+ changes?$/ }).click();
      await expect(wd()).toContainText("Read back: the radio holds the table.", { timeout: long() });
      await wd().getByRole("button", { name: "Close" }).click();
      await expect(wd()).toHaveCount(0);
    }

    /** Takes the zone named `zone` and its channels out of the table (the zone shown, every row ticked and deleted
     *  from the bulk bar, then the zone chosen on the Zones tab and its delete button): how many channels, or -1 when the table has no such zone. */
    async function removeZone(): Promise<number> {
      const t = await table();
      const zi = t.zones.findIndex((z: any) => z.name === zone);
      if (zi < 0) return -1;
      await page.getByRole("tab", { name: /^Channels/ }).click();
      const mine = t.channels.filter((c: any) => c.zone === zi).map((c: any) => c.number as number);
      if (mine.length) {
        await toolbar().getByLabel("Show zone").selectOption(String(zi));
        await page.getByRole("checkbox", { name: "Select every channel shown" }).check();
        const bar = page.getByRole("region", { name: "Selected channels" });
        await expect(bar).toContainText(`${mine.length} selected`);
        await bar.getByRole("button", { name: `Delete ${mine.length}` }).click();
        await toolbar().getByLabel("Show zone").selectOption("all");
      }
      await page.getByRole("tab", { name: /^Zones/ }).click();
      await page.getByRole("listbox", { name: "Zones" }).getByRole("option").nth(zi).click();
      await page.getByRole("button", { name: `Delete zone ${zi + 1}`, exact: true }).click();
      await page.getByRole("tab", { name: /^Channels/ }).click();
      return mine.length;
    }

    test.beforeAll(async ({ browser }) => {
      page = await browser.newPage();
      await openConsole(page, "channels");
      await connect(page);
    });

    test.afterAll(async () => {
      // Whatever failed: the zone and its channels off the radio again.
      // An open dialog (a failed step) would cover the buttons.
      if (await wd().count()) await wd().getByRole("button", { name: /^(Close|Cancel)$/ }).click().catch(() => {});
      if (await imp().count()) await imp().getByRole("button", { name: "Cancel" }).click().catch(() => {});
      if (onIt) {
        try {
          await readRadio();
          if ((await removeZone()) >= 0) {
            await startWrite(`${fx.tag}-cleanup-backup.json`);
            await commitWrite();
          }
        } catch (e) {
          console.error(`${fx.file}: couldn't take zone "${zone}" off the radio: ${(e as Error).message}`);
        }
      }
      await disconnect(page);
      await page.close();
    });

    test("import into a new zone at free numbers", async ({}, info) => {
      await readRadio();
      const t0 = await table();
      first = canon(t0);
      const used = t0.channels.map((c: any) => c.number as number);
      const fileNums = fx.want.map((_, k) => k + 1); // both files start at Location 0 or 1: channel 1 up
      const clash = fileNums.some((n) => used.includes(n));
      nums = numbersFor(used, fx.want.length);

      await page.locator('input[type=file][accept^=".csv"]').setInputFiles(fixture(fx.file));
      await expect(imp()).toBeVisible();
      await expect(imp()).toContainText(`${fx.want.length} channels${fx.skipped ? `, ${fx.skipped} line${fx.skipped === 1 ? "" : "s"} skipped` : ""}.`);
      for (const n of fx.notes) await expect(imp().locator(".notes li").filter({ hasText: n })).toHaveCount(1);
      const opt = imp().getByRole("radio", { name: "Add as new channels in a new zone" });
      // The default when the file's numbers clash with the table's.
      if (clash) await expect(opt).toBeChecked();
      else await opt.check();
      await expect(imp().getByLabel("New zone name")).toHaveValue(fx.file === "repeaterbook-bc.csv" ? "repeaterbook-bc" : "chirp-radio-expo");
      await imp().getByLabel("New zone name").fill(zone);
      await expect(imp().locator("p.plan")).toHaveText(`Add ${fx.want.length} channels as ${rangeText(nums)} in a new zone '${zone}'.`);
      await expect(imp()).toContainText("A Comment naming a zone is ignored");
      await shot(page, info, `40-${fx.tag}-import`);
      await imp().getByRole("button", { name: `Import ${fx.want.length}` }).click();
      await expect(imp()).toHaveCount(0);

      const t = await table();
      expect(t.zones.length).toBe(t0.zones.length + 1);
      expect(t.zones.at(-1).name).toBe(zone);
      const zi = t.zones.length - 1;
      const mine = t.channels.filter((c: any) => c.zone === zi);
      expect(mine.map((c: any) => c.number)).toEqual(nums);
      fx.want.forEach((w, k) => expect(mine[k], `row ${k + 1}`).toMatchObject({ rx_only: false, skip: false, ...w }));
      // Nothing else changed: the table less the new rows is the first read.
      expect(canon({ zones: t.zones.slice(0, -1), channels: t.channels.filter((c: any) => c.zone !== zi) })).toBe(first);
      await expect(page.locator("tr.added")).toHaveCount(fx.want.length);
      added = mine;
      await page.locator("tr.added").first().scrollIntoViewIfNeeded();
      await shot(page, info, `41-${fx.tag}-rows`);
    });

    test("write: backup, diff (the channels and the zone added), read back", async ({}, info) => {
      expect(added.length).toBe(fx.want.length);
      await startWrite(`${fx.tag}-backup.json`);
      await expect(wd().locator("h3.added")).toHaveText(`Added (${fx.want.length + 1})`);
      await expect(wd().locator("h3.changed")).toHaveCount(0);
      await expect(wd().locator("h3.deleted")).toHaveCount(0);
      await expect(wd().locator("li", { hasText: zone })).toHaveCount(1);
      await expect(wd().getByRole("button", { name: `Write ${fx.want.length + 1} changes` })).toBeEnabled();
      await shot(page, info, `42-${fx.tag}-diff`);
      onIt = true;
      await commitWrite();

      await readRadio();
      const t = await table();
      const zi = t.zones.findIndex((z: any) => z.name === zone);
      expect(zi).toBe(t.zones.length - 1);
      expect(canon(t.channels.filter((c: any) => c.zone === zi))).toBe(canon(added));
    });

    test("remove: the zone and its channels deleted, written; the radio as it started", async ({}, info) => {
      expect(onIt).toBe(true);
      expect(await removeZone()).toBe(fx.want.length);
      expect(canon(await table())).toBe(first);
      await startWrite(`${fx.tag}-remove-backup.json`);
      await expect(wd().locator("h3.deleted")).toHaveText(`Deleted (${fx.want.length + 1})`);
      await expect(wd().locator("h3.added")).toHaveCount(0);
      await expect(wd().locator("h3.changed")).toHaveCount(0);
      await shot(page, info, `43-${fx.tag}-remove-diff`);
      await commitWrite();
      onIt = false;
      await readRadio();
      expect(canon(await table())).toBe(first);
    });
  });
}

