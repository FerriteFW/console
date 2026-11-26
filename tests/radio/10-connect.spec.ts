// Stage 10: connect. Console on the cable says what the radio says over Bluetooth: the same firmware and build, and
// Live View shows the screen the radio shows. Then a key pressed in Console's Live View moves the real radio.
import { closeWelcome, connect, disconnect, openConsole, screenId, shot, state } from "../e2e/helpers";
import { expect, test } from "./radio";

test("Console and the radio agree on what is connected", async ({ page, oracle }, info) => {
  await openConsole(page, "live");
  await closeWelcome(page);
  await connect(page, 30_000);
  const h = await oracle.hello();
  const bar = page.locator("header, .bar").getByText(h.firmware).first();
  await expect(bar).toBeVisible();
  const consoleSays = await state(page, (f) => ({ firmware: f.radio.info?.firmware, build: f.radio.info?.build?.name }));
  expect(consoleSays.firmware).toBe(h.firmware);
  expect(consoleSays.build).toBe(h.build);
  // The screen: Live View's readback and the radio's own (over Bluetooth) name the same one.
  const screen = /^screen (\S+)/.exec(await oracle.ui())?.[1];
  await expect.poll(() => screenId(page)).toBe(screen);
  await shot(page, info, "10-connected");
  // A radio whose data waits in an older layout (UPD-16): Console reads and writes nothing until it's moved, and only
  // Alex moves a radio's data. Stop here, saying so, rather than fail in every later stage.
  const banner = page.getByRole("alert", { name: "Finish the update" });
  expect(await banner.isVisible(), `${await banner.textContent().catch(() => "")} Finish the update by hand, then run again.`).toBe(false);
});

test("a key in Live View moves the radio", async ({ page, oracle }, info) => {
  await openConsole(page, "live");
  await connect(page, 30_000);
  // From home: EXIT a few times (Live View's keys), then MENU opens quick settings on the radio itself.
  for (let i = 0; i < 4; i++) await page.keyboard.press("Escape");
  await expect.poll(() => oracle.ui().then((u) => /^screen (\S+)/.exec(u)?.[1]), { timeout: 30_000 }).toBe("Home");
  const home = await screenId(page);
  expect(home).toBe("Home");
  await shot(page, info, "11-home");
  await disconnect(page);
});
