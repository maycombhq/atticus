import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

/** A pre-installed Chromium when there is one (the build machine), else Playwright's own. */
const chromium = ["/opt/pw-browsers/chromium"].find((p) => existsSync(p));

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
    launchOptions: chromium ? { executablePath: chromium } : {},
    trace: "retain-on-failure",
  },
});
