import { parse } from "yaml";
import { z } from "zod";
import type { CatalogRecord, FlowRecord } from "@maycombhq/core";
import { normalizePath } from "./bench.js";

/**
 * Scoring drafted repo specs (ADR 0079) against the bench's reference flows (bench/flows/,
 * written by reading the code). A reference flow crosses repos; a drafted spec is one repo's,
 * so each reference flow is cut into segments, one per run of steps in one repo, and each
 * segment is matched to a drafted flow of that repo.
 *
 * How things match (deterministic, documented in bench/flows/README.md's terms):
 * - A segment matches a drafted flow of its repo when the drafted trigger, its entry step, or
 *   the catalog entry point of its trigger or a family member cites the same file within 3
 *   lines of where the segment starts (the reference trigger for
 *   the first segment, its first step for a later one), or when the segment is entered
 *   through a call-out to "METHOD /path" and the drafted trigger (or a family member) is that
 *   entry point: same method, and one path ends with the other once parameters are `{}`.
 * - Two steps match when they are of the same kind and one of: they cite the same file within
 *   3 lines; they name the same table; a call-out names the same entry point; or their `what`
 *   share at least half their words (Jaccard, words of 3 letters or more, common words left
 *   out). Steps are matched in order: the longest common subsequence under that rule.
 * - Tables named: the reference's tables (store.table) the drafted flow names too, by name
 *   (a drafted Table id is resolved to its name through the catalog). Fields named: field
 *   names in data (not `checks`, which are rules) and store, compared on their last dotted
 *   part, case, _ and - aside.
 * - A citation is correct when a matched drafted step cites the reference step's file within
 *   3 lines of its line.
 */

const At = z.string().regex(/^[^\s:]+:\d+$/, "at must be path:line");
const Data = z.record(z.string(), z.array(z.string())).optional();
const RefStep = z.strictObject({
  kind: z.string().min(1),
  repo: z.string().min(1),
  what: z.string().min(1),
  to: z.strictObject({ repo: z.string().min(1), entry: z.string().min(1) }).optional(),
  data: Data,
  store: z
    .strictObject({ table: z.string().min(1), fields: z.array(z.string()).default([]) })
    .optional(),
  at: At,
});
const RefFlow = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  trigger: z.strictObject({
    kind: z.string().min(1),
    repo: z.string().min(1),
    what: z.string().min(1),
    at: At,
  }),
  steps: z.array(RefStep).min(1),
  errors: z
    .array(
      z.strictObject({ repo: z.string().optional(), when: z.string(), then: z.string(), at: At }),
    )
    .default([]),
});
const EstateFlows = z.strictObject({
  estate: z.string().min(1),
  repos: z.array(z.string().min(1)).min(1),
  notes: z.string().optional(),
  flows: z.array(RefFlow).min(1),
});
export type ReferenceFlows = z.infer<typeof EstateFlows>;
export type RefStepT = z.infer<typeof RefStep>;
export type RefFlowT = z.infer<typeof RefFlow>;

/** Parse bench/flows/<estate>.yaml. Throws with every problem on one line. */
export function parseReferenceFlows(text: string): ReferenceFlows {
  const r = EstateFlows.safeParse(parse(text));
  if (!r.success)
    throw new Error(
      r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
    );
  return r.data;
}

export interface SegmentScore {
  repo: string;
  /** The drafted flow it matched. */
  matched?: string;
  steps: number;
  stepsMatched: number;
  /** Matched steps whose drafted citation is within 3 lines of the reference's. */
  citationsCorrect: number;
}

export interface Ratio {
  want: number;
  found: number;
}

export interface FlowScore {
  flow: string;
  /** The first segment (the reference's trigger) has a drafted flow. */
  triggerCovered: boolean;
  segments: SegmentScore[];
  steps: number;
  stepsMatched: number;
  tables: Ratio & { missed: string[] };
  fields: Ratio;
  citations: { checked: number; correct: number };
}

export interface EstateSpecScore {
  estate: string;
  flows: FlowScore[];
  total: {
    flows: number;
    triggersCovered: number;
    segments: number;
    segmentsCovered: number;
    steps: number;
    stepsMatched: number;
    tables: Ratio;
    fields: Ratio;
    citations: { checked: number; correct: number };
    /**
     * With the estate pass (ADR 0085): the reference flows that cross repos (`want`) and those
     * reached end to end through the joins (`found`, listed in `reached`).
     */
    endToEnd?: Ratio & { reached: string[] };
  };
}

const NEAR = 3;
const STOP = new Set([
  "the",
  "and",
  "with",
  "for",
  "from",
  "into",
  "its",
  "are",
  "that",
  "this",
  "then",
  "each",
  "when",
  "which",
  "their",
  "has",
  "have",
  "was",
  "were",
  "not",
  "any",
  "all",
  "one",
  "out",
]);
const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOP.has(w)),
  );
/** Jaccard similarity of two sentences' content words. */
export function whatSimilarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (x.size === 0 || y.size === 0) return 0;
  const both = [...x].filter((w) => y.has(w)).length;
  return both / (x.size + y.size - both);
}

const fieldKey = (f: string) =>
  f
    .split(".")
    .pop()!
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
const tableKey = (t: string) =>
  t
    .toLowerCase()
    .split(".")
    .pop()!
    .replace(/["`[\]]/g, "");

const splitAt = (a: string) => {
  const cut = a.lastIndexOf(":");
  return { path: a.slice(0, cut), line: Number(a.slice(cut + 1)) };
};
const near = (a: string, ev: readonly { path?: string; line?: number }[]) => {
  const r = splitAt(a);
  return ev.some(
    (e) => e.path === r.path && e.line !== undefined && Math.abs(e.line - r.line) <= NEAR,
  );
};
/** Whether evidence cites a reference's `path:line` in the same file within 3 lines (the step rule's window). */
export const citedNear = near;

/** "METHOD /path" as compared: method upper case, path normalised and lower case. */
const entryOf = (s: string) => {
  const m = /^([A-Za-z]+)\s+(\S+)$/.exec(s.trim());
  return m
    ? { method: m[1]!.toUpperCase(), path: normalizePath(m[2]!).toLowerCase() }
    : { method: undefined, path: s.trim().toLowerCase() };
};
const sameEntry = (
  a: { method?: string | undefined; path: string },
  b: { method?: string | undefined; path: string },
) =>
  (!a.method || !b.method || a.method === b.method) &&
  (a.path === b.path || a.path.endsWith(b.path) || b.path.endsWith(a.path)) &&
  Math.min(a.path.length, b.path.length) > 1;

export interface Segment {
  repo: string;
  /** Where it starts: the reference trigger or the segment's first step. */
  start: string;
  /** The entry point a call-out into it names. */
  entry?: string;
  steps: RefStepT[];
}

function segments(f: z.infer<typeof RefFlow>): Segment[] {
  const out: Segment[] = [];
  let prev: RefStepT | undefined;
  for (const s of f.steps) {
    const last = out.at(-1);
    if (last && last.repo === s.repo) last.steps.push(s);
    else
      out.push({
        repo: s.repo,
        start: out.length === 0 && s.repo === f.trigger.repo ? f.trigger.at : s.at,
        ...(prev?.to && prev.to.repo === s.repo ? { entry: prev.to.entry } : {}),
        steps: [s],
      });
    prev = s;
  }
  // A trigger in a repo the first step isn't in still starts the flow there.
  if (out[0] && out[0].repo !== f.trigger.repo)
    out.unshift({ repo: f.trigger.repo, start: f.trigger.at, steps: [] });
  return out;
}

type Drafted = readonly { repo: string; flows: readonly FlowRecord[] }[];

/**
 * The estate pass's input to the score (ADR 0085): the specs of the estate's repos scanned
 * together, that scan's catalog, and the joins `atticus estate join` wrote.
 */
export interface EstatePassInput {
  specs: Drafted;
  records: readonly CatalogRecord[];
  joins: readonly { from: { flow: string }; to: { flow: string } }[];
}

/**
 * Score the drafted specs of an estate's repos against its reference flows. With the estate
 * pass, also count the reference flows that cross repos and are reached end to end: the
 * drafted flow of the trigger's segment reaches, through joins, a drafted flow matching every
 * later segment.
 */
export function scoreSpecs(
  ref: ReferenceFlows,
  drafted: Drafted,
  records: readonly CatalogRecord[] = [],
  estate?: EstatePassInput,
): EstateSpecScore {
  const m = matching(drafted, records);
  const flows = ref.flows.map((rf) => scoreFlow(rf, m));
  const sum = (f: (x: FlowScore) => number) => flows.reduce((n, x) => n + f(x), 0);
  let endToEnd: EstateSpecScore["total"]["endToEnd"];
  if (estate) {
    const e = matching(estate.specs, estate.records);
    const next = new Map<string, string[]>();
    for (const j of estate.joins)
      next.set(j.from.flow, [...(next.get(j.from.flow) ?? []), j.to.flow]);
    const reach = (start: string) => {
      const seen = new Set([start]);
      const todo = [start];
      while (todo.length)
        for (const n of next.get(todo.pop()!) ?? [])
          if (!seen.has(n)) {
            seen.add(n);
            todo.push(n);
          }
      return seen;
    };
    const crossing = ref.flows.filter((rf) => new Set(segments(rf).map((s) => s.repo)).size > 1);
    const reached: string[] = [];
    for (const rf of crossing) {
      const [first, ...rest] = segments(rf);
      const start = first && e.matchFlow(first);
      if (!start) continue;
      const r = reach(start.id);
      if (rest.every((seg) => r.has(e.matchFlow(seg)?.id ?? ""))) reached.push(rf.id);
    }
    endToEnd = { want: crossing.length, found: reached.length, reached };
  }
  return {
    estate: ref.estate,
    flows,
    total: {
      flows: flows.length,
      triggersCovered: flows.filter((f) => f.triggerCovered).length,
      segments: sum((f) => f.segments.length),
      segmentsCovered: sum((f) => f.segments.filter((s) => s.matched).length),
      steps: sum((f) => f.steps),
      stepsMatched: sum((f) => f.stepsMatched),
      tables: { want: sum((f) => f.tables.want), found: sum((f) => f.tables.found) },
      fields: { want: sum((f) => f.fields.want), found: sum((f) => f.fields.found) },
      citations: {
        checked: sum((f) => f.citations.checked),
        correct: sum((f) => f.citations.correct),
      },
      ...(endToEnd ? { endToEnd } : {}),
    },
  };
}

/** How segments and steps match drafted flows, over one set of specs and its catalog. */
function matching(drafted: Drafted, records: readonly CatalogRecord[]) {
  const byId = new Map(records.map((r) => [r.id, r]));
  const tableName = (id: string) => {
    const r = byId.get(id);
    return tableKey(r?.kind === "Table" ? r.name : id);
  };
  const endpointOf = (id: string | undefined) => {
    const r = id ? byId.get(id) : undefined;
    return r?.kind === "Endpoint"
      ? {
          method: r.method?.toUpperCase(),
          path: r.pathOrTopic.includes("/")
            ? normalizePath(r.pathOrTopic).toLowerCase()
            : r.pathOrTopic.toLowerCase(),
        }
      : undefined;
  };
  const flowsOf = (repo: string) => drafted.find((d) => d.repo === repo)?.flows ?? [];

  /** Every drafted flow the rule matches to a segment, in the specs' order; the first is the match. */
  const matchFlows = (seg: Segment): FlowRecord[] => {
    const cands = flowsOf(seg.repo);
    // A family member's (or the trigger's) catalog entry point cited where the segment starts.
    const cites = (id: string) => {
      const r = byId.get(id);
      return !!r && near(seg.start, r.evidence);
    };
    const byCite = cands.filter(
      (f) =>
        near(seg.start, f.trigger.evidence) ||
        f.steps.some((s) => s.kind === "entry" && near(seg.start, s.evidence)) ||
        [f.trigger.ref, ...f.family].some((id) => !!id && cites(id)),
    );
    if (byCite.length || !seg.entry) return byCite;
    const want = entryOf(seg.entry);
    return cands.filter((f) =>
      [f.trigger.ref, ...f.family].some((id) => {
        const e = endpointOf(id);
        return !!e && sameEntry(want, e);
      }),
    );
  };
  const matchFlow = (seg: Segment): FlowRecord | undefined => matchFlows(seg)[0];
  const stepMatch = (r: RefStepT, d: FlowRecord["steps"][number]) => {
    if (r.kind !== d.kind) return false;
    if (near(r.at, d.evidence)) return true;
    if (r.store && d.store && tableKey(r.store.table) === tableName(d.store.table)) return true;
    if (r.to && d.to) {
      const want = entryOf(r.to.entry);
      const got = endpointOf(d.to.entry) ?? entryOf(d.to.entry);
      if (sameEntry(want, got)) return true;
    }
    return whatSimilarity(r.what, d.what) >= 0.5;
  };
  /** Longest common subsequence of matching steps: the matched pairs, in order. */
  const lcs = (a: RefStepT[], b: FlowRecord["steps"]) => {
    const n = a.length;
    const m = b.length;
    const t = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        t[i]![j] = stepMatch(a[i]!, b[j]!)
          ? t[i + 1]![j + 1]! + 1
          : Math.max(t[i + 1]![j]!, t[i]![j + 1]!);
    const pairs: [RefStepT, FlowRecord["steps"][number]][] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (stepMatch(a[i]!, b[j]!) && t[i]![j] === t[i + 1]![j + 1]! + 1) {
        pairs.push([a[i]!, b[j]!]);
        i++;
        j++;
      } else if (t[i + 1]![j]! >= t[i]![j + 1]!) i++;
      else j++;
    }
    return pairs;
  };
  return { matchFlow, matchFlows, lcs, tableName, stepMatch };
}

/** One reference flow scored against the drafted flows. */
function scoreFlow(rf: z.infer<typeof RefFlow>, m: ReturnType<typeof matching>): FlowScore {
  const { matchFlow, lcs, tableName } = m;
  const segs = segments(rf);
  const scored: SegmentScore[] = [];
  const wantTables = new Set<string>();
  const gotTables = new Set<string>();
  const wantFields = new Set<string>();
  const gotFields = new Set<string>();
  let checked = 0;
  let correct = 0;
  for (const seg of segs) {
    for (const s of seg.steps) {
      if (s.store) {
        wantTables.add(tableKey(s.store.table));
        for (const x of s.store.fields) wantFields.add(fieldKey(x));
      }
      for (const [k, v] of Object.entries(s.data ?? {}))
        if (k !== "checks") for (const x of v) wantFields.add(fieldKey(x));
    }
    const d = matchFlow(seg);
    if (!d) {
      scored.push({
        repo: seg.repo,
        steps: seg.steps.length,
        stepsMatched: 0,
        citationsCorrect: 0,
      });
      continue;
    }
    for (const s of d.steps) {
      if (s.store) {
        gotTables.add(tableName(s.store.table));
        for (const x of s.store.columns) gotFields.add(fieldKey(x));
      }
      for (const [k, v] of Object.entries(s.data ?? {}))
        if (k !== "checks") for (const x of v ?? []) gotFields.add(fieldKey(x));
    }
    const pairs = lcs(seg.steps, d.steps);
    const right = pairs.filter(([r, x]) => near(r.at, x.evidence)).length;
    checked += pairs.length;
    correct += right;
    scored.push({
      repo: seg.repo,
      matched: d.id,
      steps: seg.steps.length,
      stepsMatched: pairs.length,
      citationsCorrect: right,
    });
  }
  const steps = scored.reduce((n, s) => n + s.steps, 0);
  return {
    flow: rf.id,
    triggerCovered: !!scored[0]?.matched,
    segments: scored,
    steps,
    stepsMatched: scored.reduce((n, s) => n + s.stepsMatched, 0),
    tables: {
      want: wantTables.size,
      found: [...wantTables].filter((t) => gotTables.has(t)).length,
      missed: [...wantTables].filter((t) => !gotTables.has(t)).sort(),
    },
    fields: {
      want: wantFields.size,
      found: [...wantFields].filter((f) => gotFields.has(f)).length,
    },
    citations: { checked, correct },
  };
}

/** For the estate scorer (estate-bench.ts): the same segments, matching and field names. */
export { segments as referenceSegments, matching as specMatching, fieldKey as specFieldKey };
