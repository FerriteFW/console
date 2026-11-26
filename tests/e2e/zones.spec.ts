// The Zones tab's editor through the bridge: a channel moved into a zone (it leaves its own: one zone per channel),
// and ▲ renumbering (the channel trades numbers with the one above it in the zone; the home channel follows it),
// each written (backup and diff first) and read back, then put back. On the simulator only: the tests renumber
// channels and set the home channel, which a radio's owner wouldn't want done by a test.
import { type Page } from "@playwright/test";
import { connect, disconnect, expect, onRadio, openConsole, shot, state, test } from "./helpers";

let page: Page;
const long = () => (onRadio() ? 120_000 : 30_000);
const toolbar = () => page.getByRole("toolbar", { name: "Channels" });
const dialog = () => page.getByRole("dialog");
const zoneList = () => page.getByRole("listbox", { name: "Zones" });
const members = () => page.getByRole("list", { name: "Channels in this zone" });
const table = () => state(page, (f) => f.channels.table as { zones: any[]; channels: any[] });
const home = () => state(page, (f) => f.channels.home as number | null | undefined);
/** The write dialog's line for channel `n` (not 10 for 1). */
const diffLine = (n: number) => dialog().locator("li").filter({ has: page.locator("span.what", { hasText: new RegExp(`^Ch ${n}$`) }) });
const cmd = (line: string) => page.evaluate((l) => (window as any).ferrite.radio.connectedLink.cmd(l) as Promise<string>, line);

async function readRadio() {
  await page.evaluate(() => ((window as any).__e2eBase = (window as any).ferrite.channels.base));
  await toolbar().getByRole("button", { name: "Read from radio" }).click();
  const drop = page.getByRole("button", { name: "Read and discard" });
  if (await drop.isVisible()) await drop.click();
  await expect.poll(() => page.evaluate(() => (window as any).ferrite.channels.base !== (window as any).__e2eBase), { timeout: long() }).toBe(true);
  await expect(toolbar().getByRole("button", { name: "Read from radio" })).toBeEnabled({ timeout: long() });
}

/** Write to radio: backup, the diff (checked by `review`), the write, the read back. */
async function write(review?: () => Promise<void>) {
  await toolbar().getByRole("button", { name: /^Write to radio/ }).click();
  await expect(dialog()).toContainText("Backup kept in Console until it closes", { timeout: long() });
  await review?.();
  await dialog().getByRole("button", { name: /^Write \d+ changes?$/ }).click();
  await expect(dialog()).toContainText("Read back: the radio holds the table.", { timeout: long() });
  await dialog().getByRole("button", { name: "Close" }).click();
  await expect(dialog()).toHaveCount(0);
}

async function pickZone(i: number) {
  await page.getByRole("tab", { name: /^Zones/ }).click();
  await zoneList().getByRole("option").nth(i).click();
  await expect(page.getByRole("heading", { name: `Zone ${i + 1}`, exact: true })).toBeVisible();
}

test.describe.serial("zones", () => {
  test.skip(onRadio(), "renumbers channels and sets the home channel: simulator only");
  /** The table as first read, to end where it started. */
  let first = "";
  let firstHome: number | null | undefined;
  /** A zone the test made (deleted again at the end), as an index; -1 when the radio had one. */
  let made = -1;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await openConsole(page, "channels");
    await connect(page);
    await readRadio();
    first = JSON.stringify(await table());
    firstHome = await home();
  });

  test.afterAll(async () => {
    // The radio as it started: the channels and zones, then the home channel.
    try {
      if (await dialog().count()) await dialog().getByRole("button", { name: /^(Close|Cancel)$/ }).click();
      await readRadio();
      if (JSON.stringify(await table()) !== first) {
        await page.evaluate((s) => {
          const c = (window as any).ferrite.channels;
          c.table = JSON.parse(s);
        }, first);
        await write();
      }
      await cmd(`home ${firstHome ?? "none"}`);
    } catch (e) {
      console.error(`zones: couldn't put the radio back: ${(e as Error).message}`);
    }
    await disconnect(page);
    await page.close();
  });

  test("move a channel into a zone: it leaves its own; written and read back", async ({}, info) => {
    let t = await table();
    expect(t.channels.length).toBeGreaterThan(2);
    await page.getByRole("tab", { name: /^Zones/ }).click();
    if (!t.zones.length) {
      await page.getByLabel("New zone name").fill("E2E zone");
      await page.getByRole("button", { name: "Add", exact: true }).click();
      made = 0;
      t = await table();
    }
    // The zone with the most channels (so ▲ has a neighbour), and a channel from elsewhere.
    const count = (i: number) => t.channels.filter((c) => c.zone === i).length;
    const zi = t.zones.map((_, i) => i).sort((a, b) => count(b) - count(a))[0];
    await pickZone(zi);
    const out = t.channels.filter((c) => c.zone !== zi);
    // One from another zone when there is one (the button says Move here), else one in no zone (Add).
    const c = out.find((x) => x.zone !== null) ?? out[0];
    const label = c.zone === null ? "Add" : "Move";
    const avail = page.getByRole("list", { name: "Other channels" });
    await expect(avail.getByRole("listitem").filter({ hasText: c.zone === null ? "no zone" : t.zones[c.zone].name }).first()).toBeVisible();
    await avail.getByRole("button", { name: `${label} channel ${c.number} here` }).click();
    await expect(members().getByRole("listitem").filter({ hasText: c.name || "(no name)" }).first()).toBeVisible();
    t = await table();
    expect(t.channels.find((x) => x.number === c.number)!.zone).toBe(zi);
    const nav = page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: /^Channels & Zones/ });
    await expect(nav).toContainText(/\d+ unwritten/);
    // Still short of two: one more in, so the next test has a pair.
    if (t.channels.filter((x) => x.zone === zi).length < 2) {
      const d = t.channels.find((x) => x.zone !== zi)!;
      await avail.getByRole("button", { name: new RegExp(`^(Add|Move) channel ${d.number} here$`) }).click();
    }
    await shot(page, info, "zones-10-moved");
    await write(async () => {
      await expect(diffLine(c.number)).toHaveCount(1);
    });
    await readRadio();
    expect((await table()).channels.find((x) => x.number === c.number)!.zone).toBe(zi);
  });

  test("▲ renumbers: two channels trade numbers, the home channel follows; written and read back", async ({}, info) => {
    let t = await table();
    const count = (i: number) => t.channels.filter((c) => c.zone === i).length;
    const zi = t.zones.map((_, i) => i).sort((a, b) => count(b) - count(a))[0];
    const mine = t.channels.filter((c) => c.zone === zi);
    expect(mine.length).toBeGreaterThanOrEqual(2);
    const [upper, lower] = [mine[0], mine[1]];
    // The lower one is the radio's home channel, read with the channels.
    await cmd(`home ${lower.number}`);
    await readRadio();
    expect(await home()).toBe(lower.number);
    await pickZone(zi);
    await expect(members().getByRole("listitem").filter({ has: page.locator(".tag") })).toContainText(String(lower.number));

    await members().getByRole("button", { name: `Move channel ${lower.number} up` }).click();
    t = await table();
    const at = (n: number) => t.channels.find((c) => c.number === n)!;
    expect(at(upper.number).name).toBe(lower.name);
    expect(at(lower.number).name).toBe(upper.name);
    expect(await home()).toBe(upper.number);
    // The first row of the zone is now the moved channel, still the home one.
    await expect(members().getByRole("listitem").first()).toContainText(lower.name || "(no name)");
    await expect(members().getByRole("listitem").first().locator(".tag")).toHaveText("home");
    await expect(page.getByText(`Channels ${upper.number} and ${lower.number} swapped numbers.`)).toBeVisible();
    await shot(page, info, "zones-11-swapped");

    await write(async () => {
      await expect(diffLine(upper.number)).toHaveCount(1);
      await expect(diffLine(lower.number)).toHaveCount(1);
      const h = dialog().locator("li.home");
      await expect(h.locator("s")).toHaveText(String(lower.number));
      await expect(h.locator("b")).toHaveText(String(upper.number));
    });
    // Read back: the radio holds the swap and its home channel moved with it.
    await readRadio();
    t = await table();
    expect(at(upper.number).name).toBe(lower.name);
    expect(at(lower.number).name).toBe(upper.name);
    expect(await home()).toBe(upper.number);
    expect(await state(page, (f) => f.channels.pending)).toBe(0);

    // Undo puts it back in one step (the swap, the home channel too).
    await members().getByRole("button", { name: `Move channel ${upper.number} down` }).click();
    expect(await home()).toBe(lower.number);
    await toolbar().getByRole("button", { name: /Undo/ }).click();
    expect(await home()).toBe(upper.number);
    expect(await state(page, (f) => f.channels.pending)).toBe(0);
  });

  test("delete a zone the test made, as before", async () => {
    test.skip(made < 0, "the radio had zones");
    await pickZone(made);
    await page.getByRole("button", { name: `Delete zone ${made + 1}`, exact: true }).click();
    await expect(page.getByText(/^Deleted zone 1 "E2E zone"/)).toBeVisible();
  });
});
