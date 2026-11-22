import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  accessible,
  changeOf,
  ESTATES,
  expect,
  fieldInfo,
  forgeJourney,
  open,
  test,
  type Estate,
} from "../support/app.js";

/**
 * App-only audit: a tech lead taking a change from brief to archive with only the app. A task
 * drafted while its repo had no build command (UNVERIFIED) says what is true now and offers Build
 * and raise PR and Run again; Set up › Scans names the built-in readers as a cross-check.
 * Beta.30 (slice 9): on the tidy Forge estate (its staged change's task 1.1 in forge-ledger) and on
 * the field-shaped one (fixtures/forge-field: the quick-path change's task e2, in the topic's new
 * publisher, a repo whose manifest entry names no component).
 */

/** The task, its repo, and the manifest's line its build command is saved after, per estate. */
const TASK: Record<Estate, { task: string; repo: string; manifest: string; after: RegExp }> = {
  tidy: {
    task: "1.1",
    repo: "forge-ledger",
    manifest: "org-pack/profiles/forge/repos.manifest.yaml",
    after: /^ {4}component: ledger-api\n/m,
  },
  field: {
    task: "e2",
    repo: "forge-svc-01",
    manifest: "org-pack/profiles/github/repos.manifest.yaml",
    after: /^ {2}- id: forge-svc-01\n/m,
  },
};

for (const estate of ESTATES)
  test.describe(`the ${estate} estate`, () => {
    const app = forgeJourney({ estate });
    const CHANGE = changeOf(estate);
    const { task, repo, manifest: manifestFile, after } = TASK[estate];

    test("an unverified task says what is true now, and offers Build and raise PR and Run again", async ({
      page,
    }) => {
      if (estate === "field") expect(fieldInfo().manifest).toContain(repo);
      const root = app().root;
      const dir = join(root, "openspec/changes", CHANGE, "tasks", task);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "task-run.yaml"),
        [
          "schemaVersion: 1",
          `change: ${CHANGE}`,
          `task: '${task}'`,
          `repo: ${repo}`,
          "level: draft",
          "runtime: hand-off",
          "engine: atticus",
          "by: tom",
          `branch: task/${CHANGE}/${task}`,
          `worktree: workspace/.worktrees/${CHANGE}/.tasks/${task}/${repo}`,
          "state: unverified",
          "commit: 0123456789abcdef0123456789abcdef01234567",
          "startedAt: 2026-11-09T09:00:00Z",
          "notes:",
          `  - ${repo} has no build command in repos.manifest.yaml, so the change wasn't built or tested.`,
          "",
        ].join("\n"),
      );
      await open(page, app(), `tasks?change=${CHANGE}`);
      await expect(
        page.getByText(new RegExp(`${repo} has no build command, so nothing was built`)),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Build and raise PR" })).toHaveCount(0);

      // Set up › Repos saves the build command into the manifest; the card reads it now.
      const manifest = join(root, manifestFile);
      const text = await readFile(manifest, "utf8");
      expect(text).toMatch(after);
      await writeFile(
        manifest,
        text.replace(after, (line) => `${line}    build: forge build && forge test\n`),
      );
      await page.reload();
      await expect(page.getByText(new RegExp(`${repo} has a build command now`))).toBeVisible();
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
      await expect(
        page.getByRole("button", { name: "Check with the built-in readers" }),
      ).toBeVisible();
      await expect(page.getByText(/^A cross-check, not how the map is made/)).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Read again with your assistant" }),
      ).toHaveAttribute("href", "#/trust");
      await expect(
        page.getByLabel("Also ask about the repos your assistant hasn't read"),
      ).not.toBeChecked();
      await accessible(page, "scans");
    });
  });
