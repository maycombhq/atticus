import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessible, expect, forgeSlotsJourney, open, test } from "../support/app.js";

/**
 * ADR 0204 decision 4 in the app, on the tidy Forge estate: three new repos (invented) are added,
 * synced, read and applied in one job from Set up › Repos. Their remote is a local bare
 * repository each (file:// URLs, no network); a Git hook on the remote's side slows each clone,
 * so Stop lands while the sync runs. The page says the part and repo with Stop; after Stop it
 * offers Continue: N left, and the same button picks up from disk. Where the app can't start the
 * assistant (the fixture's runtime.yaml) the read pauses with what to paste; the person's
 * assistant writes the facts (here, the journey) and I've read them: continue applies them. Every
 * state is checked for accessibility. Nothing is committed or pushed.
 */
const NEW = ["forge-fx", "forge-rates", "forge-tax"];
const top = mkdtempSync(join(tmpdir(), "atticus-journey-remotes-"));
const git = (cwd: string, ...a: string[]) => {
  const r = spawnSync(
    "git",
    [
      "-c",
      "user.name=Forge",
      "-c",
      "user.email=forge@example.com",
      "-c",
      "commit.gpgsign=false",
      ...a,
    ],
    { cwd, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const CONTROLLER = (id: string) =>
  [
    `package forge.${id.replace(/^forge-/, "")};`,
    "",
    "@RestController",
    `public class Controller {`,
    `  @GetMapping("/v1/${id}/status")`,
    '  public String status() { return "ok"; }',
    "}",
    "",
  ].join("\n");
const FILE = "src/main/java/Controller.java";
const heads: Record<string, string> = {};

test.skip(process.platform === "win32", "the remote's slow-clone hook is a shell script");
test.beforeAll(() => {
  for (const id of NEW) {
    const work = join(top, "work", id);
    mkdirSync(join(work, "src", "main", "java"), { recursive: true });
    writeFileSync(join(work, FILE), CONTROLLER(id));
    git(work, "init", "-q", "-b", "main");
    git(work, "add", "-A");
    git(work, "commit", "-qm", id);
    heads[id] = git(work, "rev-parse", "HEAD");
    git(top, "clone", "-q", "--bare", work, join(top, `${id}.git`));
  }
  // The remote takes a moment per clone (upload-pack's pack-objects, as a slow host would), so
  // Stop is pressed while the sync runs. Git reads this hook only from a global config.
  const hook = join(top, "slow-pack.sh");
  writeFileSync(hook, '#!/bin/sh\nsleep 3\nexec "$@"\n');
  chmodSync(hook, 0o755);
  const cfg = join(top, "gitconfig");
  writeFileSync(cfg, `[uploadpack]\n\tpackObjectsHook = ${hook}\n`);
  process.env.GIT_CONFIG_GLOBAL = cfg;
});
const app = forgeSlotsJourney();
test.afterAll(() => {
  delete process.env.GIT_CONFIG_GLOBAL;
  rmSync(top, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("three new repos are added, synced, read and applied in one job, with Stop, Continue and the hand-off pause", async ({
  page,
}) => {
  const root = app().root;
  await open(page, app(), "repos");
  await page
    .getByRole("textbox", { name: "Clone URLs" })
    .fill(NEW.map((id) => `file://${join(top, `${id}.git`)}`).join("\n"));
  await page.getByRole("button", { name: "Read the list" }).click();
  const run = page.getByRole("button", { name: "Sync, read and apply these 3" });
  await expect(run).toBeVisible({ timeout: 60_000 });
  await accessible(page, "Add repos, the list read");
  await run.click();
  // The part and the repo, with Stop, while the sync runs.
  await expect(page.getByText(/Part 2 of 4: syncing forge-fx \(1 of 3\)/)).toBeVisible({
    timeout: 60_000,
  });
  await accessible(page, "Add repos, syncing");
  await page.getByRole("button", { name: /^Stop/ }).first().click();
  const again = page.getByRole("button", { name: /^Continue: \d left$/ });
  await expect(again).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText(/stopped/).first()).toBeVisible();
  // What is done stays done: the manifest lists the three already.
  const manifest = readFileSync(
    join(root, "org-pack", "profiles", "forge", "repos.manifest.yaml"),
    "utf8",
  );
  for (const id of NEW) expect(manifest).toContain(`id: ${id}`);
  await accessible(page, "Add repos, stopped");
  // Continue: the sync picks up from disk, then the read pauses for the person's assistant.
  await again.click();
  await expect(
    page.getByText(
      "Atticus can't start your assistant on this machine. Paste this into Copilot Chat or Claude Code:",
    ),
  ).toBeVisible({ timeout: 180_000 });
  await expect(page.getByText("/atticus-map forge-fx").first()).toBeVisible();
  await accessible(page, "Add repos, the read waiting for the assistant");
  // The person's assistant reads each and writes its facts, citing the clone's line.
  mkdirSync(join(root, "facts"), { recursive: true });
  for (const id of NEW)
    writeFileSync(
      join(root, "facts", `${id}.jsonl`),
      `${JSON.stringify({
        kind: "entry",
        id: `entry.get.v1-${id}-status`,
        repo: id,
        commit: heads[id],
        entryType: "rest",
        method: "GET",
        path: `/v1/${id}/status`,
        handler: "Controller.status",
        cite: {
          file: FILE,
          line: 5,
          value: `/v1/${id}/status`,
          quote: `@GetMapping("/v1/${id}/status")`,
        },
        by: "assistant",
        conf: "declared",
      })}\n`,
    );
  await page.getByRole("button", { name: "I've read them: continue" }).click();
  await expect(page.getByText("3 of 3 are on the map.")).toBeVisible({ timeout: 180_000 });
  await expect(page.getByRole("link", { name: "Show them" })).toBeVisible();
  await accessible(page, "Add repos, on the map");
});
