// More › Videos: ferritefw.dev's video list (video/index.json, the website's /watch/ list) as tiles; one plays above
// them. Offline: says where to watch them. The list and the files are faked here.
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, openConsole, shot, test } from "./helpers";

const LIST = {
  update: "keys",
  videos: [
    { file: "keys", title: "Keys worth knowing", length: "1:45", line: "# for help, hold * for the quick menu." },
    { file: "aprs", title: "APRS on the radio", length: "1:58", line: "APRS on slot C beside your two voice slots." },
  ],
};

function tinyMp4(): Buffer | null {
  const out = join(mkdtempSync(join(tmpdir(), "vid-")), "v.mp4");
  const r = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=teal:s=320x180:d=1", "-pix_fmt", "yuv420p", "-y", out]);
  return r.status === 0 && existsSync(out) ? readFileSync(out) : null;
}

test("videos: the list as tiles; a tile plays above them", async ({ page }, info) => {
  const clip = tinyMp4();
  await page.route("**/video/index.json", (route) => route.fulfill({ json: LIST }));
  await page.route("**/video/*.jpg", (route) => route.abort());
  await page.route("**/video/*.mp4", (route) => (clip ? route.fulfill({ body: clip, contentType: "video/mp4" }) : route.abort()));
  await openConsole(page, "videos");
  const tiles = page.locator('[data-k="video-tile"]');
  await expect(tiles).toHaveCount(2);
  await expect(tiles.first()).toContainText("Keys worth knowing");
  await expect(page.locator('[data-k="video-player"]')).toHaveCount(0);
  await tiles.nth(1).click();
  const player = page.getByRole("region", { name: "Playing" });
  await expect(player).toContainText("APRS on the radio");
  await expect(page.locator('[data-k="video-player"]')).toHaveAttribute("src", /\/video\/aprs\.mp4$/);
  await shot(page, info, "90-videos");
});

test("videos: offline, it says where to watch them", async ({ page }) => {
  await page.route("**/video/index.json", (route) => route.abort());
  await openConsole(page, "videos");
  await expect(page.locator('[data-k="videos-offline"]')).toContainText("ferritefw.dev");
  await expect(page.locator('[data-k="video-tile"]')).toHaveCount(0);
});
