// Add channels (the channel library): a fixed set into a new zone, written to the radio and read back; airports
// near a typed place as NAM, RX-only rows; a region's fixed sets; licensed sites (Canada and the US) near it. The
// write test runs on the simulator only: on a radio it would add 22 channels (FERRITE_E2E_LIBRARY_WRITE=1 lets it,
// at your own risk). Airports and licensed sites never use the network: data.ferritefw.dev is served from
// tests/e2e/fixtures/sitedata (a few tiny tiles) by ./sitedata.ts.
import { type Page } from "@playwright/test";
import { DATA, blockTiles, onlyKinds, openData, serveData } from "./sitedata";
import { connect, disconnect, expect, onRadio, openConsole, shot, state, test } from "./helpers";

let page: Page;
const lib = () => page.getByRole("dialog", { name: "Add channels" });
const writeDialog = () => page.getByRole("dialog", { name: "Write to the radio" });
const long = () => (onRadio() ? 120_000 : 30_000);
/** Vancouver airport. */
const PLACE = "49.1947, -123.1792";

const toolbar = () => page.getByRole("toolbar", { name: "Channels" });

async function readRadio() {
  await page.evaluate(() => ((window as any).__e2eBase = (window as any).ferrite.channels.base));
  await toolbar().getByRole("button", { name: "Read from radio" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).ferrite.channels.base !== (window as any).__e2eBase), { timeout: long() }).toBe(true);
  await expect(toolbar().getByRole("button", { name: "Read from radio" })).toBeEnabled({ timeout: long() });
}

/** "Airports" and "Licensed sites" are Near me with that kind shown, as the list (Near me opens on the map: nearme.spec.ts). */
async function openLibrary(tab: string) {
  await page.getByRole("button", { name: "Add from library…" }).click();
  await expect(lib()).toBeVisible();
  const kind = tab === "Airports" ? "Airports" : tab === "Licensed sites" ? "Business & public" : "";
  await lib().getByRole("tab", { name: new RegExp(`^${kind ? "Near me" : tab}`) }).click();
  if (kind) await nearMe(lib(), kind, true);
}

/** Near me: that kind alone shown (the sidebar's switches), and the list view if asked. */
async function nearMe(d: ReturnType<Page["getByRole"]>, kind: string, list = false) {
  await onlyKinds(d, kind);
  if (list) await d.getByRole("button", { name: "List", exact: true }).click();
}

/** Each group its own page, connected and read (the groups can run on two workers, each with its own simulator). */
function hooks() {
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await openConsole(page, "channels");
    await connect(page);
    await readRadio();
  });
  test.afterAll(async () => {
    await disconnect(page);
    await page.close();
  });
}

test.describe.serial("write", () => {
  // Static (the radio's cable is named before the run), so a skipped group doesn't connect and read either.
  test.skip(!!process.env.FERRITE_E2E_SERIAL && !process.env.FERRITE_E2E_LIBRARY_WRITE, "adds 22 channels to the radio");
  hooks();

  test("fixed set: FRS into a new zone, written and read back", async ({}, info) => {
    const before = await state(page, (f) => ({ chs: f.channels.table.channels.length, zones: f.channels.table.zones.length }));
    await serveData(page);
    await openLibrary("Fixed sets");
    await lib().getByLabel("Fixed sets for").selectOption("US");
    await lib().getByRole("option", { name: /^Family Radio Service \(US\)/ }).click();
    await expect(lib().getByRole("button", { name: "Add 22 channels" })).toBeEnabled();
    await expect(lib().getByLabel("New zone name")).toHaveValue("FRS");
    // A unique zone name: a run against a radio that already has an "FRS" zone still makes a new one.
    const zone = `FRS ${String(Date.now() % 10000).padStart(4, "0")}`;
    await lib().getByLabel("New zone name").fill(zone);
    await shot(page, info, "30-library-fixed");
    await lib().getByRole("button", { name: "Add 22 channels" }).click();
    await expect(lib()).toHaveCount(0);

    const after = await state(page, (f) => ({ chs: f.channels.table.channels.length, zones: f.channels.table.zones }));
    expect(after.chs).toBe(before.chs + 22);
    expect(after.zones.length).toBe(before.zones + 1);
    expect(after.zones.at(-1).name).toBe(zone);
    await expect(page.locator("tr.added")).toHaveCount(22);
    await expect(page.getByText("22 channels added from Family Radio Service (US), 1 new zone")).toBeVisible();
    await page.locator("tr.added").first().scrollIntoViewIfNeeded();
    await shot(page, info, "31-library-fixed-rows");

    // Write: backup, the diff (22 channels and the zone added), no problems.
    await toolbar().getByRole("button", { name: /^Write to radio/ }).click();
    await expect(writeDialog()).toContainText("Backup kept in Console until it closes", { timeout: long() });
    await expect(writeDialog().locator("h3.added")).toHaveText("Added (23)");
    await expect(writeDialog().locator("li", { hasText: zone })).toHaveCount(1);
    await shot(page, info, "32-library-fixed-diff");
    await writeDialog().getByRole("button", { name: /^Write \d+ changes$/ }).click();
    await expect(writeDialog()).toContainText("Read back: the radio holds the table.", { timeout: long() });
    await shot(page, info, "33-library-fixed-written");
    await writeDialog().getByRole("button", { name: "Close" }).click();

    // The radio holds them: in the new zone, NFM, 462.5625 first.
    await readRadio();
    const got = await state(page, (f) => {
      const zi = f.channels.table.zones.length - 1;
      return { zone: f.channels.table.zones[zi].name, chans: f.channels.table.channels.filter((c: any) => c.zone === zi) };
    });
    expect(got.zone).toBe(zone);
    expect(got.chans.length).toBe(22);
    expect(got.chans[0]).toMatchObject({ name: "FRS 1", rx: "462.56250", mode: "NFM" });
  });
});

// The airports group types the place the TAFL test uses.
test.describe.serial("near a place", () => {
  hooks();

  test("airports near a typed place: NAM, RX-only rows, named by their uses", async ({}, info) => {
    const asked = await serveData(page);
    const before = await state(page, (f) => f.channels.table.channels.length);
    await openLibrary("Airports");
    // From radio: the radio's GPS fix, else its fixed position; else it says so.
    await lib().getByRole("button", { name: "From radio" }).click();
    await expect(lib().getByText(/^From the radio's (GPS|fixed position)|no GPS fix and no fixed position/)).toBeVisible({ timeout: long() });
    console.log(`From radio: ${(await lib().locator(".place .sub, .banner").allTextContents()).join(" | ")}`);
    await lib().getByLabel("Place: latitude, longitude or grid square").fill(PLACE);
    await expect(lib().getByText("CN89")).toBeVisible();
    const cyvr = lib().getByRole("checkbox", { name: "CYVR", exact: true });
    await expect(cyvr).toBeVisible({ timeout: 20_000 });
    // Level 2: 2-character fields only (Vancouver's is CN; the radio's place, asked first, may add its own).
    const tiles = asked.filter((p) => p.startsWith("airports/") && !p.endsWith("index.json"));
    expect(tiles).toContain("airports/CN.json");
    for (const t of tiles) expect(t).toMatch(/^airports\/[A-R]{2}\.json$/);
    // Boundary Bay (18 km) is listed; Victoria (63 km) is not.
    const list = lib().getByLabel("Airports");
    await expect(list.getByRole("checkbox", { name: "CZBB", exact: true })).toBeVisible();
    await expect(list.getByRole("checkbox", { name: "CYYJ", exact: true })).toHaveCount(0);
    // OurAirports' uses as the types: TWR is TOWER, CLD clearance.
    const row = list.locator("label.ap", { hasText: "CYVR" });
    await expect(row).toContainText("118.700 TOWER");
    await expect(row).toContainText("121.400 CLEARANCE");
    await expect(row).toContainText("121.700 GROUND");
    // The data's attribution.
    await openData(lib());
    await expect(lib()).toContainText("Airport data from OurAirports");
    await cyvr.check();
    const add = lib().getByRole("button", { name: /^Add \d+ channels?$/ });
    await expect(add).toHaveText("Add 7 channels");
    const n = 7;
    await shot(page, info, "34-library-airports");
    await add.click();
    await expect(lib()).toHaveCount(0);

    const added = await state(page, (f) => f.channels.table.channels.filter((c: any) => c.name.startsWith("CYVR ")));
    expect(added.length).toBe(n);
    for (const c of added) {
      expect(c.mode).toBe("NAM");
      expect(c.rx_only).toBe(true);
      expect(c.name.length).toBeLessThanOrEqual(16);
      expect(Number(c.rx)).toBeGreaterThanOrEqual(108);
      expect(Number(c.rx)).toBeLessThan(137);
    }
    expect(await state(page, (f) => f.channels.table.channels.length)).toBe(before + n);
    expect(await state(page, (f) => f.channels.table.zones.at(-1).name)).toBe("CYVR");
    expect(added.map((c: any) => [c.name, c.rx]).sort()).toEqual([
      ["CYVR APP", "128.60000"],
      ["CYVR ATIS", "124.60000"],
      ["CYVR CLD", "121.40000"],
      ["CYVR DEP", "126.12500"],
      ["CYVR GND", "121.70000"],
      ["CYVR RCO", "123.15000"],
      ["CYVR TWR", "118.70000"],
    ]);
    const first = page.locator(`tr[data-n="${added[0].number}"]`);
    await expect(first).toHaveClass(/added/);
    await first.scrollIntoViewIfNeeded();
    await shot(page, info, "35-library-airport-rows");
  });

  test("fixed set: Canada's common airband (data.ferritefw.dev's fixed/), NAM and RX only", async ({}, info) => {
    await serveData(page);
    const before = await state(page, (f) => f.channels.table.channels.length);
    await openLibrary("Fixed sets");
    await lib().getByLabel("Fixed sets for").selectOption("CA");
    await lib().getByRole("option", { name: /^Aviation common frequencies \(Canada\)/ }).click();
    await expect(lib()).toContainText("18 of 18 channels · NAM, Low power, RX only");
    await expect(lib()).toContainText("Enroute 126.700");
    await expect(lib().getByRole("link", { name: "Suggest a correction" })).toHaveAttribute("href", /template=fixed-set\.yml&region=CA&set=ca-air-common/);
    // The international sets come after the region's.
    await expect(lib().getByRole("option", { name: /^Marine VHF/ }).first()).toBeVisible();
    await shot(page, info, "34a-library-airband");
    await lib().getByRole("button", { name: "Add 18 channels" }).click();
    await expect(lib()).toHaveCount(0);
    expect(await state(page, (f) => f.channels.table.channels.length)).toBe(before + 18);
    // Into a new zone named after the set.
    expect(await state(page, (f) => f.channels.table.zones.at(-1).name)).toBe("Air CA common");
    const added = await state(page, (f) => f.channels.table.channels.filter((c: any) => c.zone === f.channels.table.zones.length - 1));
    expect(added.length).toBe(18);
    for (const c of added) {
      expect(c.mode).toBe("NAM");
      expect(c.rx_only).toBe(true);
    }
    expect(added.find((c: any) => c.name === "Enroute 126.700").rx).toBe("126.70000");
  });

  test("licensed sites: Canada and the US near the place, modes, digital hidden, positions kept", async ({}, info) => {
    const asked = await serveData(page);
    await openLibrary("Licensed sites");
    const filter = lib().getByLabel("Filter licensed sites");
    await expect(filter).toBeVisible({ timeout: 30_000 });
    // Near Vancouver: CN89 is split, so its subsquares come (je, ke), and the US square south of it (CN88).
    await expect.poll(() => asked.filter((p) => /^(tafl|fcc)\//.test(p) && !p.endsWith("index.json")).sort()).toEqual(["fcc/CN88.json", "tafl/CN89je.json", "tafl/CN89ke.json"]);
    const list = lib().getByLabel("Licensed sites near the place");
    // Categories as switches with counts under Business & public in the sidebar, public safety first; each a
    // heading in the list. Business off to start (the long tail), one click brings it back.
    const cats = lib().getByRole("group", { name: "Business and public categories" });
    await expect(cats.getByRole("button")).toHaveText([/^Public safety\s*1$/, /^Transit\s*0$/, /^Utilities\s*0$/, /^Marine\s*3$/, /^Schools\s*0$/, /^Government\s*3$/, /^Business\s*2$/]);
    await expect(cats.getByRole("button", { name: /^Business/ })).toHaveAttribute("aria-pressed", "false");
    await expect(list.locator("h4")).toHaveText(["Public safety", "Marine", "Government"]);
    await cats.getByRole("button", { name: /^Business/ }).click();
    await expect(list.locator("h4")).toHaveText(["Public safety", "Marine", "Government", "Business"]);
    await expect(list).toContainText("point roberts"); // US
    await expect(list).toContainText("richmond works"); // Canada
    // Both sources' attribution lines.
    await expect(lib()).toContainText("Open Government Licence – Canada"); // the short credit line, always shown
    await openData(lib());
    await expect(lib()).toContainText("Federal Communications Commission");
    // Digital only never shows (Ferrite has no digital modes): no row, no switch for it.
    await expect(list).not.toContainText("ecomm");
    await expect(lib().getByRole("checkbox", { name: /digital/i })).toHaveCount(0);

    // Organizations: "city van works" and "van city" are one (City of Van), its two frequencies under one box.
    const van = list.getByRole("button", { name: /city of van\b.*2 frequencies/ });
    await expect(van).toBeVisible();
    await expect(list.getByRole("checkbox", { name: "Group city of van" })).toBeVisible();
    await van.click();
    await shot(page, info, "35a-library-sites-categories");
    await van.click();
    // One entry per organization and frequency: BC Ferries' 156.80 at two sites is one entry, its nearest's.
    await list.getByRole("button", { name: /bc ferries.*3 frequencies/ }).click();
    await expect(list.locator("label.en", { hasText: "156.80" })).toHaveCount(1);
    await expect(list.locator("label.en", { hasText: "156.80" })).toContainText("2 sites · 0.1 km");
    await list.getByRole("button", { name: /bc ferries.*3 frequencies/ }).click();
    // A category switched off hides it; the filter matches a category's name too.
    await cats.getByRole("button", { name: /^Marine/ }).click();
    await expect(cats.getByRole("button", { name: /^Marine/ })).toHaveAttribute("aria-pressed", "false");
    await expect(list).not.toContainText("bc ferries");
    await cats.getByRole("button", { name: /^Marine/ }).click();
    await filter.fill("public");
    await expect(list.locator("h4")).toHaveText(["Public safety"]);
    await expect(list).toContainText("vancouver fire");

    // BC Ferries (3 frequencies, NFM, one a mobile's) and the fire department (FM).
    await filter.fill("ferries");
    await lib().getByRole("button", { name: "All shown" }).click();
    await list.getByRole("button", { name: /3 frequencies/ }).click();
    await expect(list.locator(".tag.mob")).toHaveCount(1);
    await shot(page, info, "36-library-sites");
    await filter.fill("fire");
    await lib().getByRole("button", { name: "All shown" }).click();
    await expect(lib().getByRole("button", { name: "Add 4 channels" })).toBeEnabled();
    const before = await state(page, (f) => f.channels.table.channels.length);
    await lib().getByRole("button", { name: "Add 4 channels" }).click();
    await expect(lib()).toHaveCount(0);
    const added = await state(page, (f) => f.channels.table.channels.filter((c: any) => c.name === "bc ferries" || c.name === "vancouver fire"));
    expect(await state(page, (f) => f.channels.table.channels.length)).toBe(before + 4);
    const by = (name: string) => added.filter((c: any) => c.name === name);
    expect(by("bc ferries").map((c: any) => [c.rx, c.mode, c.rx_only]).sort()).toEqual([
      ["156.80000", "NFM", true],
      ["159.25500", "NFM", true],
      ["163.25500", "NFM", true],
    ]);
    expect(by("vancouver fire").map((c: any) => [c.rx, c.mode])).toEqual([["154.43000", "FM"]]);
    // The site's licensed position goes with the channel (LINK-53).
    expect(by("vancouver fire")[0].pos).toEqual([49.205, -123.21]);
    expect(by("bc ferries").find((c: any) => c.rx === "156.80000").pos).toEqual([49.195, -123.18]);
    await shot(page, info, "37-library-sites-rows");
    // Leave the table as read (nothing of this test is written).
    await toolbar().getByRole("button", { name: /^File/ }).click();
    await page.getByRole("menuitem", { name: /^Discard unwritten changes/ }).click();
    expect(await state(page, (f) => f.channels.pending)).toBe(0);
  });
});

// Licensed sites and airports without a radio: the data not reachable, and a source saved for offline then read
// without the network. Each test its own page (its own Cache Storage).
test.describe("licensed sites, no radio", () => {
  test("data not reachable: says so, no crash", async ({ browser }, info) => {
    const p = await browser.newPage();
    await blockTiles(p);
    await p.route(`${DATA}/**`, (r) => r.abort("internetdisconnected"));
    await openConsole(p, "channels");
    await p.getByRole("button", { name: "Add from library…" }).first().click();
    const d = p.getByRole("dialog", { name: "Add channels" });
    await d.getByRole("tab", { name: /^Near me/ }).click();
    await nearMe(d, "Business & public");
    await d.getByLabel("Place: latitude, longitude or grid square").fill(PLACE);
    await expect(d.getByText("Business and public sites aren't available right now.")).toBeVisible();
    await expect(d).toContainText("Can't reach https://data.ferritefw.dev");
    await shot(p, info, "39-library-sites-offline");
    await p.close();
  });

  test("save for offline: the zip checked and kept, then read without the network", async ({ browser }, info) => {
    const p = await browser.newPage();
    await serveData(p);
    await openConsole(p, "channels");
    await p.getByRole("button", { name: "Add from library…" }).first().click();
    const d = p.getByRole("dialog", { name: "Add channels" });
    await d.getByRole("tab", { name: /^Near me/ }).click();
    await nearMe(d, "Business & public", true);
    await openData(d);
    const save = d.getByRole("button", { name: /^Save Canada for offline \(\d+ KB\)$/ });
    await expect(save).toBeVisible();
    await save.click();
    await expect(d.getByText("Saved for offline")).toBeVisible();
    await shot(p, info, "40-library-sites-saved");
    // The network gone: Ottawa (never looked at) comes from the saved copy.
    await p.unroute(`${DATA}/**`);
    await p.route(`${DATA}/**`, (r) => r.abort("internetdisconnected"));
    await d.getByLabel("Place: latitude, longitude or grid square").fill("45.42, -75.70");
    await expect(d.getByLabel("Licensed sites near the place")).toContainText("ottawa hydro");
    await p.close();
  });

  test("airports: saved for offline, then read without the network", async ({ browser }, info) => {
    const p = await browser.newPage();
    await serveData(p);
    await openConsole(p, "channels");
    await p.getByRole("button", { name: "Add from library…" }).first().click();
    const d = p.getByRole("dialog", { name: "Add channels" });
    await d.getByRole("tab", { name: /^Near me/ }).click();
    await nearMe(d, "Airports", true);
    // Airports only: only the airports source in the footer, not the licensed sites'.
    await openData(d);
    await expect(d.getByRole("button", { name: /^Save Canada for offline/ })).toHaveCount(0);
    const save = d.getByRole("button", { name: /^Save Airports for offline \(\d+ KB\)$/ });
    await expect(save).toBeVisible();
    await save.click();
    await expect(d.getByText("Saved for offline")).toBeVisible();
    await shot(p, info, "41-library-airports-saved");
    await p.unroute(`${DATA}/**`);
    await p.route(`${DATA}/**`, (r) => r.abort("internetdisconnected"));
    await d.getByLabel("Place: latitude, longitude or grid square").fill("45.32, -75.67");
    const row = d.getByLabel("Airports").locator("label.ap", { hasText: "CYOW" });
    await expect(row).toContainText("118.800 TOWER");
    await expect(row).toContainText("119.400 CLEARANCE");
    await p.close();
  });

  test("airports: data not reachable: says so", async ({ browser }) => {
    const p = await browser.newPage();
    await blockTiles(p);
    await p.route(`${DATA}/**`, (r) => r.abort("internetdisconnected"));
    await openConsole(p, "channels");
    await p.getByRole("button", { name: "Add from library…" }).first().click();
    const d = p.getByRole("dialog", { name: "Add channels" });
    await d.getByRole("tab", { name: /^Near me/ }).click();
    await nearMe(d, "Airports");
    await d.getByLabel("Place: latitude, longitude or grid square").fill(PLACE);
    await expect(d.getByText("Airports aren't available right now.")).toBeVisible();
    await p.close();
  });
});
