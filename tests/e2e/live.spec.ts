// Connect through the bridge, the Live View, remote keys, and Disconnect putting the cable back at 115200.
import { connect, disconnect, expect, expectScreen, openConsole, screenId, shot, state, test } from "./helpers";

test.afterEach(async ({ page }) => disconnect(page));

test("connect: the Radio panel fills and Live View shows the home screen", async ({ page }, info) => {
  await openConsole(page, "live");
  await expect(page.getByRole("button", { name: "Bridge", exact: true })).toBeVisible();
  await shot(page, info, "01-disconnected");
  await connect(page);
  const i = await state(page, (f) => f.radio.info);
  expect(i.firmware).toBeTruthy();
  await expectScreen(page, "Home");
  // The home card's frequency is drawn in the Live View.
  const ui = await state(page, (f) => f.radio.ui);
  expect(ui.cards.length).toBeGreaterThan(0);
  await expect(page.getByRole("status")).toContainText("Bridge");
  await shot(page, info, "02-home");
});

test("keys: MENU opens a screen, BACK returns home", async ({ page }, info) => {
  await openConsole(page, "live");
  await connect(page);
  await expectScreen(page, "Home");
  await page.getByRole("button", { name: "OK (MENU)", exact: true }).click();
  await expect.poll(() => screenId(page)).not.toBe("Home");
  const menu = await screenId(page);
  await shot(page, info, "03-menu");
  await page.getByRole("button", { name: "BACK", exact: true }).click();
  await expectScreen(page, "Home");
  await shot(page, info, "04-back-home");
  expect(menu).not.toBe("Home");
});

test("disconnect: the cable's rate goes back to 115200 first", async ({ page }, info) => {
  const sent: (string | Buffer)[] = [];
  page.on("websocket", (ws) => ws.on("framesent", (f) => sent.push(f.payload)));
  await openConsole(page, "live");
  await connect(page);
  const raised = await state(page, (f) => f.radio.baud as number | null);
  info.annotations.push({ type: "rate", description: String(raised) });
  if (!raised || raised <= 115200) {
    // The radio (or simulator) kept 115200: nothing to put back.
    await disconnect(page);
    return;
  }
  expect(sent.some((p) => p === JSON.stringify({ baud: raised }))).toBe(true);
  const before = sent.length;
  await disconnect(page);
  const after = sent.slice(before);
  const back = after.findIndex((p) => p === JSON.stringify({ baud: 115200 }));
  expect(back, "the bridge was asked for 115200").toBeGreaterThanOrEqual(0);
  // A BAUD request went to the radio before the port switched (a binary frame), and a HELLO after.
  expect(after.slice(0, back).some((p) => typeof p !== "string")).toBe(true);
  expect(after.slice(back + 1).some((p) => typeof p !== "string")).toBe(true);
  await shot(page, info, "05-disconnected");
});
