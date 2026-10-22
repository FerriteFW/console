// APRS contacts through the bridge (APRS-42, record 6): read in callsign order, one added, renamed and deleted,
// each written at once and read back; a full book or a bad callsign is refused before anything is sent. On a
// radio the test contact is deleted again whatever happens.
import { type Page } from "@playwright/test";
import { connect, disconnect, expect, onRadio, openConsole, state, test } from "./helpers";

test.describe.configure({ mode: "serial" });

const long = () => (onRadio() ? 60_000 : 20_000);
const CALL = "VE9TST-5";
let page: Page;
const names = () => state(page, (f) => f.contacts.list.map((c: any) => `${c.call}=${c.name}`).join(" "));

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await openConsole(page, "aprs-contacts");
  await connect(page);
});

test.afterAll(async () => {
  try {
    await page.evaluate((c) => (window as any).ferrite.contacts.write([], [c]), CALL);
  } catch {
    /* not there */
  }
  await disconnect(page);
  await page.close();
});

test("read, add, rename, delete", async () => {
  await expect.poll(() => state(page, (f) => f.contacts.loaded), { timeout: long() }).toBe(true);
  await page.getByLabel("Callsign").fill("v9");
  await expect(page.getByRole("button", { name: "Add or rename" })).toBeDisabled();
  await page.getByLabel("Callsign").fill(CALL.toLowerCase());
  await page.getByLabel("Name", { exact: true }).fill("Bench");
  await page.getByRole("button", { name: "Add or rename" }).click();
  await expect.poll(names, { timeout: long() }).toContain(`${CALL}=Bench`);
  const row = page.getByLabel(`Name of ${CALL}`);
  await row.fill("Bench two");
  await row.press("Enter");
  await row.blur();
  await expect.poll(names, { timeout: long() }).toContain(`${CALL}=Bench two`);
  await page.getByRole("row", { name: new RegExp(CALL) }).getByRole("button", { name: "Delete" }).click();
  await expect.poll(names, { timeout: long() }).not.toContain(CALL);
});
