import {
  DEFAULT_SPEC_TEMPLATE,
  normalizePath,
  type SpecTemplate,
  type CatalogRecord,
  type EstateJoin,
  type EstateJoins,
  type EstateUnmatched,
  type EvidenceT,
  type FlowRecord,
  type RecordOf,
} from "@maycombhq/core";
import { familyMismatches, fieldKey, pathScore, repoComponents } from "./spec-check.js";

/**
 * The estate pass (ADR 0085), deterministic: each call-out (or publish) of a repo's flows is
 * matched to the flow its target starts, through the catalog's Interfaces (and their gateway
 * routes), or by method and normalised path on the target component when there is no
 * Interface. A join needs a citation at both ends: the caller's step and the callee's trigger.
 * A step whose target the catalog doesn't have (a relative call's guessed name, or a loose end)
 * joins the only entry point that serves its method and normalised path, of the caller's own
 * repo first, then of the estate, and is said to be inferred; two or more is a question for a
 * person (ADR 0124 addendum C-join, the join fallback).
 * Joined flows are then followed across repos (`estateFlow`), and a field along them from the
 * step that sends it to the column a write stores it in (`fieldLineage`).
 */

type Endpoint = RecordOf<"Endpoint">;
type Interface = RecordOf<"Interface">;
type FlowStep = FlowRecord["steps"][number];

export interface EstateSpec {
  repo: string;
  flows: readonly FlowRecord[];
}

export interface JoinEstateInput {
  specs: readonly EstateSpec[];
  records: readonly CatalogRecord[];
  /**
   * Whether a cited line exists in the repo. Leave it out to accept any file and line (the
   * CLI checks the clones it has).
   */
  cited?: (repo: string, path: string, line: number) => Promise<boolean>;
  /**
   * The spec template of each repo's spec, by repo id, for the family rule spec check applies
   * (ADR 0088). A repo left out uses the default template.
   */
  templates?: Readonly<Record<string, SpecTemplate>>;
  /**
   * The component a person named for a call-out whose target the catalog doesn't have, by
   * `<flow id>#<step>` (the answer to an `asks` question).
   */
  targets?: Readonly<Record<string, string>>;
}

/** Where a caller's step is: its repo, flow and step (1-based). */
export interface EstateStepRef {
  repo: string;
  flow: string;
  step: number;
}

/**
 * A join made though the step names a target the catalog doesn't have (a relative call whose
 * reader guessed a name, or a loose end): by method and path to the only entry point of the
 * caller's own repo (`repo`), else of the estate (`estate`), that serves it, or through the
 * Interface the estate join made from the caller (`interface`). ADR 0124 addendum C-join.
 */
export interface EstateInferred {
  from: EstateStepRef;
  /** The target the step names. */
  named: string;
  within: "repo" | "estate" | "interface";
  message: string;
}

/** A call-out that two or more components could answer: a person says which, never a guess. */
export interface EstateAsk {
  from: EstateStepRef & { evidence?: string };
  /** The caller's component. */
  caller: string;
  named: string;
  /** METHOD /path as the step writes it. */
  what: string;
  /** The components that serve it, sorted. */
  candidates: string[];
}

export interface JoinEstateResult {
  joins: EstateJoin[];
  unmatched: EstateUnmatched[];
  /** The joins made though the step's target isn't in the catalog: each is inferred. */
  inferred: EstateInferred[];
  asks: EstateAsk[];
}

/** The key of a caller's step in `JoinEstateInput.targets`. */
export const estateStepKey = (flow: string, step: number) => `${flow}#${step}`;

const at = (e: EvidenceT | undefined) =>
  e?.path && e.line !== undefined ? `${e.path}:${e.line}` : undefined;

/** "METHOD /path" as written in a step's `to.entry`, else the bare route or topic. */
function parseEntry(s: string): { method?: string; path: string } {
  const m = /^([A-Za-z]+)\s+(\S+)$/.exec(s.trim());
  return m ? { method: m[1]!.toUpperCase(), path: m[2]! } : { path: s.trim() };
}

const segs = (p: string) => normalizePath(p).toLowerCase().split("/").filter(Boolean);

const sameMethod = (a: string | undefined, b: string | undefined) =>
  !a || !b || a.toUpperCase() === b.toUpperCase();

/** Join every call-out of the specs to the flow its target starts, or say why not. */
export async function joinEstate(o: JoinEstateInput): Promise<JoinEstateResult> {
  const byId = new Map(o.records.map((r) => [r.id, r]));
  const endpoints = o.records.filter((r): r is Endpoint => r.kind === "Endpoint");
  const interfaces = o.records.filter((r): r is Interface => r.kind === "Interface");
  const flows = o.specs.flatMap((s) => s.flows.map((f) => ({ repo: s.repo, flow: f })));
  const cited = async (repo: string, ev: EvidenceT | undefined) =>
    !!ev?.path &&
    ev.line !== undefined &&
    (!o.cited || (await o.cited(ev.repo ?? repo, ev.path, ev.line)));

  /** The paths an Interface's call arrives on: its own, and without its gateway's base path. */
  const arrivals = (i: Interface): string[] => {
    const out = [i.normalizedPath];
    const route = i.route ? byId.get(i.route) : undefined;
    if (route?.kind === "GatewayRoute") {
      const base = segs(route.basepath);
      const p = segs(i.normalizedPath);
      if (base.length && base.every((s, k) => p[k] === s))
        out.push(`/${p.slice(base.length).join("/")}`);
    }
    return out;
  };
  /** The target component's best entry point for a method and any of these paths. */
  const bestEndpoint = (component: string, method: string | undefined, paths: string[]) => {
    let best: { e: Endpoint; score: number } | undefined;
    for (const e of endpoints) {
      if (e.component !== component || !sameMethod(method, e.method)) continue;
      const score = Math.max(...paths.map((p) => pathScore(p, e.normalizedPath ?? e.pathOrTopic)));
      if (score > 0 && (!best || score > best.score)) best = { e, score };
    }
    return best?.e;
  };
  /**
   * The flow that starts at an entry point: the one whose own trigger it is, else one that
   * stands for it in its family, where spec check finds that family member right (ADR 0088).
   * When only wrong families stand for it, the reason is the first one's finding.
   */
  const templateOf = (repo: string) => o.templates?.[repo] ?? DEFAULT_SPEC_TEMPLATE;
  const flowAt = (
    endpoint: string,
  ):
    | { found: { repo: string; flow: FlowRecord } }
    | { wrong: { repo: string; flow: FlowRecord; finding: string } }
    | undefined => {
    const own = flows.find((x) => x.flow.trigger.ref === endpoint);
    if (own) return { found: own };
    let wrong: { repo: string; flow: FlowRecord; finding: string } | undefined;
    for (const x of flows.filter((y) => y.flow.family.includes(endpoint))) {
      const bad = familyMismatches(x.flow, byId, templateOf(x.repo)).find(
        (m) => m.member === endpoint,
      );
      if (!bad) return { found: x };
      wrong ??= { ...x, finding: bad.message };
    }
    return wrong ? { wrong } : undefined;
  };

  const isComponent = (id: string) => byId.get(id)?.kind === "Component";
  const repoOfComponent = (id: string) => {
    const c = byId.get(id);
    return c?.kind === "Component" ? (c.repo ?? c.evidence.find((e) => e.repo)?.repo) : undefined;
  };
  /**
   * The entry points that serve a method and path exactly (once normalised), of the components
   * in scope (all when left out), the caller's own component aside.
   */
  const servingExactly = (
    caller: string,
    want: { method?: string; path: string },
    scope?: Set<string>,
  ) =>
    endpoints
      .filter(
        (e) =>
          e.component !== caller &&
          (!scope || scope.has(e.component)) &&
          sameMethod(want.method, e.method) &&
          pathScore(want.path, e.normalizedPath ?? e.pathOrTopic) === 1000,
      )
      .sort((a, b) => a.id.localeCompare(b.id));

  const joins: EstateJoin[] = [];
  const unmatched: EstateUnmatched[] = [];
  const inferred: EstateInferred[] = [];
  const asks: EstateAsk[] = [];
  for (const { repo, flow } of flows) {
    const callers = repoComponents(o.records, repo);
    callers.add(flow.component);
    for (const [i, s] of flow.steps.entries()) {
      if (!s.to) continue;
      const step = i + 1;
      const fromAt = at(s.evidence[0]);
      const from = { repo, flow: flow.id, step, ...(fromAt ? { evidence: fromAt } : {}) };
      const entry = `${s.to.component} ${s.to.entry}`;
      const miss = (u: Omit<EstateUnmatched, "from" | "entry">) =>
        unmatched.push({ from, entry, ...u });
      // A person's answer names the target for a step whose own target isn't in the catalog.
      const answer = o.targets?.[estateStepKey(flow.id, step)];
      const name = answer ?? s.to.component;
      const comp = byId.get(name);
      const ofRepo = repoComponents(o.records, name);
      // A step written before its callee was read names the repo the call went to, or the
      // call's loose end (ADR 0124, C-join): an Interface the estate join made since, from the
      // caller to a component of that repo (or to any, for a loose end), stands for it. A name
      // the catalog doesn't have (a relative call's guessed target) is read like a loose end,
      // then joined by method and path (the join fallback); an outside System's name is kept.
      const unknown = comp?.kind !== "Component" && ofRepo.size === 0;
      if (unknown && (answer || comp?.kind === "System")) {
        miss({
          reason: "no-target",
          message: answer
            ? `${answer}, which a person named for it, isn't a component in the catalog`
            : `${name} isn't a component in the catalog`,
        });
        continue;
      }
      const reach = comp?.kind === "Component" ? new Set([name]) : unknown ? undefined : ofRepo;
      const reaches = (to: string) => (reach ? reach.has(to) : isComponent(to));
      const named = byId.get(s.to.entry);
      const want =
        named?.kind === "Endpoint"
          ? { method: named.method, path: named.normalizedPath ?? named.pathOrTopic }
          : named?.kind === "Interface"
            ? { method: named.method, path: named.normalizedPath }
            : parseEntry(s.to.entry);
      // 1. The Interface: one the step names, else the best from the caller to the target.
      let iface = [named, ...s.refs.map((r) => byId.get(r))].find(
        (r): r is Interface => r?.kind === "Interface" && reaches(r.to),
      );
      if (!iface) {
        let best = 0;
        for (const x of interfaces) {
          if (!callers.has(x.from) || !reaches(x.to) || !sameMethod(want.method, x.method))
            continue;
          const score = Math.max(...arrivals(x).map((p) => pathScore(want.path, p)));
          if (score > best) {
            best = score;
            iface = x;
          }
        }
      }
      let target: Endpoint | undefined;
      let how: EstateJoin["how"];
      let guess: Omit<EstateInferred, "from" | "named"> | undefined;
      const stepName = `${flow.id} step ${step}`;
      const unnamed = `${stepName} names ${s.to.component}, which isn't a component in the catalog`;
      if (iface) {
        how = "interface";
        if (unknown)
          guess = {
            within: "interface",
            message: `${unnamed}: joined through ${iface.id}, the Interface from ${flow.component} that reaches ${s.to.entry}`,
          };
        const e = iface.endpoint ? byId.get(iface.endpoint) : undefined;
        target =
          e?.kind === "Endpoint"
            ? e
            : bestEndpoint(iface.to, iface.method ?? want.method, arrivals(iface));
        if (!target) {
          miss({
            reason: "no-target",
            interface: iface.id,
            message: `${iface.id} reaches ${iface.to}, but none of its entry points is ${iface.method ? `${iface.method} ` : ""}${iface.normalizedPath}`,
          });
          continue;
        }
      } else if (named?.kind === "Endpoint") {
        how = "endpoint";
        target = named;
      } else if (unknown) {
        // The join fallback: the only component of the caller's own repo that serves the
        // method and path, else of the estate; two or more is a question, never a guess.
        how = "path";
        const own = repoComponents(o.records, repo);
        let within: "repo" | "estate" = "repo";
        let hits = servingExactly(flow.component, want, own);
        if (hits.length === 0) {
          within = "estate";
          hits = servingExactly(flow.component, want);
        }
        const candidates = [...new Set(hits.map((e) => e.component))].sort();
        if (candidates.length === 0) {
          miss({
            reason: "no-target",
            message: `${s.to.component} isn't a component in the catalog, and neither an Interface from ${flow.component} nor an entry point of the estate serves ${s.to.entry}`,
          });
          continue;
        }
        if (candidates.length > 1) {
          const repos = [...new Set(candidates.map(repoOfComponent))];
          const of = repos.length === 1 && repos[0] ? repos[0] : "the estate";
          miss({
            reason: "no-target",
            message: `${s.to.component} isn't a component in the catalog, and ${candidates.length} components of ${of} serve ${s.to.entry} (${candidates.join(", ")}): a person says which`,
          });
          asks.push({
            from,
            caller: flow.component,
            named: s.to.component,
            what: s.to.entry,
            candidates,
          });
          continue;
        }
        target = hits[0]!;
        guess = {
          within,
          message: `${unnamed}: joined by method and path to ${target.id}, the only entry point of ${within === "repo" ? `its own repo (${repo})` : "the estate"} that serves ${s.to.entry}`,
        };
      } else if (comp?.kind !== "Component") {
        miss({
          reason: "no-target",
          message: `${name} isn't a component in the catalog, and no Interface from ${flow.component} reaches ${s.to.entry}`,
        });
        continue;
      } else {
        how = "path";
        target = bestEndpoint(name, want.method, [want.path]);
        if (!target) {
          miss({
            reason: "no-target",
            message: `${name} has no entry point for ${s.to.entry}, and no Interface from ${flow.component} reaches it`,
          });
          continue;
        }
      }
      const reached = flowAt(target.id);
      const ifaceId = iface ? { interface: iface.id } : {};
      if (!reached) {
        miss({
          reason: "no-flow",
          trigger: target.id,
          ...ifaceId,
          message: `${s.to.entry} reaches ${target.id}, but no flow of ${target.component} starts there`,
        });
        continue;
      }
      if ("wrong" in reached) {
        const w = reached.wrong;
        miss({
          reason: "family-mismatch",
          trigger: target.id,
          ...ifaceId,
          message: `${s.to.entry === target.id ? "The call" : s.to.entry} reaches ${target.id}, which only ${w.flow.id} stands for, in its family, and atticus spec check finds that wrong: ${w.finding}. Redraft it: atticus spec draft ${w.repo}`,
        });
        continue;
      }
      const callee = reached.found;
      const toEv = callee.flow.trigger.evidence[0];
      const ends = [
        (await cited(repo, s.evidence[0])) ? undefined : `${flow.id} step ${step}`,
        (await cited(callee.repo, toEv)) ? undefined : `the trigger of ${callee.flow.id}`,
      ].filter((x): x is string => !!x);
      if (ends.length) {
        miss({
          reason: "no-citation",
          trigger: target.id,
          ...ifaceId,
          message: `${ends.join(" and ")} ${ends.length === 1 ? "cites" : "cite"} no file and line that exists, so the join has no citation at both ends`,
        });
        continue;
      }
      joins.push({
        from: { repo, flow: flow.id, step, evidence: fromAt! },
        to: { repo: callee.repo, flow: callee.flow.id, trigger: target.id, evidence: at(toEv)! },
        entry,
        ...ifaceId,
        how,
      });
      if (guess)
        inferred.push({ from: { repo, flow: flow.id, step }, named: s.to.component, ...guess });
    }
  }
  const order = (a: { from: { flow: string; step: number } }, b: typeof a) =>
    a.from.flow.localeCompare(b.from.flow) || a.from.step - b.from.step;
  return {
    joins: joins.sort(order),
    unmatched: unmatched.sort(order),
    inferred: inferred.sort(order),
    asks: asks.sort(order),
  };
}

// ---------- end-to-end flows ----------

/** The data at a crossing: what the caller sends, what the callee's entry takes, what comes back. */
export interface Crossing {
  sends: string[];
  /** The fields the callee's first step names. */
  receives: string[];
  /** The fields the callee's responses return (or, when it has none, the caller's step expects). */
  returns: string[];
  /** Sent fields no step of the callee names (an object mapped to fields isn't one). */
  unused: string[];
  /**
   * Objects the caller sends whose fields the callee's entry takes (ADR 0088): `owner` sent,
   * firstName and lastName taken. A sent name is mapped when the callee names fields on it
   * (`owner.firstName`), or when it is the only sent name the callee doesn't take and the
   * entry takes fields the caller doesn't send.
   */
  objects: { sent: string; fields: string[] }[];
}

export interface EstateCall {
  join?: EstateJoin;
  unmatched?: EstateUnmatched;
  /** Why the callee isn't inline: the depth limit, a cycle, or a join that no longer fits the specs. */
  stopped?: "depth" | "cycle" | "stale";
  callee?: EstateFlow;
  crossing?: Crossing;
}

export interface EstateStep {
  /** Its number across the estate: 2, then 2.1, 2.2 for the callee's steps inline. */
  n: string;
  repo: string;
  flow: string;
  step: FlowStep;
  call?: EstateCall;
}

export interface EstateFlow {
  repo: string;
  flow: FlowRecord;
  steps: EstateStep[];
}

/** Every field name a step uses (data and store), as written. */
const stepFields = (s: FlowStep): string[] => [
  ...Object.values(s.data ?? {}).flatMap((v) => v ?? []),
  ...(s.store?.columns ?? []),
];

function crossing(caller: FlowStep, callee: FlowRecord): Crossing {
  const sends = caller.data?.sends ?? [];
  const first = callee.steps[0];
  const receives = first
    ? [...(first.data?.reads ?? []), ...(first.data?.sends ?? []), ...(first.data?.from ?? [])]
    : [];
  const returned = callee.steps
    .filter((s) => s.kind === "respond")
    .flatMap((s) => s.data?.returns ?? []);
  const named = new Set(callee.steps.flatMap(stepFields).map(fieldKey));
  // Objects: a sent name the entry doesn't take, whose fields the entry does.
  const taken = new Set(receives.map(fieldKey));
  const sent = new Set(sends.map(fieldKey));
  const loose = sends.filter((x) => !taken.has(fieldKey(x)));
  const owner = (r: string) => {
    const parts = r.split(".");
    return parts.length > 1 ? fieldKey(parts[parts.length - 2]!) : undefined;
  };
  const objects: Crossing["objects"] = [];
  for (const x of loose) {
    const on = receives.filter((r) => owner(r) === fieldKey(x));
    if (on.length) objects.push({ sent: x, fields: on });
  }
  if (objects.length === 0 && loose.length === 1) {
    const fields = receives.filter((r) => !sent.has(fieldKey(r)) && owner(r) === undefined);
    if (fields.length) objects.push({ sent: loose[0]!, fields });
  }
  const mapped = new Set(objects.map((m) => m.sent));
  return {
    sends,
    receives,
    returns: returned.length ? returned : (caller.data?.returns ?? []),
    unused: sends.filter((f) => !named.has(fieldKey(f)) && !mapped.has(f)),
    objects,
  };
}

/**
 * A flow followed across repos: its steps, with the callee flow's steps inline at each joined
 * call-out, recursively up to `depth` crossings, never entering a flow already on the path.
 */
export function estateFlow(o: {
  flow: string;
  specs: readonly EstateSpec[];
  joins: Pick<EstateJoins, "joins" | "unmatched">;
  depth?: number;
}): EstateFlow | undefined {
  const flows = new Map(
    o.specs.flatMap((s) => s.flows.map((f) => [f.id, { repo: s.repo, flow: f }] as const)),
  );
  const limit = o.depth ?? 5;
  const key = (flow: string, step: number) => `${flow}#${step}`;
  const joins = new Map(o.joins.joins.map((j) => [key(j.from.flow, j.from.step), j]));
  const misses = new Map(o.joins.unmatched.map((u) => [key(u.from.flow, u.from.step), u]));
  const walk = (id: string, prefix: string, path: string[]): EstateFlow | undefined => {
    const f = flows.get(id);
    if (!f) return undefined;
    const steps: EstateStep[] = f.flow.steps.map((s, i) => {
      const n = `${prefix}${i + 1}`;
      const out: EstateStep = { n, repo: f.repo, flow: id, step: s };
      if (!s.to) return out;
      const j = joins.get(key(id, i + 1));
      const u = misses.get(key(id, i + 1));
      // A join written for another version of the step (the specs changed since) isn't used.
      if (j && j.from.evidence === at(s.evidence[0]) && flows.has(j.to.flow)) {
        const callee = flows.get(j.to.flow)!.flow;
        const call: EstateCall = { join: j, crossing: crossing(s, callee) };
        if (path.includes(j.to.flow)) call.stopped = "cycle";
        else if (path.length > limit) call.stopped = "depth";
        else call.callee = walk(j.to.flow, `${n}.`, [...path, j.to.flow])!;
        out.call = call;
      } else if (u && !j) out.call = { unmatched: u };
      else out.call = { stopped: "stale" };
      return out;
    });
    return { repo: f.repo, flow: f.flow, steps };
  };
  return walk(o.flow, "", [o.flow]);
}

/** The steps of an end-to-end flow in order: each call-out followed by its callee's steps. */
export function flattenEstateFlow(f: EstateFlow): EstateStep[] {
  return f.steps.flatMap((s) => [s, ...(s.call?.callee ? flattenEstateFlow(s.call.callee) : [])]);
}

// ---------- field lineage ----------

export interface LineageLink {
  n: string;
  repo: string;
  flow: string;
  kind: string;
  what: string;
  /** How the field shows at this step: sent, named, renamed (from → to) or stored. */
  as: "sent" | "named" | "renamed" | "stored";
  /** The field's name at this step, or `from → to` for a rename, or `table.column` once stored. */
  field: string;
  /** repo:path:line of the step's first citation. */
  evidence?: string;
}

export interface Lineage {
  flow: string;
  field: string;
  links: LineageLink[];
  /** The table and column it ends in, when a write stores it. */
  stored?: { table: string; column: string };
  /** Where and why the chain breaks, when no write stores it. */
  breaks?: { after?: string; message: string };
}

/**
 * Follow a field along an end-to-end flow: from the first step that sends it, through each
 * transform that turns it into another field (`data.from` → `data.to`, by position), to the
 * column a write stores it in. Names compare on their last dotted part, letter case, `_` and
 * `-` aside (first_name is firstName).
 */
export function fieldLineage(f: EstateFlow, field: string): Lineage {
  const steps = flattenEstateFlow(f);
  const want = fieldKey(field);
  const out: Lineage = { flow: f.flow.id, field, links: [] };
  const link = (s: EstateStep, as: LineageLink["as"], name: string): LineageLink => {
    const e = s.step.evidence[0];
    const ev = at(e);
    return {
      n: s.n,
      repo: s.repo,
      flow: s.flow,
      kind: s.step.kind,
      what: s.step.what,
      as,
      field: name,
      ...(ev ? { evidence: `${e!.repo ?? s.repo}:${ev}` } : {}),
    };
  };
  // A step sends the field itself, or an object the crossing maps to it (ADR 0088).
  const inObject = (s: EstateStep) =>
    s.call?.crossing?.objects.find((m) => m.fields.some((x) => fieldKey(x) === want));
  const start = steps.findIndex(
    (s) => (s.step.data?.sends ?? []).some((x) => fieldKey(x) === want) || !!inObject(s),
  );
  if (start < 0) {
    out.breaks = { message: `No step of ${f.flow.id}, or of the flows it calls, sends ${field}.` };
    return out;
  }
  const s0 = steps[start]!;
  const direct = (s0.step.data?.sends ?? []).find((x) => fieldKey(x) === want);
  const obj = inObject(s0);
  out.links.push(
    link(
      s0,
      "sent",
      direct ??
        `${obj!.sent}.${obj!.fields
          .find((x) => fieldKey(x) === want)!
          .split(".")
          .pop()}`,
    ),
  );
  const tracked = new Set([want]);
  const names = new Map([[want, field]]);
  let last = s0;
  for (const s of steps.slice(start + 1)) {
    const d = s.step.data ?? {};
    // A write maps fields to columns as its step says (data.from → data.to), else by name.
    const mappedTo =
      s.step.kind === "write" && s.step.store
        ? d.to?.[d.from?.findIndex((x) => tracked.has(fieldKey(x))) ?? -1]
        : undefined;
    const col =
      s.step.kind === "write" &&
      (mappedTo ?? s.step.store?.columns.find((c) => tracked.has(fieldKey(c))));
    if (col) {
      out.links.push(link(s, "stored", `${s.step.store!.table}.${col}`));
      out.stored = { table: s.step.store!.table, column: col };
      return out;
    }
    if (s.step.kind === "transform" && d.from?.length && d.to?.length) {
      const renamed: string[] = [];
      d.from.forEach((x, k) => {
        const to = d.to![k];
        if (to === undefined || !tracked.has(fieldKey(x))) return;
        renamed.push(`${x} → ${to}`);
        tracked.add(fieldKey(to));
        names.set(fieldKey(to), to);
      });
      if (renamed.length) {
        out.links.push(link(s, "renamed", renamed.join(", ")));
        last = s;
        continue;
      }
    }
    const hit = stepFields(s.step).find((x) => tracked.has(fieldKey(x)));
    if (hit) {
      out.links.push(link(s, "named", hit));
      last = s;
    }
  }
  const now = [...names.values()].join(" or ");
  const call = last.call;
  const message =
    call?.unmatched && last.step.data?.sends?.some((x) => tracked.has(fieldKey(x)))
      ? `${last.n} sends ${now} to ${last.step.to!.component}, but that call-out isn't joined to a flow: ${call.unmatched.message}.`
      : call?.stopped && call.stopped !== "stale"
        ? `${last.n} sends ${now} on, but the callee isn't followed (${call.stopped === "cycle" ? "it is already on the path" : "the depth limit"}).`
        : `After ${last.n} no step names ${now}, and no write stores it.`;
  out.breaks = { after: last.n, message };
  return out;
}
