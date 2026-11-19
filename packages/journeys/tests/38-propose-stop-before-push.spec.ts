import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  accessible,
  expect,
  forgeMetarepo,
  open,
  startApp,
  stopApp,
  test,
  type App,
} from "../support/app.js";

/**
 * ADR 0202 point 2, the review's journey: Propose for review stopped before its push leaves
 * nothing on the remote and opens no pull request; the commit stays on the proposal's branch
 * here, and Propose again sends that commit and opens exactly one pull request. The remote is a
 * bare repository on this machine and the Git host is manual (it records the pull request as a
 * step for the person, a file here): no network (CLAUDE.md rule 5). Everything is invented.
 *
 * The window between "Committing…" and the push is a few milliseconds on its own. A `git` on the
 * server's PATH holds the publisher's first `fetch` while a hold file exists, so the Stop lands
 * there every time; every other git call goes straight through. POSIX only (a shell script), as
 * the sync's Stop test is.
 */

const posix = process.platform !== "win32";
let app: App | undefined;
let parent: string;
let remote: string;
let hold: string;
let path: string | undefined;
const git = (cwd: string, ...a: string[]) =>
  spawnSync("git", ["-c", "user.name=Forge", "-c", "user.email=forge@example.com", ...a], {
    cwd,
    encoding: "utf8",
  }).stdout.trim();
const proposeBranches = () =>
  git(remote, "for-each-ref", "--format=%(refname:short)", "refs/heads/propose")
    .split("\n")
    .filter(Boolean);
/** The pull requests the manual Git host recorded: its open-pull-request steps. */
async function prSteps(root: string): Promise<string[]> {
  const dir = join(root, "steps");
  const out: string[] = [];
  for (const f of await readdir(dir).catch(() => [] as string[]))
    if (/action: open-pull-request/.test(await readFile(join(dir, f), "utf8"))) out.push(f);
  return out;
}

test.describe.configure({ mode: "serial" });
test.skip(!posix, "the held git is a shell script");

test.beforeAll(async () => {
  if (!posix) return;
  parent = await mkdtemp(join(tmpdir(), "atticus-journey-stop-"));
  const root = await forgeMetarepo();
  remote = join(parent, "forge-meta.git");
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "-q", "-u", "origin", "main");
  // The person set the Git host (manual, the metarepo's repo named): the file to propose.
  const rt = join(root, "org-pack/runtime.yaml");
  await writeFile(
    rt,
    (await readFile(rt, "utf8")).replace(
      "gitHost: { type: mock }",
      "gitHost: { type: manual, settings: { metarepo: forge-meta } }",
    ),
  );
  // A git that waits at `fetch` while the hold file is there.
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  const bin = join(parent, "bin");
  hold = join(parent, "hold");
  await mkdir(bin);
  await writeFile(
    join(bin, "git"),
    [
      "#!/bin/sh",
      `if [ "$1" = "fetch" ]; then while [ -f "${hold}" ]; do sleep 0.1; done; fi`,
      `exec "${real}" "$@"`,
      "",
    ].join("\n"),
  );
  await chmod(join(bin, "git"), 0o755);
  path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path ?? ""}`;
  try {
    app = await startApp(root);
  } finally {
    process.env.PATH = path;
  }
});
test.afterAll(async () => {
  if (app) await stopApp(app);
  if (parent) await rm(parent, { recursive: true, force: true });
});

test("Propose stopped before the push: nothing on the remote, no PR; Propose again opens exactly one", async ({
  page,
}) => {
  const a = app!;
  await open(page, a, "home");
  await page.getByRole("button", { name: "Propose for review" }).first().click();
  await expect(page.getByText("org-pack/runtime.yaml")).toBeVisible();
  const yes = page.getByRole("button", { name: "Push 1 file and open the PR" });

  // The first Yes: held at the publisher's fetch, after "Committing…" is said; Stop, then let go.
  await writeFile(hold, "");
  await yes.click();
  await expect(page.getByText(/^Now: Committing 1 file to propose\/work\//)).toBeVisible({
    timeout: 30_000,
  });
  const stop = page.getByRole("button", { name: /^Stop: / });
  await expect(stop).toBeVisible();
  await accessible(page, "Propose for review, running, with Stop before the push");
  await stop.click();
  await rm(hold);
  await expect(
    page.getByText(/^Stopped before the push: nothing left this machine\. The commit is on /),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Propose again to send it\.$/)).toBeVisible();

  // What it left: nothing on the remote, no pull request, the commit on the branch here.
  expect(proposeBranches()).toEqual([]);
  expect(await prSteps(a.root)).toEqual([]);
  const local = git(a.root, "for-each-ref", "--format=%(refname:short)", "refs/heads/propose");
  expect(local.split("\n").filter(Boolean)).toHaveLength(1);
  const kept = git(a.root, "rev-parse", local);
  expect(local).toMatch(/^propose\/work\/[0-9a-z-]+$/);
  // The person's checkout is as it was: main, the file still changed in the working tree.
  expect(git(a.root, "branch", "--show-current")).toBe("main");
  expect(git(a.root, "status", "--porcelain", "--", "org-pack/runtime.yaml")).toBe(
    "M org-pack/runtime.yaml",
  );

  // Propose again: the same list's Yes sends that commit, and the PR is opened once.
  await yes.click();
  await expect(page.getByText(/The PR is a step for you on Home/)).toBeVisible({
    timeout: 60_000,
  });
  expect(proposeBranches()).toEqual([local]);
  expect(git(remote, "rev-parse", local)).toBe(kept);
  expect(await prSteps(a.root)).toHaveLength(1);
  expect(existsSync(hold)).toBe(false);
  await accessible(page, "Propose for review, proposed after a Stop");
});
