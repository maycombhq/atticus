import {
  byDecisionTime,
  parseRecord,
  type CatalogRecord,
  type EvidenceT,
  type RecordOf,
} from "@maycombhq/core";
import { FlowGraph, type CapabilityRec, type Iface, type TableUse } from "../../src/graph.js";
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
} from "../../src/words.js";

/** Endpoint types a feature can start at. */
const ENTRY_TYPES = new Set(["rest", "grpc", "soap", "graphql", "webhook", "websocket", "sse"]);

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
  /** False: the result's `flows` is left empty (a scan needs the features only). Default true. */
  keepFlows?: boolean;
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

/** A flow as `Tracer.traceIx` gives it: what it spans and reaches, by `Tracer.indexOf` number. */
export interface FlowIx {
  entry: EntryPoint;
  records: Int32Array;
  reached: Int32Array;
  visits?: Flow["visits"];
  hops?: Iface[];
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
/** `union(a, b)`, or `a` itself when `b` adds nothing (the same words, in the same order). */
const unionNew = (a: Set<string>, b: Set<string>) => {
  for (const x of b) if (!a.has(x)) return union(a, b);
  return a;
};
const sorted = (s: Iterable<string>) => [...s].sort();

/** Builds entry points and traces flows over one catalog. */
export class Tracer {
  readonly g: FlowGraph;
  private claimed = new Map<string, Set<string>>();
  private entriesAt = new Map<string, EntryPoint[]>();
  // Memos (ADR 0195 point 9, the budgets): the graph never changes after the constructor, so a
  // hop's, a call's, a table's and a component's words are worked out once, not on every trace
  // that passes them. The sets are never handed out to be changed (a flow's words are a union).
  private hopMemo = new Map<Iface, Set<string>>();
  private callMemo = new Map<Iface, Set<string>>();
  private tableMemo = new Map<TableUse["table"], Set<string>>();
  private outsMemo = new Map<string, Iface[]>();
  /** How many starts each component has, for the entry points in play (reset with them). */
  private startsMemo = new Map<string, number>();

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
      // Request-response entry points, ADR 0040's included: GraphQL operations, webhooks a
      // vendor calls, websockets and server-sent events.
      if (!ENTRY_TYPES.has(e.endpointType) || g.isVendor(e.component)) continue;
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
    this.startsMemo.clear();
    for (const e of entries) {
      const l = this.entriesAt.get(e.component) ?? [];
      l.push(e);
      this.entriesAt.set(e.component, l);
    }
  }

  private hopTokens(i: Iface): Set<string> {
    let t = this.hopMemo.get(i);
    if (!t) {
      t = tokens(i.sync === "async" ? topicWords(i.normalizedPath) : pathWords(i.normalizedPath));
      this.hopMemo.set(i, t);
    }
    return t;
  }

  private callTokens(i: Iface): Set<string> {
    let t = this.callMemo.get(i);
    if (!t) {
      t = union(
        this.hopTokens(i),
        this.g.classTokens(i.evidence, this.g.ownWords(i.from), ["caller"]),
      );
      this.callMemo.set(i, t);
    }
    return t;
  }

  private tableTokens(t: TableUse["table"]): Set<string> {
    let x = this.tableMemo.get(t);
    if (!x) {
      x = tokens(splitWords(t.name));
      this.tableMemo.set(t, x);
    }
    return x;
  }

  /** A component's calls and events out, by id (the graph's `outOf`, kept). */
  private outsOf(component: string): Iface[] {
    let o = this.outsMemo.get(component);
    if (!o) {
      o = this.g.outOf(component);
      this.outsMemo.set(component, o);
    }
    return o;
  }

  /**
   * The calls and events out of each component by word (a trace follows the ones sharing a
   * word with it: `outs.filter((i) => overlaps(toks, this.callTokens(i)))`).
   */
  private outWordsMemo = new Map<string, Map<string, number[]>>();

  /**
   * Which of `items` share a word with `toks` (`hit[k]` is 1 where `overlaps(toks, wordsOf(x))`),
   * and how many, through an index of a component's items by word (kept in `memo`), so a trace
   * looks up its words instead of comparing them with every item. `items` must be the same list
   * for the same component every time.
   */
  private sharingHits<T>(
    memo: Map<string, Map<string, number[]>>,
    component: string,
    items: readonly T[],
    toks: Set<string>,
    wordsOf: (x: T) => Set<string>,
  ): { hit: Uint8Array; n: number } {
    // One buffer per memo, reused: its hits are read before the next call with the same memo.
    let hit = this.hitBufs.get(memo);
    if (!hit || hit.length < items.length) {
      hit = new Uint8Array(Math.max(items.length, 2 * (hit?.length ?? 32)));
      this.hitBufs.set(memo, hit);
    } else hit.fill(0, 0, items.length);
    let n = 0;
    if (items.length < 8) {
      for (let k = 0; k < items.length; k++)
        if (overlaps(toks, wordsOf(items[k]!))) {
          hit[k] = 1;
          n++;
        }
      return { hit, n };
    }
    let idx = memo.get(component);
    if (!idx) {
      idx = new Map<string, number[]>();
      items.forEach((x, k) => {
        for (const t of wordsOf(x)) {
          const l = idx!.get(t);
          if (l) l.push(k);
          else idx!.set(t, [k]);
        }
      });
      memo.set(component, idx);
    }
    words: for (const t of toks) {
      const l = idx.get(t);
      if (!l) continue;
      for (const k of l)
        if (!hit[k]) {
          hit[k] = 1;
          // Every item shares a word already: the rest of the words change nothing.
          if (++n === items.length) break words;
        }
    }
    return { hit, n };
  }

  private hitBufs = new Map<object, Uint8Array>();

  /** A component's calls and events out as numbers: id, endpoint (or -1), callee, each. */
  private outsIxOf(component: string, outs: readonly Iface[]): Int32Array {
    let x = this.outsIxMemo.get(component);
    if (!x) {
      x = new Int32Array(outs.length * 3);
      outs.forEach((i, k) => {
        x![k * 3] = this.indexOf(i.id);
        x![k * 3 + 1] = i.endpoint ? this.indexOf(i.endpoint) : -1;
        x![k * 3 + 2] = this.indexOf(i.to);
      });
      this.outsIxMemo.set(component, x);
    }
    return x;
  }
  private outsIxMemo = new Map<string, Int32Array>();
  private tableWordsMemo = new Map<string, Map<string, number[]>>();

  private startCount(component: string): number {
    let n = this.startsMemo.get(component);
    if (n === undefined) {
      n = this.starts(component).length;
      this.startsMemo.set(component, n);
    }
    return n;
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
        if (starts.some((t) => overlaps(t, this.tableTokens(u.table)))) c.add(u.table.id);
      this.claimed.set(component, c);
    }
    return c;
  }

  /** Whether a component (by its number) is our own: `g.isOwn`, kept. */
  private ownAt(k: number, id: string): boolean {
    let o = this.ownMark[k];
    if (o === undefined) {
      o = this.g.isOwn(id) ? 1 : 0;
      this.ownMark[k] = o;
    }
    return o === 1;
  }
  private ownMark: (0 | 1)[] = [];

  /**
   * The tables a flow takes at a component, each given to `add` by its number, in the order of
   * the component's tables: those that share a word with the flow's words, else the ones no
   * start there claims that the flow's mode reads or writes (any, for "any").
   */
  private tablesIx(
    component: string,
    toks: Set<string>,
    mode: Mode,
    add: (k: number) => void,
  ): void {
    const uses = this.g.tables.get(component);
    if (!uses?.length) return;
    let tix = this.tablesIxMemo.get(component);
    if (!tix) {
      tix = Int32Array.from(uses, (u) => this.indexOf(u.table.id));
      this.tablesIxMemo.set(component, tix);
    }
    const { hit, n } = this.sharingHits(this.tableWordsMemo, component, uses, toks, (u) =>
      this.tableTokens(u.table),
    );
    if (n) {
      for (let k = 0; k < uses.length; k++) if (hit[k]) add(tix[k]!);
      return;
    }
    const claimed = this.claimedAt(component);
    for (let k = 0; k < uses.length; k++) {
      const u = uses[k]!;
      if (!claimed.has(u.table.id) && (mode === "any" || (mode === "write" ? u.write : u.read)))
        add(tix[k]!);
    }
  }
  private tablesIxMemo = new Map<string, Int32Array>();

  // A trace marks what it holds by number (ADR 0195 point 9: a flow of a big estate holds
  // thousands of ids, and thousands of flows are traced): each id once, in the order a trace
  // first adds it, as a Set of the ids would hold them.
  private ids: string[] = [];
  private ixOf = new Map<string, number>();
  private recMark: number[] = [];
  private reachMark: number[] = [];
  private queuedMark: number[] = [];
  private pass = 0;

  /** The number a trace marks this id by. */
  indexOf(id: string): number {
    let k = this.ixOf.get(id);
    if (k === undefined) {
      k = this.ids.length;
      this.ids.push(id);
      this.ixOf.set(id, k);
    }
    return k;
  }

  /** The id of a number `indexOf` gave. */
  idOf(k: number): string {
    return this.ids[k]!;
  }

  trace(entry: EntryPoint): Flow {
    const f = this.traceIx(entry, true);
    return {
      entry,
      records: new Set(Array.from(f.records, (k) => this.idOf(k))),
      reached: new Set(Array.from(f.reached, (k) => this.idOf(k))),
      visits: f.visits!,
      hops: f.hops!,
    };
  }

  /**
   * A flow as the numbers of what it spans and reaches, each in the order `trace` adds them;
   * its visits and hops only with `keep` (a scan's features need neither).
   */
  traceIx(entry: EntryPoint, keep: boolean): FlowIx {
    const g = this.g;
    const pass = ++this.pass;
    const recMark = this.recMark;
    const reachMark = this.reachMark;
    const records: number[] = [];
    const reached: number[] = [];
    const rec = (k: number) => {
      if (recMark[k] !== pass) {
        recMark[k] = pass;
        records.push(k);
      }
    };
    const reach = (k: number) => {
      if (reachMark[k] !== pass) {
        reachMark[k] = pass;
        reached.push(k);
      }
    };
    const visits: Flow["visits"] | undefined = keep ? [] : undefined;
    const hops: Iface[] | undefined = keep ? [] : undefined;
    rec(this.indexOf(entry.id));
    rec(this.indexOf(entry.component));
    reach(this.indexOf(entry.id));
    const iface = g.interfaces.get(entry.id);
    if (iface) {
      // an event consumer: the event and who publishes it
      rec(this.indexOf(iface.from));
      if (iface.endpoint) rec(this.indexOf(iface.endpoint));
    } else if (g.endpoints.has(entry.id)) {
      // an endpoint: the calls into it and who makes them
      for (const c of g.callers.get(entry.id) ?? []) {
        rec(this.indexOf(c.id));
        rec(this.indexOf(c.from));
      }
    }
    // Breadth first; a component is visited once, with the words of the first hop that queued
    // it. A component already queued is not queued again: the later copy would be skipped when
    // it came up, so it is never made (nor its words' union).
    const queuedMark = this.queuedMark;
    const first = this.indexOf(entry.component);
    queuedMark[first] = pass;
    const queue: { component: string; at: number; toks: Set<string>; depth: number; mode: Mode }[] =
      [{ component: entry.component, at: first, toks: entry.tokens, depth: 0, mode: entry.mode }];
    for (let q = 0; q < queue.length; q++) {
      const { component, at, toks, depth, mode } = queue[q]!;
      if (!this.ownAt(at, component)) continue;
      rec(at);
      visits?.push({ component, tokens: toks });
      this.tablesIx(component, toks, mode, rec);
      if (depth >= this.maxDepth) continue;
      const outs = this.outsOf(component);
      const { hit, n } = this.sharingHits(this.outWordsMemo, component, outs, toks, (i) =>
        this.callTokens(i),
      );
      // None shares a word: all of them, where nothing else starts work.
      const all = n === 0 && this.startCount(component) <= 1;
      if (n === 0 && !all) continue;
      const oix = this.outsIxOf(component, outs);
      for (let k = 0; k < outs.length; k++) {
        if (!all && !hit[k]) continue;
        const i = outs[k]!;
        hops?.push(i);
        const id = oix[k * 3]!;
        const ep = oix[k * 3 + 1]!;
        const to = oix[k * 3 + 2]!;
        rec(id);
        reach(id);
        if (ep >= 0) {
          rec(ep);
          reach(ep);
        }
        rec(to);
        if (queuedMark[to] !== pass && this.ownAt(to, i.to)) {
          queuedMark[to] = pass;
          queue.push({
            component: i.to,
            at: to,
            toks: unionNew(toks, this.hopTokens(i)),
            depth: depth + 1,
            mode: i.sync === "async" ? "any" : modeOf(i.method),
          });
        }
      }
    }
    return {
      entry,
      records: Int32Array.from(records),
      reached: Int32Array.from(reached),
      ...(visits ? { visits } : {}),
      ...(hops ? { hops } : {}),
    };
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
    // Every id on the way points at the root now (the same groups, found faster).
    for (let y = x; y !== r;) {
      const next = this.parent.get(y)!;
      this.parent.set(y, r);
      y = next;
    }
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
      const l = out.get(r);
      if (l) l.push(id);
      else out.set(r, [id]);
    }
    return [...out.values()];
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

type Decision = RecordOf<"CuratedDecision">;

function currentDecisions(decisions: readonly CatalogRecord[]): Decision[] {
  // Oldest first by the instant `at` names (an offset is allowed), then id: as applyCurated.
  return decisions
    .filter((d): d is Decision => d.kind === "CuratedDecision" && d.status === "current")
    .filter((d) => d.target.startsWith("feature."))
    .sort(byDecisionTime);
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

/**
 * A feature's evidence: its entry points', then the first evidence (by record id) of each other
 * repo its records come from, by repo id. A feature traced through several repos cites each, so
 * it changes only when one of them does (ADR 0195, CS2; CLAUDE.md rule 6).
 */
function withEachRepo(
  own: EvidenceT[],
  records: readonly (CatalogRecord | undefined)[],
): EvidenceT[] {
  const have = new Set(own.flatMap((e) => (e.repo ? [e.repo] : [])));
  const first = new Map<string, EvidenceT>();
  for (const r of records)
    for (const e of r?.evidence ?? [])
      if (e.repo && !have.has(e.repo) && !first.has(e.repo)) first.set(e.repo, e);
  return [...own, ...[...first].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, e]) => e)];
}

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
  const byId = new Map(records.map((r) => [r.id, r]));
  const list = [...entries.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  tracer.useEntries(list);
  const keep = o.keepFlows !== false;
  const traced = new Map(list.map((e) => [e.id, tracer.traceIx(e, keep)]));
  const flows = new Map<string, Flow>();
  if (keep)
    for (const [id, f] of traced)
      flows.set(id, {
        entry: f.entry,
        records: new Set(Array.from(f.records, (k) => tracer.idOf(k))),
        reached: new Set(Array.from(f.reached, (k) => tracer.idOf(k))),
        visits: f.visits!,
        hops: f.hops!,
      });
  /** The entry points, by their number in the traces. */
  const entryAt = new Map<number, string>();
  for (const e of list) entryAt.set(tracer.indexOf(e.id), e.id);

  const groups = new Groups(
    list.map((e) => e.id),
    (id) => pins.get(id),
  );
  // An entry point another flow passes through is part of that flow's feature.
  /** The flows that reach each entry point, by entry id (in flow order). */
  const reachers = new Map<string, string[]>();
  const joining = new Set(["endpoint", "consumer", "pinned"]);
  for (const f of traced.values()) {
    const hit: string[] = [];
    for (const k of f.reached) {
      const r = entryAt.get(k);
      if (r !== undefined) {
        hit.push(r);
        const l = reachers.get(r);
        if (l) l.push(f.entry.id);
        else reachers.set(r, [f.entry.id]);
      }
    }
    // With no pins the groups don't depend on the order of the joins (each is a connected
    // part, rooted at its least id), so only pinned groups need them in id order.
    for (const r of pins.size ? hit.sort() : hit)
      if (r !== f.entry.id && joining.has(entries.get(r)!.kind)) groups.join(f.entry.id, r);
  }
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
    const inGroup = new Set(members);
    const reachedByOthers = (m: string) =>
      (reachers.get(m) ?? []).some((x) => x !== m && inGroup.has(x));
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
  // Each feature's records: its members' flows', each once, marked by number.
  const markedFor: number[] = [];
  let feature = 0;
  for (const b of built.sort((x, y) => (x.id < y.id ? -1 : 1))) {
    feature++;
    const ids: string[] = [];
    for (const m of b.members)
      for (const k of traced.get(m)!.records)
        if (markedFor[k] !== feature) {
          markedFor[k] = feature;
          ids.push(tracer.idOf(k));
        }
    features.set(b.id, {
      members: b.members,
      name: displayName(b.resource),
      records: new Set(ids),
    });
  }

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
    const records = sorted(f.records);
    out.push(
      capability({
        id,
        name: p?.name ?? f.name,
        ...(p?.description ? { description: p.description } : {}),
        entryPoints: f.members,
        records,
        tags: p ? [...p.tags] : [],
        externalRefs: [],
        namedBy: p ? "ai" : "detected",
        evidence: withEachRepo(
          dedupeEvidence(f.members.flatMap((m) => entries.get(m)!.evidence)),
          records.map((r) => byId.get(r)),
        ),
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
