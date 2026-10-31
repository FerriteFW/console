// data.ferritefw.dev for the e2e tests, from tests/e2e/fixtures/sitedata (a few tiny tiles): no network. The zips
// are made from the fixtures here; the top index gets their real sizes and SHA-256.
import { type Page, type Route } from "@playwright/test";
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
  for (const src of ["tafl", "fcc", "airports"]) zips.set(`${src}.zip`, await fixtureZip(src));
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

