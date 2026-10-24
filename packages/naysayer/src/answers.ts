import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { answerWords, listQuestions, quotedIn, type Question } from "@maycombhq/core";
import { changeFolder } from "@maycombhq/changes";

/**
 * The answers people gave for a change (ADR 0115 addendum, 2026-10-24): what the critic's lenses
 * read beside the brief, as data, because a scope or a choice a person set by answering is part
 * of the brief. A change's questions are the ones filed under the change (the stages raise the
 * assistant's questions there) and those its stage loops raised (`stage/<stage>.yaml`
 * `questions`, which may be filed under a repo). Facts, read from files: no meaning is judged.
 */
export interface ChangeAnswer {
  /** The question's id. */
  id: string;
  question: string;
  /** The answer in words: the option's label or the person's text. */
  answer: string;
  by: string;
  at: string;
}

export async function changeAnswers(root: string, change: string): Promise<ChangeAnswer[]> {
  const ids = new Set<string>();
  const stageDir = join(changeFolder(root, change), "stage");
  for (const f of await readdir(stageDir).catch(() => [] as string[])) {
    if (!f.endsWith(".yaml")) continue;
    try {
      const data = parse(await readFile(join(stageDir, f), "utf8")) as { questions?: unknown };
      if (Array.isArray(data?.questions))
        for (const q of data.questions) if (typeof q === "string") ids.add(q);
    } catch {
      // A loop file that doesn't read lists nothing; the stage reports it.
    }
  }
  const all = (await listQuestions(root, { state: "answered" }).catch(() => ({ questions: [] })))
    .questions;
  return all
    .filter((q: Question) => q.repo === change || ids.has(q.id))
    .map((q) => ({
      id: q.id,
      question: q.question.trim(),
      answer: (answerWords(q) ?? "").trim(),
      by: q.answer!.by,
      at: q.answer!.at,
    }))
    .filter((a) => a.answer.length > 0);
}

/** The answers as a lens's data block: each with its id, so a finding can say which it is about. */
export function answersText(answers: readonly ChangeAnswer[]): string {
  return [
    "Questions people answered for this change, with their answers:",
    ...answers.map(
      (a) => `- ${a.id}: ${a.question}\n  Answer (${a.by}, ${a.at.slice(0, 10)}): ${a.answer}`,
    ),
  ].join("\n");
}

/**
 * A lens's link from a finding to an answer, checked as facts: the id is one of the answers it
 * was given, and the quote is word for word in that answer. Undefined when it doesn't check out.
 */
export function checkedAnswerLink(
  answers: readonly ChangeAnswer[],
  link: { id: string; quote: string } | undefined,
): { question: string; quote: string } | undefined {
  if (!link) return undefined;
  const a = answers.find((x) => x.id === link.id);
  if (!a || !quotedIn(a.answer, link.quote)) return undefined;
  return { question: a.id, quote: link.quote.trim() };
}
