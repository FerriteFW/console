// LINK-13.4, LINK-13.5: Listen in the Live View: off at connect, the radio's receive audio while on (the
// simulator sends a tone while a squelch is open), off again with a click and at disconnect.
import { connect, disconnect, expect, openConsole, test } from "./helpers";

test.afterEach(async ({ page }) => disconnect(page));

test("listen: off at connect, blocks heard while on, off again", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ferrite-console-cable-high-speed", "on")); // Listen needs 230400 (decision 408)
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
  await page.addInitScript(() => localStorage.setItem("ferrite-console-cable-high-speed", "on")); // Listen needs 230400 (decision 408)
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

test("listen: Record writes a WAV of what's heard (12 kHz 16-bit mono), time and size shown, Stop saves it", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ferrite-console-cable-high-speed", "on")); // Listen needs 230400 (decision 408)
  await openConsole(page, "live");
  await connect(page);
  await expect(page.getByRole("button", { name: "Record" })).toHaveCount(0); // only while listening
  await page.getByRole("button", { name: /^Listen/ }).click();
  await page.getByRole("button", { name: "Record" }).click();
  await expect(page.locator("[data-rec]")).toContainText(/0:0[1-9] · \d+ kB/, { timeout: 5_000 });
  await page.waitForTimeout(1500);
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "■ Stop" }).click();
  const d = await dl;
  expect(d.suggestedFilename()).toMatch(/^listen-\d{4}-\d\d-\d\d-\d{4}\.wav$/);
  const { readFileSync } = await import("node:fs");
  const b = readFileSync(await d.path());
  expect(b.subarray(0, 4).toString()).toBe("RIFF");
  expect(b.readUInt32LE(24)).toBe(12_000);
  expect(b.readUInt16LE(34)).toBe(16);
  const secs = (b.length - 44) / 24_000;
  expect(secs).toBeGreaterThan(2);
  expect(secs).toBeLessThan(6);
  await expect(page.getByText(/^Saved listen-/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Record" })).toBeVisible();
});
