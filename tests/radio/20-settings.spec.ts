// Stage 20: Radio Settings. Console reads the settings, a user flips Key beep and writes it (the backup and the diff
// first); the radio's own `get` (over Bluetooth) then says the new value, and its settings record changed in that one
// place only. Flipped back and written: the record is byte for byte what it was. Put back even when a step fails.
import { type Page } from "@playwright/test";
import { connect, disconnect, openConsole, shot } from "../e2e/helpers";
import { byteDiff, expect, startSnapshot, test } from "./radio";

test.describe.configure({ mode: "serial" });

const BEEP = "0 7 5 1 Key beep";
let page: Page;
let was: string | null = null;
let flipped = false;

const dialog = () => page.getByRole("dialog");
const beep = () => page.getByLabel(BEEP, { exact: true });

async function readRadio() {
  await page.evaluate(() => ((window as any).__e2eBase = (window as any).ferrite.settings.base));
  await page.getByRole("button", { name: "Read from radio" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).ferrite.settings.base !== (window as any).__e2eBase), { timeout: 120_000 }).toBe(true);
  await expect(page.getByRole("button", { name: "Read from radio" })).toBeEnabled({ timeout: 120_000 });
}

async function writeOne() {
  await page.getByRole("button", { name: "Write to radio…" }).click();
  await expect(dialog().locator('[data-k="kept"]')).toContainText("Backup kept in Console until it closes", { timeout: 120_000 });
  await expect(dialog().locator("li")).toHaveCount(1);
  await dialog().getByRole("button", { name: "Write 1 change" }).click();
  await expect(dialog()).toContainText("Read back: the radio holds these settings.", { timeout: 120_000 });
  await dialog().getByRole("button", { name: "Close" }).click();
  await expect(dialog()).toHaveCount(0);
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await openConsole(page, "settings");
  await connect(page, 30_000);
});

test.afterAll(async () => {
  if (flipped && was) {
    try {
      if (await dialog().count()) await dialog().getByRole("button", { name: /^(Close|Cancel)$/ }).click();
      await readRadio();
      await beep().selectOption(was);
      await writeOne();
    } catch (e) {
      console.error(`couldn't put Key beep back to ${was}: ${(e as Error).message}`);
    }
  }
  await disconnect(page);
  await page.close();
});

test("read: Console shows what the radio's own menu holds", async ({ oracle }, info) => {
  await readRadio();
  was = await beep().inputValue();
  expect((await oracle.get("0 7 5 1")).replace(" (not the default)", "")).toBe(`${BEEP}: ${was}`);
  await shot(page, info, "20-settings-read");
});

test("write: Key beep flipped in Console, and the radio's menu says so", async ({ oracle }, info) => {
  const to = was === "On" ? "Off" : "On";
  const before = await oracle.settings();
  await beep().selectOption(to);
  await writeOne();
  flipped = true;
  expect((await oracle.get("0 7 5 1")).replace(" (not the default)", "")).toBe(`${BEEP}: ${to}`);
  const changed = byteDiff(before, await oracle.settings());
  console.log(`Key beep ${was} -> ${to}: settings bytes ${changed.join(", ")}`);
  expect(changed.length).toBeGreaterThan(0);
  expect(changed.length).toBeLessThanOrEqual(2); // one field (and the record's check bytes, if they move)
  await shot(page, info, "21-settings-written");
});

test("put back: the settings record is as it began", async ({ oracle }) => {
  await readRadio();
  await beep().selectOption(was!);
  await writeOne();
  flipped = false;
  expect((await oracle.get("0 7 5 1")).replace(" (not the default)", "")).toBe(`${BEEP}: ${was}`);
  expect(byteDiff(startSnapshot().settings, await oracle.settings())).toEqual([]);
});
