import {
  CriticQuestion,
  isCriticQuestion,
  lensCovers,
  questionOfLens,
  type ChecklistRule,
  type Lens,
} from "@maycombhq/core";
import { BUILT_IN_CHECKS } from "./checks/index.js";
import type { DeterministicCheckDef } from "./hits.js";

/**
 * The critic asks four questions of every draft (ADR 0124 addendum, Part 4), and code answers
 * what code can before a model is asked:
 *
 * - true: is it true to the code? Every cited fact exists and is verified.
 * - complete: is it complete? A requirement the brief implies, an error path nobody wrote.
 * - safe: is it safe to build? Breaking deltas, unclassified data, timeouts, auth, policy.
 * - ship: can it ship? Migrations, rollback, lead times, what to watch.
 *
 * Every rule answers one of them: its own `question`, else its lens when the lens is a question,
 * else the question of the deterministic check it names, else the question its old role lens maps
 * to. One AI lens runs per question.
 */

export const QUESTIONS = CriticQuestion.options;

/** Each question as the critic asks it, for prompts and screens. */
export const QUESTION_TEXT: Record<CriticQuestion, string> = {
  true: "Is it true to the code?",
  complete: "Is it complete?",
  safe: "Is it safe to build?",
  ship: "Can it ship?",
};

/** Who answers a lens's knowledge gap when the lens doesn't say. */
export const QUESTION_ROLES: Record<CriticQuestion, string> = {
  true: "architect",
  complete: "product-owner",
  safe: "architect",
  ship: "delivery-lead",
};

const BUILT_IN = new Map(BUILT_IN_CHECKS.map((c) => [c.id, c]));

type RuleLike = Pick<ChecklistRule, "lens" | "question" | "check"> & { asks?: CriticQuestion };

/** The question a rule says it answers itself: its `question`, or its lens when that is one. */
export function explicitQuestion(rule: Pick<ChecklistRule, "lens" | "question">) {
  return rule.question ?? (isCriticQuestion(rule.lens) ? rule.lens : undefined);
}

/** The question a rule answers (see the module comment for the order). */
export function questionOfRule(
  rule: RuleLike,
  checks: ReadonlyMap<string, Pick<DeterministicCheckDef, "question">> = BUILT_IN,
): CriticQuestion {
  if (rule.asks) return rule.asks;
  const own = explicitQuestion(rule);
  if (own) return own;
  if (rule.check.type === "deterministic") {
    const q = checks.get(rule.check.check)?.question;
    if (q) return q;
  }
  return questionOfLens(rule.lens);
}

/**
 * Whether a change type's lenses take a rule. A rule written with an old role lens applies as it
 * did, when the type lists that lens, or when the type lists the rule's question. A rule written
 * for a question applies when one of the type's lenses covers that question (an old architecture
 * lens covers true and safe). A type that lists no lenses takes every rule.
 */
export function typeTakes(typeLenses: readonly Lens[], rule: RuleLike): boolean {
  if (typeLenses.length === 0) return true;
  const q = questionOfRule(rule);
  if (typeLenses.includes(rule.lens) || typeLenses.includes(q)) return true;
  if (!isCriticQuestion(rule.lens)) return false;
  return typeLenses.some((l) => lensCovers(l).includes(q));
}

/** The questions a list of lenses (old or new) asks for, in the questions' order. */
export function questionsOf(lenses: readonly Lens[]): CriticQuestion[] {
  const want = new Set(lenses.map(questionOfLens));
  return QUESTIONS.filter((q) => want.has(q));
}
