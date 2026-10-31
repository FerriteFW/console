// Console's own frame: the welcome (ConnectModal), the sections with tabs (APRS, Firmware) and their old addresses,
// and Live View's side panel (shown on a wide window only, hidden by its Panel switch).
import { type Page } from "@playwright/test";
import { closeWelcome, connect, disconnect, expect, openConsole, test } from "./helpers";

test.afterEach(async ({ page }) => disconnect(page));

const welcome = (page: Page) => page.getByRole("dialog", { name: "Connect your radio" });
const visit = (page: Page, bridge: string, section = "live") => page.goto(`/?bridge=${encodeURIComponent(bridge)}#/${section}`);

test("welcome: opens on a visit with Cable and Bluetooth; Look around and Esc close it", async ({ page, bridge }) => {
  await visit(page, bridge);
  await expect(welcome(page)).toBeVisible();
  await expect(welcome(page).getByRole("button", { name: /^Cable/ })).toBeVisible();
  await expect(welcome(page).getByRole("button", { name: /^Bluetooth/ })).toBeVisible();
  await welcome(page).getByRole("button", { name: "Look around without a radio" }).click();
  await expect(welcome(page)).toBeHidden();

  // every visit: back after a reload, and Esc closes it too
  await page.reload();
  await expect(welcome(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(welcome(page)).toBeHidden();
});

test("welcome: a browser without Web Serial or Web Bluetooth says why, as text", async ({ page, bridge }) => {
  await page.addInitScript(() => {
    for (const k of ["serial", "bluetooth"]) Object.defineProperty(Navigator.prototype, k, { get: () => undefined, configurable: true });
  });
  await visit(page, bridge);
  const cable = welcome(page).getByRole("button", { name: /^Cable/ });
  const bt = welcome(page).getByRole("button", { name: /^Bluetooth/ });
  await expect(cable).toBeDisabled();
  await expect(bt).toBeDisabled();
  await expect(cable).toContainText("This browser has no Web Serial");
  await expect(bt).toContainText("This browser has no Web Bluetooth");
});

test("welcome: connecting closes it (from the bar, and a connect started while it's open)", async ({ page, bridge }) => {
  // the welcome has no Bridge button: closed, then the bar's
  await visit(page, bridge);
  await closeWelcome(page);
  await connect(page);
  await expect(welcome(page)).toBeHidden();
  await disconnect(page);
  await expect(welcome(page)).toBeHidden(); // a plain disconnect doesn't bring it back

  // a connect while it's open: it closes once the port is open (radio.opened), not at the end of the session's start
  await page.reload();
  await expect(welcome(page)).toBeVisible();
  void page.evaluate(() => (window as any).ferrite.radio.connectBridge());
  await expect(welcome(page)).toBeHidden();
  await expect(page.getByRole("status")).toContainText("Connected: Bridge", { timeout: 20_000 });
});

test("tabs: APRS and Firmware switch pages, and old addresses land on their tab", async ({ page }) => {
  const tabs = (name: string) => page.getByRole("tablist", { name });
  const nav = page.getByRole("navigation", { name: "Sections" });

  // an old address: #/aprs-heard is the Heard stations tab
  await openConsole(page, "aprs-heard");
  await expect(tabs("APRS").getByRole("tab", { name: "Heard stations" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("toolbar", { name: "Heard stations" })).toBeVisible();
  await tabs("APRS").getByRole("tab", { name: "Messages", exact: true }).click();
  await expect(page).toHaveURL(/#\/aprs-messages$/);
  await expect(tabs("APRS").getByRole("tab", { name: "Messages", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("toolbar", { name: "Messages" })).toBeVisible();

  // the sidebar's Firmware opens Update; Install and Back to stock are its tabs
  await nav.getByRole("link", { name: "Firmware" }).click();
  await expect(tabs("Firmware").getByRole("tab", { name: "Update" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Update Ferrite", exact: true })).toBeVisible();
  await tabs("Firmware").getByRole("tab", { name: "Back to stock" }).click();
  await expect(page.getByRole("heading", { name: "Back to stock", exact: true })).toBeVisible();
  await expect(tabs("APRS")).toHaveCount(0);

  // #/install (the old Tools item) is the Install tab
  await page.evaluate(() => (location.hash = "#/install"));
  await expect(tabs("Firmware").getByRole("tab", { name: "Install" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Install Ferrite", exact: true })).toBeVisible();
});

test("Live View panel: beside the radio on a wide window, hidden on a small one and by its switch", async ({ page }) => {
  const panel = page.locator("[data-live-panel]");
  const toggle = page.getByRole("checkbox", { name: "Panel" });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await openConsole(page, "live");
  await connect(page);
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-slot="A"]')).toBeVisible();
  await expect(panel).toContainText("Heard now");
  await expect(panel).toContainText("Battery");
  // beside the radio, not under it, and the radio not drawn below 1x for it
  const radioBox = (await page.getByRole("region", { name: "The radio" }).boundingBox())!;
  const panelBox = (await panel.boundingBox())!;
  expect(panelBox.x).toBeGreaterThanOrEqual(radioBox.x + radioBox.width);
  expect(radioBox.height).toBeGreaterThan(600);

  // the switch hides it, and is remembered
  await toggle.uncheck();
  await expect(panel).toHaveCount(0);
  await page.reload();
  await closeWelcome(page);
  await expect(toggle).not.toBeChecked();
  await expect(panel).toHaveCount(0);
  await toggle.check();
  await expect(panel).toBeVisible();

  // a small window: no panel, no switch
  await page.setViewportSize({ width: 1000, height: 700 });
  await expect(panel).toHaveCount(0);
  await expect(toggle).toHaveCount(0);
});
