import type { FindingEvidence, FindingLocator } from "@maycombhq/core";
import { z } from "zod";
import type { CriticContext } from "./context.js";
import { quoteOf, type Doc } from "./doc.js";
import type { EffectiveRule } from "./rules.js";

export type Evidence = z.input<typeof FindingEvidence>;
export type Locator = z.input<typeof FindingLocator>;

/**
 * What a check reports before it becomes a C3 finding: where, what, why, the fix and the
 * evidence. `key` names the problem itself, so two rules that catch the same problem (an
 * org rule and the constitution rule it overlaps) produce one finding, not two.
 */
export interface Hit {
  kind: "issue" | "knowledge-gap";
  /** Change-folder-relative path, or "catalog". */
  artifact: string;
  locator: Locator;
  summary: string;
  why: string;
  fix: { text: string; patch?: string };
  evidence: Evidence[];
  /** Knowledge gaps: the owner question and who should answer. */
  question?: { text: string; owner: string };
  key: string;
  /** Knowledge gaps: the record the missing fact is about. */
  subject?: string;
  /** The person's answer for the change that decided what it is about (a lens says, checked). */
  answered?: { question: string; quote: string };
}

export interface CheckResult {
  hits: Hit[];
  /**
   * Catalog ids the check actually examined. The rule's `needs` are evaluated for these
   * (within the need's scope), so a need is asked about what the rule looked at, not about
   * every touched record. Undefined means the whole scope.
   */
  subjects?: string[];
}

export interface DeterministicCheckDef {
  id: string;
  description: string;
  params: z.ZodType<Record<string, unknown>>;
  run(ctx: CriticContext, params: Record<string, unknown>, rule: EffectiveRule): CheckResult;
}

/** Evidence pointing at a line of a change artifact, with a short quote of it. */
export function lineEvidence(doc: Doc, line: number): Evidence {
  const quote = quoteOf(doc, line);
  return { source: "artifact", path: doc.path, line, ...(quote ? { quote } : {}) };
}

export function recordEvidence(id: string): Evidence {
  return { source: "catalog", record: id };
}

/** Who answers a question about a record: the owner of its system, else the pack owner, else the architect. */
export function questionOwner(ctx: CriticContext, subject: string): string {
  const system = ctx.systemOf(subject) ?? subject;
  return ctx.ownerOf(system) ?? ctx.packOwner ?? "architect";
}

/** Fill a question template's subject placeholders. */
export function renderQuestion(
  template: string,
  v: { record: string; system?: string; kind?: string; field?: string },
): string {
  return template
    .replace(/\$\{record\}/g, v.record)
    .replace(/\$\{system\}/g, v.system ?? v.record)
    .replace(/\$\{kind\}/g, v.kind ?? "")
    .replace(/\$\{field\}/g, v.field ?? "");
}

/** The rule's own owner question for a kind of fact, if it declares one. */
export function ruleQuestion(rule: EffectiveRule, kind: string): string | undefined {
  return rule.needs.find((n) => n.kind === kind)?.question;
}

/** A one-sentence summary that fits C3's 200-character limit. */
export function sentence(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= 200 ? t : `${t.slice(0, 196)}...`;
}

export const lower = (s: string) => s.toLowerCase();

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A whole-word, case-insensitive test. */
export const hasWord = (text: string, word: string) =>
  new RegExp(`(^|[^a-z0-9_])${escapeRe(word.toLowerCase())}($|[^a-z0-9_])`).test(
    text.toLowerCase(),
  );
