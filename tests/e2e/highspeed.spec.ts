// Decision 408: the cable at 115200 with no compression unless Live View's High speed is on (then 230400, LINK-13.3).
import { connect, disconnect, expect, openConsole, test } from "./helpers";

const st = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const r = (window as any).ferrite.radio;
    return { baud: r.baud, note: r.note, lz: (r.connectedLink.caps & 1) !== 0, compress: r.connectedLink.compress };
  });

test("cable: 115200 and no compression to start; High speed raises it to 230400 now and at the next connect", async ({ page }) => {
  await openConsole(page, "live");
  await page.evaluate(() => localStorage.removeItem("ferrite-console-cable-high-speed"));
  await connect(page);
  await expect.poll(() => st(page)).toMatchObject({ baud: 115200, note: "115200 baud", lz: false, compress: false });
  const box = page.getByRole("toolbar", { name: "Display" }).getByLabel("High speed");
  await expect(box).not.toBeChecked();
  await box.check();
  await expect.poll(() => st(page)).toMatchObject({ baud: 230400, note: "230400 baud", lz: false });
  // Kept: a new connection goes straight to 230400.
  await disconnect(page);
  await connect(page);
  await expect.poll(() => st(page)).toMatchObject({ baud: 230400, lz: false });
  await expect(box).toBeChecked();
  await box.uncheck();
  await expect.poll(() => st(page)).toMatchObject({ baud: 115200, note: "115200 baud" });
  await disconnect(page);
});

test("listen: needs High speed (the audio is more than 115200 carries)", async ({ page }) => {
  await openConsole(page, "live");
  await page.evaluate(() => localStorage.removeItem("ferrite-console-cable-high-speed"));
  await connect(page);
  const listen = page.getByRole("toolbar", { name: "Display" }).getByRole("button", { name: "Listen" });
  await expect(listen).toBeDisabled();
  await expect(listen).toHaveAttribute("title", /needs High speed/);
  await page.getByRole("toolbar", { name: "Display" }).getByLabel("High speed").check();
  await expect.poll(() => page.evaluate(() => (window as any).ferrite.radio.baud)).toBe(230400);
  await expect(listen).toBeEnabled();
  await disconnect(page);
});
