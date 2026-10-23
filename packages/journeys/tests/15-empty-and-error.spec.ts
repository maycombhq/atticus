import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { accessible, expect, startApp, stopApp, test, type App } from "../support/app.js";

/**
 * Every screen on a brand-new metarepo (nothing scanned, no change) says what to do, never an
 * error; and when the local server can't be reached, every screen says so in words.
 */

const BIN = join(dirname(fileURLToPath(import.meta.url)), "../../cli/dist/bin.js");
const ROUTES = [
  // The menu, in the order of a working day (ADR 0105).
  "dashboard",
  "home",
  "changes",
  "onboarding",
  "feature-design",
  "architecture",
  "stories",
  "task-list",
  "knowledge",
  "questions",
  "explore",
  "flows",
  "map",
  "impact",
  "features",
  "orgpack",
  "intake",
  // ADR 0102: knowledge in the app.
  "wikis",
  "wiki-search",
  "parties",
  "orgpack-draft",
  "scans",
  "brief",
  "ux",
  "arch-review",
  "diagrams",
  "change-diagram",
  "reconcile",
  "contracts",
  "mappings",
  "breakdown",
  "initiatives",
  "changes?across=findings",
  "changes?across=needs",
  "tasks",
  "trace",
  "todo",
  "release",
  "service-desk",
  "governance",
  "evals",
  "learning",
  "runs",
  "history",
  "settings",
];

let app: App | undefined;
test.describe.configure({ mode: "default" });
test.beforeAll(async () => {
  const root = join(await mkdtemp(join(tmpdir(), "atticus-empty-")), "meta");
  const r = spawnSync(process.execPath, [BIN, "init", root, "--platform", "forge"], {
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`${r.stdout}${r.stderr}`);
  app = await startApp(root);
});
test.afterAll(async () => {
  if (app) await stopApp(app);
});

for (const route of ROUTES)
  test(`#/${route} on a new metarepo says what to do, not an error`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${app!.url}/#/${route}`);
    await expect(page.locator(".panel").first()).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(/Couldn't load this/)).toHaveCount(0);
    expect(errors).toEqual([]);
    await accessible(page, `${route} (empty)`);
  });

for (const route of [
  "home",
  "dashboard",
  "map",
  "changes",
  "changes?across=needs",
  "release",
  "knowledge",
  "settings",
])
  test(`#/${route} says so when the server can't be reached, and how to fix it`, async ({
    page,
  }) => {
    await page.goto(`${app!.url}/#/${route}`);
    await expect(page.locator(".panel").first()).toBeVisible();
    await page.route("**/api/**", (r) => r.abort());
    await page.reload();
    await expect(page.getByRole("alert").first()).toBeVisible();
    // One note for the page names the server and how to start it; never "Failed to fetch".
    await expect(page.getByText(/The Atticus server isn't answering/)).toHaveCount(1);
    await expect(page.getByText(/Failed to fetch/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Try again" }).first()).toBeVisible();
    await accessible(page, `${route} (server unreachable)`);
  });

test("the page loads again by itself once the server answers", async ({ page }) => {
  await page.goto(`${app!.url}/#/changes`);
  await expect(page.locator(".panel").first()).toBeVisible();
  await page.route("**/api/**", (r) => r.abort());
  await page.reload();
  await expect(page.getByText(/The Atticus server isn't answering/)).toBeVisible();
  await page.unroute("**/api/**");
  await page.getByRole("button", { name: "Try again" }).first().click();
  await expect(page.getByText(/The Atticus server isn't answering/)).toHaveCount(0);
  await expect(page.getByText(/Couldn't load this/)).toHaveCount(0);
});
