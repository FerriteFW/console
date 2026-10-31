// The APRS console through the bridge: the heard list (HEARD, LINK-44) with distances, a station arriving by an
// event (LINK-46; injected by the bridge's test hook: the headless simulator hears nothing), the map, the messages
// as conversations, and sending one (MSG_SEND, LINK-45: the simulator only; it waits for APRS mode there, so nothing
// is sent over the air even in principle).
import { type Page } from "@playwright/test";
import { connect, disconnect, expect, onRadio, openConsole, shot, state, test } from "./helpers";

test.afterEach(async ({ page }) => disconnect(page));

const heardRows = (page: Page) => page.getByRole("table", { name: "Heard stations" }).locator("tbody tr[data-call]");
const loaded = (page: Page) => expect.poll(() => state(page, (f) => f.aprs.loaded as boolean), { timeout: 20_000 }).toBe(true);
const subscribed = (page: Page, mask: number) =>
  expect.poll(() => state(page, (f) => f.radio.subMask as number), { message: "subscribed to APRS events" }).toBe(mask);

/** A heard-station event's payload (kind 1): the list's count, then the station as HEARD carries it. */
function heardEvent(call: string, lat: number, lon: number, comment: string, count = 12): number[] {
  const p: number[] = [1, count, 1, call.length, ...Buffer.from(call), 4];
  const u32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
  p.push(...u32(0), 1, 0, ...u32(Math.round(lat * 1e7) >>> 0), ...u32(Math.round(lon * 1e7) >>> 0));
  p.push(0, comment.length, ...Buffer.from(comment));
  return p;
}

test("heard stations: the radio's list, distances from its position, a new one by event", async ({ page }, info) => {
  await openConsole(page, "aprs-heard");
  await connect(page);
  await loaded(page);
  const n = await state(page, (f) => f.aprs.stations.length as number);
  await expect(heardRows(page)).toHaveCount(n);
  if (onRadio()) return; // what a radio heard is its own
  expect(n).toBeGreaterThan(5);
  await expect(heardRows(page).first()).toContainText("VE3KPW-9");
  // the simulator's GPS fix: distances and bearings
  await expect(page.locator("[data-status]")).toContainText("Distances from the radio (GPS");
  await expect(page.locator('tr[data-call="VA3RTX"]')).toContainText(/\d+(\.\d)? km [NESW]{1,2}/);
  await expect(page.locator('tr[data-call="VE3RSB-1"]')).toContainText("Digi");
  await shot(page, info, "aprs-01-heard");

  // a station heard now arrives as an event, at the top, without a read
  await subscribed(page, 3);
  const readAt = await state(page, (f) => f.aprs.readAt as number);
  await page.evaluate((p) => (window as any).ferrite.radio.bridgeControl({ inject_event: p }), heardEvent("VE3NEW-7", 45.4, -75.7, "Injected by the test"));
  await expect(heardRows(page).first()).toHaveAttribute("data-call", "VE3NEW-7");
  await expect(heardRows(page).first()).toContainText("Injected by the test");
  expect(await state(page, (f) => f.aprs.readAt as number)).toBe(readAt);
  await shot(page, info, "aprs-02-heard-event");
});

test("map: the heard stations and the radio on OpenStreetMap", async ({ page }, info) => {
  await page.route(/tile\.openstreetmap\.org/, (r) => r.fulfill({ status: 204 })); // no tile traffic from tests
  await openConsole(page, "aprs-map");
  await connect(page);
  await loaded(page);
  const map = page.locator("[data-map]");
  await expect.poll(async () => (await map.getAttribute("data-map")) === "ready" || (await page.locator(".pg-banner.warn").count()) > 0, { timeout: 20_000 }).toBe(true);
  if ((await map.getAttribute("data-map")) !== "ready") {
    info.annotations.push({ type: "skipped", description: "Leaflet's CDN unreachable from this machine" });
    return;
  }
  const placed = await state(page, (f) => f.aprs.stations.filter((s: any) => s.lat !== null).length as number);
  const me = await state(page, (f) => !!f.aprs.me);
  await expect(page.locator(".leaflet-interactive.aprs-station")).toHaveCount(placed);
  if (me) await expect(page.locator(".leaflet-interactive.aprs-me")).toHaveCount(1);
  await expect(page.locator(".leaflet-control-attribution")).toContainText("OpenStreetMap");
  await shot(page, info, "aprs-03-map");
  if (onRadio() || !placed) return;
  // a station's link centres it with its popup
  await page.evaluate(() => (location.hash = "#/aprs-map?call=VA3RTX"));
  await expect(page.locator(".leaflet-popup-content")).toContainText("VA3RTX", { timeout: 20_000 });
});

test("messages: conversations by station, and one sent (queued: waits for APRS mode)", async ({ page }, info) => {
  await openConsole(page, "aprs-messages");
  await connect(page);
  await loaded(page);
  const threads = page.getByRole("navigation", { name: "Conversations" }).locator("[data-peer]");
  const peers = await state(page, (f) => new Set(f.aprs.messages.map((m: any) => m.peer.toUpperCase())).size as number);
  await expect(threads).toHaveCount(peers);
  if (onRadio()) return; // MSG_SEND only against the simulator
  await threads.filter({ hasText: "VA3RTX" }).click();
  const conv = page.getByRole("region", { name: "Conversation with VA3RTX" });
  await expect(conv.locator("li")).toHaveCount(2);
  await expect(conv.locator('li[data-state="retrying"]')).toContainText("Yes, 146.940");
  await expect(conv.locator('li[data-state="retrying"]')).toContainText("retrying (2)");
  await shot(page, info, "aprs-04-thread");

  // Console refuses what the radio would, before sending
  await page.getByLabel("Message", { exact: true }).fill("bad {brace}");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".pg-banner")).toContainText("no | ~ {");

  await subscribed(page, 3);
  const readAt = await state(page, (f) => f.aprs.readAt as number);
  await page.getByLabel("Message", { exact: true }).fill("Console e2e hello");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("note")).toContainText("waits until APRS mode is on");
  // the radio's own event brings it in, pending
  await expect(conv.locator("li").last()).toContainText("Console e2e hello");
  await expect(conv.locator("li").last()).toHaveAttribute("data-state", "pending");
  expect(await state(page, (f) => f.aprs.readAt as number)).toBe(readAt);
  await shot(page, info, "aprs-05-sent");
});

test("messages: one deleted on the radio (MSG_DELETE, LINK-52) after an in-page confirm; the list reads again", async ({ page }, info) => {
  await openConsole(page, "aprs-messages");
  await connect(page);
  await loaded(page);
  if (onRadio()) return; // a radio's messages are its owner's
  const threads = page.getByRole("navigation", { name: "Conversations" }).locator("[data-peer]");
  const n = await state(page, (f) => f.aprs.messages.length as number);
  await threads.filter({ hasText: "VE3JLH" }).click();
  const conv = page.getByRole("region", { name: "Conversation with VE3JLH" });
  const msg = conv.locator("li").filter({ hasText: "73, thanks for the QSO" });
  await msg.hover();
  await msg.getByRole("button", { name: "Delete message" }).click();
  // Asked in the page, never a browser dialog; Keep leaves it.
  const ask = msg.getByRole("group", { name: "Delete this message?" });
  await expect(ask).toContainText("can't be undone");
  await shot(page, info, "aprs-06-delete-ask");
  await ask.getByRole("button", { name: "Keep" }).click();
  await expect(ask).toHaveCount(0);
  await msg.hover();
  await msg.getByRole("button", { name: "Delete message" }).click();
  await msg.getByRole("group", { name: "Delete this message?" }).getByRole("button", { name: "Delete" }).click();
  await expect.poll(() => state(page, (f) => f.aprs.messages.length as number)).toBe(n - 1);
  await expect(threads.filter({ hasText: "VE3JLH" })).toHaveCount(0);
  await expect(page.getByRole("note")).toContainText("Deleted from the radio.");
});

test("Live View: APRS mode's large card shows the counts (heard, /hr) and the stations heard", async ({ page }, info) => {
  test.skip(onRadio(), "APRS mode is switched on: the simulator only");
  await openConsole(page, "live");
  await connect(page);
  const cmd = (line: string) => page.evaluate((l) => (window as any).ferrite.radio.connectedLink.cmd(l), line);
  try {
    await cmd("set 0 5 3 On"); // APRS mode on slot C
    await cmd("slot C active"); // the active card is the large one
    await expect.poll(() => state(page, (f) => f.radio.ui?.cards.find((c: any) => c.slot === "C")?.kind), { timeout: 15_000 }).toBe("aprs");
    await expect.poll(() => state(page, (f) => f.radio.ui?.cards.find((c: any) => c.slot === "C")?.active), { timeout: 15_000 }).toBe(1);
    const card = page.locator("[data-readback-screen] .card.active");
    await expect(card).toContainText(/\d+ heard/);
    await expect(card).toContainText(/\d+ \/hr/);
    const rows = await state(page, (f) => {
      const k = f.radio.ui?.other.find((l: any) => l.kind === "aprs_card")?.kv ?? {};
      return ["r1", "r2", "r3"].map((r) => String(k[r] ?? "").split("|")[0]).filter(Boolean);
    });
    if (rows.length) await expect(card.locator(".aprsrow.st").first()).toContainText(rows[0]);
    info.annotations.push({ type: "stations on the card", description: String(rows.length) });
    await shot(page, info, "aprs-04-live-card");
  } finally {
    await cmd("set 0 5 3 Off").catch(() => {});
    await cmd("slot A active").catch(() => {});
  }
});
