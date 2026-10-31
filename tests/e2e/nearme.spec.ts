// Add channels › the "near me" map (no radio): the default view for Airports and Licensed sites; Canada's, the US's
// and the airports' markers near Vancouver; layer chips; a popup's box adds to Picked and shows ticked in the lists;
// one Add makes an airport's AM channel and a licensed NFM one, with positions; the radius slider loads again; "Use
// my location" with the browser's position, and refused. The data comes from tests/e2e/fixtures/sitedata, the map's
// tiles are refused (no internet).
import { type Browser, type Locator, type Page } from "@playwright/test";
import { serveData } from "./sitedata";
import { expect, openConsole, shot, state, test } from "./helpers";

/** Vancouver airport. */
const PLACE = "49.1947, -123.1792";

async function open(browser: Browser, ctx: Parameters<Browser["newContext"]>[0] = {}) {
  const c = await browser.newContext(ctx);
  const p = await c.newPage();
  await serveData(p);
  await openConsole(p, "channels");
  await p.getByRole("button", { name: "Add from library…" }).first().click();
  const d = p.getByRole("dialog", { name: "Add channels" });
  await d.getByRole("tab", { name: /^Licensed sites/ }).click();
  return { p, d, close: () => c.close() };
}

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

test("map: the default; both layers near Vancouver; chips; picks shared with the lists; one Add", async ({ browser }, info) => {
  const { p, d, close } = await open(browser);
  await expect(d.getByRole("button", { name: "Map", exact: true })).toHaveAttribute("aria-pressed", "true");
  await d.getByLabel("Place: latitude, longitude or grid square").fill(PLACE);
  await expect(d.locator(".map[data-map=ready]")).toBeVisible();
  // Layer chips for the sources with data here: Canada, the US (Point Roberts) and airports.
  const chip = (name: string) => d.getByRole("button", { name: new RegExp(`^${name} \\d+$`) });
  for (const c of ["Canada", "US", "Airports"]) await expect(chip(c)).toHaveAttribute("aria-pressed", "true");
  await expect(marker(d, "CYVR").first()).toBeVisible({ timeout: 20_000 });
  await expect(marker(d, "point roberts").first()).toBeVisible();
  await expect(marker(d, "richmond works").first()).toBeVisible();
  // Digital only hidden until asked for.
  await expect(marker(d, "ecomm")).toHaveCount(0);
  await shot(p, info, "42-nearme-map");

  // Airports off: its markers go; back on: back.
  await chip("Airports").click();
  await expect(chip("Airports")).toHaveAttribute("aria-pressed", "false");
  await expect(marker(d, "CYVR")).toHaveCount(0);
  await expect(marker(d, "richmond works").first()).toBeVisible();
  await chip("Airports").click();
  await expect(marker(d, "CYVR").first()).toBeVisible();

  // CYVR's tower and BC Ferries' 156.800 (NFM) from their popups.
  let pop = await openSite(p, d, "CYVR");
  await pop.getByRole("checkbox", { name: "CYVR 118.700 TOWER" }).check();
  pop = await openSite(p, d, "bc ferries");
  await pop.getByRole("checkbox", { name: "bc ferries 156.800 NFM" }).check();
  const picked = d.getByRole("complementary", { name: "Picked" });
  await expect(picked.locator("h3 .count")).toHaveText("2");
  await expect(picked).toContainText("CYVR");
  await expect(picked).toContainText("118.700");
  await expect(picked).toContainText("bc ferries");
  await shot(p, info, "43-nearme-popup");

  // The same picks in the lists: BC Ferries' entry ticked, CYVR partly picked.
  await d.getByRole("button", { name: "List", exact: true }).click();
  const list = d.getByLabel("Licensed sites near the place");
  await d.getByLabel("Filter licensed sites").fill("ferries");
  await list.getByRole("button", { name: /3 entries/ }).click();
  await expect(list.locator("label.en", { hasText: "156.80" }).getByRole("checkbox")).toBeChecked();
  await expect(list.locator("label.en", { hasText: "159.25" }).getByRole("checkbox")).not.toBeChecked();
  await d.getByRole("tab", { name: /^Airports/ }).click();
  const cyvr = d.getByLabel("Airports").getByRole("checkbox", { name: "CYVR", exact: true });
  await expect(cyvr).not.toBeChecked();
  expect(await cyvr.evaluate((e) => (e as HTMLInputElement).indeterminate)).toBe(true);
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
  await close();
});

test("map: the radius slider loads again; sites past it come in", async ({ browser }) => {
  const { d, close } = await open(browser);
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
