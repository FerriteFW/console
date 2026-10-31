// data.ferritefw.dev for the e2e tests, from tests/e2e/fixtures/sitedata (a few tiny tiles): no network. The zips
// are made from the fixtures here; the top index gets their real sizes and SHA-256.
import { expect, type Locator, type Page, type Route } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { createZip } from "../../src/lib/zip.ts";

export const DATA = "https://data.ferritefw.dev";
const FIX = new URL("./fixtures/sitedata/", import.meta.url);

/** A source's fixture tiles as its zip. */
async function fixtureZip(src: string): Promise<Buffer> {
  const dir = new URL(`${src}/`, FIX);
  const entries = readdirSync(dir).map((f) => ({ name: `${src}/${f}`, data: new Uint8Array(readFileSync(new URL(f, dir))) }));
  return Buffer.from(await (await createZip(entries)).arrayBuffer());
}

/** The map's OpenStreetMap tiles refused: the tests never use the internet (the map draws without them). */
export const blockTiles = (p: Page) => p.route("https://tile.openstreetmap.org/**", (r) => r.abort());

/** data.ferritefw.dev from the fixtures (and the map's tiles refused); the top index carries the zips' real sizes and SHA-256. Returns the paths asked. */
export async function serveData(p: Page): Promise<string[]> {
  const zips = new Map<string, Buffer>();
  for (const src of ["tafl", "fcc", "airports", "repeaters"]) zips.set(`${src}.zip`, await fixtureZip(src));
  const asked: string[] = [];
  await blockTiles(p);
  await p.route(`${DATA}/**`, async (route: Route) => {
    const path = new URL(route.request().url()).pathname.slice(1);
    asked.push(path);
    const zip = zips.get(path);
    if (zip) return route.fulfill({ body: zip, contentType: "application/zip", headers: { "Access-Control-Allow-Origin": "*" } });
    let body: string;
    try {
      body = readFileSync(new URL(path, FIX), "utf8");
    } catch {
      return route.fulfill({ status: 404, body: "Not Found", headers: { "Access-Control-Allow-Origin": "*" } });
    }
    if (path === "index.json") {
      const top = JSON.parse(body);
      for (const s of top.sources) {
        const z = zips.get(s.bundle)!;
        s.bundle_bytes = z.length;
        s.bundle_sha256 = createHash("sha256").update(z).digest("hex");
      }
      body = JSON.stringify(top);
    }
    return route.fulfill({ body, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" } });
  });
  return asked;
}


/** Near me's kinds in the Add channels dialog's sidebar: switches, each with its count near the place. */
export const kind = (d: Locator, name: string) => d.getByRole("group", { name: "Near me shows" }).getByRole("button", { name: new RegExp(`^${name}`) });

/** Exactly these kinds on (the wanted ones first: the last kind on can't go off). */
export async function onlyKinds(d: Locator, ...names: string[]) {
  const all = ["Business & public", "Airports", "Repeaters"];
  const on = async (n: string) => (await kind(d, n).getAttribute("aria-pressed")) === "true";
  for (const n of names) if (!(await on(n))) await kind(d, n).click();
  for (const n of all) if (!names.includes(n) && (await on(n))) await kind(d, n).click();
  for (const n of all) await expect(kind(d, n)).toHaveAttribute("aria-pressed", String(names.includes(n)));
}

/** Near me's Data popover open (each source's date, updates, Save for offline and full credits: DataCredits). */
export async function openData(d: Locator) {
  const b = d.getByRole("button", { name: /^Data/ });
  if ((await b.getAttribute("aria-expanded")) !== "true") await b.click();
  await expect(d.getByRole("dialog", { name: "Channel data sources" })).toBeVisible();
}

/** A site's marker on the map, or the cluster holding it (labelled with its sites' names). */
export const marker = (d: Locator, name: string) => d.getByRole("button", { name: new RegExp(`^(${name}: \\d+ frequenc|\\d+ sites: (.*, )?${name}(,|$))`) });

/** Opens a site's popup: its marker, or its cluster (zooming in, or listing sites too close to split). */
export async function openSite(p: Page, d: Locator, name: string) {
  const pop = d.getByRole("dialog", { name: /^Frequencies at / });
  // Another site's popup closed first: it can sit over this one's marker.
  if ((await pop.count()) && !(await pop.locator("header b", { hasText: new RegExp(`^${name}$`) }).count())) await pop.getByRole("button", { name: "Close" }).click({ timeout: 2000 });
  for (let i = 0; i < 8; i++) {
    if (await pop.locator("header b", { hasText: new RegExp(`^${name}$`) }).count()) return pop;
    const m = marker(d, name).first();
    // Off the map's view (zoomed in on another site): zoom out a step first.
    const at = (await m.count()) ? await m.boundingBox() : null;
    const view = (await d.locator(".wrap").boundingBox())!;
    const inView = at && at.x >= view.x && at.y >= view.y && at.x + at.width <= view.x + view.width && at.y + at.height <= view.y + view.height;
    if (at && !inView) await d.getByRole("button", { name: "Zoom out" }).click({ timeout: 2000 }).catch(() => {});
    else if (at) await m.click({ timeout: 2000 }).catch(() => {});
    await p.waitForTimeout(400);
  }
  await expect(pop.locator("header b", { hasText: new RegExp(`^${name}$`) })).toBeVisible();
  return pop;
}
