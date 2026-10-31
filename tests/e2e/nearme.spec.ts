// Add channels › Near me (no radio): one tab, the map by default; Licensed | Airports | Both decides what the map, the
// list and Add show (remembered); Canada and the US as sub-filter chips; a popup's box adds to Picked and shows ticked
// in the lists; Add's count follows the switch; one Add makes an airport's AM channel and a licensed NFM one, with
// positions; the radius slider loads again; "Use my location" with the browser's position, and refused. The data
// comes from tests/e2e/fixtures/sitedata, the map's tiles are refused (no internet).
import { type Browser, type Locator, type Page } from "@playwright/test";
import { serveData } from "./sitedata";
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

/** Near me's Licensed | Airports | Both switch. */
const kind = (d: Locator, name: string) => d.getByRole("group", { name: "Show" }).getByRole("button", { name, exact: true });

/** A site's marker on the map, or the cluster holding it (labelled with its sites' names). */
const marker = (d: Locator, name: string) => d.getByRole("button", { name: new RegExp(`^(${name}: \\d+ frequenc|\\d+ sites: (.*, )?${name}(,|$))`) });

/** Opens a site's popup: its marker, or its cluster (zooming in, or listing sites too close to split). */
async function openSite(p: Page, d: Locator, name: string) {
  const pop = d.getByRole("dialog", { name: /^Frequencies at / });
  for (let i = 0; i < 8; i++) {
    if (await pop.locator("header b", { hasText: new RegExp(`^${name}$`) }).count()) return pop;
    const m = marker(d, name).first();
    if (await m.count()) await m.click().catch(() => {});
    await p.waitForTimeout(400);
  }
  await expect(pop.locator("header b", { hasText: new RegExp(`^${name}$`) })).toBeVisible();
  return pop;
}

test("map: the default, big; Licensed | Airports | Both; chips; picks shared with the lists; Add follows the switch", async ({ browser }, info) => {
  const { p, d, close } = await open(browser);
  await expect(d.getByRole("button", { name: "Map", exact: true })).toHaveAttribute("aria-pressed", "true");
  // Licensed by default.
  await expect(kind(d, "Licensed")).toHaveAttribute("aria-pressed", "true");
  await d.getByLabel("Place: latitude, longitude or grid square").fill(PLACE);
  await expect(d.locator(".map[data-map=ready]")).toBeVisible();
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
  await expect(chip("Airports")).toHaveCount(0);
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

  // Airports only: airports' markers, no licensed ones, no Canada/US chips.
  await kind(d, "Airports").click();
  await expect(marker(d, "CYVR").first()).toBeVisible({ timeout: 20_000 });
  await expect(marker(d, "richmond works")).toHaveCount(0);
  await expect(marker(d, "point roberts")).toHaveCount(0);
  await expect(chip("Canada")).toHaveCount(0);
  // Both: both.
  await kind(d, "Both").click();
  await expect(marker(d, "CYVR").first()).toBeVisible();
  await expect(marker(d, "richmond works").first()).toBeVisible();

  // CYVR's tower and BC Ferries' 156.800 (NFM) from their popups.
  let pop = await openSite(p, d, "CYVR");
  await pop.getByRole("checkbox", { name: "CYVR 118.700 TOWER" }).check();
  pop = await openSite(p, d, "bc ferries");
  await pop.getByRole("checkbox", { name: "bc ferries 156.800 NFM" }).check();
  await expect(picked.locator("h3 .count")).toHaveText("2");
  await expect(picked).toContainText("CYVR");
  await expect(picked).toContainText("118.700");
  await expect(picked).toContainText("bc ferries");
  await shot(p, info, "43-nearme-popup");

  // Add takes only what shows: one kind hidden, its pick stays picked but isn't counted.
  await kind(d, "Airports").click();
  await expect(picked.locator("h3 .count")).toHaveText("1");
  await expect(picked.getByRole("button", { name: "Add 1 channel" })).toBeEnabled();
  await expect(picked).toContainText("1 more picked but hidden");
  await expect(picked).not.toContainText("bc ferries");
  await kind(d, "Licensed").click();
  await expect(picked.getByRole("button", { name: "Add 1 channel" })).toBeEnabled();
  await expect(picked).toContainText("bc ferries");
  await expect(picked).not.toContainText("CYVR");
  await kind(d, "Both").click();
  await expect(picked.getByRole("button", { name: "Add 2 channels" })).toBeEnabled();

  // The same picks in the list: Both is the licensed groups, then the airports; BC Ferries' entry ticked, CYVR
  // partly picked.
  await d.getByRole("button", { name: "List", exact: true }).click();
  const list = d.getByLabel("Licensed sites near the place");
  const airports = d.getByLabel("Airports", { exact: true });
  await expect(list).toBeVisible();
  await expect(airports).toBeVisible();
  expect((await list.boundingBox())!.y).toBeLessThan((await airports.boundingBox())!.y);
  await d.getByLabel("Filter licensed sites").fill("ferries");
  await list.getByRole("button", { name: /3 entries/ }).click();
  await expect(list.locator("label.en", { hasText: "156.80" }).getByRole("checkbox")).toBeChecked();
  await expect(list.locator("label.en", { hasText: "159.25" }).getByRole("checkbox")).not.toBeChecked();
  const cyvr = airports.getByRole("checkbox", { name: "CYVR", exact: true });
  await expect(cyvr).not.toBeChecked();
  expect(await cyvr.evaluate((e) => (e as HTMLInputElement).indeterminate)).toBe(true);
  await expect(d.getByRole("button", { name: "Add 2 channels" })).toBeEnabled();
  await shot(p, info, "43a-nearme-list-both");
  // Airports only, as a list: no licensed rows, Add 1.
  await kind(d, "Airports").click();
  await expect(list).toHaveCount(0);
  await expect(airports).toBeVisible();
  await expect(d.getByRole("button", { name: "Add 1 channel" })).toBeEnabled();
  await kind(d, "Both").click();
  await d.getByRole("button", { name: "Map", exact: true }).click();

  // One Add: the airport's AM, RX-only channel named by its use, and the licensed NFM one, both with positions.
  await picked.getByRole("button", { name: "Add 2 channels" }).click();
  await expect(d).toHaveCount(0);
  const added = await state(p, (f) => f.channels.table.channels.filter((c: any) => c.name === "CYVR TWR" || c.name === "bc ferries"));
  const by = (n: string) => added.find((c: any) => c.name === n);
  expect([by("CYVR TWR").rx, by("CYVR TWR").mode, by("CYVR TWR").rx_only]).toEqual(["118.70000", "AM", true]);
  expect([by("bc ferries").rx, by("bc ferries").mode, by("bc ferries").rx_only]).toEqual(["156.80000", "NFM", true]);
  expect(by("bc ferries").pos).toEqual([49.195, -123.18]);
  expect(by("CYVR TWR").pos).toHaveLength(2);
  // One zone per group or airport (the default target).
  const zones = await state(p, (f) => f.channels.table.zones.map((z: any) => z.name));
  expect(zones).toContain("CYVR");

  // The choice is remembered (this browser).
  await p.reload();
  await closeWelcome(p);
  await p.getByRole("button", { name: "Add from library…" }).first().click();
  await d.getByRole("tab", { name: /^Near me/ }).click();
  await expect(kind(d, "Both")).toHaveAttribute("aria-pressed", "true");
  await close();
});

test("map: Add with Airports only adds the airport, the hidden licensed pick stays", async ({ browser }) => {
  const { p, d, close } = await open(browser);
  await d.getByLabel("Place: latitude, longitude or grid square").fill(PLACE);
  let pop = await openSite(p, d, "bc ferries");
  await pop.getByRole("checkbox", { name: "bc ferries 156.800 NFM" }).check();
  await kind(d, "Airports").click();
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
  await kind(d, "Licensed").click();
  await expect(picked).toContainText("bc ferries");
  await expect(picked.getByRole("button", { name: "Add 1 channel" })).toBeEnabled();
  await close();
});

test("map: the radius slider loads again; sites past it come in", async ({ browser }) => {
  const { d, close } = await open(browser);
  await kind(d, "Airports").click();
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
  await kind(d, "Both").click();
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
