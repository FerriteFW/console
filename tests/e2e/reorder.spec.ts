// Reordering (decision in docs/DECISIONS.md, Channels): a channel dragged in the table takes the number it's dropped
// on and the ones between move one along; ↑ ↓ on its handle; a used number typed in its panel; a channel dragged
// within its zone; a zone dragged or moved with ▲ ▼ (its channels go with it). Each written (backup and diff first)
// and read back, then the radio put back. On the simulator only: the tests renumber channels and reorder zones.
import { type Page } from "@playwright/test";
import { connect, disconnect, expect, onRadio, openConsole, shot, state, test } from "./helpers";

let page: Page;
const long = () => (onRadio() ? 120_000 : 30_000);
const toolbar = () => page.getByRole("toolbar", { name: "Channels" });
const dialog = () => page.getByRole("dialog");
const zoneList = () => page.getByRole("listbox", { name: "Zones" });
const members = () => page.getByRole("list", { name: "Channels in this zone" });
type T = { zones: { number: number; name: string }[]; channels: { number: number; name: string; rx: string; zone: number | null }[] };
const table = () => state(page, (f) => f.channels.table as T);
const pending = () => state(page, (f) => f.channels.pending as number);
const row = (n: number) => page.locator(`table.grid tr[data-n="${n}"]`);
/** What sits at each number: a channel's name and RX, so a move shows as what moved where. */
const who = (t: T) => new Map(t.channels.map((c) => [c.number, `${c.name}|${c.rx}`]));

async function readRadio() {
  await page.evaluate(() => ((window as any).__e2eBase = (window as any).ferrite.channels.base));
  await toolbar().getByRole("button", { name: "Read from radio" }).click();
  const drop = page.getByRole("button", { name: "Read and discard" });
  if (await drop.isVisible()) await drop.click();
  await expect.poll(() => page.evaluate(() => (window as any).ferrite.channels.base !== (window as any).__e2eBase), { timeout: long() }).toBe(true);
  await expect(toolbar().getByRole("button", { name: "Read from radio" })).toBeEnabled({ timeout: long() });
}

async function write() {
  const dl = page.waitForEvent("download", { timeout: long() });
  await toolbar().getByRole("button", { name: /^Write to radio/ }).click();
  await dl;
  await expect(dialog()).toContainText("Backup saved", { timeout: long() });
  await dialog().getByRole("button", { name: /^Write \d+ changes?$/ }).click();
  await expect(dialog()).toContainText("Read back: the radio holds the table.", { timeout: long() });
  await dialog().getByRole("button", { name: "Close" }).click();
  await expect(dialog()).toHaveCount(0);
}

/** JSON with keys sorted: a read gives the keys in another order than an edit. */
const canon = (v: unknown): string =>
  JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

/** Written, read back, and the radio holds what the table held. */
async function writeAndCheck() {
  const want = canon(await table());
  await write();
  await readRadio();
  expect(canon(await table()) === want, "the radio holds the table").toBe(true);
  expect(await pending()).toBe(0);
}

test.describe.serial("reorder", () => {
  test.skip(onRadio(), "renumbers channels and reorders zones: simulator only");
  let first = "";

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await openConsole(page, "channels");
    await connect(page);
    await readRadio();
    first = JSON.stringify(await table());
  });

  test.afterAll(async () => {
    try {
      if (await dialog().count()) await dialog().getByRole("button", { name: /^(Close|Cancel)$/ }).click();
      await readRadio();
      if (JSON.stringify(await table()) !== first) {
        await page.evaluate((s) => ((window as any).ferrite.channels.table = JSON.parse(s)), first);
        await write();
      }
    } catch (e) {
      console.error(`reorder: couldn't put the radio back: ${(e as Error).message}`);
    }
    await disconnect(page);
    await page.close();
  });

  test("table: drag a channel up, ↓ on its handle, a used number typed; written and read back", async ({}, info) => {
    // A run of five channels numbered in a row to work in: copies of the first at 900-904, written first (the
    // clean-up deletes them again).
    const s = 900;
    await page.evaluate((s) => {
      // New channels as the toolbar's Add makes them, each moved to its number, named and tuned through the editor.
      const c = (window as any).ferrite.channels;
      for (let k = 0; k < 5; k++) {
        const n = c.addChannel();
        c.move(n, s + k);
        c.edit(s + k, "name", `E2E ${k}`);
        c.edit(s + k, "rx", `145.${510 + k * 10}`);
      }
    }, s);
    await writeAndCheck();
    await page.getByLabel("Find a channel", { exact: true }).fill("E2E");
    let t = await table();
    const was = who(t);

    // The fourth dragged onto the first: it takes the first's number, the three it passed move one along.
    await row(s + 3).locator("button.grip").dragTo(row(s));
    t = await table();
    let now = who(t);
    expect(now.get(s)).toBe(was.get(s + 3));
    expect([now.get(s + 1), now.get(s + 2), now.get(s + 3)]).toEqual([was.get(s), was.get(s + 1), was.get(s + 2)]);
    expect(now.get(s + 4)).toBe(was.get(s + 4));
    await expect(page.getByText(`Channel ${s + 3} is now ${s}; channels ${s}–${s + 2} moved one along (now ${s + 1}–${s + 3}).`)).toBeVisible();
    await shot(page, info, "reorder-10-dragged");

    // ↓ on its handle: one place down (a trade with the next), the handle keeps focus at its new number.
    await row(s).locator("button.grip").focus();
    await page.keyboard.press("ArrowDown");
    now = who(await table());
    expect(now.get(s + 1)).toBe(was.get(s + 3));
    expect(now.get(s)).toBe(was.get(s));
    await expect(row(s + 1).locator("button.grip")).toBeFocused();

    // A used number typed in the panel: it takes it (the last of the run to the first).
    const before = who(await table());
    await row(s + 4).getByRole("button", { name: `Details for channel ${s + 4}` }).click();
    const num = page.getByLabel("Channel number");
    await num.fill(String(s));
    await num.press("Enter");
    now = who(await table());
    expect(now.get(s)).toBe(before.get(s + 4));
    expect(now.get(s + 4)).toBe(before.get(s + 3));
    // The panel followed the channel.
    await expect(num).toHaveValue(String(s));
    await page.getByRole("button", { name: "Close the channel panel" }).click();

    await writeAndCheck();

    // Undo takes back one move at a time.
    await row(s + 1).locator("button.grip").focus();
    await page.keyboard.press("ArrowUp");
    expect(await pending()).toBeGreaterThan(0);
    await toolbar().getByRole("button", { name: /Undo/ }).click();
    expect(await pending()).toBe(0);
  });

  test("zones: drag a zone up the list, ▼ moves it back; its channels go with it; written and read back", async ({}, info) => {
    let t = await table();
    await page.getByRole("tab", { name: /^Zones/ }).click();
    while (t.zones.length < 3) {
      await page.getByLabel("New zone name").fill(`E2E ${t.zones.length + 1}`);
      await page.getByRole("button", { name: "Add", exact: true }).click();
      t = await table();
    }
    const names = t.zones.map((z) => z.name);
    const inZone = (tt: T, i: number) => tt.channels.filter((c) => c.zone === i).map((c) => c.number);
    const third = inZone(t, 2);

    // The third dragged onto the first: it's zone 1, the first two move one along, and its channels follow.
    await zoneList().getByRole("option").nth(2).dragTo(zoneList().getByRole("option").nth(0));
    t = await table();
    expect(t.zones.map((z) => z.name)).toEqual([names[2], names[0], names[1], ...names.slice(3)]);
    expect(t.zones.map((z) => z.number)).toEqual(names.map((_, i) => i + 1));
    expect(inZone(t, 0)).toEqual(third);
    await expect(page.getByText(`Zone "${names[2]}" is now zone 1; 2 zones moved one along.`)).toBeVisible();
    await shot(page, info, "reorder-20-zone-dragged");

    // ▼ on the picked zone: one place down.
    await zoneList().getByRole("option").nth(0).click();
    await page.getByRole("button", { name: "Move zone 1 down" }).click();
    t = await table();
    expect(t.zones.map((z) => z.name).slice(0, 3)).toEqual([names[0], names[2], names[1]]);
    await expect(page.getByRole("heading", { name: "Zone 2", exact: true })).toBeVisible();
    expect(inZone(t, 1)).toEqual(third);

    await writeAndCheck();
  });

  test("in a zone: drag the last channel to the top; only the zone's numbers change; written and read back", async ({}, info) => {
    let t = await table();
    const count = (i: number) => t.channels.filter((c) => c.zone === i).length;
    let zi = t.zones.map((_, i) => i).sort((a, b) => count(b) - count(a))[0];
    await page.getByRole("tab", { name: /^Zones/ }).click();
    await zoneList().getByRole("option").nth(zi).click();
    // Three at least: bring some in from no zone when it's short.
    const avail = page.getByRole("list", { name: "Other channels" });
    while (count(zi) < 3) {
      const c = t.channels.find((x) => x.zone !== zi)!;
      await avail.getByRole("button", { name: new RegExp(`^(Add|Move) channel ${c.number} here$`) }).click();
      t = await table();
    }
    const mine = t.channels.filter((c) => c.zone === zi);
    const nums = mine.map((c) => c.number);
    const was = who(t);
    const last = mine.length - 1;

    await members().getByRole("listitem").nth(last).dragTo(members().getByRole("listitem").nth(0));
    t = await table();
    const now = who(t);
    // The zone holds the same numbers; the last one's channel is on the first number, the rest one along.
    expect(t.channels.filter((c) => c.zone === zi).map((c) => c.number)).toEqual(nums);
    expect(now.get(nums[0])).toBe(was.get(nums[last]));
    for (let k = 1; k <= last; k++) expect(now.get(nums[k])).toBe(was.get(nums[k - 1]));
    // Nothing outside the zone moved.
    for (const c of t.channels) if (c.zone !== zi) expect(now.get(c.number)).toBe(was.get(c.number));
    await expect(members().getByRole("listitem").first()).toContainText(mine[last].name || "(no name)");
    await shot(page, info, "reorder-30-in-zone");

    await writeAndCheck();
  });
});
