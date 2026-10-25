import type { RecordOf } from "@maycombhq/core";
import type { KnowledgeRecord } from "@maycombhq/knowledge";

/**
 * A knowledge item as a stage writes it for its drafter (B2): the same line in every stage, so
 * the feature, architecture and stories prompts say an item the same way. In full (what the
 * selection's fit had room for), a pattern or standard carries its rules and a decision what it
 * decided; in one line, its title and when it applies. A process or request is one line at
 * either level, with its lead time.
 */

type Pattern = RecordOf<"Pattern">;
type Decision = RecordOf<"Decision">;
type Process = RecordOf<"ProcessDefinition">;
export type Level = "full" | "line";

const sentence = (s: string) => {
  const t = s.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

/** A pattern, standard, decision or constraint, as the architecture stage has always written it. */
export function patternLine(i: Pattern | Decision, level: Level = "line"): string {
  const title = i.kind === "Pattern" ? i.name : i.title;
  const base = `${i.kind} ${i.id}: ${title}. Applies when: ${i.appliesWhen ?? ""} (${i.quote?.page ?? ""})`;
  if (level !== "full") return base;
  if (i.kind === "Pattern")
    return i.rules.length ? `${base}. Rules: ${i.rules.map(sentence).join(" ")}` : base;
  return i.decision.trim() ? `${base}. Decided: ${sentence(i.decision)}` : base;
}

/** A process or request, as the stories stage has always written it. */
export const processLine = (p: Process): string =>
  `${p.processKind} ${p.id} "${p.title}": applies when ${p.appliesWhen.replace(/[.\s]+$/, "")}${p.leadTime ? `; lead time ${p.leadTime}` : ""}`;

/** A standard beside the processes (the stories stage): its rules are what a story's Context names. */
export function standardLine(p: Pattern, level: Level = "line"): string {
  const base = `standard ${p.id} "${p.name}": applies when ${(p.appliesWhen ?? "a service is built or changed").replace(/[.\s]+$/, "")}`;
  return level === "full" && p.rules.length
    ? `${base}. Rules: ${p.rules.map(sentence).join(" ")}`
    : base;
}

export const isStandard = (r: { kind: string; patternKind?: string }): boolean =>
  r.kind === "Pattern" && r.patternKind === "standard";

/** Any item a stage may send: a pattern or decision by patternLine, a process by processLine. */
export function itemLine(r: KnowledgeRecord, level: Level): string | undefined {
  if (r.kind === "Pattern" || r.kind === "Decision") return patternLine(r, level);
  if (r.kind === "ProcessDefinition") return processLine(r);
  return undefined;
}
