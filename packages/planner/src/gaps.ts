import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SourceInput } from "@maycombhq/ai";
import {
  answerWords,
  changesDirOf,
  changesRelOf,
  listQuestions,
  raiseQuestions,
  type Question,
  type QuestionDraft,
} from "@maycombhq/core";
import { parse } from "yaml";
import { GAP_STEP, gapNameOf, gapQuestion } from "@maycombhq/index";
import { unfence } from "./stages/answer.js";

/**
 * What neither the wikis nor the repos say (ADR 0107 point 5), in the steps that use the
 * context engine (needs, feature, architecture, stories): the names the change uses that the
 * index has nothing for are listed as gaps in the step's result, sent to the model with the
 * rule not to guess, and each gap the model's answer says it relies on (under relies_on_gaps,
 * ADR 0117; a name it merely mentions isn't one) becomes a question
 * to a person (questions/, ADR 0078), never a guess. Asked under one step id with the change as
 * its repo and the line the change names it on as evidence, so every step of the change that
 * meets the same gap waits on the same question. A person's answer is indexed as asserted
 * knowledge (who and when), the name is known from then on, and the answer goes in the packs
 * of the change's later steps.
 */

export interface ContextGap {
  name: string;
  /** Where the change names it: path:line, relative to the metarepo. */
  evidence?: string;
  /** listed: in the result only; asked: the answer relied on it, a question waits; answered. */
  state: "listed" | "asked" | "answered";
  /** The question it became. */
  question?: string;
}

/** The change's files a gap's line is looked for in. */
async function changeTexts(root: string, change: string): Promise<[string, string][]> {
  const dir = join(changesDirOf(root), change);
  const out: [string, string][] = [];
  const top = (await readdir(dir).catch(() => [] as string[]))
    .filter((f) => /\.md$/.test(f))
    .sort();
  for (const f of ["brief.md", ...top.filter((x) => x !== "brief.md")]) {
    const t = await readFile(join(dir, f), "utf8").catch(() => undefined);
    if (t !== undefined) out.push([f, t]);
  }
  for (const sub of ["stories", "target-flows"])
    for (const f of (await readdir(join(dir, sub)).catch(() => [] as string[])).sort())
      if (/\.(md|ya?ml)$/.test(f)) {
        const t = await readFile(join(dir, sub, f), "utf8").catch(() => undefined);
        if (t !== undefined) out.push([`${sub}/${f}`, t]);
      }
  return out;
}

const fold = (s: string) => s.toLowerCase().replace(/\s+/g, " ");

/** The gaps of a step's selection, each with the first line of the change that names it. */
export async function gapsOf(
  root: string,
  change: string,
  unknown: string[],
): Promise<ContextGap[]> {
  if (!unknown.length) return [];
  const texts = await changeTexts(root, change);
  const rel = `${changesRelOf(root)}/${change}`;
  const out: ContextGap[] = [];
  for (const name of unknown) {
    let gap: ContextGap = { name, state: "listed" };
    let own = false;
    for (const [f, t] of texts) {
      const lines = t.split(/\r?\n/);
      const i = lines.findIndex((l) => fold(l).includes(fold(name)));
      if (i < 0) continue;
      // What the change's own target flows add (new: true) is the change's, not a gap.
      own = f.startsWith("target-flows/") && /\bnew:\s*true\b/.test(lines[i]!);
      gap = { name, evidence: `${rel}/${f}:${i + 1}`, state: "listed" };
      break;
    }
    if (!own) out.push(gap);
  }
  return out;
}

/**
 * The gap sources and the answered gaps for a change's selection, with the tokens they take,
 * so the step can give the selection that much less room.
 */
export async function gapContext(
  root: string,
  change: string,
  unknown: string[],
): Promise<{ gaps: ContextGap[]; sources: SourceInput[] }> {
  const gaps = await gapsOf(root, change, unknown);
  const answers = await gapAnswers(root, change);
  return { gaps, sources: [...gapSources(gaps), ...(answers.source ? [answers.source] : [])] };
}

/** Said to the model when the step has gaps: list them, never guess. Atticus's own words. */
export const GAP_RULE =
  "The names in context-gaps are gaps: nothing Atticus has read says what they are. Never guess a fact about one. When your answer needs a fact about one, list it, as it is listed, under relies_on_gaps: [<name>, ...] at the top level of your answer, and Atticus asks a person. A gap you leave out or only mention is not asked.";

/** The gaps as the model reads them (data: the names come from the change) and the rule. */
export function gapSources(gaps: ContextGap[]): SourceInput[] {
  if (!gaps.length) return [];
  return [
    {
      id: "gap-rule",
      kind: "instruction",
      origin: "atticus (ADR 0107 point 5)",
      text: GAP_RULE,
      classification: "public",
      trusted: true,
    },
    {
      id: "context-gaps",
      kind: "document",
      origin: "context-gaps",
      text: [
        "Names the change uses that nothing Atticus has read says anything about:",
        ...gaps.map((g) => `- ${g.name}${g.evidence ? ` (${g.evidence})` : ""}`),
      ].join("\n"),
      classification: "internal",
      priority: 95,
    },
  ];
}

/** The change's gap questions people answered, as a source of the step's pack (asserted knowledge). */
export async function gapAnswers(
  root: string,
  change: string,
): Promise<{ answered: Question[]; source?: SourceInput }> {
  const answered = (
    await listQuestions(root, { repo: change, step: GAP_STEP, state: "answered" }).catch(() => ({
      questions: [] as Question[],
    }))
  ).questions.filter((q) => gapNameOf(q));
  if (!answered.length) return { answered };
  return {
    answered,
    source: {
      id: "gap-answers",
      kind: "document",
      origin: "questions/ (answered gaps)",
      text: [
        "People said what these names are; their answers are asserted knowledge (who and when), not read from code:",
        ...answered.map(
          (q) =>
            `- ${gapNameOf(q)}: ${answerWords(q) ?? ""} (${q.answer!.by}, ${q.answer!.at}, question ${q.id})`,
        ),
      ].join("\n"),
      classification: "internal",
      priority: 96,
    },
  };
}

/**
 * The gaps an answer relies on (ADR 0117): the names it lists under relies_on_gaps, each one a
 * gap the step listed (set membership, spacing and case aside). A name that isn't a listed gap
 * comes back in `unknown`; an answer that doesn't parse relies on none.
 */
export function reliedOn(
  gaps: ContextGap[],
  answer: string,
): { relied: ContextGap[]; unknown: string[] } {
  let data: unknown;
  try {
    data = parse(unfence(answer));
  } catch {
    return { relied: [], unknown: [] };
  }
  const listed = (data as { relies_on_gaps?: unknown } | null)?.relies_on_gaps;
  const names = Array.isArray(listed)
    ? listed.filter((x): x is string => typeof x === "string" && x.trim() !== "")
    : [];
  const relied: ContextGap[] = [];
  const unknown: string[] = [];
  for (const n of names) {
    const g = gaps.find((x) => fold(x.name).trim() === fold(n).trim());
    if (!g) unknown.push(n);
    else if (!relied.includes(g)) relied.push(g);
  }
  return { relied, unknown };
}

/** The question a gap becomes, or undefined when the change doesn't say where it names it. */
export function gapDraft(g: ContextGap): QuestionDraft | undefined {
  if (!g.evidence) return undefined;
  return { question: gapQuestion(g.name), options: [], evidence: [g.evidence], scope: "repo" };
}

/**
 * Ask a person about each gap the answer relies on. The gaps are updated in place (asked or
 * answered, with the question); the questions raised or already on file come back.
 */
export async function askGaps(
  root: string,
  change: string,
  gaps: ContextGap[],
  answer: string,
  by: { command: string; rerun: string; run?: string; at: string },
): Promise<Question[]> {
  const { relied } = reliedOn(gaps, answer);
  const drafts = relied.map((g) => [g, gapDraft(g)] as const).filter((x) => x[1]);
  if (!drafts.length) return [];
  const r = await raiseQuestions(
    root,
    drafts.map((x) => x[1]!),
    { step: GAP_STEP, repo: change, ...by },
  );
  const qs = [...r.raised, ...r.known];
  for (const [g] of drafts) {
    const q = qs.find((x) => gapNameOf(x) === g.name);
    if (!q) continue;
    g.question = q.id;
    g.state = q.state === "answered" ? "answered" : "asked";
  }
  return qs;
}
