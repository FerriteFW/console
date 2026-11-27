// Stage 75 (after a fresh Install, stage 70): SSB on the radio, as Console's Firmware page shows it (INST-10, INST-10.2,
// decision 457). Installed from stock, the install took the patch from the radio: "This radio has SSB". Installed
// from nicFW (stage 62), it had none: the card says so, and Add SSB… with stock's .BTF finds the patch here, sends it
// (SSB_WRITE, LINK-73) and checks it; the radio uses it at once.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename } from "node:path";
import { connect, disconnect, openConsole, shot } from "../e2e/helpers";
import { expect, nicfwMark, stockBtf, stockRound, test } from "./radio";

test.skip(!stockRound(), "after a fresh Install: FERRITE_RADIO_FLASH=1 FERRITE_RADIO_STOCK=1");
test.setTimeout(10 * 60_000);

test("ssb: the Firmware page says the radio has SSB; from nicFW, Add SSB puts it there", async ({ page }, info) => {
  await openConsole(page, "firmware");
  await connect(page, 60_000);
  const card = page.getByRole("region", { name: "SSB" });
  const held = card.locator('[data-k="ssb-held"]');
  if (existsSync(nicfwMark())) {
    await expect(held).toContainText("This radio has no SSB yet", { timeout: 30_000 });
    await shot(page, info, "75-ssb-none");
    const btf = stockBtf();
    await page.getByLabel("Stock firmware for SSB").setInputFiles({ name: basename(btf), mimeType: "application/octet-stream", buffer: readFileSync(btf) });
    await expect(card.locator('[data-k="ssb-notice"]')).toContainText("SSB added and checked", { timeout: 5 * 60_000 });
    await expect(card.locator('[data-k="ssb-error"]')).toHaveCount(0);
    rmSync(nicfwMark());
  }
  await expect(held).toContainText("This radio has SSB", { timeout: 30_000 });
  await shot(page, info, "76-ssb-held");
  await disconnect(page);
});
