// Channels & Zones through the bridge: read, edit one channel's name and write it (backup and diff first), read it
// back, put it back, and a CHIRP CSV export and import round trip. On the radio (FERRITE_E2E_CHANNEL) the edited
// channel is a scratch one, and its name is put back even when a test fails.
import { type Download, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { closeWelcome, connect, disconnect, expect, onRadio, openConsole, saveKept, shot, shotsDir, state, test } from "./helpers";

let page: Page;
/** The channel the tests edit, its name as read, and the name written (while it is on the radio). */
let num = 0;
let original = "";
let written: string | null = null;

const row = () => page.locator(`tr[data-n="${num}"]`);
const dialog = () => page.getByRole("dialog");
const toolbar = () => page.getByRole("toolbar", { name: "Channels" });

async function readRadio() {
  // Done when the read set is a new one (the button can still look enabled before the read starts).
  await page.evaluate(() => ((window as any).__e2eBase = (window as any).ferrite.channels.base));
  await toolbar().getByRole("button", { name: "Read from radio" }).click();
  // Unwritten changes: the page asks first.
  const drop = page.getByRole("button", { name: "Read and discard" });
  if (await drop.isVisible()) await drop.click();
  await expect
    .poll(() => page.evaluate(() => (window as any).ferrite.channels.base !== (window as any).__e2eBase), {
      timeout: onRadio() ? 120_000 : 30_000,
    })
    .toBe(true);
  await expect(toolbar().getByRole("button", { name: "Read from radio" })).toBeEnabled({ timeout: onRadio() ? 120_000 : 30_000 });
  await expect.poll(() => state(page, (f) => f.channels.table.channels.length)).toBeGreaterThan(0);
}

const nameOnTable = () => state(page, (f) => f.channels.table.channels.map((c: any) => [c.number, c.name]));

async function setName(name: string) {
  const input = row().locator("input.name");
  await input.fill(name);
  await input.press("Tab"); // the change event
}

async function save(d: Download, as?: string) {
  const path = join(shotsDir(), `${onRadio() ? "radio" : "sim"}-${as ?? d.suggestedFilename()}`);
  await d.saveAs(path);
  return path;
}

/** Write to radio...: the backup kept in Console (LINK-21.2), the review shows; `as`: the backup saved from the
 *  dialog too (its channels part returned). */
async function startWrite(as?: string) {
  await toolbar().getByRole("button", { name: /^Write to radio/ }).click();
  await expect(dialog()).toContainText("Backup kept in Console until it closes", { timeout: onRadio() ? 120_000 : 30_000 });
  return as ? (await saveKept(page, dialog(), as, "channels", onRadio() ? 120_000 : 30_000)).file : null;
}

async function commitWrite() {
  await dialog().getByRole("button", { name: /^Write \d+ changes?$/ }).click();
  await expect(dialog()).toContainText("Read back: the radio holds the table.", { timeout: onRadio() ? 120_000 : 30_000 });
}

async function closeWrite() {
  await dialog().getByRole("button", { name: /^(Close|Cancel)$/ }).click();
  await expect(dialog()).toHaveCount(0);
}

// Two groups, each with its own page: they can run on two workers (each with its own simulator).
test.describe.serial("edit", () => {
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await openConsole(page, "channels");
    await connect(page);
  });

  test.afterAll(async () => {
    // The radio's channel back as it was, whatever failed on the way.
    if (written !== null && original !== written) {
      try {
        if (await dialog().count()) await closeWrite();
        await readRadio();
        await setName(original);
        await startWrite();
        await commitWrite();
        await closeWrite();
      } catch (e) {
        console.error(`channel ${num}: couldn't put its name back to "${original}": ${(e as Error).message}`);
      }
    }
    await disconnect(page);
    await page.close();
  });

  test("read: zones and channels as INFO counts them", async ({}, info) => {
    await readRadio();
    const [chs, zones, want] = await state(page, (f) => [f.channels.table.channels.length, f.channels.table.zones.length, f.radio.info]);
    expect(chs).toBe(want.channels);
    expect(zones).toBe(want.zones);
    const env = process.env.FERRITE_E2E_CHANNEL;
    // A bridge on a real cable (whatever the env says): never pick a channel to edit by ourselves.
    const label = await state(page, (f) => f.radio.label as string);
    if (!env && !label.includes("simulator")) throw new Error(`${label}: set FERRITE_E2E_CHANNEL to a scratch channel`);
    const all = await nameOnTable();
    num = env ? Number(env) : Math.max(...all.map(([n]) => n as number));
    const hit = all.find(([n]) => n === num);
    expect(hit, `channel ${num} is on the radio`).toBeTruthy();
    original = hit![1] as string;
    console.log(`editing channel ${num} ("${original}")`);
    await row().scrollIntoViewIfNeeded();
    await shot(page, info, "10-read");
  });

  test("edit and write: a backup first, the diff, then the write", async ({}, info) => {
    const name = `E2E ${String(Date.now() % 100000).padStart(5, "0")}`;
    await setName(name);
    await expect(row()).toHaveClass(/changed|edit|dirty/);
    await shot(page, info, "11-edited");
    // The backup holds the radio as it was: the old name.
    const file = await startWrite("channels-backup.ferrite");
    expect(file.format).toBe("ferrite-console-channels");
    expect(JSON.stringify(file)).toContain(JSON.stringify(original));
    // The diff: exactly this channel, its name old to new.
    const item = dialog().locator("li", { hasText: `Ch ${num}` });
    await expect(item).toHaveCount(1);
    await expect(item.locator("b")).toHaveText(name);
    if (original) await expect(item.locator("s")).toHaveText(original);
    await expect(dialog().getByRole("button", { name: "Write 1 change" })).toBeEnabled();
    await shot(page, info, "12-diff");
    written = name;
    await commitWrite();
    await shot(page, info, "13-written");
    await closeWrite();
  });

  test("read back: the radio holds the new name; then it is put back", async ({}, info) => {
    expect(written).not.toBeNull();
    await readRadio();
    expect((await nameOnTable()).find(([n]) => n === num)?.[1]).toBe(written);
    await row().scrollIntoViewIfNeeded();
    await shot(page, info, "14-read-back");
    await setName(original);
    await startWrite();
    await commitWrite();
    await closeWrite();
    written = null;
    await readRadio();
    expect((await nameOnTable()).find(([n]) => n === num)?.[1]).toBe(original);
    await shot(page, info, "15-put-back");
  });
});

test.describe.serial("round trip", () => {
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await openConsole(page, "channels");
    await connect(page);
  });

  test.afterAll(async () => {
    await disconnect(page);
    await page.close();
  });

  test("CHIRP: export, import that file (merge), nothing to write", async ({}, info) => {
    await readRadio();
    const dl = page.waitForEvent("download");
    await toolbar().getByRole("button", { name: /^File/ }).click();
    await page.getByRole("menuitem", { name: /^Export CHIRP/ }).click();
    const csv = await save(await dl, "export.csv");
    const text = readFileSync(csv, "utf8");
    expect(text.split(/\r?\n/)[0]).toMatch(/^Location,Name,Frequency,Duplex,Offset,Tone,/);
    const count = await state(page, (f) => f.channels.table.channels.length);
    await page.locator('input[type=file][accept^=".csv"]').setInputFiles(csv);
    await expect(dialog()).toBeVisible();
    // Every number clashes, so the dialog offers a new zone first: merge is the round trip.
    await expect(dialog().getByRole("radio", { name: "Add as new channels in a new zone" })).toBeChecked();
    await dialog().getByRole("radio", { name: /^Merge by number/ }).check();
    await shot(page, info, "16-chirp-import");
    await dialog().getByRole("button", { name: /^Import \d+$/ }).click();
    await expect(dialog()).toHaveCount(0);
    expect(await state(page, (f) => f.channels.table.channels.length)).toBe(count);
    // Nothing to write: the table is, field for field, the radio as read, so Write has no change to send.
    expect(await state(page, (f) => f.channels.pending)).toBe(0);
    const w = toolbar().getByRole("button", { name: /^Write to radio/ });
    await expect(w).toHaveText("Write to radio");
    await expect(w).toBeDisabled();
    await shot(page, info, "17-chirp-nothing-to-write");
  });
});

// Unwritten changes (nothing here is written to the radio): a bulk edit from the bar, its delete undone, and the
// table's changes kept across a reload, then discarded.
test.describe.serial("unwritten", () => {
  /** The table as first read: each test ends with the table like this again. */
  let first = "";
  const table = () => state(page, (f) => JSON.stringify(f.channels.table));

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await openConsole(page, "channels");
    await connect(page);
  });

  test.afterAll(async () => {
    await disconnect(page);
    await page.close();
  });

  test("bulk edit: power on two rows, delete them, undo both", async ({}, info) => {
    await readRadio();
    first = await table();
    const two = await state(page, (f) => f.channels.table.channels.slice(0, 2).map((c: any) => ({ n: c.number, power: c.power })));
    for (const c of two) await page.getByRole("checkbox", { name: `Select channel ${c.n}`, exact: true }).check();
    const bar = page.getByRole("region", { name: "Selected channels" });
    await expect(bar).toContainText("2 selected");
    // A power neither row has.
    const powers = (await bar.getByLabel("Set power").locator("option").allTextContents()).filter((p) => !p.endsWith("…"));
    const want = powers.find((p) => !two.some((c) => c.power === p))!;
    await bar.getByLabel("Set power").selectOption(want);
    const got = await state(page, (f) => f.channels.table.channels.slice(0, 2).map((c: any) => c.power));
    expect(got).toEqual([want, want]);
    await expect(toolbar().getByRole("button", { name: "Write to radio (2 changes)" })).toBeEnabled();
    for (const c of two) await expect(page.locator(`tr[data-n="${c.n}"]`)).toHaveClass(/changed/);
    await shot(page, info, "18-bulk-power");

    // Delete from the bar: gone, then back from the notice's Undo (the power change stays).
    await bar.getByRole("button", { name: "Delete 2" }).click();
    for (const c of two) await expect(page.locator(`tr[data-n="${c.n}"]`)).toHaveCount(0);
    await expect(page.locator(".toast", { hasText: "Deleted 2 channels." })).toBeVisible();
    await shot(page, info, "19-bulk-deleted");
    await page.locator(".toast", { hasText: "Deleted 2 channels." }).getByRole("button", { name: "Undo" }).click();
    for (const c of two) await expect(page.locator(`tr[data-n="${c.n}"]`)).toHaveCount(1);
    expect(await state(page, (f) => f.channels.table.channels.slice(0, 2).map((c: any) => c.power))).toEqual([want, want]);
    // Ctrl/Cmd+Z: the power change undone too; the table is the radio as read.
    await page.locator("h1, .status").first().click().catch(() => {});
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(table).toBe(first);
    await expect(toolbar().getByRole("button", { name: "Write to radio" })).toBeDisabled();
  });

  test("RX and TX typed; the shift shown, and typed it sets TX; then undone", async () => {
    if (!first) {
      await readRadio();
      first = await table();
    }
    const n = await state(page, (f) => f.channels.table.channels[0].number);
    const r = page.locator(`tr[data-n="${n}"]`);
    await r.getByLabel("RX MHz").fill("146.94");
    await r.getByLabel("RX MHz").press("Tab");
    // TX 600 kHz below: the shift shows it, stored as CHIRP's duplex/offset.
    await r.getByLabel("TX MHz").fill("146.34");
    await r.getByLabel("TX MHz").press("Tab");
    await expect(r.getByLabel("Shift")).toHaveValue("\u2212600 kHz");
    expect(await state(page, (f) => [f.channels.table.channels[0].duplex, f.channels.table.channels[0].offset])).toEqual(["-", "0.60000"]);
    // The shift typed: TX follows.
    await r.getByLabel("Shift").fill("+5M");
    await r.getByLabel("Shift").press("Tab");
    await expect(r.getByLabel("TX MHz")).toHaveValue("151.94000");
    // A TX far from RX (crossband): no shift shown, kept as a TX of its own.
    await r.getByLabel("TX MHz").fill("446.94");
    await r.getByLabel("TX MHz").press("Tab");
    await expect(r.getByLabel("Shift")).toHaveValue("");
    expect(await state(page, (f) => f.channels.table.channels[0].duplex)).toBe("split");
    // Nonsense: refused, marked, the channel as it was.
    await r.getByLabel("Shift").fill("lots");
    await r.getByLabel("Shift").press("Tab");
    await expect(r.getByLabel("Shift")).toHaveClass(/err/);
    expect(await state(page, (f) => f.channels.table.channels[0].duplex)).toBe("split");
    // Undo back to the radio's table.
    await page.locator("h1, .status").first().click().catch(() => {});
    for (let i = 0; i < 6 && (await table()) !== first; i++) await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(table).toBe(first);
  });

  test("restore: unwritten changes come back after a reload, then Discard", async ({}, info) => {
    if (!first) {
      await readRadio();
      first = await table();
    }
    num = await state(page, (f) => f.channels.table.channels[0].number);
    const name = `E2E ${String(Date.now() % 100000).padStart(5, "0")}`;
    await setName(name);
    const nav = page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: /^Channels & Zones/ });
    await expect(nav).toContainText("1 unwritten");
    // Kept (IndexedDB) once the edit settles.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            new Promise<string>((ok) => {
              const r = indexedDB.open("ferrite-console-channels", 1);
              r.onsuccess = () => {
                const q = r.result.transaction("kv").objectStore("kv").get("working");
                q.onsuccess = () => ok(JSON.stringify(q.result?.table ?? null));
                q.onerror = () => ok("");
              };
              r.onerror = () => ok("");
            }),
        ),
      )
      .toContain(name);
    // Leaving asks first (beforeunload); the test says yes.
    const asked: string[] = [];
    const yes = (d: import("@playwright/test").Dialog) => {
      asked.push(d.type());
      void d.accept();
    };
    page.on("dialog", yes);
    await page.reload();
    await closeWelcome(page);
    page.off("dialog", yes);
    expect(asked.every((t) => t === "beforeunload")).toBe(true);

    const notice = page.locator(".restored", { hasText: "Restored 1 unwritten change from your last visit." });
    await expect(notice).toBeVisible();
    await expect(row().locator("input.name")).toHaveValue(name);
    await expect(nav).toContainText("1 unwritten");
    await shot(page, info, "20-restored");
    await notice.getByRole("button", { name: "Discard" }).click();
    await expect(notice).toHaveCount(0);
    await expect(nav).not.toContainText("unwritten");
    expect(await table()).toBe(first);
    // Nothing kept now: a reload has no notice.
    await page.waitForTimeout(500);
    await page.reload();
    await closeWelcome(page);
    await expect(page.getByText(/^Restored /)).toHaveCount(0);
  });
});
