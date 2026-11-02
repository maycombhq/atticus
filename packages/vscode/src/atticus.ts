import { targetArgs } from "./beta11";
import { parseJson } from "./cli";
import type {
  Cancel,
  Cli,
  NextStep,
  OpenQuestion,
  QuestionAbout,
  QueueEntry,
  QuestionsMe,
} from "./types";

/**
 * The deterministic commands the extension reads (ADR 0090): `atticus next --json` and
 * `atticus questions list|answer`. They read and write the metarepo's files only.
 */

export type Read<T> = { ok: true; value: T } | { ok: false; message: string };

const why = (stderr: string, stdout: string, code: number) =>
  (stderr.trim() || stdout.trim() || `atticus ended with exit code ${code}`).split("\n")[0]!;

export async function readNext(
  cli: Cli,
  root: string,
  token?: Cancel,
): Promise<Read<{ next?: NextStep; steps: NextStep[]; runs?: string }>> {
  const r = await cli(["next", "--json", "--root", root], token);
  const j = parseJson<{ next?: NextStep; steps?: NextStep[]; runs?: string }>(r.stdout);
  if (!j) return { ok: false, message: why(r.stderr, r.stdout, r.code) };
  return {
    ok: true,
    value: {
      ...(j.next ? { next: j.next } : {}),
      steps: j.steps ?? [],
      ...(typeof j.runs === "string" ? { runs: j.runs } : {}),
    },
  };
}

type QuestionList = {
  questions?: OpenQuestion[];
  about?: Record<string, QuestionAbout>;
  me?: QuestionsMe;
};

/** Each question with what the list says of it under `about` (beta.10), in the list's order. */
const withAbout = (j: QuestionList): OpenQuestion[] =>
  (j.questions ?? []).map((q) => {
    const about = j.about?.[q.id];
    return about ? { ...q, about } : q;
  });

export async function readOpenQuestions(
  cli: Cli,
  root: string,
  token?: Cancel,
): Promise<Read<OpenQuestion[]>> {
  const r = await cli(["questions", "list", "--state", "open", "--json", "--root", root], token);
  const j = parseJson<QuestionList>(r.stdout);
  if (!j) return { ok: false, message: why(r.stderr, r.stdout, r.code) };
  return { ok: true, value: withAbout(j) };
}

/**
 * My teams' questions (ADR 0140, 0153): `--mine`, from roles.yaml's teams and the changes that
 * name the person under owners, and who the command line took the person to be.
 */
export async function readMyQuestions(
  cli: Cli,
  root: string,
  token?: Cancel,
): Promise<Read<{ questions: OpenQuestion[]; me?: QuestionsMe }>> {
  const r = await cli(
    ["questions", "list", "--state", "open", "--mine", "--json", "--root", root],
    token,
  );
  const j = parseJson<QuestionList>(r.stdout);
  if (!j) return { ok: false, message: why(r.stderr, r.stdout, r.code) };
  return { ok: true, value: { questions: withAbout(j), ...(j.me ? { me: j.me } : {}) } };
}

/** The steps whose answers take a rule (ADR 0153): where calls go, by target or by host. */
const RULE_STEPS = new Set(["facts-targets", "scan-hosts"]);

/** Whether a question's answer can carry a rule (`--match`). */
export const takesRule = (q: Pick<OpenQuestion, "askedBy">) =>
  RULE_STEPS.has(q.askedBy?.step ?? "");

/** The onboarding queue (ADR 0141): the repos to read, in order, each with why and its cost. */
export async function readQueue(
  cli: Cli,
  root: string,
  token?: Cancel,
): Promise<Read<QueueEntry[]>> {
  const r = await cli(["next", "--queue", "--json", "--root", root], token);
  const j = parseJson<{ queue?: QueueEntry[] }>(r.stdout);
  if (!j) return { ok: false, message: why(r.stderr, r.stdout, r.code) };
  return { ok: true, value: j.queue ?? [] };
}

/**
 * An answer: an option, the person's own words, the assistant's proposal, or (ADR 0162, 0166) a
 * target named from the "Another repo…" picker, with the new system it adds when the person said
 * yes to adding one.
 */
export type Answer =
  | { option: number }
  | { text: string }
  | { acceptProposal: true }
  | { target: string; addSystem?: "vendor" | "internal"; name?: string };

/**
 * Answer a question: an option (counting from 1), the person's own words, or the assistant's
 * checked proposal taken as theirs (ADR 0144). A target or hosts answer may carry a rule.
 */
export async function answerQuestion(
  cli: Cli,
  root: string,
  id: string,
  answer: Answer,
  o: { match?: string } = {},
): Promise<{ ok: boolean; lines: string[] }> {
  const how =
    "option" in answer
      ? ["--option", String(answer.option)]
      : "text" in answer
        ? ["--text", answer.text]
        : "target" in answer
          ? targetArgs(answer)
          : ["--accept-proposal"];
  const r = await cli([
    "questions",
    "answer",
    id,
    ...how,
    ...(o.match && !("acceptProposal" in answer) ? ["--match", o.match] : []),
    "--root",
    root,
  ]);
  const lines = [...r.stdout.trimEnd().split("\n"), ...r.stderr.trimEnd().split("\n")].filter(
    Boolean,
  );
  return { ok: r.code === 0, lines };
}

/** What the extension does for a step `atticus next` names. */
export type NextAction =
  | { kind: "ai"; args: string[]; spec?: string }
  | { kind: "answer" }
  | { kind: "run"; args: string[] }
  | { kind: "person"; command: string };

/** The AI steps the runner takes (ADR 0086's --handoff steps), by their first two words. */
const AI_STEPS = new Set([
  "scan survey",
  "scan verify",
  "spec draft",
  "knowledge scan",
  "change feature",
  "change architecture",
  // ADR 0113: the fast path's one step.
  "change small",
  "change draft",
  "plan stories",
  // ADR 0101: what a change needs from the organisation; searching the wikis for a phrase.
  "change needs",
  "knowledge find",
  "knowledge ask",
]);

/** The words of a printed command, without "atticus"; quotes kept together. */
export const argsOf = (command: string) =>
  [...command.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]!).slice(1);

export function actionFor(step: NextStep): NextAction {
  if (step.step === "answer") return { kind: "answer" };
  const args = argsOf(step.command);
  // A step only a person takes, or a command with a part to fill in, is shown, not run.
  if (step.person || /<[^>]+>/.test(step.command)) return { kind: "person", command: step.command };
  if (step.step === "spec" && step.repo) return { kind: "ai", args, spec: step.repo };
  if (AI_STEPS.has(args.slice(0, 2).join(" "))) return { kind: "ai", args };
  // The critic's AI lenses, one at a time (ADR 0106 addendum); critic stats only reads.
  if (args[0] === "critic" && args[1] && args[1] !== "stats" && !args.includes("--resume"))
    return { kind: "ai", args };
  // ADR 0124 §4: the batched read of a repo, a batch a hand-off; its estimate and the rendered
  // map only read.
  if (
    args[0] === "map" &&
    args[1] &&
    !args[1].startsWith("-") &&
    args[1] !== "render" &&
    !args.includes("--estimate") &&
    // beta.10 (ADR 0157): --gaps only writes the second pass's prompt; a new chat reads it.
    !args.includes("--gaps")
  )
    return { kind: "ai", args };
  return { kind: "run", args };
}

/** The chat commands and palette commands that run an AI step on a repo or a change. */
export const STEP_COMMANDS = {
  survey: { args: (t: string) => ["scan", "survey", t], target: "repo" },
  // The old scan's check, an AI step; /verify (ADR 0124) checks the facts and runs no model.
  scanverify: { args: (t: string) => ["scan", "verify", t], target: "repo" },
  spec: { args: (t: string) => ["spec", "draft", t], target: "repo" },
  feature: { args: (t: string) => ["change", "feature", t], target: "change" },
  architecture: { args: (t: string) => ["change", "architecture", t], target: "change" },
  stories: { args: (t: string) => ["plan", "stories", t], target: "change" },
  small: { args: (t: string) => ["change", "small", t], target: "change" },
  // Phase D: the assistant reads the repo (ADR 0124), and the critic reviews a change.
  map: { args: (t: string) => ["map", t], target: "repo" },
  critic: { args: (t: string) => ["critic", t], target: "change" },
} as const;

export type StepCommand = keyof typeof STEP_COMMANDS;

/** The step command each AI step runs as, by its first two words. */
const STEP_BY_WORDS: Record<string, StepCommand> = {
  "scan survey": "survey",
  "scan verify": "scanverify",
  "spec draft": "spec",
  "change feature": "feature",
  "change architecture": "architecture",
  "plan stories": "stories",
  "change small": "small",
};

/**
 * The @atticus command a next step runs as, when the chat runs it: the step with the editor's
 * model, the open questions, or a task started in agent mode with its context (ADR 0113).
 */
export function chatQuery(n: NextStep): string | undefined {
  const a = actionFor(n);
  if (a.kind === "answer") return "@atticus /answer";
  const words = argsOf(n.command);
  if (words[0] === "task" && words[1] === "run" && words[2] && words[3])
    return `@atticus /task ${words[2]} ${words[3]}`;
  // ADR 0124: checking the facts runs no model, but the chat runs it and shows what it found.
  if (words[0] === "verify" && words[1] && !words[1].startsWith("-"))
    return `@atticus /verify ${words[1]}${words.includes("--write") ? " --write" : ""}`;
  if (a.kind !== "ai") return undefined;
  // map <repo> and critic <change> name their target second; the others third.
  const one = a.args[0] === "map" || a.args[0] === "critic";
  const name = one ? (a.args[0] as StepCommand) : STEP_BY_WORDS[a.args.slice(0, 2).join(" ")];
  const target = one ? a.args[1] : a.args[2];
  return name && target ? `@atticus /${name} ${target}` : undefined;
}
