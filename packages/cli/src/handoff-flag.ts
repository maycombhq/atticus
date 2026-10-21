import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { HandoffRuntime, type Run } from "@maycombhq/ai";
import { changesRelOf, runsDirOf, runsRelOf } from "@maycombhq/core";
import type { Output } from "./commands.js";

/**
 * `atticus <step> --handoff` (ADR 0086, plan 4.8): the step runs with the hand-off runtime, as
 * `--mode hand-off` would, and prints only what an assistant in Copilot Chat needs: the prompt
 * file, the result file and the two commands that finish the step. The hand-off itself is
 * HandoffRuntime's (prompt.md, run.json, `atticus handoff done`); nothing here prepares a run.
 * When the step hands nothing off (it finished, or failed before a prompt), its own output is
 * printed as it is.
 */

/** The AI steps that take --handoff. */
const STEPS = new Set([
  "scan survey",
  "scan verify",
  "spec draft",
  "knowledge scan",
  // ADR 0087: the feature and architecture stages (plan stories already takes it).
  "change feature",
  "change architecture",
  "change draft",
  "plan stories",
]);

export const isHandoffStep = (group: string | undefined, command: string | undefined) =>
  STEPS.has(`${group ?? ""} ${command ?? ""}`);

type Dispatch = (argv: string[], io: Output) => Promise<number>;

/** Every run.json under the runs folder: path → its state and attempt, to see what changed. */
async function runStates(root: string): Promise<Map<string, { key: string; run: Run }>> {
  const out = new Map<string, { key: string; run: Run }>();
  const dir = runsDirOf(root);
  for (const change of await readdir(dir).catch(() => [] as string[]))
    for (const id of await readdir(join(dir, change)).catch(() => [] as string[])) {
      const text = await readFile(join(dir, change, id, "run.json"), "utf8").catch(() => "");
      if (!text) continue;
      try {
        const run = JSON.parse(text) as Run;
        out.set(`${change}/${id}`, { key: `${run.state}:${run.attempt}`, run });
      } catch {
        // a run file being written; it isn't this step's
      }
    }
  return out;
}

/** argv without --handoff, --mode and --resume (with their values). */
function stepArgs(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--handoff") continue;
    if (a === "--mode" || a === "--resume") {
      i++;
      continue;
    }
    if (a.startsWith("--mode=") || a.startsWith("--resume=") || a.startsWith("--handoff="))
      continue;
    out.push(a);
  }
  return out;
}

/** An argument as a person types it: bare when it is plain, else in double quotes. */
const shell = (a: string) =>
  /^[\w./:@=+-]+$/.test(a) ? a : a.includes('"') ? JSON.stringify(a) : `"${a}"`;

export async function handoffStep(
  root: string,
  argv: string[],
  io: Output,
  dispatch: Dispatch,
): Promise<number> {
  const args = stepArgs(argv);
  const resumeAt = argv.findIndex((a) => a === "--resume" || a.startsWith("--resume="));
  const resume =
    resumeAt < 0
      ? []
      : argv[resumeAt]!.includes("=")
        ? [argv[resumeAt]!]
        : argv.slice(resumeAt, resumeAt + 2);
  const before = await runStates(root);
  const out: string[] = [];
  const err: string[] = [];
  const code = await dispatch([...args, ...resume, "--mode", "hand-off"], {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  const after = await runStates(root);
  const waiting = [...after]
    .filter(([path, s]) => s.run.state === "waiting" && before.get(path)?.key !== s.key)
    .map(([, s]) => s.run)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.runId.localeCompare(b.runId));
  // Resumed before `handoff done`: the same run is still waiting, so say how to finish it again.
  const resumed = resume.length ? resume.join("=").split("=").at(-1) : undefined;
  const still = [...after.values()].find(
    (s) => s.run.runId === resumed && s.run.state === "waiting",
  )?.run;
  const run = waiting.at(-1) ?? still;
  if (run && run === still) io.out(`Run ${run.runId} is still waiting for its result file.`);
  if (!run) {
    for (const l of out) io.out(l);
    for (const l of err) io.err(l);
    return code;
  }
  const runsRel = runsRelOf(root);
  io.out(`Prompt: ${HandoffRuntime.promptRel(run, runsRel)}`);
  io.out(`Result file: ${HandoffRuntime.outputRel(run, changesRelOf(root), runsRel)}`);
  io.out("When the result file is written, run:");
  io.out(`  atticus handoff done ${run.runId}${rootArg(argv)}`);
  io.out(`  atticus ${[...args, "--handoff", "--resume", run.runId].map(shell).join(" ")}`);
  return 0;
}

/** " --root <dir>" when the step was given one, so `handoff done` finds the same metarepo. */
function rootArg(argv: string[]): string {
  const i = argv.indexOf("--root");
  if (i >= 0 && argv[i + 1]) return ` --root ${shell(argv[i + 1]!)}`;
  const eq = argv.find((a) => a.startsWith("--root="));
  return eq ? ` ${shell(eq)}` : "";
}
