// Shared steps: open Console with the bridge, connect, disconnect, read the Live View's state, step screenshots.
import { expect, type Page, type TestInfo } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** "sim" (the default) or "radio" (FERRITE_E2E_SERIAL). */
export const target = (): "sim" | "radio" => (process.env.FERRITE_E2E_TARGET === "radio" ? "radio" : "sim");
export const onRadio = () => target() === "radio";

/** Step screenshots: FERRITE_E2E_OUT, or test-results/shots (kept after the run). */
export const shotsDir = () => process.env.FERRITE_E2E_OUT ?? "test-results/shots";

export async function shot(page: Page, info: TestInfo, name: string) {
  mkdirSync(shotsDir(), { recursive: true });
  const path = join(shotsDir(), `${target()}-${name}.png`);
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
}

/** Console at `page` (live, channels), with the Bridge button pointed at the run's bridge. */
export async function openConsole(page: Page, section = "live") {
  const url = process.env.FERRITE_E2E_BRIDGE;
  if (!url) throw new Error("FERRITE_E2E_BRIDGE is not set (global-setup starts the bridge)");
  await page.goto(`/?bridge=${encodeURIComponent(url)}#/${section}`);
}

export async function connect(page: Page) {
  await page.getByRole("button", { name: "Bridge", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Connected: Bridge", { timeout: 20_000 });
  await expect.poll(() => screenId(page)).not.toBeNull();
}

export async function disconnect(page: Page) {
  const b = page.getByRole("button", { name: "Disconnect" });
  if (await b.isVisible()) {
    await b.click();
    await expect(page.getByRole("status")).toContainText("Disconnected", { timeout: 10_000 });
  }
}

type Win = { ferrite: { radio: Record<string, any>; channels: Record<string, any> } };

/** The screen the Live View last read: its id ("Home", ...), or null. */
export const screenId = (page: Page) =>
  page.evaluate(() => ((window as unknown as Win).ferrite.radio.ui?.screen?.id as string | undefined) ?? null);

/** Something of window.ferrite (Console's radio and channels state), as JSON. */
export const state = <T>(page: Page, f: (w: Win["ferrite"]) => T) =>
  page.evaluate(`(${f.toString()})(window.ferrite)`) as Promise<T>;

/** Waits for the readback to show `id` (the poll runs every 150 ms on the cable). */
export async function expectScreen(page: Page, id: string) {
  await expect.poll(() => screenId(page), { message: `the radio's screen is ${id}` }).toBe(id);
}
