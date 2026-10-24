import { settle, verdictOf, type JudgeItem, type Judged, type JudgeSpec } from "@maycombhq/ai";
import type { ReleaseContext } from "./context.js";

/**
 * The release views' judgments of meaning (ADR 0117 addendum). Each was a regex or a word list:
 * whether an API change breaks callers (BREAKING, NEW_ERROR, ADDITIVE), which sentences undo a
 * deployment step (ROLLBACK and "migration, schema, column, table"), which lines name a secret
 * (SECRET_WORDS) and which columns are personal (looksPersonal). Now each is a closed question
 * to the judge, vetoed first by a fact, and kept in the judgments store: the same words read the
 * same verdict on every view. Without a model the runtime can call, a verdict on file is read
 * and what is left is shown to a person as not judged; a word rule never stands in for it.
 */

/** An API change: must a caller that uses the operation today change? */
export function breakingItem(
  h: { change: string; operation: string; caller: string; callee: string },
  notes: string,
): JudgeItem {
  return {
    inputs: {
      v: 1,
      change: h.change,
      operation: h.operation,
      caller: h.caller,
      callee: h.callee,
      notes,
    },
    texts: { notes },
    facts: [
      `operation: ${h.operation}`,
      `caller: ${h.caller}`,
      `callee: ${h.callee}`,
      `change: ${h.change.replace(/^planned-/, "")}`,
    ],
  };
}

/** A deployment step for the undoes judgment: its key, kind, what deploys and its names. */
export interface UndoStep {
  key: string;
  kind: string;
  repo: string;
  what: string[];
  names: string[];
}

/** A sentence and a step: does the sentence say how the step is undone? */
export function undoesItem(sentence: string, step: UndoStep, others: string[]): JudgeItem {
  return {
    inputs: {
      v: 1,
      sentence,
      step: step.key,
      names: [...new Set(step.names)].sort(),
      others: [...new Set(others.filter((n) => !step.names.includes(n)))].sort(),
    },
    texts: { sentence },
    facts: [
      `the step: ${step.kind} in ${step.repo}`,
      ...step.what.map((w) => `it deploys: ${w}`),
      `its names: ${[...new Set(step.names)].join(", ")}`,
    ],
  };
}

/** A line of the change: does it say a secret or credential is needed or touched? */
export function secretItem(line: string): JudgeItem {
  return { inputs: { v: 1, line }, texts: { line } };
}

/** The verdicts of a view's items: vetoes, judgments on file, and the judge where it can be asked. */
export async function judgedFor(
  ctx: ReleaseContext,
  spec: JudgeSpec,
  items: JudgeItem[],
): Promise<(item: JudgeItem) => Judged | undefined> {
  const results = items.length
    ? await settle(spec, items, {
        store: ctx.judging.store,
        runtime: ctx.judging.runtime,
        change: ctx.change.id,
        now: new Date(ctx.now),
      })
    : new Map<string, Judged>();
  return (item) => verdictOf(results, spec, item.inputs);
}
