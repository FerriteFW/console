// Add channels › Near me (no radio): one tab, the map by default; the sidebar's kinds (Licensed, Airports, Repeaters:
// switches, any of them, at least one, with counts) decide what the map, the list and Add show (remembered); one
// clicked from another tab opens Near me; Canada and the US as sub-filter chips; a popup's box adds to Picked and shows
// ticked in the lists; Add's count follows the switches; one Add makes an airport's AM channel, a licensed NFM one and
// a repeater's (shift and tones), with positions; repeaters as a list, searched; the radius slider loads again; "Use
// my location" with the browser's position, and refused. The data comes from tests/e2e/fixtures/sitedata, the map's
// tiles are refused (no internet).
import { type Browser, type Locator, type Page } from "@playwright/test";
import { kind, marker, onlyKinds, openData, openSite, serveData } from "./sitedata";
import { closeWelcome, expect, openConsole, shot, state, test } from "./helpers";

/** Vancouver airport. */
const PLACE = "49.1947, -123.1792";

async function open(browser: Browser, ctx: Parameters<Browser["newContext"]>[0] = {}) {
  const c = await browser.newContext(ctx);
  const p = await c.newPage();
  await serveData(p);
  await openConsole(p, "channels");
  await p.getByRole("button", { name: "Add from library…" }).first().click();
  const d = p.getByRole("dialog", { name: "Add channels" });
  await d.getByRole("tab", { name: /^Near me/ }).click();
  return { p, d, close: () => c.close() };
}

test("map: the default, big; the sidebar's kinds; chips; picks shared with the lists; Add follows the switches", async ({ browser }, info) => {
  const { p, d, close } = await open(browser);
  await expect(d.getByRole("button", { name: "Map", exact: true })).toHaveAttribute("aria-pressed", "true");
  // Repeaters and Business & public by default (repeaters first in the sidebar).
  await expect(kind(d, "Repeaters")).toHaveAttribute("aria-pressed", "true");
  await expect(kind(d, "Business & public")).toHaveAttribute("aria-pressed", "true");
  await expect(kind(d, "Airports")).toHaveAttribute("aria-pressed", "false");
  await expect(d.locator(".map[data-map=ready]")).toBeVisible();
  await d.getByLabel("Place: latitude, longitude or grid square").fill(PLACE);
  // Each kind's count near the place, shown or not (the fixtures: 2 airports and 7 repeater sites within 50 km).
  await expect(kind(d, "Airports")).toHaveText(/^Airports\s*2$/);
  await expect(kind(d, "Repeaters")).toHaveText(/^Repeaters\s*7$/);
  await expect(kind(d, "Business & public")).toHaveText(/^Business & public\s*\d+$/);
  // The dialog nearly fills the window; Picked is a slim column on the map's right.
  const vw = p.viewportSize()!;
  const box = (await d.boundingBox())!;
  expect(box.width).toBeGreaterThan(vw.width * 0.9);
  expect(box.height).toBeGreaterThan(vw.height * 0.85);
  const picked = d.getByRole("complementary", { name: "Picked" });
  const side = (await picked.boundingBox())!;
  const mapBox = (await d.locator(".wrap").boundingBox())!;
  expect(side.x).toBeGreaterThan(mapBox.x + mapBox.width - 1);
  expect(side.width).toBeLessThan(300);
  // Sub-filter chips for the sources with data here: Canada and the US (Point Roberts); no airport markers.
  const chip = (name: string) => d.getByRole("button", { name: new RegExp(`^${name} \\d+$`) });
  for (const c of ["Canada", "US"]) await expect(chip(c)).toHaveAttribute("aria-pressed", "true");
  // Business is off to start (the map's noise): its sites (point roberts, richmond works) show once it's on.
  const business = d.getByRole("group", { name: "Business and public categories" }).getByRole("button", { name: /^Business/ });
  await expect(business).toHaveAttribute("aria-pressed", "false");
  await expect(marker(d, "point roberts")).toHaveCount(0);
  await business.click();
  await expect(marker(d, "point roberts").first()).toBeVisible({ timeout: 20_000 });
  await expect(marker(d, "richmond works").first()).toBeVisible();
  await expect(marker(d, "CYVR")).toHaveCount(0);
  // Digital only never shows.
  await expect(marker(d, "ecomm")).toHaveCount(0);
  await shot(p, info, "42-nearme-map");

  // Canada off: its markers go, the US's stay; back on.
  await chip("Canada").click();
  await expect(chip("Canada")).toHaveAttribute("aria-pressed", "false");
  await expect(marker(d, "richmond works")).toHaveCount(0);
  await expect(marker(d, "point roberts").first()).toBeVisible();
  await chip("Canada").click();
  await expect(marker(d, "richmond works").first()).toBeVisible();

  // The search narrows the map's markers (and the list's rows: the same search).
  const search = d.getByLabel("Search sites near the place");
  await search.fill("point roberts");
  await expect(marker(d, "richmond works")).toHaveCount(0);
  await expect(marker(d, "point roberts").first()).toBeVisible();
  await search.fill("");
  await expect(marker(d, "richmond works").first()).toBeVisible();

  // Airports only: airports' markers, no licensed ones, no Canada/US chips.
  await onlyKinds(d, "Airports");
  await expect(marker(d, "CYVR").first()).toBeVisible({ timeout: 20_000 });
  await expect(marker(d, "richmond works")).toHaveCount(0);
  await expect(marker(d, "point roberts")).toHaveCount(0);
  await expect(chip("Canada")).toHaveCount(0);
  // The last kind on stays on.
  await kind(d, "Airports").click();
  await expect(kind(d, "Airports")).toHaveAttribute("aria-pressed", "true");
  // Repeaters only: their markers, in the legend.
  await onlyKinds(d, "Repeaters");
  await expect(marker(d, "VE7RPT").first()).toBeVisible({ timeout: 20_000 });
  await expect(marker(d, "CYVR")).toHaveCount(0);
  await expect(d.locator(".legend")).toContainText("Repeater");
  // All three.
  await onlyKinds(d, "Business & public", "Airports", "Repeaters");
  await expect(marker(d, "CYVR").first()).toBeVisible();
  await expect(marker(d, "richmond works").first()).toBeVisible();
  await expect(marker(d, "VE7RPT").first()).toBeVisible();

  // CYVR's tower, BC Ferries' 156.800 (NFM) and VE7RHS's 2 m machine (its shift and tone shown) from their popups.
  let pop = await openSite(p, d, "CYVR");
  await pop.getByRole("checkbox", { name: "CYVR 118.700 TOWER" }).check();
  pop = await openSite(p, d, "bc ferries");
  await pop.getByRole("checkbox", { name: "bc ferries 156.800 NFM" }).check();
  pop = await openSite(p, d, "VE7RHS");
  await expect(pop).toContainText("Repeater");
  await expect(pop).toContainText("TSQL 100.0");
  await pop.getByRole("checkbox", { name: "VE7RHS 145.270 −600 kHz" }).check();
  await expect(picked.locator("h3 .count")).toHaveText("3");
  await expect(picked).toContainText("CYVR");
  await expect(picked).toContainText("118.700");
  await expect(picked).toContainText("bc ferries");
  await expect(picked).toContainText("VE7RHS");
  await shot(p, info, "43-nearme-popup");

  // Add takes only what shows: kinds hidden, their picks stay picked but aren't counted.
  await onlyKinds(d, "Airports");
  await expect(picked.locator("h3 .count")).toHaveText("1");
  await expect(picked.getByRole("button", { name: "Add 1 channel" })).toBeEnabled();
  await expect(picked).toContainText("2 more picked but hidden");
  await expect(picked).not.toContainText("bc ferries");
  await onlyKinds(d, "Business & public");
  await expect(picked.getByRole("button", { name: "Add 1 channel" })).toBeEnabled();
  await expect(picked).toContainText("bc ferries");
  await expect(picked).not.toContainText("CYVR");
  await onlyKinds(d, "Business & public", "Airports");
  await expect(picked.getByRole("button", { name: "Add 2 channels" })).toBeEnabled();

  // The same picks in the list: the licensed groups, then the airports; BC Ferries' entry ticked, CYVR partly
  // picked.
  await d.getByRole("button", { name: "List", exact: true }).click();
  const list = d.getByLabel("Licensed sites near the place");
  const airports = d.getByLabel("Airports", { exact: true });
  await expect(list).toBeVisible();
  await expect(airports).toBeVisible();
  expect((await list.boundingBox())!.y).toBeLessThan((await airports.boundingBox())!.y);
  await d.getByLabel("Filter licensed sites").fill("ferries");
  await list.getByRole("button", { name: /3 frequencies/ }).click();
  await expect(list.locator("label.en", { hasText: "156.80" }).getByRole("checkbox")).toBeChecked();
  await expect(list.locator("label.en", { hasText: "159.25" }).getByRole("checkbox")).not.toBeChecked();
  const cyvr = airports.getByRole("checkbox", { name: "CYVR", exact: true });
  await expect(cyvr).not.toBeChecked();
  expect(await cyvr.evaluate((e) => (e as HTMLInputElement).indeterminate)).toBe(true);
  await expect(d.getByRole("button", { name: "Add 2 channels" })).toBeEnabled();
  await shot(p, info, "43a-nearme-list-both");
  // Airports only, as a list: no licensed rows, Add 1.
  await onlyKinds(d, "Airports");
  await expect(list).toHaveCount(0);
  await expect(airports).toBeVisible();
  await expect(d.getByRole("button", { name: "Add 1 channel" })).toBeEnabled();
  await onlyKinds(d, "Business & public", "Airports", "Repeaters");
  await expect(d.getByLabel("Repeaters near the place")).toBeVisible();
  await d.getByRole("button", { name: "Map", exact: true }).click();

  // One Add: the airport's NAM, RX-only channel named by its use, the licensed NFM one and the repeater's (its input
  // as TX, its tone both ways), all with positions.
  await picked.getByRole("button", { name: "Add 3 channels" }).click();
  await expect(d).toHaveCount(0);
  const added = await state(p, (f) => f.channels.table.channels.filter((c: any) => ["CYVR TWR", "bc ferries", "VE7RHS"].includes(c.name)));
  const by = (n: string) => added.find((c: any) => c.name === n);
  expect([by("CYVR TWR").rx, by("CYVR TWR").mode, by("CYVR TWR").rx_only]).toEqual(["118.70000", "NAM", true]);
  expect([by("bc ferries").rx, by("bc ferries").mode, by("bc ferries").rx_only]).toEqual(["156.80000", "NFM", true]);
  expect(by("bc ferries").pos).toEqual([49.195, -123.18]);
  expect(by("CYVR TWR").pos).toHaveLength(2);
  const rhs = by("VE7RHS");
  expect([rhs.rx, rhs.duplex, rhs.offset, rhs.tx_tone, rhs.rx_tone, rhs.mode, rhs.rx_only]).toEqual(["145.27000", "-", "0.60000", "100.0", "100.0", "FM", false]);
  expect(rhs.pos).toEqual([49.26973, -123.24992]);
  // One zone per group or airport (the default target), repeaters in one.
  const zones = await state(p, (f) => f.channels.table.zones.map((z: any) => z.name));
  expect(zones).toContain("CYVR");
  expect(zones).toContain("Repeaters");

  // The kinds are remembered (this browser).
  await p.reload();
  await closeWelcome(p);
  await p.getByRole("button", { name: "Add from library…" }).first().click();
  await d.getByRole("tab", { name: /^Near me/ }).click();
  for (const k of ["Business & public", "Airports", "Repeaters"]) await expect(kind(d, k)).toHaveAttribute("aria-pressed", "true");
  await close();
});

test("sidebar: a kind clicked from another tab opens Near me; repeaters as a list, searched, added with shift and tones", async ({ browser }, info) => {
  const { p, d, close } = await open(browser);
  await d.getByRole("tab", { name: /^Fixed sets/ }).click();
  await kind(d, "Repeaters").click();
  await expect(d.getByRole("tab", { name: /^Near me/ })).toHaveAttribute("aria-selected", "true");
  await expect(kind(d, "Repeaters")).toHaveAttribute("aria-pressed", "true");
  await onlyKinds(d, "Repeaters");
  await d.getByRole("button", { name: "List", exact: true }).click();
  await d.getByLabel("Place: latitude, longitude or grid square").fill(PLACE);
  const list = d.getByLabel("Repeaters near the place");
  await expect(list).toContainText("VE7RHS");
  await expect(list).toContainText("XX7DCS");
  await expect(list).toContainText("TSQL D023");
  // The search keeps a callsign or the start of the MHz.
  await d.getByLabel("Filter repeaters").fill("443");
  await expect(list).toContainText("XX7DCS");
  await expect(list).toContainText("VE7RSC");
  await expect(list).not.toContainText("VE7RHS");
  await d.getByLabel("Filter repeaters").fill("");
  await list.getByRole("checkbox", { name: "XX7DCS", exact: true }).check();
  await list.getByRole("checkbox", { name: "VE7RPT", exact: true }).check();
  await expect(d).toContainText("2 repeater (shift and tones)");
  await openData(d);
  await expect(d).toContainText("Repeater data from HearHam.com (user-contributed).");
  await shot(p, info, "45-nearme-repeaters-list");
  await d.getByRole("button", { name: "Add 2 channels" }).click();
  await expect(d).toHaveCount(0);
  const added = await state(p, (f) => f.channels.table.channels.filter((c: any) => ["XX7DCS", "VE7RPT"].includes(c.name)));
  const by = (n: string) => added.find((c: any) => c.name === n);
  const row = (c: any) => [c.rx, c.duplex, c.offset, c.tx_tone, c.rx_tone, c.rx_only];
  expect(row(by("XX7DCS"))).toEqual(["443.00000", "+", "5.00000", "D023N", "D023N", false]);
  expect(row(by("VE7RPT"))).toEqual(["146.94000", "-", "0.60000", "off", "off", false]);
  expect(by("XX7DCS").pos).toEqual([49.25, -123.1]);
  const zones = await state(p, (f) => f.channels.table.zones.map((z: any) => z.name));
  expect(zones).toContain("Repeaters");
  await close();
});

test("map: Add with Airports only adds the airport, the hidden licensed pick stays", async ({ browser }) => {
  const { p, d, close } = await open(browser);
  // The map first: a place given before it's ready can be fitted before its size settles.
  await expect(d.locator(".map[data-map=ready]")).toBeVisible();
  await d.getByLabel("Place: latitude, longitude or grid square").fill(PLACE);
  let pop = await openSite(p, d, "bc ferries");
  await pop.getByRole("checkbox", { name: "bc ferries 156.800 NFM" }).check();
  await onlyKinds(d, "Airports");
  pop = await openSite(p, d, "CYVR");
  await pop.getByRole("checkbox", { name: "CYVR 118.700 TOWER" }).check();
  const picked = d.getByRole("complementary", { name: "Picked" });
  await picked.getByRole("button", { name: "Add 1 channel" }).click();
  await expect(d).toHaveCount(0);
  const names = await state(p, (f) => f.channels.table.channels.map((c: any) => c.name));
  expect(names).toContain("CYVR TWR");
  expect(names).not.toContain("bc ferries");
  // Back to Licensed: BC Ferries is still picked.
  await p.getByRole("button", { name: "Add from library…" }).first().click();
  await d.getByRole("tab", { name: /^Near me/ }).click();
  await onlyKinds(d, "Business & public");
  await expect(picked).toContainText("bc ferries");
  await expect(picked.getByRole("button", { name: "Add 1 channel" })).toBeEnabled();
  await close();
});

test("map: the radius slider loads again; sites past it come in", async ({ browser }) => {
  const { d, close } = await open(browser);
  await onlyKinds(d, "Airports");
  await d.getByLabel("Place: latitude, longitude or grid square").fill(PLACE);
  await expect(marker(d, "CYVR").first()).toBeVisible({ timeout: 20_000 });
  // Victoria (63 km) is outside 50 km.
  await expect(marker(d, "CYYJ")).toHaveCount(0);
  await d.getByLabel("Radius in km").fill("80");
  await expect(d.getByLabel("Radius", { exact: true })).toHaveValue("80");
  await expect(d.locator(".status")).toContainText("within 80 km");
  await expect(marker(d, "CYYJ").first()).toBeVisible();
  // Dragging the circle's edge in: a smaller radius, and Victoria goes again.
  const h = d.locator(".nm-handle");
  const box = (await h.boundingBox())!;
  const p = d.page();
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await p.mouse.down();
  const left = (await d.locator(".wrap").boundingBox())!.x;
  await p.mouse.move((box.x + left) / 2, box.y + box.height / 2, { steps: 10 });
  await p.mouse.up();
  const km = Number((await d.getByLabel("Radius in km").inputValue()) || 0);
  expect(km).toBeLessThan(80);
  await expect(d.locator(".status")).toContainText(/within \d+ km/);
  await expect(d.locator(".status")).not.toContainText("within 80 km");
  await expect(marker(d, "CYYJ")).toHaveCount(0);
  await close();
});

test("map: Use my location: the browser's position, asked on the click", async ({ browser }, info) => {
  const { p, d, close } = await open(browser, { geolocation: { latitude: 45.32, longitude: -75.67 }, permissions: ["geolocation"] });
  await onlyKinds(d, "Business & public", "Airports");
  await d.getByRole("button", { name: "Use my location" }).click();
  await expect(d.getByLabel("Place: latitude, longitude or grid square")).toHaveValue("45.3200, -75.6700");
  await expect(d).toContainText("From this computer's location");
  await expect(marker(d, "CYOW").first()).toBeVisible({ timeout: 20_000 });
  await shot(p, info, "44-nearme-my-location");
  await close();
});

test("map: Use my location refused: says so calmly, the place left alone", async ({ browser }) => {
  const { d, close } = await open(browser, { permissions: [] });
  await d.getByRole("button", { name: "Use my location" }).click();
  await expect(d.getByText(/^Location is off for Console/)).toBeVisible();
  await expect(d.getByLabel("Place: latitude, longitude or grid square")).toHaveValue("");
  await expect(d.locator(".banner")).toHaveCount(0);
  await close();
});

test("map: the locate button centres on this computer's location, again after panning away", async ({ browser }, info) => {
  const { p, d, close } = await open(browser, { geolocation: { latitude: 45.32, longitude: -75.67 }, permissions: ["geolocation"] });
  await onlyKinds(d, "Business & public", "Airports");
  const locate = d.getByRole("button", { name: "Centre the map on my position" });
  await locate.click();
  await expect(d.getByLabel("Place: latitude, longitude or grid square")).toHaveValue("45.3200, -75.6700");
  const cyow = marker(d, "CYOW").first();
  await expect(cyow).toBeInViewport({ timeout: 20_000 });
  // Panned well away: the same place, so only the button brings the view back.
  const box = (await d.locator(".map").boundingBox())!;
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await p.mouse.down();
  await p.mouse.move(box.x + box.width / 2 + 600, box.y + box.height / 2 + 300, { steps: 8 });
  await p.mouse.up();
  await expect(cyow).not.toBeInViewport();
  await locate.click();
  await expect(cyow).toBeInViewport();
  await shot(p, info, "45-nearme-locate");
  await close();
});
