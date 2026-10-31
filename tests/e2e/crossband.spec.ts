// Radio Settings › Crossband repeater (XbCfg in the settings record; chapter 19): a setting changed through the
// record with the start page's own choices, written (a backup and the diff first), read back, and put back. The read
// only rows say why (LINK-5, LINK-7), and MENU 0 1 4 links to the range presets.
import { type Page } from "@playwright/test";
import { connect, disconnect, expect, onRadio, openConsole, shot, state, test } from "./helpers";

test.describe.configure({ mode: "serial" });

const long = () => (onRadio() ? 120_000 : 30_000);
let page: Page;
let was = "";
const dialog = () => page.getByRole("dialog");
const hang = () => page.getByLabel("Hang time", { exact: true });
const value = (id: string) =>
  page.evaluate((id) => (window as any).ferrite.settings.view.groups.flatMap((g: any) => g.items).find((i: any) => i.id === id)?.value as string, id);

async function readRadio() {
  await page.evaluate(() => ((window as any).__e2eBase = (window as any).ferrite.settings.base));
  await page.getByRole("button", { name: "Read from radio" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).ferrite.settings.base !== (window as any).__e2eBase), { timeout: long() }).toBe(true);
  await expect(page.getByRole("button", { name: "Read from radio" })).toBeEnabled({ timeout: long() });
}

async function write() {
  const dl = page.waitForEvent("download", { timeout: long() });
  await page.getByRole("button", { name: "Write to radio…" }).click();
  await dl;
  await expect(dialog()).toContainText("Backup saved", { timeout: long() });
  await expect(dialog().locator("li")).toHaveCount(1);
  await expect(dialog().locator("li")).toContainText("Hang time");
  await dialog().getByRole("button", { name: "Write 1 change" }).click();
  await expect(dialog()).toContainText("Read back: the radio holds these settings.", { timeout: long() });
  await dialog().getByRole("button", { name: "Close" }).click();
  await expect(dialog()).toHaveCount(0);
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await openConsole(page, "settings");
  await connect(page);
  await expect.poll(() => state(page, (f) => !!f.settings.view), { timeout: long() }).toBe(true);
});

test.afterAll(async () => {
  if (was) {
    try {
      if (await dialog().count()) await dialog().getByRole("button", { name: /^(Close|Cancel)$/ }).click();
      await readRadio();
      if ((await value("xb.hang")) !== was) {
        await hang().selectOption(was);
        await write();
      }
    } catch (e) {
      console.error(`couldn't put the crossband hang time back (${was}): ${(e as Error).message}`);
    }
  }
  await disconnect(page);
  await page.close();
});

test("read only rows say why; 0 1 4 links to the range presets", async () => {
  await expect(page.locator('[data-id="0 9 4"] [data-reason]')).toContainText("for safety");
  await expect(page.locator('[data-id="0 9 2 3"] [data-reason]')).toContainText("cut this connection");
  await expect(page.locator('[data-id="0 9 3 1"] [data-reason]')).toContainText("PIN never goes over the link");
  await expect(page.locator('[data-id="0 8 8 5"] [data-reason]')).toContainText("only the radio turns it off");
  await expect(page.locator('[data-id="0 1 4"] a')).toHaveAttribute("href", "#/channels?tab=presets");
  await expect(page.locator('[data-id="0 1 5"] a')).toHaveAttribute("href", "#/channels?tab=presets");
});

test("crossband: the start page's choices, a change written and read back", async ({}, info) => {
  const g = page.getByRole("region", { name: "Crossband repeater" });
  await expect(g).toBeVisible();
  await expect(page.getByLabel("Power", { exact: true }).locator("option")).toHaveText(["Low", "Mid"]);
  await expect(hang().locator("option")).toHaveText(["0.0 s", "0.5 s", "1.0 s", "1.5 s", "2.0 s", "2.5 s", "3.0 s"]);
  was = await value("xb.hang");
  const to = was === "2.5 s" ? "1.5 s" : "2.5 s";
  await hang().selectOption(to);
  await expect(page.locator('[data-id="xb.hang"]')).toHaveClass(/changed/);
  await g.scrollIntoViewIfNeeded();
  await shot(page, info, "crossband-01-edited");
  await write();
  await readRadio();
  expect(await value("xb.hang")).toBe(to);
  await expect(hang()).toHaveValue(to);
});
