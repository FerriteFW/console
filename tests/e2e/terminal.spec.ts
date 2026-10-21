// Tools > Terminal: the radio's command line over the link (CMD, LINK-34). Commands and answers are the radio's own;
// refusals show the radio's reason; commands that transmit are refused by Console; history and Ctrl-L.
import { expect, test, type Page } from "@playwright/test";
import { connect, disconnect, expectScreen, openConsole, screenId, shot } from "./helpers";

test.afterEach(async ({ page }) => disconnect(page));

const input = (page: Page) => page.getByRole("textbox", { name: "Command" });
const log = (page: Page) => page.getByRole("log", { name: "Terminal output" });
const last = (page: Page, kind: string) => log(page).locator(`[data-kind="${kind}"]`).last();

async function run(page: Page, line: string) {
  const before = await log(page).locator(".entry:not(.working)").count();
  await input(page).fill(line);
  await input(page).press("Enter");
  // The command line, then its answer (or refusal) after it.
  await expect.poll(() => log(page).locator(".entry:not(.working)").count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(before + 2);
  await expect(log(page).locator(".entry.working")).toHaveCount(0);
}

test("terminal: help, slot, get, a refusal, Console's own refusal, history and Ctrl-L", async ({ page }, info) => {
  await openConsole(page, "terminal");
  await connect(page);
  await expect(input(page)).toBeVisible();

  await run(page, "help");
  await expect(last(page, "out")).toContainText("Commands:");
  await expect(last(page, "out")).toContainText("slot");
  await shot(page, info, "20-terminal-help");

  await run(page, "slot");
  await expect(last(page, "cmd")).toHaveText(":slot");
  await expect(last(page, "out")).toContainText(/^A[ *]/);
  await expect(last(page, "out")).toContainText(/\nB /);

  await run(page, "get 0 7 1");
  await expect(last(page, "out")).toHaveText(/^0 7 1 \S.*: /);

  // The radio refuses: its status and reason, shown as a refusal.
  await run(page, "set 0 7 1 bogus");
  await expect(last(page, "refused")).toContainText("invalid");
  await expect(last(page, "refused")).toContainText("Theme: one of");
  await shot(page, info, "21-terminal-refused");

  // Console refuses a command that transmits, without sending it.
  await run(page, "txtest");
  await expect(last(page, "note")).toContainText("not from Console");

  // History: Up recalls the last lines in turn, Down goes back.
  await input(page).click();
  await input(page).press("ArrowUp");
  await expect(input(page)).toHaveValue("txtest");
  await input(page).press("ArrowUp");
  await expect(input(page)).toHaveValue("set 0 7 1 bogus");
  await input(page).press("ArrowUp");
  await expect(input(page)).toHaveValue("get 0 7 1");
  await input(page).press("ArrowDown");
  await expect(input(page)).toHaveValue("set 0 7 1 bogus");
  await input(page).press("ArrowDown");
  await expect(input(page)).toHaveValue("txtest");
  await input(page).press("ArrowDown");
  await expect(input(page)).toHaveValue("");
  await input(page).press("ArrowUp");
  await input(page).press("ArrowUp");
  await input(page).press("Enter"); // the recalled refusal, sent again
  await expect(last(page, "cmd")).toHaveText(":set 0 7 1 bogus");
  await expect(last(page, "refused")).toContainText("Theme: one of");

  // A shortcut runs its command.
  await page.getByRole("button", { name: "ch 1", exact: true }).click();
  await expect(last(page, "cmd")).toHaveText(":ch 1");
  await expect(last(page, "out")).toContainText(/^ch 1 /);
  await shot(page, info, "22-terminal-history");

  // Ctrl-L clears the log.
  await input(page).press("Control+l");
  await expect(log(page).locator(".entry")).toHaveCount(0);
});

test("terminal: Live View's polling runs alongside, and the log stays across pages", async ({ page }) => {
  await openConsole(page, "terminal");
  await connect(page);
  await expectScreen(page, "Home");
  // A command that changes the screen: the readback (polled meanwhile) follows it.
  await page.getByRole("link", { name: "Live View" }).click();
  await page.getByRole("button", { name: "OK (MENU)", exact: true }).click();
  await expect.poll(() => screenId(page)).not.toBe("Home");
  await page.getByRole("link", { name: "Terminal" }).click();
  await run(page, "slot");
  await run(page, "get 0 7 1");
  await page.getByRole("link", { name: "Live View" }).click();
  await page.getByRole("button", { name: "BACK", exact: true }).click();
  await expectScreen(page, "Home");
  await page.getByRole("link", { name: "Terminal" }).click();
  await expect(log(page).locator('[data-kind="cmd"]')).toHaveText([":slot", ":get 0 7 1"]);
});
