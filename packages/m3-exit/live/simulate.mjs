#!/usr/bin/env node
// A perfect agent, for dry runs: does exercises A to E of a run's TASK.md by answering every
// hand-off prompt with the hand-written recording the repository keeps for that agent (the
// replay recordings the exit suite uses). It goes through the run's own `bin/atticus` shim,
// reads only what a real agent reads (the prompt files), writes only where the prompt says, and
// finishes every run with `atticus handoff done <run>` (or `--resume`), the paths a person uses.
//
//   node packages/m3-exit/live/simulate.mjs <outDir>      every run-N in the folder
//
// Use it to check prepare.mjs and grade.mjs before spending a live agent's time: the grade of a
// simulated run should pass a to d and collect e. live.test.ts does exactly that.
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CHANGE,
  changeDirOf,
  fileBlocks,
  metarepoOf,
  recordedAnswer,
  recordingsOf,
  runFolders,
  writeText,
} from "./common.mjs";

const WIN = process.platform === "win32";

/** Run the run's shim in a metarepo folder. */
function shim(runDir, cwd, args) {
  const file = join(runDir, "bin", WIN ? "atticus.cmd" : "atticus");
  return new Promise((resolveRun) => {
    execFile(
      file,
      args,
      { cwd, encoding: "utf8", shell: WIN, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) =>
        resolveRun({
          code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          text: `${stdout}${stderr}`,
        }),
    );
  });
}

/** Answers for prompts nothing was recorded for: a lens that finds nothing wrong. */
const NOTHING_WRONG = "findings: []\n";

const runIdOf = (text) => /(run-[0-9a-z]+-[0-9a-z]+)/.exec(text)?.[1];

/** The run folders under .runs/ whose prompt's first line matches. */
async function promptsMatching(root, pattern) {
  const found = [];
  const runs = join(root, ".runs");
  for (const change of await readdir(runs).catch(() => []))
    for (const id of await readdir(join(runs, change)).catch(() => [])) {
      const prompt = await readFile(join(runs, change, id, "prompt.md"), "utf8").catch(() => "");
      if (pattern.test(prompt.split("\n")[0] ?? "")) found.push({ change, id });
    }
  return found.sort((a, b) => a.id.localeCompare(b.id));
}

/** Read a hand-off prompt's run, write the recorded answer where the prompt says, say done. */
async function answer(runDir, root, run, { expectDone = [0] } = {}) {
  const dir = join(root, ".runs", run.change, run.id);
  const info = JSON.parse(await readFile(join(dir, "run.json"), "utf8"));
  const { agent, outputPath, pack, outputIn } = info.request;
  const sha = pack.manifest.promptSha256;
  // A lens answers from its recording only when the prompt is the recorded one; otherwise the
  // perfect agent finds nothing wrong. Every other agent falls back to its only recording.
  const text = /findings-|review-(complete|code-and-test)\.yaml/.test(outputPath)
    ? ((await recordingsOf(agent.id)).find((r) => r.promptSha256 === sha)?.output ?? NOTHING_WRONG)
    : await recordedAnswer(agent.id, sha);
  // The prompt names the file: in the run's own folder for a lens and the story writer, in the
  // change folder for the rest.
  await writeText(
    outputIn === "run"
      ? join(dir, outputPath)
      : join(root, "openspec/changes", info.request.change, outputPath),
    text,
  );
  const done = await shim(runDir, root, ["handoff", "done", run.id]);
  if (!expectDone.includes(done.code))
    throw new Error(`handoff done ${run.id} (${agent.id}) exited ${done.code}:\n${done.text}`);
  return done;
}

function step(r, what, codes = [0]) {
  if (!codes.includes(r.code)) throw new Error(`${what} exited ${r.code}:\n${r.text}`);
  return r;
}

/** Answer every AI lens the critic handed over; `handoff done` reads each into its round. */
async function lenses(runDir, root) {
  const prompts = await promptsMatching(root, /^# [a-z-]+-critic: write findings-/);
  for (const p of prompts) await answer(runDir, root, p);
  return prompts.length;
}

/** Exercise A: story writer. */
async function exerciseA(runDir) {
  const root = metarepoOf(runDir, "stories");
  const run = (...a) => shim(runDir, root, a);
  const first = step(
    await run("plan", "stories", CHANGE, "--mode", "hand-off"),
    "plan stories",
    [1],
  );
  const id = runIdOf(first.text);
  await answer(runDir, root, { change: CHANGE, id });
  step(await run("plan", "stories", CHANGE, "--resume", id), "plan stories --resume");
  step(await run("plan", "snow", CHANGE), "plan snow", [0, 1]);
  step(await run("critic", CHANGE, "--gate", "plan", "--mode", "hand-off"), "critic", [1]);
  await lenses(runDir, root);
  step(await run("plan", "bar", CHANGE), "plan bar", [0, 1]);
}

/** Exercise B: the critic's AI lenses. */
async function exerciseB(runDir) {
  const root = metarepoOf(runDir, "critic");
  step(
    await shim(runDir, root, ["critic", CHANGE, "--gate", "plan", "--mode", "hand-off"]),
    "critic",
    [1],
  );
  const n = await lenses(runDir, root);
  if (n === 0) throw new Error("the critic prepared no lens prompt");
}

/** Exercise C: the task runner. */
async function exerciseC(runDir) {
  const root = metarepoOf(runDir, "task");
  const run = (...a) => shim(runDir, root, a);
  const started = step(
    await run(
      "task",
      "run",
      CHANGE,
      "1.2",
      "--by",
      "dev",
      "--level",
      "draft",
      "--mode",
      "hand-off",
    ),
    "task run",
  );
  const id = runIdOf(started.text.split("\n").find((l) => l.includes("handoff done")) ?? "");
  const info = JSON.parse(await readFile(join(root, ".runs", CHANGE, id, "run.json"), "utf8"));
  const worktree = /^Make the changes in (\S+)/.exec(
    (await readFile(join(root, ".runs", CHANGE, id, "prompt.md"), "utf8")).split("\n")[2] ?? "",
  )?.[1];
  if (!worktree) throw new Error("the task prompt names no worktree");
  const output = await recordedAnswer(
    info.request.agent.id,
    info.request.pack.manifest.promptSha256,
  );
  for (const [path, content] of fileBlocks(output))
    await writeText(join(root, worktree, path), content);
  await writeText(
    join(changeDirOf(root), "tasks/1.2/report.md"),
    "Added GET /accounts/{id}/limit with tests.\n",
  );
  step(await run("handoff", "done", id), "handoff done (task 1.2)");
  step(await run("drift", CHANGE), "drift");
  step(await run("trace", CHANGE), "trace", [0, 1]);
}

/** Exercise D: the complete lens at hand-up. */
async function exerciseD(runDir) {
  const root = metarepoOf(runDir, "handup");
  const up = step(
    await shim(runDir, root, [
      ...["spec", "hand-up", CHANGE, "1.2", "--by", "dev", "--pr", "7"],
      ...["--pr-url", "https://git.example.com/forge/forge-ledger/pull/7"],
    ]),
    "spec hand-up",
  );
  await answer(runDir, root, {
    change: CHANGE,
    id: runIdOf(up.text.split("\n").find((l) => l.includes("handoff done")) ?? ""),
  });
}

/** Exercise E: names, definitions and drafts. */
async function exerciseE(runDir) {
  const root = metarepoOf(runDir, "names");
  const run = (...a) => shim(runDir, root, a);
  const names = step(
    await run("feature", "suggest-names", "--mode", "hand-off"),
    "feature suggest-names",
  );
  await answer(runDir, root, { change: "features", id: runIdOf(names.text) });
  const tests = step(
    await run("tests", "generate", CHANGE, "s2-remaining-limit", "--mode", "hand-off"),
    "tests generate",
  );
  const testRun = runIdOf(
    tests.text.split("\n").find((l) => l.includes("test writer is with")) ?? "",
  );
  await answer(runDir, root, { change: CHANGE, id: testRun });
  step(
    await run("tests", "generate", CHANGE, "s2-remaining-limit", "--resume", testRun),
    "tests generate --resume",
  );
  const glossary = step(await run("glossary", "scan", "--mode", "hand-off"), "glossary scan");
  await answer(runDir, root, { change: "glossary", id: runIdOf(glossary.text) });
  const templates = step(await run("templates", "draft", "--mode", "hand-off"), "templates draft");
  await answer(runDir, root, {
    change: "org-pack",
    id: runIdOf(templates.text.split("\n").find((l) => l.includes("handoff done")) ?? ""),
  });
}

/** Do all five exercises of one run. */
export async function simulate(runDir) {
  await Promise.all([
    exerciseA(runDir),
    exerciseB(runDir),
    exerciseC(runDir),
    exerciseD(runDir),
    exerciseE(runDir),
  ]);
}

async function cli(argv) {
  if (argv.length !== 1) {
    console.error("Usage: node packages/m3-exit/live/simulate.mjs <outDir>");
    return 2;
  }
  const out = resolve(argv[0]);
  try {
    for (const run of await runFolders(out)) {
      await simulate(join(out, run));
      console.log(`${run}: answered every hand-off from the recordings`);
    }
    return 0;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await cli(process.argv.slice(2));
