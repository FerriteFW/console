// LINK-13.4, LINK-13.5: Listen in the Live View: off at connect, the radio's receive audio while on (the
// simulator sends a tone while a squelch is open), off again with a click and at disconnect.
import { connect, disconnect, expect, openConsole, test } from "./helpers";

test.afterEach(async ({ page }) => disconnect(page));

test("listen: off at connect, blocks heard while on, off again", async ({ page }) => {
  await openConsole(page, "live");
  await connect(page);
  const btn = page.getByRole("button", { name: /^Listen/ });
  await expect(btn).toBeEnabled();
  await expect(btn).toHaveAttribute("aria-pressed", "false"); // never on by itself
  await btn.click();
  const on = page.getByRole("button", { name: "Listening" });
  await expect(on).toHaveAttribute("aria-pressed", "true", { timeout: 10_000 });
  await expect(page.getByText(/^Hearing [ABC]$/)).toBeVisible({ timeout: 10_000 });
  await on.click();
  await expect(page.getByRole("button", { name: "Listen", exact: true })).toHaveAttribute("aria-pressed", "false");
});

test("listen: the health dot comes up a few seconds in, with its tooltip, and goes with Listen", async ({ page }) => {
  await openConsole(page, "live");
  await connect(page);
  await page.getByRole("button", { name: /^Listen/ }).click();
  const dot = page.locator("[data-listen-health]");
  await expect(dot).toBeVisible({ timeout: 10_000 });
  // The simulator reports no audio counts (its `audio` line needs real blocks dropped or made in the radio's DSP).
  await expect(dot).toHaveAttribute("title", /audio counts|blocks dropped/);
  await page.getByRole("button", { name: "Listening" }).click();
  await expect(dot).toHaveCount(0);
});
