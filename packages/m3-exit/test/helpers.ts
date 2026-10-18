import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { parse, stringify } from "yaml";
import { main } from "@maycombhq/cli/dist/main.js";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";

/**
 * Shared set-up for the M3 exit suite. Everything runs in a temp folder built from the
 * hand-written fixtures; nothing touches the network (remotes are local bare repositories,
 * outside systems are mocks or manual steps, AI is recorded replay).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(HERE, "../../../fixtures");
export const FORGE = join(FIXTURES, "forge");
export const FORGE_CHANGE = join(FIXTURES, "forge-change");
export const SPECKIT = join(FIXTURES, "forge-speckit");
export const OWN = join(HERE, "fixtures");
export const ADOPT_FIXTURES = join(HERE, "../../adopt/test/fixtures");
export const CHANGE = "add-transfer-limit";
export const METAREPO = "forge/forge-metarepo";
export const T = 300_000;

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
  GIT_TERMINAL_PROMPT: "0",
};

// The CLI runs in this process and commits on task branches as the developer would; give it the
// identity a developer's machine has (CI runners have no git user configured).
for (const k of [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_TERMINAL_PROMPT",
] as const)
  process.env[k] ??= ENV[k];

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    env: ENV,
    stdio: "pipe",
  }).trim();
}

/**
 * A test that records a known product gap: it asserts what the exit needs and is expected to
 * fail until the gap is fixed (then vitest reports it, and `gap` becomes `it`). Set
 * M3_EXIT_SHOW_GAPS=1 to run gap tests as ordinary tests and see why each fails.
 */
export const gap: typeof it.fails = process.env.M3_EXIT_SHOW_GAPS ? it : it.fails;

export interface Result {
  code: number;
  out: string[];
  err: string[];
  /** stdout and stderr joined, for matching. */
  text: string;
}

/** Run `atticus <args>` through the real CLI entry point, against a metarepo. */
export async function atticus(root: string | undefined, ...args: string[]): Promise<Result> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(root ? [...args, "--root", root] : args, {
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
  });
  return { code, out, err, text: [...out, ...err].join("\n") };
}

/** Parse the JSON a command printed. */
export function json<T>(r: Result): T {
  return JSON.parse(r.out.join("\n")) as T;
}

export interface Estate {
  /** The temp folder: metarepo/, repos/, inputs/ and remotes/ side by side, as fixtures/forge. */
  top: string;
  /** The metarepo. */
  root: string;
  /** Replay recordings for every AI step the suite runs. */
  replayDir: string;
  /** Lines the fake build runner appends, one per build. */
  buildLog: string;
}

/**
 * The Forge estate as a team would have it: fixtures/forge copied (metarepo beside repos and
 * inputs), the forge-change and forge-speckit org-pack additions laid over the Forge pack, then
 * this suite's own runtime.yaml (replay allowed, mock outside systems) and a manifest whose
 * repos point at local bare remotes and build with a fake build runner. The metarepo is a Git
 * repository. Nothing is scanned yet.
 */
export async function forgeEstate(): Promise<Estate> {
  const top = await mkdtemp(join(tmpdir(), "atticus-m3-exit-"));
  await cp(FORGE, top, { recursive: true });
  const root = join(top, "metarepo");
  await cp(join(FORGE_CHANGE, "org-pack"), join(root, "org-pack"), { recursive: true });
  await cp(join(SPECKIT, "org-pack"), join(root, "org-pack"), { recursive: true });
  await cp(join(OWN, "org-pack"), join(root, "org-pack"), { recursive: true });
  // The diagrams and documents a team drops into the metarepo's inputs/ folder.
  await cp(join(top, "inputs"), join(root, "inputs"), { recursive: true });

  const buildLog = join(top, "build.log");
  const fakeBuild = join(top, "fake-build.mjs");
  await writeFile(
    fakeBuild,
    [
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(buildLog)}, process.cwd() + "\\n");`,
      'console.log("fake build: compiled and tested");',
      "",
    ].join("\n"),
  );

  const manifestPath = join(root, "org-pack/profiles/forge/repos.manifest.yaml");
  const manifest = parse(await readFile(manifestPath, "utf8")) as {
    repos: { id: string; url: string; build?: string }[];
  };
  for (const id of (await readdir(join(top, "repos"))).sort()) {
    const work = join(top, "repos", id);
    sh(work, "init", "-q", "-b", "main");
    sh(work, "add", "-A");
    sh(work, "commit", "-q", "-m", "initial");
    const bare = join(top, "remotes", `${id}.git`);
    await mkdir(dirname(bare), { recursive: true });
    sh(dirname(bare), "clone", "-q", "--bare", work, bare);
    const entry = manifest.repos.find((r) => r.id === id);
    if (!entry) throw new Error(`${id} is not in the Forge manifest`);
    entry.url = bare;
    if (entry.build) entry.build = `node ${JSON.stringify(fakeBuild)}`;
  }
  await writeFile(manifestPath, stringify(manifest));

  // Replay recordings: the forge-change critic and story-writer answers, and this suite's own.
  const replayDir = join(top, "recordings");
  await cp(join(FORGE_CHANGE, "recordings"), replayDir, { recursive: true });
  await cp(join(OWN, "recordings"), replayDir, { recursive: true });

  await writeFile(join(root, ".gitignore"), "workspace/\n.runs/\n");
  await mkdir(join(root, ".github"), { recursive: true });
  await writeFile(join(root, ".github/CODEOWNERS"), "openspec/  @forge/platform\n");
  sh(root, "init", "-q", "-b", "main");
  sh(root, "add", "-A");
  sh(root, "commit", "-q", "-m", "Forge metarepo");
  return { top, root, replayDir, buildLog };
}

/**
 * Write fixtures/forge/expected/scan.yaml as the metarepo's catalog files: the hand-written
 * catalog the forge-change ground truth (expected/findings.yaml, expected/stories.yaml) is
 * defined on.
 */
export async function writeExpectedCatalog(root: string): Promise<void> {
  const rows = parse(await readFile(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[];
  for (const r of rows) {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
    if (!p.ok) throw new Error(`bad fixture record ${String(r.id)}`);
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
}

/** Copy a fixture folder over a change folder (writing artifacts as their author would). */
export async function writeArtifacts(root: string, from: string, files: string[]): Promise<void> {
  const dir = join(root, "openspec/changes", CHANGE);
  for (const f of files) {
    await mkdir(dirname(join(dir, f)), { recursive: true });
    await cp(join(from, f), join(dir, f), { recursive: true });
  }
}

export const changeDir = (root: string) => join(root, "openspec/changes", CHANGE);

export async function readYaml<T>(path: string): Promise<T> {
  return parse(await readFile(path, "utf8")) as T;
}

/** Every file under a folder, relative and with forward slashes, sorted. */
export async function walk(dir: string, skip: (rel: string) => boolean = () => false) {
  const out: string[] = [];
  async function go(d: string) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const rel = relative(dir, p).split(sep).join("/");
      if (skip(rel)) continue;
      if (e.isDirectory()) await go(p);
      else out.push(rel);
    }
  }
  await go(dir);
  return out.sort();
}

/**
 * A byte-level fingerprint of a repo's files: path → sha-256. `.git/` is left out because Git
 * itself rewrites its index when any tool reads status; the working tree is what a team sees.
 */
export async function fingerprint(dir: string, skip: (rel: string) => boolean = () => false) {
  const out: Record<string, string> = {};
  for (const f of await walk(dir, (rel) => rel === ".git" || skip(rel)))
    out[f] = createHash("sha256")
      .update(await readFile(join(dir, f)))
      .digest("hex");
  return out;
}

export async function removeTop(e: Estate): Promise<void> {
  await rm(e.top, { recursive: true, force: true });
}
