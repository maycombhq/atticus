import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { parse } from "yaml";
import { main } from "@maycombhq/cli/dist/main.js";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import {
  CHANGE,
  FIXTURES,
  FORGE,
  FORGE_CHANGE,
  forgeEstate as buildForgeEstate,
  OWN,
  SPECKIT,
  sh,
} from "../live/estate.mjs";

/**
 * Shared set-up for the M3 exit suite. Everything runs in a temp folder built from the
 * hand-written fixtures; nothing touches the network (remotes are local bare repositories,
 * outside systems are mocks or manual steps, AI is recorded replay).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
export { CHANGE, FIXTURES, FORGE, FORGE_CHANGE, OWN, SPECKIT, sh };
export const ADOPT_FIXTURES = join(HERE, "../../adopt/test/fixtures");
export const METAREPO = "forge/forge-metarepo";
export const T = 300_000;

// The CLI runs in this process and commits on task branches as the developer would; give it the
// identity a developer's machine has (CI runners have no git user configured).
const IDENTITY = {
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
  GIT_TERMINAL_PROMPT: "0",
} as const;
for (const [k, v] of Object.entries(IDENTITY)) process.env[k] ??= v;

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
  // Shared with the live-run sandboxes (live/estate.mjs); the suite keeps every expected file
  // and replay recording, the sandboxes leave them out.
  const e = await buildForgeEstate();
  return { top: e.top, root: e.root, replayDir: e.replayDir!, buildLog: e.buildLog };
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
