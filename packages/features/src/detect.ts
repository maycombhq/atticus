import { parseRecord, type CatalogRecord, type EvidenceT, type RecordOf } from "@maycombhq/core";
import { FlowGraph, type CapabilityRec, type Iface, type TableUse } from "./graph.js";
import {
  classOf,
  displayName,
  nameWords,
  overlaps,
  pathWords,
  resourceOfPath,
  slugOf,
  splitWords,
  tokens,
  topicWords,
} from "./words.js";

/**
 * Features found in code (ADR 0031), without AI, in every scan.
 *
 * 1. Entry points: an endpoint called from a UI, through the gateway or from another system;
 *    an event consumer in another system than its publisher; a scheduled job (a batch
 *    Setting `schedule.*`); a batch component with no schedule found.
 * 2. Flows: from each entry point, the calls and events its component makes that share a word
 *    with where the flow started (path segments, topics, class names), the tables it reads or
 *    writes that share a word (else the ones nobody else claims), to a bounded depth. Calls
 *    go caller → callee and events publisher → subscriber, the direction work moves in.
 * 3. Features: an entry point another flow passes through joins that flow's feature, and
 *    flows with the same primary resource are one feature. Ids come from the primary
 *    resource (`feature.<slug>`), names from the same words, `namedBy: detected`, `inferred`.
 *
 * People's decisions shape the result on every scan: an assert of `entryPoints` on a feature
 * pins those entry points to it (a split, or a feature's confirmed members), and an alias
 * whose value is another feature's id merges that feature into the target. AI proposals
 * (made outside the scan, stored as files) name detected features, still `inferred`.
 * Reads records only; deterministic.
 */

export type Capability = RecordOf<"Capability">;

export interface FeatureNameProposal {
  feature: string;
  name: string;
  description?: string;
  tags: string[];
  /** Record ids from the feature's evidence the proposal relies on. */
  evidence: string[];
  agent: string;
  at: string;
  runId?: string;
}

export interface DetectOptions {
  /** Interface hops followed from an entry point. Default 8. */
  maxDepth?: number;
  /** Curated decisions (catalog/curated); only membership asserts and merges are read here. */
  decisions?: readonly CatalogRecord[];
  /** AI name proposals for detected features. */
  proposals?: readonly FeatureNameProposal[];
}

export interface DetectProblem {
  decision: string;
  message: string;
}

export type EntryKind = "endpoint" | "consumer" | "schedule" | "job" | "pinned";

export interface EntryPoint {
  id: string;
  kind: EntryKind;
  /** The component where work starts. */
  component: string;
  /** The words of the primary resource, in order: account, balance. */
  resource: string[];
  /** Words to match calls and tables against. */
  tokens: Set<string>;
  mode: Mode;
  evidence: EvidenceT[];
}

/** Which unclaimed tables a flow takes at a component when none shares a word with it. */
type Mode = "read" | "write" | "any";

export interface Flow {
  entry: EntryPoint;
  /** Everything the flow spans, entry point included. */
  records: Set<string>;
  /** Endpoints and interfaces the flow passes through (callers of the entry point excluded). */
  reached: Set<string>;
  /** Components the flow continued into, with the words it carried there. */
  visits: { component: string; tokens: Set<string> }[];
  /** Interfaces followed. */
  hops: Iface[];
}

export interface DetectResult {
  features: Capability[];
  flows: Map<string, Flow>;
  problems: DetectProblem[];
}

const DEFAULT_DEPTH = 8;
const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const modeOf = (method?: string): Mode =>
  !method ? "any" : WRITES.has(method.toUpperCase()) ? "write" : "read";

const union = (a: Set<string>, b: Iterable<string>) => new Set([...a, ...b]);
const sorted = (s: Iterable<string>) => [...s].sort();

/** Builds entry points and traces flows over one catalog. */
export class Tracer {
  readonly g: FlowGraph;
  private claimed = new Map<string, Set<string>>();
  private entriesAt = new Map<string, EntryPoint[]>();

  constructor(
    records: readonly CatalogRecord[],
    private readonly maxDepth = DEFAULT_DEPTH,
  ) {
    this.g = new FlowGraph(records);
  }

  private endpointEntry(id: string, kind: EntryKind = "endpoint"): EntryPoint | undefined {
    const e = this.g.endpoints.get(id);
    if (!e) return undefined;
    const words = pathWords(e.normalizedPath ?? e.pathOrTopic);
    const fallback = nameWords(e.id.slice(e.component.length + 1));
    const resource = words.length ? resourceOfPath(words) : fallback;
    const own = this.g.ownWords(e.component);
    return {
      id,
      kind,
      component: e.component,
      resource: resource.length ? resource : splitWords(e.component),
      tokens: union(
        tokens(resource),
        this.g.classTokens(e.evidence, own, ["callee", "definition"]),
      ),
      mode: modeOf(e.method),
      evidence: e.evidence,
    };
  }

  private consumerEntry(i: Iface, kind: EntryKind = "consumer"): EntryPoint {
    const words = topicWords(i.normalizedPath);
    const resource = words.length ? words : nameWords(i.endpoint ?? i.to);
    return {
      id: i.id,
      kind,
      component: i.to,
      resource,
      tokens: union(
        tokens(resource),
        this.g.classTokens(i.evidence, this.g.ownWords(i.to), ["callee"]),
      ),
      mode: "any",
      evidence: i.evidence,
    };
  }

  /** A job's words: its class (or schedule name) and, if missing, its system's word. */
  private jobResource(component: string, words: string[]): string[] {
    const sys = this.g.systemWord(component);
    const base = words.length ? words : nameWords(component);
    return sys && !tokens(base).has(sys) ? [...base, sys] : base;
  }

  private scheduleEntry(id: string, kind: EntryKind = "schedule"): EntryPoint | undefined {
    const s = this.g.settings.get(id);
    if (!s) return undefined;
    const parts = s.key.replace(/^schedule\./, "").split(".");
    const words =
      parts.length > 1
        ? nameWords(parts[0]!).length
          ? nameWords(parts[0]!)
          : nameWords(parts.slice(1).join(" "))
        : nameWords(parts[0]!);
    const resource = this.jobResource(s.component, words);
    return {
      id,
      kind,
      component: s.component,
      resource,
      tokens: tokens(resource),
      mode: "any",
      evidence: s.evidence,
    };
  }

  private jobEntry(id: string, kind: EntryKind = "job"): EntryPoint | undefined {
    const c = this.g.components.get(id);
    if (!c) return undefined;
    const cls = c.evidence.map((e) => (e.path ? classOf(e.path) : undefined)).find(Boolean);
    const resource = this.jobResource(id, cls ? nameWords(cls) : []);
    return {
      id,
      kind,
      component: id,
      resource,
      tokens: tokens(resource),
      mode: "any",
      evidence: c.evidence,
    };
  }

  /** An entry point for any record a person pinned, detected or not. */
  entryFor(id: string): EntryPoint | undefined {
    if (this.g.endpoints.has(id)) return this.endpointEntry(id, "pinned");
    const i = this.g.interfaces.get(id);
    if (i) return this.consumerEntry(i, "pinned");
    if (this.g.settings.has(id)) return this.scheduleEntry(id, "pinned");
    if (this.g.components.has(id)) return this.jobEntry(id, "pinned");
    return undefined;
  }

  /** Every entry point the code shows, in id order. */
  detectEntries(): EntryPoint[] {
    const g = this.g;
    const out: EntryPoint[] = [];
    for (const e of g.endpoints.values()) {
      if (!["rest", "grpc", "soap"].includes(e.endpointType) || g.isVendor(e.component)) continue;
      const own = g.systemOf(e.component);
      const callers = g.callers.get(e.id) ?? [];
      const outside = callers.some(
        (c) => c.via === "gateway" || g.isUi(c.from) || g.systemOf(c.from) !== own,
      );
      if (outside) out.push(this.endpointEntry(e.id)!);
    }
    for (const i of g.interfaces.values()) {
      if (i.sync !== "async" || !g.isOwn(i.to)) continue;
      if (g.systemOf(i.from) === g.systemOf(i.to)) continue;
      out.push(this.consumerEntry(i));
    }
    for (const [component, settings] of g.schedules)
      if (g.isOwn(component)) for (const s of settings) out.push(this.scheduleEntry(s.id)!);
    for (const c of g.components.values())
      if (g.isJob(c.id) && !g.isVendor(c.id) && !g.schedules.has(c.id))
        out.push(this.jobEntry(c.id)!);
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** Tell the tracer the entry points in play, so tables can be claimed by the right flows. */
  useEntries(entries: EntryPoint[]): void {
    this.entriesAt.clear();
    this.claimed.clear();
    for (const e of entries) {
      const l = this.entriesAt.get(e.component) ?? [];
      l.push(e);
      this.entriesAt.set(e.component, l);
    }
  }

  private hopTokens(i: Iface): Set<string> {
    return tokens(i.sync === "async" ? topicWords(i.normalizedPath) : pathWords(i.normalizedPath));
  }

  private callTokens(i: Iface): Set<string> {
    return union(
      this.hopTokens(i),
      this.g.classTokens(i.evidence, this.g.ownWords(i.from), ["caller"]),
    );
  }

  /** Where work starts at a component: its entry points and the calls and events into it. */
  private starts(component: string): Set<string>[] {
    const entries = this.entriesAt.get(component) ?? [];
    const entryIds = new Set(entries.map((e) => e.id));
    return [
      ...entries.map((e) => e.tokens),
      ...(this.g.into.get(component) ?? [])
        .filter((i) => !entryIds.has(i.id) && !(i.endpoint && entryIds.has(i.endpoint)))
        .map((i) => this.hopTokens(i)),
    ];
  }

  /** Tables at a component that share a word with some start there: they belong to that work. */
  private claimedAt(component: string): Set<string> {
    let c = this.claimed.get(component);
    if (!c) {
      c = new Set<string>();
      const starts = this.starts(component);
      for (const u of this.g.tables.get(component) ?? [])
        if (starts.some((t) => overlaps(t, tokens(splitWords(u.table.name))))) c.add(u.table.id);
      this.claimed.set(component, c);
    }
    return c;
  }

  private tablesFor(component: string, toks: Set<string>, mode: Mode): TableUse[] {
    const uses = [...(this.g.tables.get(component) ?? [])];
    const named = uses.filter((u) => overlaps(toks, tokens(splitWords(u.table.name))));
    if (named.length) return named;
    const claimed = this.claimedAt(component);
    return uses.filter(
      (u) => !claimed.has(u.table.id) && (mode === "any" || (mode === "write" ? u.write : u.read)),
    );
  }

  trace(entry: EntryPoint): Flow {
    const g = this.g;
    const flow: Flow = {
      entry,
      records: new Set([entry.id, entry.component]),
      reached: new Set([entry.id]),
      visits: [],
      hops: [],
    };
    const iface = g.interfaces.get(entry.id);
    if (iface) {
      // an event consumer: the event and who publishes it
      flow.records.add(iface.from);
      if (iface.endpoint) flow.records.add(iface.endpoint);
    } else if (g.endpoints.has(entry.id)) {
      // an endpoint: the calls into it and who makes them
      for (const c of g.callers.get(entry.id) ?? []) {
        flow.records.add(c.id);
        flow.records.add(c.from);
      }
    }
    const seen = new Set<string>();
    const queue: { component: string; toks: Set<string>; depth: number; mode: Mode }[] = [
      { component: entry.component, toks: entry.tokens, depth: 0, mode: entry.mode },
    ];
    while (queue.length) {
      const { component, toks, depth, mode } = queue.shift()!;
      if (seen.has(component) || !g.isOwn(component)) continue;
      seen.add(component);
      flow.records.add(component);
      flow.visits.push({ component, tokens: toks });
      for (const u of this.tablesFor(component, toks, mode)) flow.records.add(u.table.id);
      if (depth >= this.maxDepth) continue;
      const outs = g.outOf(component);
      let follow = outs.filter((i) => overlaps(toks, this.callTokens(i)));
      if (!follow.length && this.starts(component).length <= 1) follow = outs;
      for (const i of follow) {
        flow.hops.push(i);
        flow.records.add(i.id);
        flow.reached.add(i.id);
        if (i.endpoint) {
          flow.records.add(i.endpoint);
          flow.reached.add(i.endpoint);
        }
        flow.records.add(i.to);
        if (g.isOwn(i.to) && !seen.has(i.to))
          queue.push({
            component: i.to,
            toks: union(toks, this.hopTokens(i)),
            depth: depth + 1,
            mode: i.sync === "async" ? "any" : modeOf(i.method),
          });
      }
    }
    return flow;
  }
}

/** Union-find over entry points that never joins two entry points people pinned apart. */
class Groups {
  private parent = new Map<string, string>();
  /** The feature a group is pinned to, by root. */
  private pins = new Map<string, string>();
  constructor(ids: string[], pinOf: (id: string) => string | undefined) {
    for (const id of ids) {
      this.parent.set(id, id);
      const p = pinOf(id);
      if (p) this.pins.set(id, p);
    }
  }
  find(x: string): string {
    let r = x;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    this.parent.set(x, r);
    return r;
  }
  join(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const pa = this.pins.get(ra);
    const pb = this.pins.get(rb);
    if (pa && pb && pa !== pb) return;
    const [root, child] = ra < rb ? [ra, rb] : [rb, ra];
    this.parent.set(child, root);
    const pin = pa ?? pb;
    if (pin) this.pins.set(root, pin);
  }
  groups(): string[][] {
    const out = new Map<string, string[]>();
    for (const id of [...this.parent.keys()].sort()) {
      const r = this.find(id);
      out.set(r, [...(out.get(r) ?? []), id]);
    }
    return [...out.values()];
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

type Decision = RecordOf<"CuratedDecision">;

function currentDecisions(decisions: readonly CatalogRecord[]): Decision[] {
  return decisions
    .filter((d): d is Decision => d.kind === "CuratedDecision" && d.status === "current")
    .filter((d) => d.target.startsWith("feature."))
    .sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at < b.at ? -1 : 1));
}

/** Entry points pinned to a feature by membership asserts; later decisions win. */
function pinsFrom(decisions: Decision[]): Map<string, string> {
  const latest = new Map<string, string[]>();
  for (const d of decisions) {
    if (d.action !== "assert" || !isObject(d.value) || !Array.isArray(d.value.entryPoints))
      continue;
    latest.set(
      d.target,
      d.value.entryPoints.filter((x): x is string => typeof x === "string"),
    );
  }
  const pins = new Map<string, string>();
  const order = decisions.filter((d) => latest.has(d.target)).map((d) => d.target);
  for (const target of [...new Set(order)])
    for (const e of latest.get(target)!) pins.set(e, target);
  return pins;
}

const evKey = (e: EvidenceT) => JSON.stringify(Object.entries(e).sort());

function dedupeEvidence(list: EvidenceT[]): EvidenceT[] {
  const seen = new Set<string>();
  return list.filter((e) => {
    const k = evKey(e);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const better = (a: string[], b: string[]): boolean =>
  a.length !== b.length
    ? a.length > b.length
    : a.join(" ").length !== b.join(" ").length
      ? a.join(" ").length > b.join(" ").length
      : a.join(" ") < b.join(" ");

function capability(
  c: Omit<Capability, "kind" | "schemaVersion" | "status" | "confidence">,
): Capability {
  const p = parseRecord({
    schemaVersion: 2,
    kind: "Capability",
    status: "current",
    confidence: "inferred",
    ...c,
  });
  if (!p.ok)
    throw new Error(
      `feature ${c.id}: ${p.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
    );
  return p.record as Capability;
}

/** Detect features and say which people's decisions couldn't shape them. */
export function detectFeaturesWithReport(
  records: readonly CatalogRecord[],
  o: DetectOptions = {},
): DetectResult {
  const tracer = new Tracer(records, o.maxDepth ?? DEFAULT_DEPTH);
  const decisions = currentDecisions(o.decisions ?? []);
  const problems: DetectProblem[] = [];
  const pins = pinsFrom(decisions);

  const detected = tracer.detectEntries();
  const entries = new Map(detected.map((e) => [e.id, e]));
  for (const id of [...pins.keys()].sort()) {
    if (entries.has(id)) continue;
    const e = tracer.entryFor(id);
    if (e) entries.set(id, e);
    else {
      const d = decisions.filter((x) => x.action === "assert" && x.target === pins.get(id)).at(-1)!;
      problems.push({
        decision: d.id,
        message: `${id} isn't in the catalog, so it can't start ${d.target}`,
      });
    }
  }
  const list = [...entries.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  tracer.useEntries(list);
  const flows = new Map(list.map((e) => [e.id, tracer.trace(e)]));

  const groups = new Groups(
    list.map((e) => e.id),
    (id) => pins.get(id),
  );
  // An entry point another flow passes through is part of that flow's feature.
  for (const f of flows.values())
    for (const r of sorted(f.reached))
      if (
        r !== f.entry.id &&
        entries.has(r) &&
        ["endpoint", "consumer", "pinned"].includes(entries.get(r)!.kind)
      )
        groups.join(f.entry.id, r);
  // Flows about the same primary resource are one feature.
  const bySlug = new Map<string, string>();
  for (const e of list) {
    const s = slugOf(e.resource);
    const first = bySlug.get(s);
    if (first) groups.join(first, e.id);
    else bySlug.set(s, e.id);
  }

  const built: { id: string; pinned: boolean; members: string[]; resource: string[] }[] = [];
  for (const members of groups.groups()) {
    const pin = members.map((m) => pins.get(m)).find(Boolean);
    // outermost first: the entry points no other member's flow passes through
    const reachedByOthers = (m: string) =>
      members.some((x) => x !== m && flows.get(x)!.reached.has(m));
    const outer = members.filter((m) => !reachedByOthers(m)).sort();
    const inner = members.filter((m) => reachedByOthers(m)).sort();
    let resource = entries.get(members[0]!)!.resource;
    for (const m of members)
      if (better(entries.get(m)!.resource, resource)) resource = entries.get(m)!.resource;
    built.push({
      id: pin ?? `feature.${slugOf(resource)}`,
      pinned: !!pin,
      members: [...outer, ...inner],
      resource,
    });
  }
  // pinned ids first, so a detected feature never takes an id a person chose
  const taken = new Set(built.filter((b) => b.pinned).map((b) => b.id));
  for (const b of built.filter((x) => !x.pinned).sort((x, y) => (x.id < y.id ? -1 : 1))) {
    let id = b.id;
    for (let n = 2; taken.has(id); n++) id = `${b.id}-${n}`;
    b.id = id;
    taken.add(id);
  }

  let features = new Map<string, { members: string[]; name: string; records: Set<string> }>();
  for (const b of built.sort((x, y) => (x.id < y.id ? -1 : 1)))
    features.set(b.id, {
      members: b.members,
      name: displayName(b.resource),
      records: new Set(b.members.flatMap((m) => [...flows.get(m)!.records])),
    });

  // Merges: an alias whose value names other features folds them into the target.
  for (const d of decisions.filter((x) => x.action === "alias")) {
    const names = (Array.isArray(d.value) ? d.value : [d.value]).filter(
      (v): v is string => typeof v === "string" && v.startsWith("feature."),
    );
    if (!names.length) continue;
    const into = features.get(d.target);
    if (!into) {
      problems.push({
        decision: d.id,
        message: `${d.target} isn't a detected feature, so nothing can be merged into it`,
      });
      continue;
    }
    for (const n of names) {
      const from = features.get(n);
      if (!from) {
        problems.push({
          decision: d.id,
          message: `${n} isn't a detected feature, so it can't be merged into ${d.target}`,
        });
        continue;
      }
      into.members.push(...from.members.filter((m) => !into.members.includes(m)));
      for (const r of from.records) into.records.add(r);
      features.delete(n);
    }
  }
  features = new Map([...features.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));

  const proposals = new Map<string, FeatureNameProposal>();
  for (const p of [...(o.proposals ?? [])].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)))
    proposals.set(p.feature, p);

  const out: Capability[] = [];
  for (const [id, f] of features) {
    const p = proposals.get(id);
    out.push(
      capability({
        id,
        name: p?.name ?? f.name,
        ...(p?.description ? { description: p.description } : {}),
        entryPoints: f.members,
        records: sorted(f.records),
        tags: p ? [...p.tags] : [],
        externalRefs: [],
        namedBy: p ? "ai" : "detected",
        evidence: dedupeEvidence(f.members.flatMap((m) => entries.get(m)!.evidence)),
      }),
    );
  }
  return { features: out, flows, problems };
}

/** Detected Capability records for a catalog (existing Capability records are ignored). */
export function detectFeatures(
  records: readonly CatalogRecord[],
  o: DetectOptions = {},
): Capability[] {
  return detectFeaturesWithReport(records, o).features;
}

export type { CapabilityRec };
