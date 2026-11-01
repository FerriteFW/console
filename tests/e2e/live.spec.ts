// Connect through the bridge, the Live View, remote keys, and Disconnect putting the cable back at 115200.
import { readFileSync } from "node:fs";
import { connect, disconnect, expect, expectScreen, openConsole, screenId, shot, state, test } from "./helpers";

test.afterEach(async ({ page }) => disconnect(page));

/** Where MENU 0 7 lands from home: advanced settings, group 7. */
const SEQ_SCREEN = "Group";
/** PNG width and height from its IHDR. */
const pngSize = (b: Buffer) => ({ w: b.readUInt32BE(16), h: b.readUInt32BE(20) });

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

test("save PNG: the screen downloads at 240x320 (and 480x640 at 2x), named by screen and time", async ({ page }, info) => {
  await openConsole(page, "live");
  await connect(page);
  await expectScreen(page, "Home");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Save PNG", exact: true }).click()]);
  expect(dl.suggestedFilename()).toMatch(/^ferrite-Home-\d{8}-\d{6}\.png$/);
  const path = await dl.path();
  const png = readFileSync(path);
  expect(png.subarray(1, 4).toString()).toBe("PNG");
  expect(pngSize(png)).toEqual({ w: 240, h: 320 });
  // Not one flat fill: text and cards are drawn.
  expect(png.length).toBeGreaterThan(3000);
  await info.attach("screen-1x", { path, contentType: "image/png" });

  await page.getByRole("button", { name: "More screenshot options" }).click();
  const [dl2] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /Save PNG 2×/ }).click()]);
  const path2 = await dl2.path();
  expect(pngSize(readFileSync(path2))).toEqual({ w: 480, h: 640 });
  await info.attach("screen-2x", { path: path2, contentType: "image/png" });
});

/** The key sequence box opens from the toolbar's ⋯ menu. */
async function openSequence(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "More Live View options" }).click();
  await page.getByRole("button", { name: "Send a key sequence…" }).click();
  return page.getByRole("combobox", { name: "Key sequence" });
}
/** Pauses or resumes reading the screen (⋯ › Update the screen live). */
async function setLive(page: import("@playwright/test").Page, on: boolean) {
  await page.getByRole("button", { name: "More Live View options" }).click();
  const c = page.getByRole("checkbox", { name: "Update the screen live" });
  await (on ? c.check() : c.uncheck());
  await page.keyboard.press("Escape");
}

test("key sequence: typed keys are pressed in order and reach the screen", async ({ page }, info) => {
  await openConsole(page, "live");
  await connect(page);
  await expectScreen(page, "Home");
  const box = await openSequence(page);
  await box.fill("MENU 0 7");
  await box.press("Enter");
  await expectScreen(page, SEQ_SCREEN);
  await shot(page, info, "06-sequence");
  // Back home the same way; both sequences are remembered, newest first.
  await box.fill("BACK BACK BACK");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expectScreen(page, "Home");
  const recent = await page.evaluate(() => JSON.parse(localStorage.getItem("keySequences") ?? "[]"));
  expect(recent.slice(0, 2)).toEqual(["BACK BACK BACK", "MENU 0 7"]);
});

test("key sequence: an unknown name (or PTT) is refused before anything is sent", async ({ page }) => {
  const sent: (string | Buffer)[] = [];
  page.on("websocket", (ws) => ws.on("framesent", (f) => sent.push(f.payload)));
  await openConsole(page, "live");
  await connect(page);
  await expectScreen(page, "Home");
  // Readbacks paused, so any frame sent after Enter would be a key.
  await setLive(page, false);
  await page.waitForTimeout(500);
  const box = await openSequence(page);
  await box.fill("MENU 0 PTT FOO");
  const before = sent.length;
  await box.press("Enter");
  await expect(page.getByRole("alert")).toContainText("Unknown keys: PTT, FOO");
  await page.waitForTimeout(500);
  expect(sent.length, "nothing went to the radio").toBe(before);
  await setLive(page, true);
  await expectScreen(page, "Home");
});

test("keyboard: Enter is MENU and Esc is BACK; ? lists the keys; an open dialog keeps its keys", async ({ page }) => {
  await openConsole(page, "live");
  await connect(page);
  await expectScreen(page, "Home");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Enter");
  await expect.poll(() => screenId(page)).not.toBe("Home");
  await page.keyboard.press("Escape");
  await expectScreen(page, "Home");
  // ? opens the keyboard help; while it's up, keys stay with it (Esc closes it, nothing reaches the radio).
  await page.keyboard.press("Shift+Slash");
  await expect(page.getByText("Keyboard controls")).toBeVisible();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await expect(page.getByText("Keyboard controls")).toBeHidden();
  await page.waitForTimeout(800);
  expect(await screenId(page)).toBe("Home");
  // Tune from map's dialog: Esc closes it, not BACK on the radio; Enter isn't MENU.
  await page.getByRole("button", { name: "Tune from map" }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg).toBeVisible();
  await page.keyboard.press("KeyM");
  await page.keyboard.press("Escape");
  await expect(dlg).toBeHidden();
  await page.waitForTimeout(800);
  expect(await screenId(page)).toBe("Home");
});
