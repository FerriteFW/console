// Reconnecting by itself: the link drops (the bridge's WebSocket closes, as a pulled cable), Console says so calmly
// and opens the same connection again with no chooser; Listen stays off (LINK-13.5); Stop ends the retrying.
import { connect, disconnect, expect, expectScreen, openConsole, state, test } from "./helpers";

test.afterEach(async ({ page }) => disconnect(page));

test("reconnect: a dropped link comes back by itself, Live View reads again, Listen stays off", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ferrite-console-cable-high-speed", "on")); // Listen needs 230400 (decision 408)
  await openConsole(page, "live");
  await connect(page);
  await page.getByRole("button", { name: /^Listen/ }).click();
  await expect(page.getByRole("button", { name: "Listening" })).toHaveAttribute("aria-pressed", "true", { timeout: 10_000 });
  expect(await state(page, (f) => f.radio.bridgeDrop())).toBe(true);
  await expect(page.getByRole("status")).toContainText("Radio lost: reconnecting", { timeout: 5_000 });
  await expect(page.getByRole("alert")).toHaveCount(0); // no error banner while it tries
  await expect(page.getByRole("status")).toContainText("Connected: Bridge", { timeout: 20_000 });
  await expectScreen(page, "Home");
  await expect(page.getByRole("button", { name: "Listen", exact: true })).toHaveAttribute("aria-pressed", "false");
  expect(await state(page, (f) => f.radio.retrying)).toBeNull();
});

test("reconnect: Stop ends the retrying and leaves Console disconnected", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ferrite-console-cable-high-speed", "on")); // Listen needs 230400 (decision 408)
  await openConsole(page, "live");
  await connect(page);
  // A reopen that always fails (the cable not back): the retrying stays up until Stop.
  await page.evaluate(() => {
    const r = (window as unknown as { ferrite: { radio: { reopen: unknown } } }).ferrite.radio;
    r.reopen = () => Promise.reject(new Error("not back yet"));
  });
  expect(await state(page, (f) => f.radio.bridgeDrop())).toBe(true);
  await expect(page.getByRole("status")).toContainText("Radio lost: reconnecting", { timeout: 5_000 });
  await page.waitForTimeout(2500);
  expect(await state(page, (f) => f.radio.retrying?.tries)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Disconnected");
  await expect(page.getByRole("button", { name: "Bridge", exact: true })).toBeVisible();
});
