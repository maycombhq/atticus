import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

/**
 * A pre-installed Chromium when there is one (ATTICUS_CHROMIUM, or the build machine's), else
 * Playwright's own.
 */
const chromium = [process.env.ATTICUS_CHROMIUM, "/opt/pw-browsers/chromium"].find(
  (p): p is string => !!p && existsSync(p),
);

export default defineConfig({
  testDir: "tests",
  // Each journey gets its own metarepo and server; they run one at a time to stay gentle on CI.
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    viewport: { width: 1440, height: 900 },
    // The app follows the system's theme. The journeys run dark, as the app was built; the light
    // theme has its own pass over every screen (17-light-theme).
    colorScheme: "dark",
    launchOptions: chromium ? { executablePath: chromium } : {},
    trace: "retain-on-failure",
  },
});
