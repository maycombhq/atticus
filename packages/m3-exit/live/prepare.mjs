#!/usr/bin/env node
// Build sandboxes for the M3 AI-graded exits, for fresh agent sessions to work in.
//
//   node packages/m3-exit/live/prepare.mjs <outDir> --runs 5
//
// Each run (<outDir>/run-1 … run-N) holds five independent Forge estates built as the exit suite
// builds them (a-stories, b-critic, c-task, d-handup, e-names: see SANDBOXES in common.mjs), an
// `atticus` shim in bin/, env.sh and a TASK.md that tells a fresh agent what to do. Nothing in
// a run holds an expected file, a recording, or the repository's tests; grade.mjs reads those
// from the repository. Build the CLI first: pnpm turbo build --filter @maycombhq/cli...
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse, stringify } from "yaml";
import {
  assertBuilt,
  atticus,
  BIN,
  CHANGE,
  changeDirOf,
  fileBlocks,
  metarepoOf,
  recordedAnswer,
  SANDBOXES,
  writeText,
} from "./common.mjs";
import { forgeEstate, FORGE_CHANGE, OWN, sh } from "./estate.mjs";
import { taskMd } from "./task-md.mjs";

const REPOS = "forge-ledger,forge-portal-bff,forge-portal-ui";
const DESIGN_FIXES = ["interfaces.md", "data.md", "design.md", "ux.md"];
/** What the delivery lead fills in on the service-desk drafts (the suite does the same). */
const SNOW_VALUES = [
  ["| Target |  |", "| Target | https://api.northwind.example |"],
  ["| Destination host |  |", "| Destination host | api.northwind.example |"],
];

/** Fail with the command's own words when a set-up step doesn't do what it must. */
function must(r, what, codes = [0]) {
  if (!codes.includes(r.code)) throw new Error(`${what} failed (exit ${r.code}):\n${r.text}`);
  return r;
}

/** An estate with the workspace cloned and the catalog scanned. Returns the metarepo. */
async function scannedEstate(runDir, key) {
  const e = await forgeEstate({ top: join(runDir, SANDBOXES[key]), answers: false });
  must(await atticus(e.root, ["workspace", "sync"]), `${key}: workspace sync`);
  must(await atticus(e.root, ["scan"]), `${key}: scan`);
  return e.root;
}

/** The fixture change in the metarepo, optionally without its hand-written plan, optionally on the fixed design. */
async function putChange(root, { strip = false, fixedDesign = false } = {}) {
  const dir = changeDirOf(root);
  await cp(join(FORGE_CHANGE, "openspec/changes", CHANGE), dir, { recursive: true });
  if (strip)
    for (const f of ["stories.md", "tasks.md", "snow.md", "stories"])
      await rm(join(dir, f), { recursive: true, force: true });
  if (fixedDesign)
    for (const f of DESIGN_FIXES) await cp(join(OWN, "fixes/design", f), join(dir, f));
}

/** Exit a: the seeded change at the plan gate, without stories, tasks or service-desk drafts. */
async function stories(runDir) {
  const root = await scannedEstate(runDir, "stories");
  await putChange(root, { strip: true });
}

/** Exit b: the seeded change, complete, at the plan gate. */
async function critic(runDir) {
  const root = await scannedEstate(runDir, "critic");
  await putChange(root);
}

/**
 * Exits c, d and e: the change on the architect-fixed design, planned (stories and tasks written
 * from recorded story prose, service-desk drafts filled, work items and requests sent on the mock
 * systems), in Build, with the change's worktrees open. `handDown` hands task 1.2 to forge-ledger;
 * `built` also builds it (the recorded answer, applied as an assistant would) and merges the task
 * branch, so spec hand-up is next.
 */
async function buildReady(runDir, key, replayDir, { handDown, built }) {
  const root = await scannedEstate(runDir, key);
  await putChange(root, { strip: true, fixedDesign: true });
  const replay = { ATTICUS_REPLAY_DIR: replayDir };
  must(
    await atticus(root, ["plan", "stories", CHANGE, "--mode", "replay"], replay),
    "plan stories",
  );
  // Exit 1 only says there are values left to fill, which the next lines do.
  must(await atticus(root, ["plan", "snow", CHANGE]), "plan snow", [0, 1]);
  const snow = join(changeDirOf(root), "snow.md");
  let text = await readFile(snow, "utf8");
  for (const [from, to] of SNOW_VALUES) text = text.replace(from, to);
  await writeFile(snow, text);
  must(await atticus(root, ["ado", "sync", CHANGE, "--approve", "--by", "bao"]), "ado sync");
  must(await atticus(root, ["plan", "submit", CHANGE, "--approve", "--by", "dana"]), "plan submit");

  // The Plan hand-off was approved by the team lead: the change is in Build. (The suite gets
  // here through hand-off PRs on a mock Git host, which lives in one process; a sandbox is
  // used across processes, so the approved hand-off is written down as it would have been.)
  const file = join(changeDirOf(root), "change.yaml");
  const change = parse(await readFile(file, "utf8"));
  change.state = "build";
  change.handoffs.push({
    phase: "plan",
    state: "merged",
    approvals: [{ at: "2026-10-19T17:00:00Z", by: "tia", roles: ["team-lead"] }],
    artifacts: [],
    branch: `handoff/${CHANGE}/plan`,
    by: "bao",
    openedAt: "2026-10-19T16:00:00Z",
    pr: { number: 3, url: "https://git.example.com/forge/forge-metarepo/pull/3" },
    reviewers: ["tia"],
    updatedAt: "2026-10-19T17:00:00Z",
  });
  change.history.push({
    from: "plan",
    to: "build",
    at: "2026-10-19T17:00:00Z",
    by: "tia",
    pr: 3,
    reason: "Plan ready merged",
  });
  await writeFile(file, stringify(change));

  must(await atticus(root, ["workspace", "open", CHANGE, "--repos", REPOS]), "workspace open");
  if (handDown) must(await atticus(root, ["spec", "hand-down", CHANGE, "1.2"]), "spec hand-down");
  if (built) {
    const run = must(
      await atticus(
        root,
        ["task", "run", CHANGE, "1.2", "--by", "dev", "--level", "draft"].concat([
          "--mode",
          "hand-off",
        ]),
      ),
      "task run",
    );
    const runId = /atticus handoff done (run-[0-9a-z-]+)/.exec(run.text)?.[1];
    if (!runId) throw new Error(`task run named no hand-off run:\n${run.text}`);
    const answer = await recordedAnswer("task-runner");
    const worktree = join(root, "workspace/.worktrees", CHANGE, ".tasks/1.2/forge-ledger");
    for (const [path, content] of fileBlocks(answer))
      await writeText(join(worktree, path), content);
    await writeText(
      join(changeDirOf(root), "tasks/1.2/report.md"),
      "Added GET /accounts/{id}/limit to ledger-api with unit tests.\n",
    );
    must(await atticus(root, ["handoff", "done", runId]), "handoff done (task 1.2)");
    sh(
      join(root, "workspace/.worktrees", CHANGE, "forge-ledger"),
      ...["merge", "--no-ff", "-q", "-m", "Merge task 1.2", `task/${CHANGE}/1.2`],
    );
  }
}

/** The shim, env.sh and TASK.md of a run. */
async function writeRunFiles(runDir, n) {
  const bin = join(runDir, "bin");
  await mkdir(bin, { recursive: true });
  const node = process.execPath;
  await writeFile(
    join(bin, "atticus"),
    [
      "#!/bin/sh",
      "# The atticus command line for this run (the built CLI, by absolute path).",
      'export ATTICUS_RUNTIME="${ATTICUS_RUNTIME:-hand-off}"',
      'export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-Live Run}"',
      'export GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-live-run@example.com}"',
      'export GIT_COMMITTER_NAME="${GIT_COMMITTER_NAME:-Live Run}"',
      'export GIT_COMMITTER_EMAIL="${GIT_COMMITTER_EMAIL:-live-run@example.com}"',
      `exec "${node}" "${BIN}" "$@"`,
      "",
    ].join("\n"),
  );
  await chmod(join(bin, "atticus"), 0o755);
  await writeFile(
    join(bin, "atticus.cmd"),
    [
      "@echo off",
      "if not defined ATTICUS_RUNTIME set ATTICUS_RUNTIME=hand-off",
      `"${node}" "${BIN}" %*`,
      "",
    ].join("\r\n"),
  );
  await writeFile(
    join(runDir, "env.sh"),
    [
      "# source this file: puts atticus on the PATH and makes hand-off the AI mode",
      `export PATH="${bin}:$PATH"`,
      "export ATTICUS_RUNTIME=hand-off",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(runDir, "TASK.md"),
    taskMd(runDir, n, (key) => metarepoOf(runDir, key)),
  );
}

/**
 * Nothing a grader holds may be in a sandbox: no expected or recorded answer, no grading file,
 * no test of the repository. Throws with the first few offenders.
 */
export async function leaks(dir) {
  const seeded = (await readFile(join(FORGE_CHANGE, "expected/findings.yaml"), "utf8"))
    .split("\n")
    .map((l) => /^\s*- id: (\S+)/.exec(l)?.[1])
    .filter(Boolean);
  const found = [];
  async function walk(d, rel) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const path = join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === ".git") continue;
      if (e.isDirectory()) {
        if (e.name === "expected" || e.name === "recordings") found.push(r);
        else await walk(path, r);
        continue;
      }
      if (
        /^(findings|stories)\.yaml$/.test(e.name) ||
        /\.test\.(ts|mjs)$/.test(e.name) ||
        /^[0-9a-f]{64}\.json$/.test(e.name)
      ) {
        found.push(r);
        continue;
      }
      if ((await stat(path)).size > 2_000_000) continue;
      const text = await readFile(path, "utf8").catch(() => "");
      const hit = seeded.find((id) => text.includes(id));
      if (hit) found.push(`${r} (mentions the seeded id ${hit})`);
    }
  }
  await walk(dir, "");
  return found;
}

/** Recordings the set-up replays for the parts of the plan that are not under test. */
async function replayFolder() {
  const dir = await mkdtemp(join(tmpdir(), "atticus-live-replay-"));
  await cp(join(FORGE_CHANGE, "recordings"), dir, { recursive: true });
  await cp(join(OWN, "recordings"), dir, { recursive: true });
  return dir;
}

/**
 * Build `runs` sandboxes in `outDir`. Returns the run folders. Refuses to write into a run
 * folder that already exists.
 */
export async function prepare(outDir, { runs = 5, log = () => {} } = {}) {
  assertBuilt();
  if (!Number.isInteger(runs) || runs < 1)
    throw new Error("--runs must be a whole number of at least 1");
  const out = resolve(outDir);
  const replayDir = await replayFolder();
  const made = [];
  try {
    for (let n = 1; n <= runs; n++) {
      const runDir = join(out, `run-${n}`);
      if (
        await stat(runDir).then(
          () => true,
          () => false,
        )
      )
        throw new Error(`${runDir} already exists; choose another folder or remove it`);
      const t0 = Date.now();
      await mkdir(runDir, { recursive: true });
      await Promise.all([
        stories(runDir),
        critic(runDir),
        buildReady(runDir, "task", replayDir, { handDown: true, built: false }),
        buildReady(runDir, "handup", replayDir, { handDown: true, built: true }),
        buildReady(runDir, "names", replayDir, { handDown: false, built: false }),
      ]);
      await writeRunFiles(runDir, n);
      const bad = await leaks(runDir);
      if (bad.length)
        throw new Error(`run-${n} holds files a grader owns: ${bad.slice(0, 5).join(", ")}`);
      made.push(runDir);
      log(`run-${n}: ready in ${((Date.now() - t0) / 1000).toFixed(1)} s (${runDir})`);
    }
  } finally {
    await rm(replayDir, { recursive: true, force: true });
  }
  return made;
}

function usage() {
  return "Usage: node packages/m3-exit/live/prepare.mjs <outDir> [--runs 5]";
}

async function cli(argv) {
  const args = [...argv];
  let runs = 5;
  const i = args.indexOf("--runs");
  if (i >= 0) {
    runs = Number(args[i + 1]);
    args.splice(i, 2);
  }
  if (args.length !== 1 || args[0].startsWith("-")) {
    console.error(usage());
    return 2;
  }
  try {
    const made = await prepare(args[0], { runs, log: (l) => console.log(l) });
    console.log(
      `Prepared ${made.length} run${made.length === 1 ? "" : "s"} in ${resolve(args[0])}. Give each fresh agent session one run folder's TASK.md. Then: node packages/m3-exit/live/grade.mjs ${resolve(args[0])}`,
    );
    return 0;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await cli(process.argv.slice(2));
