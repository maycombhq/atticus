import {
  differentThings,
  SAME_QUESTION,
  type QuestionJudge,
  type SameVerdict,
} from "@maycombhq/core";
import { judge, type JudgeItem, type JudgeOptions, type JudgeSpec } from "./judge.js";

/**
 * The kinds of judgment Atticus asks (ADR 0117). Each is a closed question with its verdicts,
 * the texts it quotes, and the catalog fact that vetoes it before the model.
 */

/** Is a new question one already on file? (questions/, ADR 0089) */
export const SAME_QUESTION_SPEC: JudgeSpec = {
  kind: SAME_QUESTION,
  ask: "Does the new question ask what the existing question asks, so that a person's answer to the existing one answers the new one too?",
  verdicts: ["same", "narrower", "different"],
  means: {
    same: "they ask the same thing, in other words; one answer serves both",
    narrower: "the new one asks part of what the existing one asks, or the same about fewer things",
    different: "they ask different things, even if they share words or a line",
  },
  quote: "each",
  veto: (item) => {
    const why = differentThings(
      { question: item.texts.new ?? "" },
      { question: item.texts.existing ?? "" },
      String(item.inputs.repo ?? ""),
    );
    return why ? { verdict: "different", rule: "veto:different-ids" } : undefined;
  },
};

/** A judge for raiseQuestions' open pairs, through the AI runtime (model or replay). */
export function questionJudge(o: JudgeOptions): QuestionJudge {
  return async (pairs) => {
    const items: JudgeItem[] = pairs.map((p) => ({
      inputs: p.inputs,
      texts: { new: p.draft.question, existing: p.existing.question },
      facts: [
        `new cites ${p.draft.evidence.join(", ")}`,
        `existing cites ${p.existing.evidence.join(", ")}${p.existing.state === "answered" ? " (answered)" : ""}`,
      ],
    }));
    const r = await judge(SAME_QUESTION_SPEC, items, o);
    const out = new Map<string, SameVerdict>();
    for (const [k, v] of r.results) out.set(k, v.verdict as SameVerdict);
    return out;
  };
}

/** Does an acceptance criterion check a field's value? (planner stories, ADR 0117) */
export const COVERS_FIELD_SPEC: JudgeSpec = {
  kind: "covers-field",
  ask: "Does the criterion's then clause assert the value of the field named in the facts, so that a test written from it checks that field?",
  verdicts: ["yes", "no"],
  means: {
    yes: "the then clause asserts what the field holds, in its own name or in words that mean it",
    no: "the criterion doesn't check the field's value (naming the event or the record isn't enough)",
  },
  quote: "one",
};

/** Does a quoted span state a value? (knowledge values, ADR 0111, 0117) */
export const STATES_VALUE_SPEC: JudgeSpec = {
  kind: "states-value",
  ask: "Does the span, word for word from the page, state the value given in the facts for the field named there?",
  verdicts: ["yes", "no"],
  means: {
    yes: "the span says it: the same value, in its words or in other units that mean exactly it",
    no: "the span doesn't say it, says something else, or says it about something else",
  },
  quote: "one",
};

/** Does a process or request apply to a step of the change? (planner stories, ADR 0083) */
export const APPLIES_SPEC: JudgeSpec = {
  kind: "applies",
  ask: "Does the process's applies-when hold for the step, given the step's facts from the catalog?",
  verdicts: ["yes", "no"],
  means: {
    yes: "what the step does meets the applies-when clause",
    no: "the step doesn't meet it",
  },
  quote: "each",
};
