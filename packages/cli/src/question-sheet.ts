import { createHash } from "node:crypto";
import { parse, stringify } from "yaml";
import { z } from "zod";
import {
  answerQuestion,
  answerByWords,
  answerWords,
  HOSTS_STEP,
  QuestionError,
  QuestionScopeLevel,
  readQuestion,
  TARGETS_STEP_ID,
  type Question,
} from "@maycombhq/core";

/**
 * Answer in one sitting (ADR 0153, Q6): `atticus questions sheet` writes every open question into
 * one YAML file with an empty `answer:`, and `atticus questions sheet --apply <file>` answers each
 * entry a person filled in through `answerQuestion`, as the person running it, exactly as
 * `atticus questions answer` would. A blank entry is skipped; an entry whose question changed
 * since the sheet was written (its words, options, evidence or state) is refused, so nobody
 * answers a question they didn't read. The sheet is a working file, not a contract: the
 * question files stay the record.
 */

export const SHEET_VERSION = 1 as const;

/** What a sheet entry was written from: the question's words, options and evidence, while open. */
export function askedFingerprint(q: Question): string {
  const key = JSON.stringify([
    q.question.trim(),
    q.options.map((o) => [o.label, o.means, o.changes]),
    [...q.evidence].sort(),
    q.scope,
    q.state,
  ]);
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

const RULE_STEPS = new Set<string>([TARGETS_STEP_ID, HOSTS_STEP]);

const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

/** The sheet for these questions (the open ones are written; the others are left out). */
export function answerSheet(questions: readonly Question[], at: string): string {
  const open = questions.filter((q) => q.state === "open");
  const doc = {
    schemaVersion: SHEET_VERSION,
    written: at,
    questions: open.map((q) => ({
      id: q.id,
      repo: q.repo,
      question: q.question.trim(),
      ...(q.options.length
        ? {
            options: q.options.map(
              (o, i) =>
                `${i + 1}. ${o.label}: ${sentence(o.means)} It would change: ${sentence(o.changes)}`,
            ),
          }
        : {}),
      evidence: q.evidence,
      scope: q.scope.level === "repo" ? "repo" : `repo-type ${q.scope.id}`,
      asked: askedFingerprint(q),
      answer: null,
      ...(RULE_STEPS.has(q.askedBy.step) ? { match: null } : {}),
    })),
  };
  return [
    "# Atticus answer sheet (ADR 0153): every open question, to answer in one sitting.",
    "# Fill in answer: with an option's number, or your own words in quotes. Leave it empty to skip.",
    "# Optional per entry: scope: repo | repo-type (with type: <repo type>), and for a target or",
    '# hosts question match: "<host pattern or /path/**>" so one answer covers every call it matches.',
    "# Then: atticus questions sheet --apply <this file>. It answers as you, through the question files;",
    "# this sheet is a working file: don't commit it.",
    stringify(doc, { lineWidth: 0 }),
  ].join("\n");
}

const Entry = z.object({
  id: z.string(),
  asked: z.string().optional(),
  answer: z.union([z.number(), z.string(), z.null()]).optional(),
  scope: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  match: z.string().nullable().optional(),
});
const Sheet = z.object({
  schemaVersion: z.literal(SHEET_VERSION),
  questions: z.array(z.unknown()),
});

/** What happened to one entry. */
export type SheetOutcome =
  | { id: string; status: "answered"; answer: string; question: Question; rerun: string }
  | { id: string; status: "skipped"; why: string }
  | { id: string; status: "refused"; why: string };

export interface SheetReport {
  outcomes: SheetOutcome[];
  /** Why the sheet itself couldn't be read, when it couldn't. */
  problem?: string;
}

/** Answer every filled entry of a sheet, in order, as `by`. */
export async function applySheet(
  root: string,
  text: string,
  o: { by: string; at: string },
): Promise<SheetReport> {
  let data: unknown;
  try {
    data = parse(text);
  } catch (e) {
    return { outcomes: [], problem: `It doesn't read: ${(e as Error).message.split("\n")[0]}` };
  }
  const sheet = Sheet.safeParse(data);
  if (!sheet.success)
    return {
      outcomes: [],
      problem:
        "It isn't an answer sheet Atticus wrote (schemaVersion 1, with questions): write one with atticus questions sheet.",
    };
  const outcomes: SheetOutcome[] = [];
  for (const [i, raw] of sheet.data.questions.entries()) {
    const e = Entry.safeParse(raw);
    if (!e.success) {
      outcomes.push({
        id: `entry ${i + 1}`,
        status: "refused",
        why: "it has no question id; leave the sheet's ids as they were written",
      });
      continue;
    }
    const { id } = e.data;
    const given = e.data.answer;
    if (given === undefined || given === null || (typeof given === "string" && !given.trim())) {
      outcomes.push({ id, status: "skipped", why: "left blank" });
      continue;
    }
    const q = await readQuestion(root, id).catch(() => undefined);
    if (!q) {
      outcomes.push({ id, status: "refused", why: `there is no question ${id}` });
      continue;
    }
    if (q.state !== "open") {
      outcomes.push({
        id,
        status: "skipped",
        why: `it is ${q.state} already${q.answer ? ` (${answerWords(q)}, by ${answerByWords(q.answer.by)})` : ""}`,
      });
      continue;
    }
    if (e.data.asked !== askedFingerprint(q)) {
      outcomes.push({
        id,
        status: "refused",
        why: "the question changed since the sheet was written (its words, options or evidence): write a new sheet and read it again",
      });
      continue;
    }
    const scope = e.data.scope?.trim().split(/\s+/)[0];
    if (scope && !QuestionScopeLevel.safeParse(scope).success) {
      outcomes.push({
        id,
        status: "refused",
        why: "scope is repo (this repo only) or repo-type (every repo of its type)",
      });
      continue;
    }
    const option =
      typeof given === "number" ? given : /^\s*\d+\s*$/.test(given) ? Number(given) : undefined;
    const typeFromScope = e.data.scope?.trim().split(/\s+/)[1];
    const repoType = e.data.type?.trim() || typeFromScope;
    const match = e.data.match?.trim() || undefined;
    try {
      const r = await answerQuestion(root, id, {
        ...(option !== undefined ? { option } : { text: String(given) }),
        ...(scope ? { scope: scope as QuestionScopeLevel } : {}),
        ...(repoType ? { repoType } : {}),
        ...(match ? { match } : {}),
        by: o.by,
        at: o.at,
      });
      outcomes.push({
        id,
        status: "answered",
        answer: answerWords(r.question) ?? "",
        question: r.question,
        rerun: r.question.rerun,
      });
    } catch (x) {
      if (!(x instanceof QuestionError)) throw x;
      outcomes.push({ id, status: "refused", why: x.message });
    }
  }
  return { outcomes };
}
