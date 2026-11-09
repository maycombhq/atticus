import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { accessible, expect, forgeJourney, open, test } from "../support/app.js";

/**
 * App-only audit: a tech lead taking a change from brief to archive with only the app. A task
 * drafted while its repo had no build command (UNVERIFIED) says what is true now and offers Build
 * and raise PR and Run again; Set up › Scans names the built-in readers as a cross-check.
 */
const app = forgeJourney();
const CHANGE = "add-transfer-limit";

test("an unverified task says what is true now, and offers Build and raise PR and Run again", async ({
  page,
}) => {
  const root = app().root;
  const dir = join(root, "openspec/changes", CHANGE, "tasks", "1.1");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "task-run.yaml"),
    [
      "schemaVersion: 1",
      `change: ${CHANGE}`,
      "task: '1.1'",
      "repo: forge-ledger",
      "level: draft",
      "runtime: hand-off",
      "engine: atticus",
      "by: tom",
      `branch: task/${CHANGE}/1.1`,
      `worktree: workspace/.worktrees/${CHANGE}/.tasks/1.1/forge-ledger`,
      "state: unverified",
      "commit: 0123456789abcdef0123456789abcdef01234567",
      "startedAt: 2026-11-09T09:00:00Z",
      "notes:",
      "  - forge-ledger has no build command in repos.manifest.yaml, so the change wasn't built or tested.",
      "",
    ].join("\n"),
  );
  await open(page, app(), `tasks?change=${CHANGE}`);
  await expect(
    page.getByText(/forge-ledger has no build command, so nothing was built/),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Build and raise PR" })).toHaveCount(0);

  // Set up › Repos saves the build command into the manifest; the card reads it now.
  const manifest = join(root, "org-pack/profiles/forge/repos.manifest.yaml");
  await writeFile(
    manifest,
    (await readFile(manifest, "utf8")).replace(
      "    component: ledger-api\n",
      "    component: ledger-api\n    build: forge build && forge test\n",
    ),
  );
  await page.reload();
  await expect(page.getByText(/forge-ledger has a build command now/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Build and raise PR" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run with AI again" }).first()).toBeVisible();
  await accessible(page, "task board, an unverified task");
  // No worktree here: said, with what to do, never a bare failure.
  await page.getByRole("button", { name: "Build and raise PR" }).click();
  await expect(page.getByText(/isn't here any more: run the task again/)).toBeVisible();
});

test("Set up › Scans names the built-in readers as a cross-check, and links to Trust", async ({
  page,
}) => {
  await open(page, app(), "scans");
  await expect(page.getByRole("button", { name: "Check with the built-in readers" })).toBeVisible();
  await expect(page.getByText(/^A cross-check, not how the map is made/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Read again with your assistant" })).toHaveAttribute(
    "href",
    "#/trust",
  );
  await expect(
    page.getByLabel("Also ask about the repos your assistant hasn't read"),
  ).not.toBeChecked();
  await accessible(page, "scans");
});
