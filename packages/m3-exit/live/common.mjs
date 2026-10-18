// Shared by prepare.mjs, grade.mjs and the live-run test: where the built CLI is, how to run it,
// the names of a run's sandboxes, and the finding match rule of fixtures/forge-change/expected.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { CHANGE, FORGE_CHANGE, OWN, PACKAGE, REPO } from "./estate.mjs";

export { CHANGE };

/** The built command line: `pnpm turbo build --filter @maycombhq/cli...` makes it. */
export const BIN = join(REPO, "packages/cli/dist/bin.js");

export function assertBuilt() {
  if (!existsSync(BIN))
    throw new Error(
      `The atticus command line isn't built (${BIN} is missing). Run: pnpm turbo build --filter @maycombhq/cli...`,
    );
}

/**
 * The sandboxes of one run, one per exit (or pair of exits), each a complete Forge estate
 * (`<name>/metarepo`, `<name>/inputs`, `<name>/remotes`, ...):
 *   stories  exit a: the seeded change without stories, tasks or service-desk drafts
 *   critic   exit b: the seeded change, complete, at the plan gate
 *   task     exit c: the fixed design planned and in Build, task 1.2 handed down
 *   handup   exit d: as task, with task 1.2 built and merged, ready for spec hand-up
 *   names    exit e: as task without the hand-down, for the namers, glossary and templates
 */
export const SANDBOXES = {
  stories: "a-stories",
  critic: "b-critic",
  task: "c-task",
  handup: "d-handup",
  names: "e-names",
};

/** The metarepo of one sandbox of a run. */
export const metarepoOf = (runDir, key) => join(runDir, SANDBOXES[key], "metarepo");
export const changeDirOf = (root) => join(root, "openspec/changes", CHANGE);

/** A Git identity for commands that commit, so a fresh machine needs no Git configuration. */
export const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Live Run",
  GIT_AUTHOR_EMAIL: "live-run@example.com",
  GIT_COMMITTER_NAME: "Live Run",
  GIT_COMMITTER_EMAIL: "live-run@example.com",
};

const lines = (s) => (s === "" ? [] : s.replace(/\r?\n$/, "").split(/\r?\n/));

/**
 * Run `atticus <args>` in a folder through the built command line, as a separate process.
 * Never rejects on a non-zero exit: look at `code`.
 */
export function atticus(cwd, args, env = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, ...GIT_IDENTITY, ...env },
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        resolve({
          code,
          out: lines(stdout),
          err: lines(stderr),
          stdout,
          stderr,
          text: `${stdout}${stderr}`,
        });
      },
    );
  });
}

export async function readYaml(path) {
  return parse(await readFile(path, "utf8"));
}

export async function writeText(path, text) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

/**
 * The match rule of fixtures/forge-change/expected/findings.yaml, as the suite applies it
 * (critic-seeded.test.ts): rule, severity and kind agree, and the artifact, line or record agree
 * when the entry gives them. `e` is an expected entry, `f` a finding file.
 */
export function matches(e, f) {
  if (f.rule !== e.rule || f.severity !== e.severity || f.kind !== e.kind) return false;
  if (e.artifact && f.artifact !== e.artifact) return false;
  if (e.line && f.locator?.line !== e.line) return false;
  if (
    e.record &&
    f.locator?.record !== e.record &&
    !(f.evidence ?? []).some((v) => v.record === e.record)
  )
    return false;
  return true;
}

/** The `run-N` folders of an out folder, in order. */
export async function runFolders(outDir) {
  return (await readdir(outDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && /^run-\d+$/.test(d.name))
    .map((d) => d.name)
    .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
}

/**
 * Where the repository keeps hand-written replay recordings (`<agent>/<promptSha256>.json`).
 * Only prepare.mjs (to build task 1.2 in the hand-up sandbox) and the live-run test (a perfect
 * agent) read them; no sandbox holds one.
 */
export const RECORDING_DIRS = [
  join(FORGE_CHANGE, "recordings"),
  join(OWN, "recordings"),
  ...["features", "glossary", "planner", "testgen"].map((p) =>
    join(PACKAGE, "..", p, "test/fixtures/recordings"),
  ),
];

/** Every recording of an agent: [{ promptSha256, output }]. */
export async function recordingsOf(agent) {
  const out = [];
  for (const dir of RECORDING_DIRS) {
    const d = join(dir, agent);
    for (const f of (await readdir(d).catch(() => [])).filter((n) => n.endsWith(".json")).sort()) {
      const r = JSON.parse(await readFile(join(d, f), "utf8"));
      out.push({ promptSha256: r.promptSha256, output: r.output });
    }
  }
  return out;
}

/**
 * The recorded answer for an agent: the one for this prompt when there is one, else the agent's
 * only recording (a sandbox's prompt can differ from the suite's in details that don't change
 * what a good answer is). Throws when the agent has several recordings and none is this prompt's.
 */
export async function recordedAnswer(agent, promptSha256) {
  const all = await recordingsOf(agent);
  const exact = promptSha256 ? all.find((r) => r.promptSha256 === promptSha256) : undefined;
  if (exact) return exact.output;
  if (all.length === 1) return all[0].output;
  throw new Error(
    all.length === 0
      ? `no recording for agent ${agent}`
      : `${all.length} recordings for agent ${agent}, none for prompt ${promptSha256}`,
  );
}

/**
 * The files an answer of a task-runner run holds: `=== file: <path>` … `=== end file` blocks
 * (the format the task runner's prompt asks for), as [path, content] pairs.
 */
export function fileBlocks(output) {
  return [...output.matchAll(/^=== file: (.+)\n([\s\S]*?)^=== end file$/gm)].map((m) => [
    m[1].trim(),
    m[2],
  ]);
}
