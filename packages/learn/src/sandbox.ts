import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The practice sandbox: a throwaway metarepo for lessons, built from the invented Forge
 * fixture. Layout (the same as the Forge fixture, so its dialect tests find the repos):
 *
 *   <dir>/repos/<id>            the seven Forge repos
 *   <dir>/inputs/               Forge's diagram, wiki pages, partner spec and ticket exports
 *   <dir>/metarepo/             the metarepo: the Forge org pack with the forge-change
 *                               additions, inputs/, workspace/<id> base clones (committed with
 *                               git so a scan can read them), and the seeded change
 *                               openspec/changes/add-transfer-limit
 *
 * Nothing in it is real and nothing leaves it: every adapter in the org pack is a mock. A
 * marker file `.atticus-sandbox.json` at the metarepo root lets the lesson commands refuse to
 * run anywhere else, so a lesson never writes decisions into a real metarepo.
 */

export const SANDBOX_MARKER = ".atticus-sandbox.json";
export const SEEDED_CHANGE = "add-transfer-limit";

export interface SandboxInfo {
  /** The folder given. */
  dir: string;
  /** The metarepo root inside it: pass this as --root. */
  root: string;
  repos: string[];
  change: string;
}

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

/** The Atticus checkout's fixtures folder, found by walking up from this package. */
export function findFixtures(start = dirname(fileURLToPath(import.meta.url))): string | undefined {
  let d = resolve(start);
  for (;;) {
    if (existsSync(join(d, "fixtures", "forge", "README.md"))) return join(d, "fixtures");
    const up = dirname(d);
    if (up === d) return undefined;
    d = up;
  }
}

function git(cwd: string, args: string[]) {
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Atticus sandbox",
      "-c",
      "user.email=sandbox@example.com",
      "-c",
      "init.defaultBranch=main",
      "-c",
      "core.autocrlf=false",
      ...args,
    ],
    { cwd, stdio: "pipe" },
  );
}

const isEmptyDir = async (d: string) => {
  try {
    return (await readdir(d)).length === 0;
  } catch {
    return true;
  }
};

/**
 * Make a sandbox in `dir` (which must not exist or be empty). Copies the Forge fixture and
 * the forge-change fixture, commits each repo as a base clone, and writes the marker. Needs
 * git on the path (the scan reads base clones).
 */
export async function createSandbox(
  dir: string,
  o: { fixtures?: string; now?: Date } = {},
): Promise<SandboxInfo> {
  const fixtures = o.fixtures ?? findFixtures();
  if (!fixtures || !existsSync(join(fixtures, "forge")))
    throw new SandboxError(
      "The Forge fixture isn't here: the practice sandbox is built from fixtures/forge in the Atticus checkout.",
    );
  const target = resolve(dir);
  if (existsSync(target) && !(await stat(target)).isDirectory())
    throw new SandboxError(`${dir} is a file; give a new or empty folder.`);
  if (!(await isEmptyDir(target)))
    throw new SandboxError(`${dir} isn't empty; give a new or empty folder.`);
  await mkdir(target, { recursive: true });
  const forge = join(fixtures, "forge");
  const change = join(fixtures, "forge-change");
  await cp(join(forge, "repos"), join(target, "repos"), { recursive: true });
  await cp(join(forge, "inputs"), join(target, "inputs"), { recursive: true });
  const root = join(target, "metarepo");
  await cp(join(forge, "metarepo"), root, { recursive: true });
  await cp(join(change, "org-pack"), join(root, "org-pack"), { recursive: true });
  await cp(join(forge, "inputs"), join(root, "inputs"), { recursive: true });
  await cp(
    join(change, "openspec", "changes", SEEDED_CHANGE),
    join(root, "openspec", "changes", SEEDED_CHANGE),
    {
      recursive: true,
    },
  );
  const repos = (await readdir(join(target, "repos"))).sort();
  for (const id of repos) {
    const base = join(root, "workspace", id);
    await cp(join(target, "repos", id), base, { recursive: true });
    try {
      git(base, ["init", "-q"]);
      git(base, ["add", "-A"]);
      git(base, ["commit", "-q", "-m", "Forge fixture"]);
      // A local bare repository stands in for the Git host, so the base clone has an origin
      // and workspace sync, worktrees and task branches work with no network.
      const remote = join(target, "remotes", `${id}.git`);
      await mkdir(dirname(remote), { recursive: true });
      git(target, ["clone", "-q", "--bare", base, remote]);
      git(base, ["remote", "add", "origin", remote]);
      git(base, ["fetch", "-q", "origin"]);
      git(base, ["branch", "-q", "--set-upstream-to=origin/main", "main"]);
    } catch (e) {
      await rm(join(base, ".git"), { recursive: true, force: true });
      throw new SandboxError(
        `git couldn't set up the base clone of ${id}: ${(e as Error).message.split("\n")[0]}`,
      );
    }
  }
  await writeFile(
    join(root, ".gitignore"),
    ["workspace/", ".index/", ".runs/", ".learn/", ".evals/", ""].join("\n"),
    "utf8",
  );
  await writeFile(
    join(root, "README.md"),
    [
      "# Atticus practice sandbox",
      "",
      "A throwaway metarepo built from the invented Forge ecosystem. Everything here is made up;",
      "every adapter is a mock. Try anything, then delete the folder.",
      "",
      "Run commands from this folder, or add `--root " + root.replace(/\\/g, "/") + "`.",
      "",
    ].join("\n"),
    "utf8",
  );
  const info: SandboxInfo = { dir: target, root, repos, change: SEEDED_CHANGE };
  await writeFile(
    join(root, SANDBOX_MARKER),
    JSON.stringify(
      { sandbox: 1, createdAt: (o.now ?? new Date()).toISOString(), repos, change: SEEDED_CHANGE },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  return info;
}

/** True when `root` is a practice sandbox's metarepo. */
export async function isSandbox(root: string): Promise<boolean> {
  try {
    const m = JSON.parse(await readFile(join(root, SANDBOX_MARKER), "utf8")) as {
      sandbox?: number;
    };
    return m.sandbox === 1;
  } catch {
    return false;
  }
}
