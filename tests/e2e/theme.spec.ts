// The theme menu: one icon in the bar; Light, Dark or Auto (follow the system), kept across visits.
import { expect, openConsole, test } from "./helpers";

const shown = (page: import("@playwright/test").Page) => page.evaluate(() => document.documentElement.dataset.theme);

test("theme: Light, Dark and Auto from the icon, kept after a reload, Auto follows the system", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await openConsole(page, "live");
  // A first visit is Auto: the system says light.
  await expect(page.getByRole("button", { name: /^Theme: Auto/ })).toBeVisible();
  expect(await shown(page)).toBe("light");

  await page.getByRole("button", { name: /^Theme:/ }).click();
  await page.getByRole("menuitemradio", { name: "Dark" }).click();
  expect(await shown(page)).toBe("dark");
  await page.reload();
  await page.getByRole("button", { name: "Look around without a radio" }).click();
  expect(await shown(page)).toBe("dark");

  await page.getByRole("button", { name: /^Theme:/ }).click();
  await page.getByRole("menuitemradio", { name: /^Auto/ }).click();
  expect(await shown(page)).toBe("light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => shown(page)).toBe("dark");
});
