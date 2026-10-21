// End-to-end tests (tests/e2e/): Console in Chromium, connected through the development bridge (tools/bridge.py)
// to the simulator (the default: global-setup starts a headless ferrite-sim and the bridge) or to the radio's cable
// (FERRITE_E2E_SERIAL=/dev/cu.usbserial-... plus FERRITE_E2E_CHANNEL, a scratch channel the write tests edit and
// put back). `npm run e2e` builds and runs them; see README.
import { defineConfig } from "@playwright/test";
import { createHash } from "node:crypto";

const radio = !!process.env.FERRITE_E2E_SERIAL;
const shared = radio || !!process.env.FERRITE_E2E_BRIDGE;
// The preview's port: one per checkout (from its path), so two checkouts' runs at once don't share a server.
const PORT = Number(process.env.FERRITE_E2E_WEB_PORT ?? 41000 + (createHash("sha1").update(import.meta.dirname).digest().readUInt16BE(0) % 2000));

export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  // The radio (one cable) or a bridge given in FERRITE_E2E_BRIDGE: one test at a time. The simulator: tests (and
  // serial groups) in parallel, each worker with its own simulator and bridge (helpers.ts).
  workers: shared ? 1 : Number(process.env.FERRITE_E2E_WORKERS ?? 12),
  fullyParallel: !shared,
  retries: 0,
  timeout: radio ? 180_000 : 60_000,
  expect: { timeout: radio ? 20_000 : 10_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  outputDir: "test-results",
  use: {
    baseURL: `http://localhost:${PORT}`,
    browserName: "chromium",
    viewport: { width: 1440, height: 960 },
    acceptDownloads: true,
    screenshot: "only-on-failure",
    // Tracing slows every test (seconds on the channel table); on the simulator, rerun a failure with --trace on.
    trace: radio ? "retain-on-failure" : "off",
    video: "off",
  },
  projects: [{ name: radio ? "radio" : "sim" }],
  webServer: {
    command: `node node_modules/vite/bin/vite.js preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
