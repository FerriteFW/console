// Live View over Bluetooth (LINK-47, LINK-48): the simulator's Bluetooth side through a bridge paced as the BT513
// is (20-byte writes 25 ms apart, ~960 B/s back). Console subscribes (mask 4) and keeps the screen from the radio's
// compact updates instead of polling the text readback; a lost update is noticed and the whole state asked again.
import { connect, disconnect, expect, expectScreen, bluetoothBridge, openConsole, screenId, shot, state, test } from "./helpers";

test.afterEach(async ({ page }) => disconnect(page));

test("bluetooth: Live View from the radio's updates, keys, a lost update put right", async ({ page }, info) => {
  const url = await bluetoothBridge();
  test.skip(!url, "the simulator only");
  test.setTimeout(90_000);
  const sent: Buffer[] = [];
  page.on("websocket", (ws) => ws.on("framesent", (f) => typeof f.payload !== "string" && sent.push(f.payload as Buffer)));
  await openConsole(page, "live", url!);
  await connect(page);
  await expect(page.getByRole("status")).toContainText("Bluetooth");
  await expect.poll(() => state(page, (f) => f.radio.subMask as number), { timeout: 20_000 }).toBe(4);
  await expectScreen(page, "Home");
  const ui = await state(page, (f) => f.radio.ui);
  expect(ui.cards.length).toBeGreaterThan(0);

  // no text readback (UI, 0x33) is asked while the updates come: the frames sent are SUBSCRIBE renewals and keys
  const before = sent.length;
  await page.waitForTimeout(6000);
  const rate = await state(page, (f) => f.radio.liveRate as number);
  info.annotations.push({ type: "idle B/s", description: String(rate) });
  expect(rate).toBeLessThan(400);
  expect(sent.length - before, "a renewal or two, no polling").toBeLessThan(6);
  await shot(page, info, "bt-01-home");

  await page.getByRole("button", { name: "OK (MENU)", exact: true }).click();
  await expect.poll(() => screenId(page), { timeout: 15_000 }).not.toBe("Home");
  await shot(page, info, "bt-02-menu");

  // the next update lost on the way: Console asks for the whole state and the screen is right again
  const resyncs = await state(page, (f) => f.radio.liveResyncs as number);
  await page.evaluate(() => (window as any).ferrite.radio.bridgeControl({ drop_ui: 1 }));
  await page.getByRole("button", { name: "BACK", exact: true }).click();
  await expect.poll(() => state(page, (f) => f.radio.liveResyncs as number), { timeout: 20_000 }).toBeGreaterThan(resyncs);
  await expectScreen(page, "Home");
  await shot(page, info, "bt-03-resynced");
});
