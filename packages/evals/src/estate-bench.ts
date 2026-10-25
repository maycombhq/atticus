import type { CatalogRecord, FlowRecord } from "@maycombhq/core";
import {
  citedNear,
  referenceSegments,
  specFieldKey,
  specMatching,
  type RefFlowT,
  type RefStepT,
  type ReferenceFlows,
} from "./spec-bench.js";

/**
 * Scoring the estate the facts make (ADR 0124 addendum C-join) against the bench's reference
 * flows (bench/flows/). Where the spec scorer matches each repo's segment of a reference flow on
 * its own, this one follows the drafted flow through the estate's joins, the callee's steps
 * inline at each joined call-out, and matches the reference's steps against that one sequence in
 * order (the longest common subsequence, a step matching as the spec scorer matches one and in
 * the same repo). It also counts the fields at each crossing: what the call-out sends and what
 * the callee returns, against what the estate knows there (the call-out's sends, the request and
 * response schemas of the Interface and of the entry it joins, and the callee flow's returns).
 *
 * The start is a drafted flow the spec scorer's rule matches to the reference's first segment
 * (its trigger cited within 3 lines of the reference's), the one of those matching the most
 * steps; when none matches a step, the flow of the trigger's repo that matches the most stands
 * in and is marked `best`. `strict` counts only flows started by the trigger rule.
 *
 * An error path and a branch are the same step (addendum C-estate): a drafted flow's `errors[]`
 * entry stands in its flow's sequence where its cite falls (after the last step citing the same
 * file at or before its line, else before the first step citing that file, else at the flow's
 * end), and matches a reference `branch` step of its repo cited in the same file within 3 lines.
 * `stepsOnly` is the figure without it: the drafted steps alone, as before.
 */

/** Where a cited file is in the reference's terms: its repo and its path there. */
export type Place = (repo: string, path: string) => { repo: string; path: string };

/**
 * A monorepo whose folders under `prefix` are the reference's repos (microservices-demo's
 * src/<service>/, eShop's src/<Project>/): `src/cartservice/x.cs` is cartservice's `x.cs`.
 */
export const monorepoPlace =
  (prefix: string): Place =>
  (repo, path) => {
    if (!path.startsWith(prefix)) return { repo, path };
    const rest = path.slice(prefix.length);
    const cut = rest.indexOf("/");
    return cut > 0 ? { repo: rest.slice(0, cut), path: rest.slice(cut + 1) } : { repo, path };
  };

export interface EstateFlowsInput {
  /** Each repo's flows (specs/<repo>/, or `estateFromFacts`). */
  specs: readonly { repo: string; flows: readonly FlowRecord[] }[];
  records: readonly CatalogRecord[];
  /** The estate's joins (`atticus estate join`, scanner `joinEstate`). */
  joins: readonly { from: { flow: string; step: number }; to: { flow: string } }[];
  place?: Place;
  /** How many crossings deep to follow (default 5). */
  depth?: number;
}

export interface CrossingScore {
  /** The reference step (from 1) of the call-out. */
  step: number;
  want: number;
  found: number;
  missed: string[];
}

export interface EstateFlowScore {
  flow: string;
  /** The drafted flow it starts at. */
  start?: string;
  startBy?: "trigger" | "best";
  steps: number;
  stepsInOrder: number;
  /** Steps in order matched by the drafted steps alone, no error path counted as a branch. */
  stepsOnly: number;
  /** Reference steps not matched: "<n> <kind> <repo>". */
  missed: string[];
  crossings: CrossingScore[];
}

export interface EstateFlowsScore {
  estate: string;
  flows: EstateFlowScore[];
  total: {
    flows: number;
    started: number;
    startedByTrigger: number;
    steps: number;
    stepsInOrder: number;
    crossingFields: { want: number; found: number };
    /** The same, counting only the flows started by the trigger rule. */
    strict: {
      steps: number;
      stepsInOrder: number;
      crossingFields: { want: number; found: number };
    };
    /** Steps in order without error paths matched as branches: all flows, and the trigger rule's only. */
    stepsOnly: { stepsInOrder: number; strict: number };
  };
}

type Step = FlowRecord["steps"][number];
type FlowErr = FlowRecord["errors"][number];
interface Placed {
  repo: string;
  flow: FlowRecord;
}
interface At {
  repo: string;
  flow: string;
  /** The step's number in its flow, from 1. */
  n: number;
  step: Step;
}
/** A drafted error path in a flow's sequence, where its cite falls. */
interface ErrAt {
  repo: string;
  flow: string;
  error: FlowErr;
}
type Item = At | ErrAt;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Score an estate's flows against its reference flows. */
export function scoreEstateFlows(ref: ReferenceFlows, input: EstateFlowsInput): EstateFlowsScore {
  const place: Place = input.place ?? ((repo, path) => ({ repo, path }));
  const depth = input.depth ?? 5;
  const placeEv = <E extends { repo?: string; path?: string }>(repo: string, ev: E): E =>
    ev.path ? { ...ev, path: place(ev.repo ?? repo, ev.path).path } : ev;
  // A file outside the reference's repos (a monorepo's shared protos/) places nowhere: the step
  // is its flow's, and the flow the first of its trigger's, its steps' or its component's repo.
  const known = new Set(ref.repos);
  const repoOf = (repo: string, ev: readonly { repo?: string; path?: string }[]) => {
    const r = ev[0]?.path ? place(ev[0].repo ?? repo, ev[0].path).repo : undefined;
    return r && known.has(r) ? r : undefined;
  };

  // ---- every flow and record in the reference's terms
  const flows = new Map<string, Placed>();
  const stepRepo = new Map<string, string>(); // flow#n -> repo
  const errRepo = new Map<string, string>(); // flow!n -> repo
  for (const s of input.specs)
    for (const f of s.flows) {
      const home =
        repoOf(s.repo, f.trigger.evidence) ??
        f.steps.map((x) => repoOf(s.repo, x.evidence)).find((x) => !!x) ??
        (known.has(f.component) ? f.component : s.repo);
      const flow: FlowRecord = {
        ...f,
        trigger: { ...f.trigger, evidence: f.trigger.evidence.map((e) => placeEv(s.repo, e)) },
        steps: f.steps.map((x, i) => {
          stepRepo.set(`${f.id}#${i + 1}`, repoOf(s.repo, x.evidence) ?? home);
          return { ...x, evidence: x.evidence.map((e) => placeEv(s.repo, e)) };
        }),
        errors: f.errors.map((x, i) => {
          errRepo.set(`${f.id}!${i}`, repoOf(s.repo, x.evidence) ?? home);
          return { ...x, evidence: x.evidence.map((e) => placeEv(s.repo, e)) };
        }),
      };
      flows.set(f.id, { repo: home, flow });
    }
  const records = input.records.map(
    (r) =>
      ({
        ...r,
        evidence: r.evidence.map((e) => placeEv(e.repo ?? "", e)),
      }) as CatalogRecord,
  );
  const byRepo = new Map<string, FlowRecord[]>();
  for (const p of [...flows.values()].sort((a, b) => cmp(a.flow.id, b.flow.id)))
    byRepo.set(p.repo, [...(byRepo.get(p.repo) ?? []), p.flow]);
  const m = specMatching(
    [...byRepo.entries()].map(([repo, fs]) => ({ repo, flows: fs })),
    records,
  );
  const byId = new Map(records.map((r) => [r.id, r]));

  /** Where each error path stands: the index of the step it goes before (the length: at the end). */
  const errorSlots = (flow: FlowRecord): Map<number, ErrAt[]> => {
    const slots = new Map<number, { line: number; k: number; at: ErrAt }[]>();
    flow.errors.forEach((error, k) => {
      const cite = error.evidence.find((e) => e.path && e.line !== undefined);
      let slot = flow.steps.length;
      if (cite) {
        let after = -1;
        let first = -1;
        flow.steps.forEach((s, i) => {
          const lines = s.evidence.flatMap((e) =>
            e.path === cite.path && e.line !== undefined ? [e.line] : [],
          );
          if (!lines.length) return;
          if (first < 0) first = i;
          if (lines.some((l) => l <= cite.line!)) after = i;
        });
        slot = after >= 0 ? after + 1 : first >= 0 ? first : flow.steps.length;
      }
      const at: ErrAt = { repo: errRepo.get(`${flow.id}!${k}`)!, flow: flow.id, error };
      slots.set(slot, [...(slots.get(slot) ?? []), { line: cite?.line ?? 0, k, at }]);
    });
    return new Map(
      [...slots.entries()].map(([i, xs]) => [
        i,
        xs.sort((x, y) => x.line - y.line || x.k - y.k).map((x) => x.at),
      ]),
    );
  };

  // ---- a flow followed through the joins
  const joinAt = new Map(input.joins.map((j) => [`${j.from.flow}#${j.from.step}`, j.to.flow]));
  const expand = (id: string, path: string[], errors: boolean): Item[] => {
    const f = flows.get(id);
    if (!f) return [];
    const slots = errors ? errorSlots(f.flow) : new Map<number, ErrAt[]>();
    return [
      ...f.flow.steps.flatMap((step, i): Item[] => {
        const here: At = { repo: stepRepo.get(`${id}#${i + 1}`)!, flow: id, n: i + 1, step };
        const to = joinAt.get(`${id}#${i + 1}`);
        const before = slots.get(i) ?? [];
        return to && !path.includes(to) && path.length <= depth
          ? [...before, here, ...expand(to, [...path, to], errors)]
          : [...before, here];
      }),
      ...(slots.get(f.flow.steps.length) ?? []),
    ];
  };
  const lcs = (a: readonly RefStepT[], b: readonly Item[]) => {
    const ok = (r: RefStepT, x: Item) =>
      r.repo === x.repo &&
      ("step" in x
        ? m.stepMatch(r, x.step)
        : r.kind === "branch" && citedNear(r.at, x.error.evidence));
    const t = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--)
      for (let j = b.length - 1; j >= 0; j--)
        t[i]![j] = ok(a[i]!, b[j]!)
          ? t[i + 1]![j + 1]! + 1
          : Math.max(t[i + 1]![j]!, t[i]![j + 1]!);
    const pairs = new Map<number, Item>();
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (ok(a[i]!, b[j]!) && t[i]![j] === t[i + 1]![j + 1]! + 1) {
        pairs.set(i, b[j]!);
        i++;
        j++;
      } else if (t[i + 1]![j]! >= t[i]![j + 1]!) i++;
      else j++;
    }
    return pairs;
  };

  /** Every field name the estate knows at a call-out: sends, schemas of the Interface and its entry, the callee's returns. */
  const knownAt = (x: At): Set<string> => {
    const names: string[] = [...(x.step.data?.sends ?? [])];
    const schema = (id: string) => {
      const r = byId.get(id);
      if (r?.kind === "Schema") names.push(...r.fields.map((f) => f.name));
    };
    for (const ref of x.step.refs) {
      for (const r of records) if (r.kind === "Schema" && r.ref === ref) schema(r.id);
      const i = byId.get(ref);
      const ep = i?.kind === "Interface" && i.endpoint ? byId.get(i.endpoint) : undefined;
      if (ep?.kind === "Endpoint") for (const s of ep.schemaRefs) schema(s);
    }
    const callee = joinAt.get(`${x.flow}#${x.n}`);
    for (const s of callee ? (flows.get(callee)?.flow.steps ?? []) : [])
      if (s.kind === "respond") names.push(...(s.data?.returns ?? []));
    return new Set(names.map(specFieldKey));
  };

  // The figure without error paths (the steps alone) is scored the same way, start and all.
  const alone = ref.flows.map((rf) => scoreOne(rf, false));
  const scored = ref.flows.map((rf, k): EstateFlowScore => {
    const { flow, start, startBy, steps, stepsInOrder, missed, crossings } = scoreOne(rf, true);
    return {
      flow,
      ...(start ? { start, startBy } : {}),
      steps,
      stepsInOrder,
      stepsOnly: alone[k]!.stepsInOrder,
      missed,
      crossings,
    };
  });
  function scoreOne(rf: RefFlowT, errors: boolean): Omit<EstateFlowScore, "stepsOnly"> {
    const [first] = referenceSegments(rf);
    /** The flow of these that matches the most steps (at least one), first in id order on a tie. */
    const most = (fs: readonly FlowRecord[]) => {
      let best: { id: string; pairs: Map<number, Item> } | undefined;
      for (const f of fs) {
        const p = lcs(rf.steps, expand(f.id, [f.id], errors));
        if (p.size > (best?.pairs.size ?? 0)) best = { id: f.id, pairs: p };
      }
      return best;
    };
    // The trigger rule's flows (routes on neighbouring lines can all be near the reference's),
    // the one matching most steps; else the trigger's repo's flow matching most, marked best.
    const byTrigger = first ? most(m.matchFlows(first)) : undefined;
    const found = byTrigger ?? most(byRepo.get(rf.trigger.repo) ?? []);
    const start = found?.id;
    const startBy: EstateFlowScore["startBy"] = byTrigger ? "trigger" : found ? "best" : undefined;
    const pairs = found?.pairs ?? new Map<number, Item>();
    const crossings: CrossingScore[] = [];
    rf.steps.forEach((s, k) => {
      if (!s.to || s.to.repo === s.repo) return;
      const want = new Map<string, string>();
      for (const f of s.data?.sends ?? [])
        if (!want.has(specFieldKey(f))) want.set(specFieldKey(f), f);
      for (let j = k + 1; j < rf.steps.length && rf.steps[j]!.repo !== s.repo; j++) {
        const r = rf.steps[j]!;
        if (r.repo === s.to.repo && r.kind === "respond")
          for (const f of r.data?.returns ?? [])
            if (!want.has(specFieldKey(f))) want.set(specFieldKey(f), f);
      }
      const x = pairs.get(k);
      const known = x && "step" in x ? knownAt(x) : new Set<string>();
      const missed = [...want.entries()].filter(([key]) => !known.has(key)).map(([, f]) => f);
      crossings.push({ step: k + 1, want: want.size, found: want.size - missed.length, missed });
    });
    return {
      flow: rf.id,
      ...(start ? { start, startBy } : {}),
      steps: rf.steps.length,
      stepsInOrder: pairs.size,
      missed: rf.steps.flatMap((s, k) => (pairs.has(k) ? [] : [`${k + 1} ${s.kind} ${s.repo}`])),
      crossings,
    };
  }

  const sum = (fs: EstateFlowScore[], f: (x: EstateFlowScore) => number) =>
    fs.reduce((n, x) => n + f(x), 0);
  /** The crossing fields all the flows want, and those the given flows found. */
  const fields = (fs: EstateFlowScore[], all: EstateFlowScore[]) => ({
    want: sum(all, (x) => x.crossings.reduce((n, c) => n + c.want, 0)),
    found: sum(fs, (x) => x.crossings.reduce((n, c) => n + c.found, 0)),
  });
  const strict = scored.filter((f) => f.startBy === "trigger");
  const strictAlone = alone.filter((f) => f.startBy === "trigger");
  return {
    estate: ref.estate,
    flows: scored,
    total: {
      flows: scored.length,
      started: scored.filter((f) => f.start).length,
      startedByTrigger: strict.length,
      steps: sum(scored, (f) => f.steps),
      stepsInOrder: sum(scored, (f) => f.stepsInOrder),
      crossingFields: fields(scored, scored),
      strict: {
        steps: sum(scored, (f) => f.steps),
        stepsInOrder: sum(strict, (f) => f.stepsInOrder),
        crossingFields: fields(strict, scored),
      },
      stepsOnly: {
        stepsInOrder: alone.reduce((n, x) => n + x.stepsInOrder, 0),
        strict: strictAlone.reduce((n, x) => n + x.stepsInOrder, 0),
      },
    },
  };
}
