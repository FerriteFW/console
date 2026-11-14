// Satellites (SAT-2, SAT-3, SAT-13, SAT-15, SAT-18, SAT-21; LINK-63 – LINK-65) through the bridge: the list from
// data.ferritefw.dev (tests/e2e/fixtures/satellites/sats.json: six satellites, one with only a 10 m transmitter the
// radio can't use), picks, a write (clock, list, info with the declination) read back from the radio, and the
// refresh on connect when the list is newer, at most once a day, never for a radio holding none. Simulator only: a
// test shouldn't rewrite a radio's satellites.
import { type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import { connect, disconnect, expect, onRadio, openConsole, shot, state, test } from "./helpers";
import { DATA, blockTiles } from "./sitedata";

test.skip(onRadio(), "rewrites the radio's satellites: simulator only");
test.afterEach(async ({ page }) => disconnect(page));

const long = 30_000;
const FIX = readFileSync(new URL("./fixtures/satellites/sats.json", import.meta.url), "utf8");
const day = 86_400;
const utc = (d: string) => Date.parse(`${d}T00:00:00Z`) / 1000;

/** The fixture built on `built`, every element epoch `shift` days later. */
function file(built: string, shift = 0): string {
  const f = JSON.parse(FIX);
  f.built = built;
  for (const s of f.satellites) s.elements.epoch = new Date(Date.parse(`${s.elements.epoch}Z`) + shift * day * 1000).toISOString().replace("Z", "");
  return JSON.stringify(f);
}

/** data.ferritefw.dev's satellites/sats.json from `body()` (asked again on every fetch); anything else 404. */
async function serveSats(page: Page, body: () => string): Promise<string[]> {
  const asked: string[] = [];
  await blockTiles(page);
  await page.route(`${DATA}/**`, async (route: Route) => {
    const path = new URL(route.request().url()).pathname.slice(1);
    asked.push(path);
    const headers = { "Access-Control-Allow-Origin": "*" };
    if (path === "satellites/sats.json") return route.fulfill({ body: body(), contentType: "application/json", headers });
    return route.fulfill({ status: 404, body: "Not Found", headers });
  });
  return asked;
}

type Held = { id: number; short: string; epoch: number }[];
const held = (page: Page) => state(page, (f: any) => (f.satellites.held as Held | null)?.map((s) => ({ id: s.id, short: s.short, epoch: s.epoch })) ?? null);
const info = (page: Page) => state(page, (f: any) => f.satellites.info as { decl: number | null; stamp: number; written: number } | null);
const toolbar = (page: Page) => page.getByRole("toolbar", { name: "Satellites" });
// one table (Alex, Nov 14, 2026): the list, sorted by next pass; "On the radio" says which the radio holds
const listRows = (page: Page) => page.getByRole("table", { name: "Satellites" }).locator("tbody tr");
const radioRows = (page: Page) => listRows(page).filter({ has: page.locator("td.onradio.yes") });

/** Connected on the Satellites page with the radio's satellites read. */
async function ready(page: Page) {
  await connect(page);
  await expect.poll(() => held(page), { timeout: long, message: "the radio's satellites read" }).not.toBeNull();
  await expect.poll(() => state(page, (f: any) => f.satellites.busy as string), { timeout: long }).toBe("");
}

/** Write with the toolbar; the page's note says how many. */
async function write(page: Page, n: number) {
  await toolbar(page).getByRole("button", { name: "Write to radio" }).click();
  await expect(page.locator(".pg-banner.ok")).toContainText(`Wrote ${n} satellites and set the radio's clock`, { timeout: long });
}

test("the list: only what an FM handheld can work, all written, with the clock and declination, read back", async ({ page }, info_) => {
  await serveSats(page, () => file("2026-10-31"));
  await openConsole(page, "satellites");
  await page.evaluate(() => ((window as any).ferrite.library.placeText = "49.2827, -123.1207"));
  await expect(listRows(page)).toHaveCount(5);
  await expect(page.getByRole("table", { name: "Satellites" })).not.toContainText("TEVEL2-8");
  await expect(page.locator("[data-status]")).toContainText("List of 2026-10-31: 5 satellites an FM handheld can work.");
  await expect(page.getByRole("checkbox", { name: /^Pick / })).toHaveCount(0); // no picking (Alex, Nov 14, 2026)
  await expect(listRows(page).filter({ hasText: "SO-50" })).toContainText("tone 67.0 (arm 74.4)");
  await ready(page);
  await shot(page, info_, "satellites-01-list");
  const before = Math.floor(Date.now() / 1000);
  await write(page, 5);
  await expect(page.locator(".pg-banner.ok")).toContainText(/declination \d+\.\d° [EW] at /);
  await expect(radioRows(page)).toHaveCount(5);
  const listed = await state(page, (f: any) => f.satellites.file.sats.map((s: { id: number }) => s.id) as number[]);
  expect((await held(page))!.map((s) => s.id)).toEqual(listed); // the whole list, in its order
  await expect(page.locator('[data-k="radio-state"]')).toContainText("The radio has this list (5 satellites).");
  // sorted by next pass: up now first, then the soonest
  const order = await listRows(page).locator("td.pass").allTextContents();
  const up = order.filter((t) => t.startsWith("Up now")).length;
  expect(order.slice(0, up).every((t) => t.startsWith("Up now"))).toBe(true);
  await expect(radioRows(page).filter({ hasText: "SO-50" })).toContainText("arm 74.4");
  const i = (await info(page))!;
  expect(i.stamp).toBe(utc("2026-10-31"));
  expect(i.written).toBeGreaterThanOrEqual(before);
  expect(i.decl).not.toBeNull();
  const clock = await state(page, (f: any) => f.satellites.clock as { now: number; source: string });
  expect(Math.abs(clock.now - before)).toBeLessThan(120);
  await expect(page.locator("[data-radio-info]")).toContainText("5 of 32 satellites · declination");
  await shot(page, info_, "satellites-02-written");
});

test("SAT-21: a connect puts the whole list on the radio when its set differs or the list is newer, once a day; a radio with none gets it too", async ({ page }) => {
  let body = file("2026-10-30");
  await serveSats(page, () => body);
  await openConsole(page, "satellites");
  await expect(listRows(page)).toHaveCount(5);
  await ready(page);
  await write(page, 5);
  const was = (await held(page))!;
  expect(was.length).toBe(5);
  expect((await info(page))!.stamp).toBe(utc("2026-10-30"));
  await disconnect(page);

  // Two days on, a newer list (every epoch a day later): the connect writes it, no prompt.
  body = file("2026-11-01", 1);
  await page.clock.setSystemTime(Date.now() + 2 * day * 1000);
  await page.goto("about:blank"); // a new visit: nothing kept in memory
  await openConsole(page, "live");
  await ready(page);
  const toast = page.locator("[data-sat-toast]");
  await expect(toast).toContainText("Updated the radio's 5 satellites with fresh elements (data of 2026-11-01).", { timeout: long });
  await expect.poll(async () => (await info(page))?.stamp, { timeout: long }).toBe(utc("2026-11-01"));
  const now = (await held(page))!;
  expect(now.map((s) => s.id)).toEqual(was.map((s) => s.id));
  expect(now.map((s) => s.epoch - was.find((w) => w.id === s.id)!.epoch)).toEqual([day, day, day, day, day]);
  const written = (await info(page))!.written;
  await toast.getByRole("button", { name: "Dismiss" }).click();
  await disconnect(page);

  // An even newer list at once: written under a day ago, so no second write.
  body = file("2026-11-02", 2);
  await ready(page);
  await page.waitForTimeout(3000);
  await expect(toast).toHaveCount(0);
  expect((await info(page))!.written).toBe(written);

  // A radio holding none, a day later: it gets the whole list (Alex, Nov 14, 2026: no picking).
  await page.evaluate(() => (window as any).ferrite.radio.connectedLink.writeRecords(12, [{ index: 0xffff, record: new Uint8Array() }]));
  await disconnect(page);
  await page.clock.setSystemTime(Date.now() + 4 * day * 1000);
  await ready(page);
  await expect(toast).toContainText("Put the 5 satellites of the list on the radio", { timeout: long });
  await expect.poll(async () => (await held(page))?.length, { timeout: long }).toBe(5);
});

test("SAT-23: one list sorted by next pass; the map shows the satellite picked in its menu or a row clicked", async ({ page }) => {
  await serveSats(page, () => file("2026-10-31"));
  await openConsole(page, "satellites");
  await page.evaluate(() => ((window as any).ferrite.library.placeText = "49.2827, -123.1207"));
  await expect(listRows(page)).toHaveCount(5);
  await ready(page);
  const menu = page.getByRole("combobox", { name: "Satellite on the map" });
  const caption = page.locator('[data-k="satmap"]');
  await expect(menu).toBeVisible();
  // SAT-23: each satellite's next pass over the place, and the map's passes
  await expect(page.getByRole("table", { name: "Satellites" }).locator("td.pass").first()).toHaveText(/(Up now until|Today|Tomorrow|[A-Z][a-z]{2}) .*\d+°|none in 2 days/);
  await expect(page.locator('[data-k="pass"]')).toContainText(/Next over you|Over you now|No pass/);
  // the menu
  await menu.selectOption({ label: "SO-50" });
  await expect(menu.locator("option:checked")).toHaveText("SO-50");
  await expect(caption).toContainText("km up");
  // a row in the list
  await listRows(page).filter({ hasText: "AO-27" }).locator("td.pass").click();
  await expect(menu.locator("option:checked")).toHaveText("AO-27");
  // one table, no second list of the radio's
  await expect(page.getByRole("table")).toHaveCount(1);
  // sorted by next pass: the passes' times never go backwards (no-pass rows last)
  const keys = await listRows(page).evaluateAll((trs) => trs.map((tr) => tr.querySelector("td.pass")?.textContent ?? ""));
  const firstNone = keys.findIndex((k) => k.startsWith("none") || k === "–");
  if (firstNone >= 0) expect(keys.slice(firstNone).every((k) => k.startsWith("none") || k === "–")).toBe(true);
});
