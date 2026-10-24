import {
  judgmentKey,
  makeJudgment,
  type JudgmentStore,
  type JudgmentConfirmer,
} from "@maycombhq/core";
import { judge, STATES_VALUE_SPEC, type AiRuntime, type JudgeItem } from "@maycombhq/ai";
import type { LeadTimeDays, ValueClaim } from "./grounding.js";

/**
 * The values a knowledge item states that no check settles (ADR 0117): a judge decides whether
 * the words cited state them, where the runtime can call a model directly; with a hand-off a
 * value (a lead time, a date) must be the page's words, and a reading (a status, a normalised
 * lead time) is kept as the model's, with its run. Either way the verdict is kept in the
 * judgments store, and each item's normalised lead time is kept under judgments/lead-time/ for
 * the steps that plan by it (needs, initiatives, the next-step list).
 */

/** The kind under which a normalised lead time is kept. */
export const LEAD_TIME = "lead-time";

/** What a normalised lead time is keyed by: the item and its lead time as the page says it. */
export const leadTimeInputs = (item: string, leadTime: string) => ({
  v: 1,
  item,
  leadTime: leadTime.trim(),
});

/** An item's normalised lead time, when one is kept and its words are the ones it was read from. */
export async function leadTimeDaysOf(
  store: JudgmentStore,
  item: string,
  leadTime: string | undefined,
): Promise<LeadTimeDays | undefined> {
  if (!leadTime?.trim()) return undefined;
  const j = await store.get(LEAD_TIME, judgmentKey(LEAD_TIME, leadTimeInputs(item, leadTime)));
  const v = j?.value as Partial<LeadTimeDays> | undefined;
  return v && typeof v.min === "number" && typeof v.max === "number" && v.unit
    ? { min: v.min, max: v.max, unit: v.unit }
    : undefined;
}

interface Claimed {
  item: { id: string; lead_time?: string | undefined; lead_time_days?: LeadTimeDays | undefined };
  claims: ValueClaim[];
}

/** Fields whose value must be the page's words when no judge can read them. */
const VALUES = (field: string) => field === "lead_time" || field.startsWith("dates.");

const inputsOf = (id: string, c: ValueClaim) => ({
  v: 1,
  item: id,
  field: c.field,
  value: c.value,
  span: c.span,
});

/**
 * Settle the claims of the items kept: the problems of each item a claim fails for (it is
 * handed back), by item id. Each settled claim and each normalised lead time is stored.
 */
export async function settleClaims(
  items: Claimed[],
  o: { runtime: AiRuntime; store: JudgmentStore; run: string; now: Date },
): Promise<Map<string, string[]>> {
  const at = o.now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const judging = o.runtime.kind !== "hand-off" && o.runtime.kind !== "mock";
  const out = new Map<string, string[]>();
  const fail = (id: string, p: string) => out.set(id, [...(out.get(id) ?? []), p]);
  const verdicts = new Map<string, { verdict: string; by: JudgmentConfirmer }>();
  const ask: JudgeItem[] = [];
  for (const c of items)
    for (const cl of c.claims) {
      const inputs = inputsOf(c.item.id, cl);
      const key = judgmentKey(STATES_VALUE_SPEC.kind, inputs);
      const stored = await o.store.get(STATES_VALUE_SPEC.kind, key);
      if (stored && typeof stored.verdict === "string") {
        verdicts.set(key, { verdict: stored.verdict, by: stored.confirmedBy });
        continue;
      }
      if (judging)
        ask.push({
          inputs,
          texts: { span: cl.span },
          facts: [`field: ${cl.field}`, `value: ${cl.value}`],
        });
      else if (!VALUES(cl.field)) {
        // A reading the model made in its own answer: kept as its, with its run.
        const by: JudgmentConfirmer = { by: "ai", run: o.run };
        await o.store.put(
          makeJudgment({
            kind: STATES_VALUE_SPEC.kind,
            inputs,
            verdict: "yes",
            quotes: [{ of: "span", text: cl.span }],
            why: "The reading the knowledge scan gave with the words it cited.",
            confirmedBy: by,
            at,
          }),
        );
        verdicts.set(key, { verdict: "yes", by });
      }
    }
  if (ask.length) {
    const r = await judge(STATES_VALUE_SPEC, ask, {
      runtime: o.runtime,
      store: o.store,
      change: "knowledge-scan",
      now: o.now,
    });
    for (const [k, v] of r.results)
      verdicts.set(k, {
        verdict: v.verdict,
        by: v.judgment?.confirmedBy ?? { by: "check", rule: "veto" },
      });
  }
  for (const c of items) {
    let daysBy: JudgmentConfirmer | undefined;
    for (const cl of c.claims) {
      const v = verdicts.get(judgmentKey(STATES_VALUE_SPEC.kind, inputsOf(c.item.id, cl)));
      if (v?.verdict === "yes") {
        if (cl.field === "lead_time_days") daysBy = v.by;
        continue;
      }
      fail(
        c.item.id,
        v === undefined
          ? `${cl.field} "${cl.value}" isn't word for word in "${cl.span}": write it as the page says it`
          : `${cl.field} "${cl.value}": the words "${cl.span}" don't state it (a judge read them${v.verdict === "unsure" ? " and couldn't tell" : ""}); quote the words that do`,
      );
    }
    const days = c.item.lead_time_days;
    if (days && daysBy && c.item.lead_time && !out.has(c.item.id))
      await o.store.put(
        makeJudgment({
          kind: LEAD_TIME,
          inputs: leadTimeInputs(c.item.id, c.item.lead_time),
          verdict: "normalised",
          value: days,
          confirmedBy: daysBy,
          at,
        }),
      );
  }
  return out;
}
