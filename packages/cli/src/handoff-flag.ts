import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { HandoffRuntime, TOOL_LIMITS, type Run } from "@maycombhq/ai";
import { CONTEXT_TOOLS } from "@maycombhq/index";
import { changesRelOf, listQuestions, runsDirOf, runsRelOf, type Question } from "@maycombhq/core";
import { lensRunOf } from "@maycombhq/naysayer";
import type { Output, StepFact } from "./commands.js";

/**
 * `atticus <step> --handoff` (ADR 0086, plan 4.8): the step runs with the hand-off runtime, as
 * `--mode hand-off` would, and prints only what an assistant in Copilot Chat needs: the prompt
 * file, the result file and the two commands that finish the step. The hand-off itself is
 * HandoffRuntime's (prompt.md, run.json, `atticus handoff done`); nothing here prepares a run.
 * When the step hands nothing off (it finished, or failed before a prompt), its own output is
 * printed as it is.
 *
 * With --json (ADR 0090) it prints one JSON object instead, for a tool that runs the loop (the
 * VS Code extension): the hand-off (state "handoff", the run, both files, both commands as text
 * and as argv, and the lens when the run is one of the critic's AI lenses), or the step's end: "done" (exit 0), "question" (it raised or re-asked an open
 * question), "stopped" (exit 1) or "failed" (exit 2 or more, or it threw), with its messages.
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
  // ADR 0113: the fast path's one step.
  "change small",
  "change draft",
  "plan stories",
  // ADR 0101: what a change needs from the organisation.
  "change needs",
  "knowledge find",
  "knowledge ask",
]);

export const isHandoffStep = (group: string | undefined, command: string | undefined) =>
  STEPS.has(`${group ?? ""} ${command ?? ""}`) || isCritic(group, command);

/**
 * `atticus critic <change>` (ADR 0106 addendum): its AI lenses wait together, one run each, so
 * --handoff offers them one at a time, oldest first, and each resume offers the next.
 */
const isCritic = (group: string | undefined, command: string | undefined) =>
  group === "critic" && !!command && command !== "stats";

/**
 * The stages (ADR 0115): after a draft passes the rules, the critic's AI lenses wait together,
 * one run each, and the stage offers them as the critic does, one at a time, oldest first.
 */
const isStage = (group: string | undefined, command: string | undefined) =>
  (group === "change" &&
    (command === "feature" || command === "architecture" || command === "small")) ||
  (group === "plan" && command === "stories");

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

/** argv without --handoff, --json, --mode and --resume (with their values). */
function stepArgs(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--handoff" || a === "--json") continue;
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
  const json = argv.includes("--json");
  const before = await runStates(root);
  const asked = json ? await openQuestions(root) : new Map<string, string>();
  const out: string[] = [];
  const err: string[] = [];
  const facts: StepFact[] = [];
  let code: number;
  try {
    code = await dispatch([...args, ...resume, "--mode", "hand-off"], {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      report: (f) => facts.push(f),
    });
  } catch (e) {
    if (!json) throw e;
    err.push((e as Error).message.split("\n")[0]!);
    code = 3;
  }
  const after = await runStates(root);
  const byStart = (a: Run, b: Run) =>
    a.startedAt.localeCompare(b.startedAt) || a.runId.localeCompare(b.runId);
  const critic = isCritic(args[0], args[1]);
  const stage = isStage(args[0], args[1]);
  const queue = critic || stage;
  // A step of a change offers only that change's runs: two steps at once (two chats, a chat and
  // a terminal) hand off two runs, and the other change's must never be answered as this one's.
  const changeArg = critic ? args[1] : stage ? args[2] : undefined;
  const ofChange = (x: Run) =>
    !changeArg || changeArg.startsWith("-") || x.request.change === changeArg;
  const waiting = [...after]
    .filter(([path, s]) => s.run.state === "waiting" && before.get(path)?.key !== s.key)
    .map(([, s]) => s.run)
    .filter(ofChange)
    .sort(byStart);
  const resumed = resume.length ? resume.join("=").split("=").at(-1) : undefined;
  const resumedRun = [...after.values()].find((s) => s.run.runId === resumed)?.run;
  // The run the step says it handed off or waits on, as data (Output.report), never read from
  // its words: a stage names its draft or the lens it waits on.
  const named = facts
    .map((f) => ("handoff" in f ? f.handoff.runId : undefined))
    .filter((x): x is string => !!x)
    .at(-1);
  const namedRun = named ? [...after.values()].find((s) => s.run.runId === named)?.run : undefined;
  // Resumed before `handoff done`, or after an answer that failed its check (the step offers the
  // same run again, to be fixed): the same run, said to be still waiting.
  const still =
    resumedRun &&
    (resumedRun.state === "waiting" ||
      (resumedRun.state === "failed" && namedRun?.runId === resumedRun.runId))
      ? resumedRun
      : undefined;
  // The critic's next lens: a run of the same change, started with or after the one resumed
  // (for a stage, a lens run: the stage's next draft is a new run, found above).
  const next =
    queue && resumedRun && !still
      ? [...after.values()]
          .map((s) => s.run)
          .filter(
            (x) =>
              x.state === "waiting" &&
              x.runId !== resumedRun.runId &&
              x.request.change === resumedRun.request.change &&
              x.startedAt >= resumedRun.startedAt &&
              (critic || !!lensRunOf(x.request)),
          )
          .sort(byStart)[0]
      : undefined;
  // Run again while its hand-off waits (a runner that lost its place, a person who ran it twice):
  // the step names the run it is waiting on, and that run is offered again.
  const waitedOn =
    !resume.length && namedRun && before.get(`${namedRun.request.change}/${namedRun.runId}`)
      ? namedRun
      : undefined;
  const offered = namedRun && ["waiting", "failed"].includes(namedRun.state) ? namedRun : undefined;
  const run =
    offered ?? (queue ? waiting[0] : waiting.at(-1)) ?? still ?? next ?? waitedOn ?? undefined;
  const pagesLeft = facts
    .map((f) => ("pagesLeft" in f ? f.pagesLeft : undefined))
    .filter((x): x is number => x !== undefined)
    .at(-1);
  const stillOffered = !!run && (run === still || run === waitedOn);
  if (json)
    return printJson(
      root,
      argv,
      args,
      {
        run,
        still: stillOffered,
        code,
        out,
        err,
        asked,
        ...(pagesLeft !== undefined ? { pagesLeft } : {}),
      },
      io,
    );
  if (stillOffered) io.out(`Run ${run.runId} is still waiting for its result file.`);
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

/** Open questions by id, with what changes when a step asks one again. */
async function openQuestions(root: string): Promise<Map<string, string>> {
  const r = await listQuestions(root, { state: "open" });
  return new Map(
    r.questions.map((q) => [q.id, `${q.askedBy.at}:${q.alsoAskedBy?.length ?? 0}:${q.rerun}`]),
  );
}

/** The parts of a question a tool shows a person to answer it. */
const questionOut = (q: Question) => ({
  id: q.id,
  repo: q.repo,
  question: q.question,
  options: q.options,
  evidence: q.evidence,
  answer: `atticus questions answer ${q.id}`,
});

async function printJson(
  root: string,
  argv: string[],
  args: string[],
  s: {
    run: Run | undefined;
    still: boolean;
    code: number;
    out: string[];
    err: string[];
    asked: Map<string, string>;
    pagesLeft?: number;
  },
  io: Output,
): Promise<number> {
  const { run } = s;
  if (run) {
    const runsRel = runsRelOf(root);
    const doneArgs = ["handoff", "done", run.runId, ...rootArgv(argv)];
    const resumeArgs = [...args, "--handoff", "--json", "--resume", run.runId];
    const lens = lensRunOf(run.request);
    io.out(
      JSON.stringify(
        {
          state: "handoff",
          runId: run.runId,
          // ADR 0115: one of the critic's AI lenses, reviewing what the step wrote.
          ...(lens ? { lens } : {}),
          root,
          ...(s.still ? { stillWaiting: true } : {}),
          promptFile: HandoffRuntime.promptRel(run, runsRel),
          resultFile: HandoffRuntime.outputRel(run, changesRelOf(root), runsRel),
          doneCommand: `atticus ${doneArgs.map(shell).join(" ")}`,
          doneArgs,
          resumeCommand: `atticus ${resumeArgs.map(shell).join(" ")}`,
          resumeArgs,
          // ADR 0107 addendum: the read-only tools the model may call. A tool call runs as
          // atticus <callArgs> <tool> --input <json> --round <n> --json <runArgs>, kept in the run.
          tools: {
            definitions: CONTEXT_TOOLS,
            limits: TOOL_LIMITS,
            callArgs: ["context", "call"],
            runArgs: ["--run", run.runId, ...rootArgv(argv)],
          },
          messages: s.out,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  // A question is the step's when it is new, asked again, or named in what the step printed.
  const text = [...s.out, ...s.err].join("\n");
  const open = (await listQuestions(root, { state: "open" })).questions;
  const questions = open.filter((q) => {
    const was = s.asked.get(q.id);
    return (
      was === undefined ||
      was !== `${q.askedBy.at}:${q.alsoAskedBy?.length ?? 0}:${q.rerun}` ||
      text.includes(q.id)
    );
  });
  const state = questions.length
    ? "question"
    : s.code === 0
      ? "done"
      : s.code === 1
        ? "stopped"
        : "failed";
  io.out(
    JSON.stringify(
      {
        state,
        exitCode: s.code,
        root,
        messages: s.out,
        errors: s.err,
        questions: questions.map(questionOut),
        // A batched scan's pages left for the next batch, as data (never read from its words).
        ...(s.pagesLeft !== undefined ? { pagesLeft: s.pagesLeft } : {}),
      },
      null,
      2,
    ),
  );
  return s.code;
}

/** The --root argument as argv, when the step was given one. */
function rootArgv(argv: string[]): string[] {
  const i = argv.indexOf("--root");
  if (i >= 0 && argv[i + 1]) return ["--root", argv[i + 1]!];
  const eq = argv.find((a) => a.startsWith("--root="));
  return eq ? [eq] : [];
}

/** " --root <dir>" when the step was given one, so `handoff done` finds the same metarepo. */
function rootArg(argv: string[]): string {
  const i = argv.indexOf("--root");
  if (i >= 0 && argv[i + 1]) return ` --root ${shell(argv[i + 1]!)}`;
  const eq = argv.find((a) => a.startsWith("--root="));
  return eq ? ` ${shell(eq)}` : "";
}
