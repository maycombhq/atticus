import { parseJson } from "./cli";
import type { Cancel, Cli, NextStep, OpenQuestion } from "./types";

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
): Promise<Read<{ next?: NextStep; steps: NextStep[] }>> {
  const r = await cli(["next", "--json", "--root", root], token);
  const j = parseJson<{ next?: NextStep; steps?: NextStep[] }>(r.stdout);
  if (!j) return { ok: false, message: why(r.stderr, r.stdout, r.code) };
  return { ok: true, value: { ...(j.next ? { next: j.next } : {}), steps: j.steps ?? [] } };
}

export async function readOpenQuestions(
  cli: Cli,
  root: string,
  token?: Cancel,
): Promise<Read<OpenQuestion[]>> {
  const r = await cli(["questions", "list", "--state", "open", "--json", "--root", root], token);
  const j = parseJson<{ questions?: OpenQuestion[] }>(r.stdout);
  if (!j) return { ok: false, message: why(r.stderr, r.stdout, r.code) };
  return { ok: true, value: j.questions ?? [] };
}

/** Answer a question: an option (counting from 1) or the person's own words. */
export async function answerQuestion(
  cli: Cli,
  root: string,
  id: string,
  answer: { option: number } | { text: string },
): Promise<{ ok: boolean; lines: string[] }> {
  const r = await cli([
    "questions",
    "answer",
    id,
    ...("option" in answer ? ["--option", String(answer.option)] : ["--text", answer.text]),
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
  return { kind: "run", args };
}

/** The chat commands and palette commands that run an AI step on a repo or a change. */
export const STEP_COMMANDS = {
  survey: { args: (t: string) => ["scan", "survey", t], target: "repo" },
  verify: { args: (t: string) => ["scan", "verify", t], target: "repo" },
  spec: { args: (t: string) => ["spec", "draft", t], target: "repo" },
  feature: { args: (t: string) => ["change", "feature", t], target: "change" },
  architecture: { args: (t: string) => ["change", "architecture", t], target: "change" },
  stories: { args: (t: string) => ["plan", "stories", t], target: "change" },
  small: { args: (t: string) => ["change", "small", t], target: "change" },
} as const;

export type StepCommand = keyof typeof STEP_COMMANDS;
