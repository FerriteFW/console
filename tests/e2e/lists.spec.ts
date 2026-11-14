// The owner's lists through the bridge (LINK-54 – LINK-57): APRS › Quick messages, APRS › Waypoints (and the map's
// layer), Radio Settings › DTMF memories, each read, edited, written (a backup and the diff first) and read back,
// then put back; and the Event Log's new events arriving live (SUBSCRIBE mask 8; injected by the bridge's test hook:
// the headless simulator logs nothing by itself). Simulator only: a test shouldn't rewrite a radio's lists.
import { type Page } from "@playwright/test";
import { connect, disconnect, expect, onRadio, openConsole, shot, state, test } from "./helpers";

test.skip(onRadio(), "rewrites the radio's lists: simulator only");
test.afterEach(async ({ page }) => disconnect(page));

const long = 30_000;
const dialog = (page: Page) => page.getByRole("dialog");
const badge = (page: Page, section: string) => page.locator("nav[aria-label=Sections] a").filter({ hasText: section }).locator(".badge");
const read = (page: Page, key: string) =>
  expect.poll(() => page.evaluate((k) => (window as any).ferrite.lists[k].base !== null, key), { timeout: long, message: `${key} read` }).toBe(true);

/** Write with the list's toolbar: the backup downloads, the diff shows, then Write N changes and the read back. */
async function write(page: Page, toolbar: string, noun: string, review?: () => Promise<void>) {
  const dl = page.waitForEvent("download", { timeout: long });
  await page.getByRole("toolbar", { name: toolbar }).getByRole("button", { name: /^Write to radio/ }).click();
  await dl;
  await expect(dialog(page)).toContainText("Backup saved", { timeout: long });
  await review?.();
  await dialog(page).getByRole("button", { name: /^Write \d+ changes?$/ }).click();
  await expect(dialog(page)).toContainText(`Read back: the radio holds these ${noun}.`, { timeout: long });
  await dialog(page).getByRole("button", { name: "Close" }).click();
  await expect(dialog(page)).toHaveCount(0);
}

test("quick messages: one made the owner's, refused text shown, written, read back, then the factory text again", async ({ page }, info) => {
  await openConsole(page, "aprs-quick");
  await connect(page);
  await read(page, "quick");
  const list = page.getByRole("listbox", { name: "Quick messages" });
  await expect(list.getByRole("option")).toHaveCount(9);
  await list.getByRole("option").nth(3).click();
  const box = page.getByLabel("Quick message text");
  // A text APRS can't carry: the radio's reason, before anything is sent.
  await box.fill("Meet at | the club");
  await box.press("Tab");
  await expect(page.getByRole("alert")).toContainText("no | ~ {");
  await box.fill("E2E: at the club");
  await box.press("Tab");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("Your own text")).toBeVisible();
  await expect(badge(page, "APRS")).toHaveText("1 unwritten");
  await shot(page, info, "lists-01-quick");
  await write(page, "Quick messages", "quick messages", async () => {
    await expect(dialog(page).locator("li").filter({ hasText: "Quick 4" })).toContainText("E2E: at the club");
  });
  expect(await state(page, (f: any) => f.lists.quick.base[3])).toEqual({ own: true, text: "E2E: at the club" });
  await expect(badge(page, "APRS")).toHaveCount(0);
  // Read again from the radio: still there.
  await page.getByRole("toolbar", { name: "Quick messages" }).getByRole("button", { name: "Read from radio" }).click();
  await read(page, "quick");
  await expect(list.getByRole("option").nth(3)).toContainText("E2E: at the club");
  // Back to the factory text.
  await page.getByRole("button", { name: "Back to the factory text" }).click();
  await write(page, "Quick messages", "quick messages");
  expect(await state(page, (f: any) => f.lists.quick.base[3].own)).toBe(false);
});

test("waypoints: one added by grid square, written, on the map, deleted again", async ({ page }, info) => {
  await page.route(/tile\.openstreetmap\.org/, (r) => r.fulfill({ status: 204 }));
  await openConsole(page, "aprs-waypoints");
  await connect(page);
  await read(page, "waypoints");
  const before = await state(page, (f: any) => f.lists.waypoints.base.length as number);
  await page.getByRole("button", { name: "+ Add" }).click();
  await page.getByLabel("Waypoint name").fill("E2E point");
  await page.getByLabel("Waypoint name").press("Tab");
  await page.getByLabel("Waypoint position").fill("FN25dk");
  await page.getByLabel("Waypoint position").press("Tab");
  await expect(page.getByTestId("waypoint-grid")).toContainText("FN25dk");
  await expect(page.getByTestId("waypoint-source")).toHaveText("From Console");
  // A position that isn't one: why, and nothing changed.
  await page.getByLabel("Waypoint position").fill("north of here");
  await page.getByLabel("Waypoint position").press("Tab");
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByLabel("Waypoint position").fill("FN25dk");
  await page.getByLabel("Waypoint position").press("Tab");
  await expect(badge(page, "APRS")).toHaveText("1 unwritten");
  await shot(page, info, "lists-02-waypoint");
  await write(page, "Waypoints", "waypoints", async () => {
    await expect(dialog(page).locator("details.diff > summary")).toContainText("1 added"); // the list folded under its summary
    await dialog(page).locator("details.diff > summary").click();
    await expect(dialog(page).getByRole("heading", { name: "Added (1)" })).toBeVisible();
  });
  const back = await state(page, (f: any) => f.lists.waypoints.base as { name: string; source: string }[]);
  expect(back.length).toBe(before + 1);
  expect([back[0].name, back[0].source]).toEqual(["E2E point", "link"]);

  // On the map: its own layer, switched off and on.
  await page.getByRole("tab", { name: "Map" }).click();
  const map = page.locator("[data-map]");
  await expect.poll(async () => (await map.getAttribute("data-map")) === "ready" || (await page.locator(".pg-banner.warn").count()) > 0, { timeout: 20_000 }).toBe(true);
  if ((await map.getAttribute("data-map")) === "ready") {
    await expect(map).toHaveAttribute("data-waypoints", String(before + 1));
    await expect(page.locator('.aprs-wp[title="E2E point"]')).toHaveCount(1);
    await shot(page, info, "lists-03-map");
    await page.getByLabel("Show waypoints").uncheck();
    await expect(map).toHaveAttribute("data-waypoints", "0");
    await page.getByLabel("Show waypoints").check();
    await expect(page.locator('.aprs-wp[title="E2E point"]')).toHaveCount(1);
  } else info.annotations.push({ type: "skipped", description: "Leaflet's CDN unreachable: the map's layer not checked" });

  // Put back.
  await page.getByRole("tab", { name: "Waypoints" }).click();
  await page.getByRole("option", { name: /E2E point/ }).click();
  await page.getByRole("button", { name: "Delete waypoint E2E point" }).click();
  await write(page, "Waypoints", "waypoints", async () => {
    await expect(dialog(page).locator("details.diff > summary")).toContainText("1 deleted"); // the list folded under its summary
    await dialog(page).locator("details.diff > summary").click();
    await expect(dialog(page).getByRole("heading", { name: "Deleted (1)" })).toBeVisible();
  });
  expect(await state(page, (f: any) => f.lists.waypoints.base.length as number)).toBe(before);
});

test("waypoints: GPX in (on top, names cut to 16), right-click on the map adds one, GPX out (decision 396)", async ({ page }) => {
  await page.route(/tile\.openstreetmap\.org/, (r) => r.fulfill({ status: 204 }));
  await openConsole(page, "aprs-waypoints");
  await connect(page);
  await read(page, "waypoints");
  const before = await state(page, (f: any) => f.lists.waypoints.items.length as number);
  const gpx = `<?xml version="1.0"?><gpx version="1.1"><wpt lat="49.2827" lon="-123.1207"><name>GPX one</name></wpt><wpt lat="48.9" lon="-122.5"><name>A very long waypoint name</name></wpt></gpx>`;
  await page.getByLabel("GPX file").setInputFiles({ name: "trip.gpx", mimeType: "application/gpx+xml", buffer: Buffer.from(gpx) });
  await expect(page.getByText("Added 2 waypoints from trip.gpx")).toBeVisible();
  const items = await state(page, (f: any) => f.lists.waypoints.items.map((w: any) => w.name) as string[]);
  expect(items.length).toBe(before + 2);
  expect(items.slice(0, 2)).toEqual(["GPX one", "A very long wayp"]);
  // Out: a GPX file with every waypoint
  const dl = page.waitForEvent("download", { timeout: long });
  await page.getByRole("button", { name: "Export GPX" }).click();
  const text = await (await dl).createReadStream().then(async (st) => {
    let t = "";
    for await (const c of st) t += c;
    return t;
  });
  expect(text).toContain("<name>GPX one</name>");
  // The map: a right-click adds one there
  await page.getByRole("tab", { name: "Map" }).click();
  const map = page.locator("[data-map]");
  await expect.poll(async () => (await map.getAttribute("data-map")) === "ready" || (await page.locator(".pg-banner.warn").count()) > 0, { timeout: 20_000 }).toBe(true);
  if ((await map.getAttribute("data-map")) === "ready") {
    await map.click({ button: "right", position: { x: 200, y: 200 } });
    await expect(page.locator('[data-k="wp-note"]')).toContainText(`Added Waypoint ${before + 3}`);
    expect(await state(page, (f: any) => f.lists.waypoints.items.length as number)).toBe(before + 3);
  }
  // Put back: nothing written
  await page.getByRole("tab", { name: "Waypoints" }).click();
  await state(page, (f: any) => f.lists.waypoints.revert());
});

test("DTMF memories: one set (lower case to capitals), refused symbols shown, written, read back, cleared", async ({ page }, info) => {
  await openConsole(page, "settings-dtmf");
  await connect(page);
  await read(page, "dtmf");
  await expect(page.getByRole("tab", { name: "DTMF memories" })).toHaveAttribute("aria-selected", "true");
  const list = page.getByRole("listbox", { name: "DTMF memories" });
  await expect(list.getByRole("option")).toHaveCount(16);
  const was = await state(page, (f: any) => f.lists.dtmf.base[14]);
  await list.getByRole("option").nth(14).click();
  await page.getByLabel("DTMF symbols").fill("12E");
  await page.getByLabel("DTMF symbols").press("Tab");
  await expect(page.getByRole("alert")).toContainText("symbols");
  await page.getByLabel("DTMF symbols").fill("*79#a");
  await page.getByLabel("DTMF symbols").press("Tab");
  await page.getByLabel("Memory name").fill("E2E link");
  await page.getByLabel("Memory name").press("Tab");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(badge(page, "Radio Settings")).toHaveText("1 unwritten");
  await shot(page, info, "lists-04-dtmf");
  await write(page, "DTMF memories", "DTMF memories");
  expect(await state(page, (f: any) => f.lists.dtmf.base[14])).toEqual({ symbols: "*79#A", name: "E2E link" });
  // Radio Settings links here from Transmit.
  await page.getByRole("tab", { name: "Settings" }).click();
  await expect(page.getByRole("link", { name: /DTMF memories/ })).toBeVisible({ timeout: long });
  await page.getByRole("link", { name: /DTMF memories/ }).click();
  await list.getByRole("option").nth(14).click();
  await page.getByRole("button", { name: "Clear memory 15" }).click();
  await write(page, "DTMF memories", "DTMF memories");
  expect(await state(page, (f: any) => f.lists.dtmf.base[14])).toEqual(was);
});

/** An event log event's payload (kind 5): the record as LOG_READ gives it (LINK-57). */
function logEvent(seq: number, text: string): number[] {
  const u32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
  const freq = 14_652_000;
  return [5, ...u32(seq), ...u32(0), 5 /* DTMF */, 0, 1 /* unread */, ...u32(freq), ...u32(0), 0, 0, 0, 0, 0, text.length, ...Buffer.from(text)];
}

test("event log: a new event arrives live, without a read", async ({ page }, info) => {
  await openConsole(page, "activity");
  await connect(page);
  await expect.poll(() => state(page, (f: any) => f.activity.readAt as number), { timeout: 20_000 }).toBeGreaterThan(0);
  await expect.poll(() => state(page, (f) => f.radio.subMask as number), { message: "subscribed to the event log" }).toBe(8);
  const readAt = await state(page, (f: any) => f.activity.readAt as number);
  const newest = await state(page, (f: any) => (f.activity.rows[0]?.seq as number | undefined) ?? 0);
  await page.evaluate((p) => (window as any).ferrite.radio.bridgeControl({ inject_event: p }), logEvent(newest + 1, "*E2E#"));
  const first = page.getByRole("table", { name: "Events" }).locator("tbody tr[data-seq]").first();
  await expect(first).toHaveAttribute("data-seq", String(newest + 1));
  await expect(first).toContainText("*E2E#");
  await expect(page.locator("[data-status]")).toContainText("1 new since");
  expect(await state(page, (f: any) => f.activity.readAt as number)).toBe(readAt);
  await shot(page, info, "lists-05-event-live");
});
