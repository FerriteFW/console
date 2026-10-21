// End-to-end tests (tests/e2e/): Console in Chromium, connected through the development bridge (tools/bridge.py)
// to the simulator (the default: global-setup starts a headless ferrite-sim and the bridge) or to the radio's cable
// (FERRITE_E2E_SERIAL=/dev/cu.usbserial-... plus FERRITE_E2E_CHANNEL, a scratch channel the write tests edit and
// put back). `npm run e2e` builds and runs them; see README.
import { defineConfig } from "@playwright/test";

const radio = !!process.env.FERRITE_E2E_SERIAL;
const PORT = Number(process.env.FERRITE_E2E_WEB_PORT ?? 4174);

export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  // One radio (or simulator) and one bridge client at a time: the tests run one after another.
  workers: 1,
  fullyParallel: false,
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
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [{ name: radio ? "radio" : "sim" }],
  webServer: {
    command: `npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
