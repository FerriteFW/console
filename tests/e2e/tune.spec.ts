// Live View's Tune from map: refused with no radio; connected, it opens Near me's map alone (no Fixed sets, no Picked
// column); a repeater's frequency clicked tunes the active slot as a VFO with its shift and tones (the terminal's
// `slot` line over the link, TERM-35) and the dialog closes with a confirmation; an airport's tunes AM, simplex, no
// tones. The slot is put back after. Data from tests/e2e/fixtures/sitedata.
import { connect, disconnect, expect, openConsole, state, test } from "./helpers";
import { kind, openSite, serveData } from "./sitedata";

test.afterEach(async ({ page }) => disconnect(page));

/** Vancouver airport. */
const PLACE = "49.1947, -123.1792";

test("tune from map: refused without a radio", async ({ page }) => {
  await openConsole(page, "live");
  await expect(page.getByRole("button", { name: "Tune from map" })).toBeDisabled();
});

test("tune from map: a repeater with its shift and tones, then an airport in AM", async ({ page }) => {
  await serveData(page);
  await openConsole(page, "live");
  await connect(page);
  const slots = () => state(page, (f) => f.radio.connectedLink.cmd("slot")) as Promise<string>;
  const before = await slots();
  const letter = /^([ABC])\*/m.exec(before)![1];
  const line = () => slots().then((t) => t.split("\n").find((l) => l.startsWith(`${letter}*`)) ?? "");
  const was = await line();
  try {
    await page.getByRole("button", { name: "Tune from map" }).click();
    const d = page.getByRole("dialog", { name: "Tune from map" });
    await expect(d).toBeVisible();
    await expect(d.getByRole("tab", { name: /^Fixed sets/ })).toHaveCount(0);
    await expect(d.getByRole("button", { name: "List", exact: true })).toHaveCount(0);
    await expect(d.getByRole("complementary", { name: "Picked" })).toHaveCount(0);
    await d.getByLabel("Place: latitude, longitude or grid square").fill(PLACE);

    let pop = await openSite(page, d, "VE7RHS");
    await expect(pop.getByRole("checkbox")).toHaveCount(0);
    await pop.getByRole("button", { name: "Tune VE7RHS 145.270 −600 kHz" }).click();
    await expect(d).toBeHidden();
    await expect(page.getByText(`Tuned Slot ${letter}: 145.27 FM −600 kHz, T 100.0 · R 100.0`)).toBeVisible();
    await expect.poll(line).toMatch(new RegExp(`^${letter}\\* vfo 145\\.27000 .*offset=-0\\.60000`));
    expect(await line()).toMatch(/tone=100\.0/);

    await page.getByRole("button", { name: "Tune from map" }).click();
    await expect(d).toBeVisible();
    await kind(d, "Airports").click();
    pop = await openSite(page, d, "CYVR");
    await pop.getByRole("button", { name: "Tune CYVR 118.700 TOWER" }).click();
    await expect(d).toBeHidden();
    await expect(page.getByText(`Tuned Slot ${letter}: 118.7 AM`)).toBeVisible();
    const air = await line();
    expect(air).toMatch(new RegExp(`^${letter}\\* vfo 118\\.70000 mode=AM`));
    expect(air).not.toMatch(/offset=/);
  } finally {
    // Back as it was (the simulator is the worker's, shared with the next tests).
    const f = /vfo (\d+\.\d+)/.exec(was)?.[1];
    const m = /mode=(\w+)/.exec(was)?.[1]?.toLowerCase();
    const o = /offset=([+-][\d.]+)/.exec(was)?.[1] ?? "off";
    const both = /\btone=(\S+)/.exec(was)?.[1];
    const tx = /txtone=(\S+)/.exec(was)?.[1] ?? both ?? "off";
    const rx = /rxtone=(\S+)/.exec(was)?.[1] ?? both ?? "off";
    if (f) await page.evaluate((cmd) => (window as any).ferrite.radio.connectedLink.cmd(cmd), `slot ${letter} vfo ${f} ${m ?? ""} txtone ${tx} rxtone ${rx} offset ${o}`);
  }
});
