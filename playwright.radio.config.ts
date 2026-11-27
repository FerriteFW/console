// The radio journey (tests/radio/): Console driven as a user drives it, against a real radio, with the radio itself
// checked over its Bluetooth by a second program (tests/radio/oracle.py). Run by hand, never in CI:
//   npm run radio -- [--grep STAGE]          (FERRITE_RADIO=black by default: ~/.config/ferrite/radios.toml)
// The stages run in file order (10-connect, 20-settings, ...), one at a time, on one cable. A stage that changes the
// radio puts it back; the last stage checks the radio ends exactly as it started. See tests/radio/README.md.
import { defineConfig } from "@playwright/test";
import { createHash } from "node:crypto";

const PORT = Number(process.env.FERRITE_E2E_WEB_PORT ?? 43000 + (createHash("sha1").update(import.meta.dirname).digest().readUInt16BE(0) % 2000));

export default defineConfig({
  testDir: "tests/radio",
  globalSetup: "./tests/radio/setup.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  // Stage order matters (a later stage expects an earlier one's radio); a failure stops the run.
  maxFailures: 1,
  timeout: 300_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report-radio" }]],
  outputDir: "test-results/radio",
  use: {
    baseURL: `http://localhost:${PORT}`,
    browserName: "chromium",
    viewport: { width: 1440, height: 960 },
    acceptDownloads: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [{ name: "radio" }],
  webServer: {
    command: `node node_modules/vite/bin/vite.js preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
