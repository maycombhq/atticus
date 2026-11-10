import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runsDirOf, writeFileIfUnchanged } from "@maycombhq/core";
import { withFileLock } from "./file-lock.js";
import { isHandoffStep } from "./handoff-steps.js";
import { listRuns } from "./runs-view.js";
import { forgetUserState, readUserState, writeUserState } from "./user-state.js";

/** One atticus command run in-process: its code and lines. */
export type StepRunner = (
  args: string[],
) => Promise<{ code: number; out: string[]; err: string[] }>;

/**
 * Fourth UX walk: a step prepared for the person's assistant is finished in two moves, Done
 * (the answer checked) and the step again with --resume (it writes what the answer said, or
 * offers its next prompt). The app keeps the step's resume beside its run, so Done does both.
 */
export interface Prepared {
  runId?: string;
  lines: string[];
  stillWaiting?: boolean;
}

/** What a stage's command is called in the app, and the page it is prepared on. */
const STAGE_PAGES: [RegExp, string][] = [
  [
    /^atticus change feature \S+(?: --\S+(?: \S+)?)*$/,
    "prepare the feature stage again on Feature design",
  ],
  [
    /^atticus change architecture \S+(?: --\S+(?: \S+)?)*$/,
    "prepare the architecture stage again on Architecture",
  ],
  [/^atticus plan stories \S+(?: --\S+(?: \S+)?)*$/, "prepare the stories stage again on Stories"],
  [/^atticus change small \S+(?: --\S+(?: \S+)?)*$/, "prepare its one step again on At a glance"],
];
const againWords = (command: string) =>
  STAGE_PAGES.find(([re]) => re.test(command))?.[1] ??
  "prepare it again on the page you prepared it from";

/**
 * Sixth UX walk: what a step the app ran says to do next, in the app's words. The command line
 * prints the commands to type (hand-off done, the step again with --resume, the hand-off PR);
 * in the app those are Done, Prepare and the change page's hand-off, so the lines say so.
 * `next`: the app has prepared the step's next prompt (Done's resume), not this step's first.
 */
export function appLines(lines: string[], o: { next?: boolean } = {}): string[] {
  // ADR 0189: the prompt is in the stage's thread, and the app checks the answer when it arrives.
  const ready = o.next
    ? "The next prompt is ready in the stage's thread."
    : "The prompt is ready in the stage's thread: paste it into your assistant. The app checks the answer once your assistant has written the file.";
  return lines.map((l) =>
    l
      .replace(/\s*When it is done(?:, run)?: atticus handoff done \S+.*$/, ` ${ready}`)
      // ADR 0189 (app-only audit): a step's own resume is the app's to run; the line says the
      // next prompt is in the stage's thread, never a command with --resume to type.
      .replace(
        /\s*(?:Next:\s*|[Rr]un:?\s*)?atticus [^\n]*?--resume run-[0-9a-z-]+(?::[^\n]*|\.)?$/,
        " The next prompt is ready in the stage's thread.",
      )
      // Ninth UX walk: an answer that failed its checks is fixed, then Done is pressed again.
      .replace(/,? (?:and|then) run atticus handoff done \S+ again/g, ", then press Done again")
      .replace(/\b([Rr])un atticus handoff done \S+ again/g, (_m, r: string) =>
        r === "R" ? "Press Done again" : "press Done again",
      )
      // Ninth UX walk: the app's Bring in what merged does the pull (the command line keeps it).
      .replace(
        /: pull \S+, then run atticus change learn\.$/,
        ": Bring in what merged on Home; the comparison with what Atticus drafted is kept the next time the drafts are measured.",
      )
      .replace(
        /^Answer each with atticus questions answer <id> .*, or with \/atticus-answer\.$/,
        "Answer each on Questions.",
      )
      .replace(
        /\b([Tt])hen run (atticus [^:]+?) again\b/,
        (_m, t: string, cmd: string) => `${t}hen ${againWords(cmd)}`,
      )
      .replace(
        /^Open the stage's pull request for a person to approve: .*$/,
        "Raise the stage's hand-off on the change page for a person to approve.",
      )
      // Review of beta.23 (ADR 0188): the local steps' refusals name the app's buttons. A repo
      // with no base clone is offered Sync the repos beside these words (sync-next.ts).
      .replace(
        /^No checkout of (\S+): clone it \(atticus workspace sync\) or give its folder with --dir\.$/,
        "No checkout of $1 on this machine: Sync the repos to clone it, then try again.",
      )
      .replace(
        /^(No repo has facts yet \([^)]*\))\. Read one first: \/atticus-map <repo> in your assistant\.$/,
        "$1. Read one first on Map › Trust.",
      )
      .replace(
        /^(No facts for (\S+) at \S+)\. Run \/atticus-map \S+ in your assistant first \(or atticus map \S+ to read it in batches\); it writes that file\.$/,
        "$1. Read $2 first on Map › Trust; the read writes that file.",
      )
      .replace(
        /^(There are no repo specs in \S+ yet)\. Draft them first: atticus spec draft <repo>\.$/,
        "$1: read a repo on Map › Trust and apply it, which writes its spec.",
      )
      .trimStart(),
  );
}

/**
 * Review round 50 (ADR 0186 addendum): a step's resume is kept where the assistant can't write
 * it, the person's own state folder (user-state.ts), never beside the run in `.runs/`: Done runs
 * it as the person, so a command written there (a hand-off's `--approve`, `digest --send`) would
 * have been the assistant's, run with the person's click. It is made by Atticus from the words
 * the step was started with, and checked again before it runs.
 */
const resumeFile = (runId: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) throw new Error(`${runId} isn't a run id.`);
  return `resume/${runId}.json`;
};

/** ADR 0189: whether Atticus kept a step's resume for this run (Done, or the app's check, runs it). */
export async function hasKeptResume(root: string, runId: string): Promise<boolean> {
  return !!(await readUserState(root, resumeFile(runId)).catch(() => undefined));
}

/**
 * Review of beta.23: the run a command resumes (`--resume <run>` or `--resume=<run>`), or
 * undefined. Once it ran, the resume the app kept for that run is done with.
 */
export function resumedRunOf(argv: readonly string[]): string | undefined {
  const isRun = (v: string | undefined) => !!v && /^run-[0-9A-Za-z._-]+$/.test(v);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--resume" && isRun(argv[i + 1])) return argv[i + 1];
    if (a.startsWith("--resume=") && isRun(a.slice("--resume=".length)))
      return a.slice("--resume=".length);
  }
  return undefined;
}

/**
 * Forget the resume the app kept for a run the command line resumed itself (review of beta.23),
 * so neither the app's own check nor the next server start resumes it a second time.
 */
export async function forgetKeptResume(root: string, runId: string): Promise<void> {
  await forgetUserState(root, resumeFile(runId)).catch(() => undefined);
}

/** The steps that read the wikis take `--source <wiki>` from the app (round 36). */
export const SOURCE_STEPS = new Set(["knowledge scan", "knowledge find"]);

/** ADR 0188: the one step the app starts with `--force`: the stories drafted again. */
export const FORCE_STEPS = new Set(["plan stories"]);

/**
 * Why these words aren't a step's own resume, or undefined when they are: an AI step that takes
 * --handoff, its arguments, and no option but --handoff, `--resume <this run>` and (on a step
 * that reads the wikis) `--source <wiki>`, each once, and `--force` on plan stories (ADR 0188).
 * Never --approve, --send, --level or --mode.
 */
export function resumeRefusal(args: unknown, runId: string): string | undefined {
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string" && a !== ""))
    return "it isn't a step's words";
  const words = args as string[];
  if (!isHandoffStep(words[0], words[1]))
    return `atticus ${words.slice(0, 2).join(" ")} isn't an AI step the app prepares`;
  let resumed = false;
  let source = false;
  for (let i = 2; i < words.length; i++) {
    const a = words[i]!;
    if (!a.startsWith("-")) continue;
    if (a === "--handoff") continue;
    if (a === "--resume" && !resumed && words[i + 1] === runId) {
      resumed = true;
      i++;
      continue;
    }
    // ADR 0188: Draft the stories again (`plan stories <change> --force`), on that step only.
    if (a === "--force" && FORCE_STEPS.has(`${words[0]} ${words[1]}`)) continue;
    const value = words[i + 1];
    if (
      a === "--source" &&
      !source &&
      SOURCE_STEPS.has(`${words[0]} ${words[1]}`) &&
      value &&
      !value.startsWith("-")
    ) {
      source = true;
      i++;
      continue;
    }
    return `it names ${a}${a === "--resume" ? " for another run" : ""}, which a step's resume never does`;
  }
  return resumed ? undefined : `it doesn't resume ${runId}`;
}

/** The step's words without what prepareStep adds (--handoff, --json) and its --resume. */
function ownWords(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--handoff" || a === "--json") continue;
    if (a === "--resume") {
      i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** Keep a step's resume for Done, in the person's own state (tests call it too). */
export async function keepResume(
  root: string,
  change: string,
  runId: string,
  args: string[],
): Promise<void> {
  await writeUserState(root, resumeFile(runId), { change, runId, args });
}

/** Ends an open run as cancelled, superseded by `by`; false when it moved on meanwhile. */
async function supersede(root: string, change: string, runId: string, by: string) {
  const file = join(runsDirOf(root), change, runId, "run.json");
  const was = await readFile(file, "utf8").catch(() => undefined);
  if (was === undefined) return false;
  let rec: { state?: string; finishedAt?: string; errors?: string[] };
  try {
    rec = JSON.parse(was) as typeof rec;
  } catch {
    return false;
  }
  if (rec.state !== "waiting" && rec.state !== "prepared") return false;
  rec.state = "cancelled";
  rec.finishedAt = new Date().toISOString();
  rec.errors = [
    `Superseded by run ${by}: the step was prepared again, so this run's answer is no longer read.`,
  ];
  await writeFileIfUnchanged(file, was, JSON.stringify(rec, null, 2) + "\n").catch(() => undefined);
  await forgetUserState(root, resumeFile(runId)).catch(() => undefined);
  return true;
}

/** Runs the step as a hand-off (`--json`), and keeps its resume (outside the metarepo). */
export async function prepareStep(
  root: string,
  runStep: StepRunner,
  args: string[],
  o: { next?: boolean } = {},
): Promise<{ code: number; prepared: Prepared }> {
  const res = await runStep([...args, "--handoff", "--json"]);
  const lines = [...res.out, ...res.err];
  const json = [...res.out].reverse().find((l) => l.trim().startsWith("{"));
  let h: {
    state?: string;
    runId?: string;
    resumeArgs?: string[];
    stillWaiting?: boolean;
    messages?: string[];
    errors?: string[];
    questions?: { id: string; question: string; answer?: string }[];
    pagesLeft?: number;
  } = {};
  try {
    h = json ? JSON.parse(json) : {};
  } catch {
    h = {};
  }
  // Round 39: what the step said is inside its JSON (messages, errors, questions, pages left):
  // all of it reaches the person, never an empty "prepared no run".
  // Sixth UX walk: in the app's words, not the terminal's.
  const said = appLines(
    [
      ...lines.filter((l) => !l.trim().startsWith("{")),
      ...(h.messages ?? []),
      ...(h.errors ?? []),
      ...(h.questions ?? []).map((q) => `Question ${q.id}: ${q.question} (answer it on Questions)`),
      ...(h.pagesLeft
        ? [`${h.pagesLeft} pages are left for the next part: Prepare it again.`]
        : []),
    ],
    o,
  );
  if (h.state !== "handoff" || !h.runId) return { code: res.code, prepared: { lines: said } };
  const runs = await listRuns(root, { limit: 100000 });
  const run = runs.find((x) => x.runId === h.runId);
  // Round 50: from the words this step was started with (the app checked them), not from
  // anything in the run's folder; a step that offers no resume keeps none.
  if (run && h.resumeArgs) {
    const resume = [...ownWords(args), "--resume", run.runId];
    if (!resumeRefusal(resume, run.runId))
      await keepResume(root, run.change, run.runId, resume).catch(() => undefined);
  }
  // App-only audit: the step prepared again made a new run while an older one of the same step
  // still waited, for ever. The older open runs Atticus kept this step's resume for are
  // cancelled (RunState's own state, as superseded decide runs are), saying by which run.
  if (run && !h.stillWaiting) {
    const mine = JSON.stringify(ownWords(args));
    for (const x of runs) {
      if (x.runId === run.runId || x.change !== run.change) continue;
      if (x.state !== "waiting" && x.state !== "prepared") continue;
      const kept = await readUserState<{ args?: unknown }>(root, resumeFile(x.runId)).catch(
        () => undefined,
      );
      if (!Array.isArray(kept?.args) || JSON.stringify(ownWords(kept.args as string[])) !== mine)
        continue;
      if (await supersede(root, x.change, x.runId, run.runId))
        said.push(`Run ${x.runId} was waiting for the same step: it is cancelled.`);
    }
  }
  return {
    code: res.code,
    prepared: {
      runId: h.runId,
      lines: said,
      ...(h.stillWaiting ? { stillWaiting: true } : {}),
    },
  };
}

/**
 * After Done passed: the step's resume, when the app prepared it. Gives the next run when the
 * step offers another prompt, else what it said (it wrote the files).
 */
export function resumeAfterDone(
  root: string,
  runStep: StepRunner,
  change: string,
  runId: string,
): Promise<{ next?: string; lines: string[]; applied?: string } | undefined> {
  // Review of beta.23: one resume at a time per run, so two at once (Done and the app's own
  // check) never both read the kept resume before either forgets it: the second finds none.
  return withFileLock(join(runsDirOf(root), change, runId, "resume"), () =>
    resumeOnce(root, runStep, change, runId),
  );
}

async function resumeOnce(
  root: string,
  runStep: StepRunner,
  change: string,
  runId: string,
): Promise<{ next?: string; lines: string[]; applied?: string } | undefined> {
  // Round 50: only the resume Atticus kept for this run; a resume.json in the run's folder (the
  // assistant writes there) is never read.
  const kept = await readUserState<{ change?: unknown; runId?: unknown; args?: unknown }>(
    root,
    resumeFile(runId),
  );
  if (!kept) return undefined;
  const no =
    kept.runId !== runId || kept.change !== change
      ? "it was kept for another run"
      : resumeRefusal(kept.args, runId);
  if (no)
    return {
      lines: [
        `The step's resume for ${runId} wasn't run: ${no}. Prepare the step again from the page you prepared it on.`,
      ],
    };
  await forgetUserState(root, resumeFile(runId)).catch(() => undefined);
  // --resume <run> is in args; prepareStep adds --handoff --json and keeps the next resume.
  const words = (kept.args as string[]).filter((a) => a !== "--handoff");
  const r = await prepareStep(root, runStep, words, { next: true });
  if (r.prepared.runId && r.prepared.runId !== runId)
    return { next: r.prepared.runId, lines: r.prepared.lines };
  // ADR 0188: a read of a repo (`atticus map <repo>`) whose last batch is in is put on the map
  // here, as `atticus verify <repo> --write` does in a terminal: the facts checked again, the
  // kept ones in the catalog, the flows in specs/ and the map drawn. Nothing is written to the
  // catalog while a fact is rejected; verify says which, in the lines Done shows.
  const repo = mapRepoOf(words);
  if (repo && !r.prepared.runId) {
    const v = await runStep(["verify", repo, "--write"]);
    return { lines: [...r.prepared.lines, ...appLines([...v.out, ...v.err])], applied: repo };
  }
  return { lines: r.prepared.lines };
}

/** The repo a read of one repo (`map <repo> …`) is of; undefined for any other step. */
export function mapRepoOf(words: readonly string[]): string | undefined {
  return words[0] === "map" && words[1] && !words[1].startsWith("-") ? words[1] : undefined;
}
