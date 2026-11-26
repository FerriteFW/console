// LINK-19.8: Live View draws the radio's screen in the radio's theme, not Console's. Console dark, the radio set to
// Daylight from the Terminal: the screen is light with dark text; back to Dark: dark with light text. (Discord,
// Nov 25, 2026: a daylight radio's menu text on Console's dark background couldn't be read.)
import { type Page } from "@playwright/test";
import { connect, disconnect, expect, openConsole, shot, test } from "./helpers";

const lum = (css: string) => {
  const [r, g, b] = (css.match(/\d+/g) ?? ["0", "0", "0"]).map(Number);
  return 0.3 * r + 0.59 * g + 0.11 * b;
};
const screen = (page: Page) => page.locator("[data-readback-screen]");
const colours = (page: Page) =>
  screen(page).evaluate((el) => {
    const s = getComputedStyle(el);
    return { bg: s.backgroundColor, text: s.color };
  });

async function setTheme(page: Page, name: string) {
  await page.getByRole("link", { name: "Terminal" }).click();
  const input = page.getByRole("textbox", { name: "Command" });
  await input.fill(`set 0 7 1 ${name}`);
  await input.press("Enter");
  await expect(page.getByRole("log", { name: "Terminal output" })).toContainText(`Theme: ${name}`);
  await page.getByRole("link", { name: "Live View" }).click();
}

test("Live View follows the radio's theme, whatever Console's is", async ({ page }, info) => {
  await page.addInitScript(() => localStorage.setItem("theme", "dark"));
  await openConsole(page, "live");
  await connect(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await setTheme(page, "Daylight");
  await expect(screen(page)).toHaveAttribute("data-theme-radio", "1");
  const day = await colours(page);
  expect(lum(day.bg)).toBeGreaterThan(lum(day.text));
  await shot(page, info, "live-theme-daylight-on-dark");

  await setTheme(page, "Dark");
  await expect(screen(page)).toHaveAttribute("data-theme-radio", "0");
  const dark = await colours(page);
  expect(lum(dark.bg)).toBeLessThan(lum(dark.text));
  await disconnect(page);
});
