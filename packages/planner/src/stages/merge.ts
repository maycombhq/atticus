import { createHash } from "node:crypto";
import type { FlowRecord } from "@maycombhq/core";
import type { DeltaStep, FlowDelta } from "./schema.js";

/**
 * The version of today's flow a delta is written against (ADR 0111): the sha-256 of its steps'
 * kind, what, to and store, in order. Citations and confirmations are left out, so a rescan that
 * only moves a line doesn't change it; a step added, removed, reworded or moved does.
 */
export function flowBase(flow: Pick<FlowRecord, "steps">): string {
  const steps = flow.steps.map((s) => ({
    kind: s.kind,
    what: s.what,
    to: s.to ? { component: s.to.component, entry: s.to.entry } : null,
    store: s.store ? { table: s.store.table, columns: s.store.columns } : null,
  }));
  return createHash("sha256").update(JSON.stringify(steps)).digest("hex");
}

/** Whether a delta still fits today's flow: same, changed since, or written before the pin. */
export function deltaBase(
  d: FlowDelta,
  today: Pick<FlowRecord, "steps"> | undefined,
): "same" | "changed" | "not-pinned" | undefined {
  if (d.change === "new" || !today) return undefined;
  if (!d.base) return "not-pinned";
  return d.base.steps === flowBase(today) ? "same" : "changed";
}

/** What the merge says when the pin doesn't hold (ADR 0111). */
export function baseProblem(d: FlowDelta, state: ReturnType<typeof deltaBase>): string | undefined {
  if (state === "changed")
    return `Today's flow ${d.flow} changed since this target was written, so its step numbers may point at other steps now. Check them, then run atticus change architecture again.`;
  if (state === "not-pinned")
    return `This target of ${d.flow} was written before target flows were pinned to today's flow, so a change to today's flow can't be seen. Check its step numbers, then run atticus change architecture again to pin it.`;
  return undefined;
}

/**
 * A change's target flow beside today's (ADR 0095): one list of steps, each marked the same,
 * changed, added or removed, with its number in today's flow and in the target flow. A picture
 * draws before and after at once from it; `repeats` is in target-flow numbers throughout.
 */

export type Mark = "same" | "changed" | "added" | "removed";

type FlowStep = FlowRecord["steps"][number];

export interface MergedStep {
  mark: Mark;
  /** Its number in today's flow; none for an added step. */
  today?: number;
  /** Its number in the target flow; none for a removed step. */
  target?: number;
  kind: string;
  what: string;
  to?: { component: string; entry: string; new?: boolean };
  /** migration: the file that changes the table, when the change alters its columns. */
  store?: { table: string; columns: string[]; new?: boolean; migration?: string };
  data?: NonNullable<FlowStep["data"]>;
  repeats?: { from: number; to: number };
  /** Today's citations, on a kept, changed or removed step. */
  evidence: FlowStep["evidence"];
  confirmedBy?: FlowStep["confirmedBy"];
  /** A changed step: what it was today (and where it went, when the change sends it elsewhere). */
  was?: { kind: string; what: string; to?: { component: string; entry: string } };
  /** The delta's reason for this step. */
  why?: string;
}

export interface MergedFlow {
  flow: string;
  repo: string;
  change: FlowDelta["change"];
  name: string;
  why: string;
  component: string;
  trigger: { kind: string; what: string; caller?: FlowRecord["trigger"]["caller"] };
  triggerEvidence: FlowRecord["trigger"]["evidence"];
  steps: MergedStep[];
  counts: { added: number; changed: number; removed: number };
  problems: string[];
}

const fromToday = (s: FlowStep): Omit<MergedStep, "mark"> => ({
  kind: s.kind,
  what: s.what,
  ...(s.to ? { to: s.to } : {}),
  ...(s.store ? { store: s.store } : {}),
  ...(s.data ? { data: s.data } : {}),
  ...(s.repeats ? { repeats: s.repeats } : {}),
  evidence: s.evidence,
  ...(s.confirmedBy ? { confirmedBy: s.confirmedBy } : {}),
});

const fromDelta = (d: DeltaStep): Partial<MergedStep> => ({
  ...(d.kind ? { kind: d.kind } : {}),
  ...(d.what?.trim() ? { what: d.what } : {}),
  ...(d.to
    ? { to: { component: d.to.component, entry: d.to.entry, ...(d.to.new ? { new: true } : {}) } }
    : {}),
  ...(d.store
    ? {
        store: {
          table: d.store.table,
          columns: d.store.columns,
          ...(d.store.new ? { new: true } : {}),
          ...(d.store.migration ? { migration: d.store.migration } : {}),
        },
      }
    : {}),
  // A flow step's data holds the field lists; `as` (which column a sent field is) stays the delta's.
  ...(d.fields
    ? {
        data: Object.fromEntries(Object.entries(d.fields).filter(([k]) => k !== "as")),
      }
    : {}),
  ...(d.repeats ? { repeats: d.repeats } : {}),
  ...(d.why ? { why: d.why } : {}),
});

export function mergeDelta(d: FlowDelta, today: FlowRecord | undefined): MergedFlow {
  const problems: string[] = [];
  const stale = baseProblem(d, deltaBase(d, today));
  if (stale) problems.push(stale);
  const base = {
    flow: d.flow,
    repo: d.repo,
    change: d.change,
    why: d.why,
    name: d.name ?? today?.name ?? d.flow,
    component: today?.component ?? d.flow.split(".")[0]!,
    trigger: today
      ? {
          kind: today.trigger.kind,
          what: today.trigger.what,
          ...(today.trigger.caller ? { caller: today.trigger.caller } : {}),
        }
      : { kind: d.trigger?.kind ?? "endpoint", what: d.trigger?.what ?? d.flow },
    triggerEvidence: today?.trigger.evidence ?? [],
  };
  const steps: MergedStep[] = [];
  /** Steps whose repeats are today's numbers (not the delta's), to move to target numbers. */
  const todayRepeats = new Set<MergedStep>();
  const added = (s: DeltaStep): MergedStep => ({
    mark: "added",
    kind: s.kind ?? "entry",
    what: s.what ?? "",
    evidence: [],
    ...fromDelta(s),
  });

  if (d.change === "new") {
    steps.push(...d.steps.filter((s) => s.op === "add").map(added));
  } else if (!today) {
    problems.push(
      `${d.flow} isn't in ${d.repo}'s spec, so the steps it ${d.change === "remove" ? "removes" : "changes"} can't be shown.`,
    );
  } else if (d.change === "remove") {
    today.steps.forEach((s, i) =>
      steps.push({ mark: "removed", today: i + 1, ...fromToday(s), why: d.why }),
    );
  } else {
    const changes = new Map(d.steps.filter((s) => s.op === "change").map((s) => [s.step, s]));
    const removes = new Map(d.steps.filter((s) => s.op === "remove").map((s) => [s.step, s]));
    const addsAfter = (n: number) =>
      d.steps.filter((s) => s.op === "add" && (s.after ?? 0) === n).map(added);
    steps.push(...addsAfter(0));
    today.steps.forEach((s, i) => {
      const n = i + 1;
      const rm = removes.get(n);
      const ch = changes.get(n);
      if (rm)
        steps.push({
          mark: "removed",
          today: n,
          ...fromToday(s),
          ...(rm.why ? { why: rm.why } : {}),
        });
      else {
        const m: MergedStep = ch
          ? {
              mark: "changed",
              today: n,
              ...fromToday(s),
              ...fromDelta(ch),
              was: {
                kind: s.kind,
                what: s.what,
                ...(s.to &&
                ch.to &&
                (s.to.component !== ch.to.component || s.to.entry !== ch.to.entry)
                  ? { to: { component: s.to.component, entry: s.to.entry } }
                  : {}),
              },
            }
          : { mark: "same", today: n, ...fromToday(s) };
        if (s.repeats && !ch?.repeats) todayRepeats.add(m);
        steps.push(m);
      }
      steps.push(...addsAfter(n));
    });
  }

  // Number the target flow; today's repeats move to target numbers.
  let t = 0;
  const targetOf = new Map<number, number>();
  for (const s of steps)
    if (s.mark !== "removed") {
      s.target = ++t;
      if (s.today !== undefined) targetOf.set(s.today, t);
    }
  for (const s of steps)
    if (s.repeats && s.today !== undefined && s.mark !== "removed" && todayRepeats.has(s)) {
      const from = targetOf.get(s.repeats.from);
      const to = targetOf.get(s.repeats.to);
      if (from !== undefined && to !== undefined) s.repeats = { from, to };
    }

  const count = (m: Mark) => steps.filter((s) => s.mark === m).length;
  return {
    ...base,
    steps,
    counts: { added: count("added"), changed: count("changed"), removed: count("removed") },
    problems,
  };
}
