import type { CatalogRecord, RecordOf } from "@maycombhq/core";

/**
 * Views are a small neutral model between the catalog and a drawing format, so the same view
 * renders as Mermaid or draw.io, and a draw.io file read back can render as Mermaid too.
 * Every builder sorts what it returns: the same catalog always gives the same drawing.
 */

export type Legend = "new" | "modify" | "retire";
export type Boundary = "product" | "internal" | "vendor";

export interface ViewNode {
  /** The record id (or diagram cell for a view read from draw.io). */
  id: string;
  label: string;
  kind: "system" | "component" | "table" | "topic" | "box";
  boundary?: Boundary;
  legend?: Legend;
  /** The group (system or data store) the node is drawn inside. */
  group?: string;
}

export interface ViewGroup {
  id: string;
  label: string;
  kind: "system" | "datastore";
  boundary?: Boundary;
  legend?: Legend;
}

export interface ViewEdge {
  id: string;
  from: string;
  to: string;
  /** For interfaces, the reconcile label grammar: `<pattern> <METHOD> <path>` or `<pattern> <topic>`. */
  label: string;
  async: boolean;
  legend?: Legend;
}

export interface FlowView {
  type: "context" | "container" | "data" | "event" | "diagram";
  title: string;
  /** Set when the view was read from a file rather than built from the catalog. */
  source?: string;
  /** Groups in drawing order; nodes in drawing order (grouped nodes first, by group). */
  groups: ViewGroup[];
  nodes: ViewNode[];
  edges: ViewEdge[];
}

export type SequenceStep =
  | { kind: "message"; from: string; to: string; label: string; async: boolean; legend?: Legend }
  | { kind: "note"; over: [string, string]; text: string };

export interface SequenceView {
  type: "sequence";
  title: string;
  participants: { id: string; label: string; legend?: Legend }[];
  steps: SequenceStep[];
}

export type View = FlowView | SequenceView;
export type ViewName = "context" | "container" | "data" | "event" | "sequence";
export const VIEW_NAMES: ViewName[] = ["context", "container", "data", "event", "sequence"];

/** A request the catalog can't answer (unknown focus or id); the CLI reports it, exit 1. */
export class ViewError extends Error {}

type Iface = RecordOf<"Interface">;
type Endpoint = RecordOf<"Endpoint">;
type Table = RecordOf<"Table">;

export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
const normPath = (p: string) => p.replace(/\{[^}]*\}/g, "{}").replace(/\/+$/, "") || "/";

export function legendOf(status: string | undefined): Legend | undefined {
  if (status === "planned-new") return "new";
  if (status === "planned-modify") return "modify";
  if (status === "planned-retire") return "retire";
  return undefined;
}
const withLegend = (status: string | undefined) => {
  const l = legendOf(status);
  return l ? { legend: l } : {};
};

/** Lookups over the records a view needs. Retired records are left out of every view. */
class Catalog {
  readonly byId = new Map<string, CatalogRecord>();
  readonly systems = new Map<string, RecordOf<"System">>();
  readonly components = new Map<string, RecordOf<"Component">>();
  readonly endpoints = new Map<string, Endpoint>();
  readonly stores = new Map<string, RecordOf<"DataStore">>();
  readonly interfaces: Iface[];
  readonly tables: Table[];

  constructor(records: CatalogRecord[]) {
    const live = records.filter((r) => r.status !== "retired").sort((a, b) => cmp(a.id, b.id));
    for (const r of live) {
      if (r.kind !== "CuratedDecision") this.byId.set(r.id, r);
      if (r.kind === "System") this.systems.set(r.id, r);
      else if (r.kind === "Component") this.components.set(r.id, r);
      else if (r.kind === "Endpoint") this.endpoints.set(r.id, r);
      else if (r.kind === "DataStore") this.stores.set(r.id, r);
    }
    this.interfaces = live.filter((r): r is Iface => r.kind === "Interface");
    this.tables = live.filter((r): r is Table => r.kind === "Table");
  }

  isSystem(id: string): boolean {
    return this.systems.has(id) || [...this.components.values()].some((c) => c.system === id);
  }
  /** A component's system; a system is its own. */
  systemOf(id: string): string | undefined {
    return this.components.get(id)?.system ?? (this.isSystem(id) ? id : undefined);
  }
  boundaryOf(id: string): Boundary | undefined {
    const s = this.systemOf(id);
    return s ? this.systems.get(s)?.boundary : undefined;
  }
  systemName(id: string): string {
    return this.systems.get(id)?.name ?? id;
  }
  /** Does `drawn` (a component or system) stand for this interface end? */
  same(drawn: string, end: string): boolean {
    return drawn === end || (!this.components.has(drawn) && this.systemOf(end) === drawn);
  }
  componentsOf(system: string): string[] {
    return [...this.components.values()].filter((c) => c.system === system).map((c) => c.id);
  }
  /** A node for a component or system end of an interface. */
  endNode(id: string, group?: string): ViewNode {
    const sys = this.components.has(id) ? undefined : this.systems.get(id);
    const boundary = this.boundaryOf(id);
    return {
      id,
      label: sys ? sys.name : id,
      kind: this.components.has(id) ? "component" : this.isSystem(id) ? "system" : "box",
      ...(boundary ? { boundary } : {}),
      ...withLegend((sys ?? this.components.get(id))?.status),
      ...(group ? { group } : {}),
    };
  }
  /** The topic an async interface carries. */
  topicOf(i: Iface): string {
    const ep = i.endpoint ? this.endpoints.get(i.endpoint) : undefined;
    return ep?.endpointType === "event-topic" ? ep.pathOrTopic : i.normalizedPath;
  }
  /**
   * An interface's label in the grammar reconcile reads back: pattern code, then METHOD and
   * path, or the topic. The path is the endpoint's own template when it normalizes to the
   * interface's path, because that is what people recognise.
   */
  interfaceLabel(i: Iface): string {
    let what: string;
    if (i.sync === "async") what = this.topicOf(i);
    else {
      const ep = i.endpoint ? this.endpoints.get(i.endpoint) : undefined;
      const path =
        ep?.endpointType === "rest" && normPath(ep.pathOrTopic) === normPath(i.normalizedPath)
          ? ep.pathOrTopic
          : i.normalizedPath;
      what = [i.method?.toUpperCase(), path].filter(Boolean).join(" ");
    }
    return [i.pattern?.code, what].filter(Boolean).join(" ");
  }
  interfaceEdge(i: Iface, from: string, to: string): ViewEdge {
    return {
      id: i.id,
      from,
      to,
      label: this.interfaceLabel(i),
      async: i.sync === "async",
      ...withLegend(i.status),
    };
  }
}

const byEdge = (a: ViewEdge, b: ViewEdge) =>
  cmp(a.from, b.from) || cmp(a.to, b.to) || cmp(a.label, b.label) || cmp(a.id, b.id);

/**
 * Context view: every system and every interface between systems. An interface inside one
 * system is a loop on that system, so the view accounts for every interface and a draw.io
 * export reconciles without gaps.
 */
export function contextView(records: CatalogRecord[]): FlowView {
  const c = new Catalog(records);
  const nodes = new Map<string, ViewNode>();
  for (const id of c.systems.keys()) nodes.set(id, c.endNode(id));
  for (const comp of c.components.values())
    if (!nodes.has(comp.system)) nodes.set(comp.system, c.endNode(comp.system));
  const edges: ViewEdge[] = [];
  for (const i of c.interfaces) {
    const from = c.systemOf(i.from) ?? i.from;
    const to = c.systemOf(i.to) ?? i.to;
    for (const end of [from, to]) if (!nodes.has(end)) nodes.set(end, c.endNode(end));
    edges.push(c.interfaceEdge(i, from, to));
  }
  return {
    type: "context",
    title: "Context view",
    groups: [],
    nodes: [...nodes.values()].sort((a, b) => cmp(a.id, b.id)),
    edges: edges.sort(byEdge),
  };
}

/** Container view: one system's components, the components they talk to, and the interfaces. */
export function containerView(records: CatalogRecord[], system: string): FlowView {
  const c = new Catalog(records);
  if (!c.isSystem(system)) throw new ViewError(`No system "${system}" in the catalog.`);
  const own = c.componentsOf(system).sort(cmp);
  const inside = (id: string) => id === system || own.includes(id);
  const sys = c.systems.get(system);
  const groups: ViewGroup[] = [];
  const nodes = new Map<string, ViewNode>();
  const groupOf = (s: string): ViewGroup => {
    const rec = c.systems.get(s);
    return {
      id: s,
      label: c.systemName(s),
      kind: "system",
      ...(rec?.boundary ? { boundary: rec.boundary } : {}),
      ...withLegend(rec?.status),
    };
  };
  if (own.length > 0) {
    groups.push(groupOf(system));
    for (const id of own) nodes.set(id, c.endNode(id, system));
  } else nodes.set(system, c.endNode(system));

  const edges: ViewEdge[] = [];
  const neighbourGroups = new Map<string, ViewGroup>();
  for (const i of c.interfaces) {
    if (!inside(i.from) && !inside(i.to)) continue;
    for (const end of [i.from, i.to]) {
      if (nodes.has(end)) continue;
      const comp = c.components.get(end);
      if (comp) {
        if (!neighbourGroups.has(comp.system))
          neighbourGroups.set(comp.system, groupOf(comp.system));
        nodes.set(end, c.endNode(end, comp.system));
      } else nodes.set(end, c.endNode(end));
    }
    edges.push(c.interfaceEdge(i, i.from, i.to));
  }
  groups.push(...[...neighbourGroups.values()].sort((a, b) => cmp(a.id, b.id)));
  const order = new Map(groups.map((g, n) => [g.id, n]));
  const sorted = [...nodes.values()].sort(
    (a, b) =>
      (a.group !== undefined ? order.get(a.group)! : groups.length) -
        (b.group !== undefined ? order.get(b.group)! : groups.length) || cmp(a.id, b.id),
  );
  return {
    type: "container",
    title: `Container view of ${sys?.name ?? system}`,
    groups,
    nodes: sorted,
    edges: edges.sort(byEdge),
  };
}

/** Components in scope for a focus that is a component or a system; undefined for "all". */
function scopeOf(c: Catalog, focus: string): Set<string> | undefined {
  if (c.components.has(focus)) return new Set([focus]);
  if (c.isSystem(focus)) return new Set([focus, ...c.componentsOf(focus)]);
  return undefined;
}

/**
 * Data view: tables grouped by data store, and the components that read or write them. A
 * focus (component, system, data store or table) keeps the tables it touches and everyone
 * who uses those tables.
 */
export function dataView(records: CatalogRecord[], focus?: string): FlowView {
  const c = new Catalog(records);
  let tables = c.tables;
  if (focus !== undefined) {
    const scope = scopeOf(c, focus);
    if (scope)
      tables = tables.filter((t) =>
        [...t.readers, ...t.writers, ...(t.ownerComponent ? [t.ownerComponent] : [])].some((x) =>
          scope.has(x),
        ),
      );
    else if (c.stores.has(focus) || tables.some((t) => t.dataStore === focus))
      tables = tables.filter((t) => t.dataStore === focus);
    else if (c.byId.get(focus)?.kind === "Table") tables = tables.filter((t) => t.id === focus);
    else throw new ViewError(`"${focus}" isn't in the catalog.`);
  }
  const groups = [...new Set(tables.map((t) => t.dataStore))].sort(cmp).map((s): ViewGroup => {
    const store = c.stores.get(s);
    return {
      id: s,
      label: store ? `${s} (${store.storeType})` : s,
      kind: "datastore",
      ...withLegend(store?.status),
    };
  });
  const nodes: ViewNode[] = [];
  for (const g of groups)
    for (const t of tables.filter((x) => x.dataStore === g.id))
      nodes.push({ id: t.id, label: t.name, kind: "table", group: g.id, ...withLegend(t.status) });
  const users = [...new Set(tables.flatMap((t) => [...t.readers, ...t.writers]))].sort(cmp);
  for (const u of users) nodes.push(c.endNode(u));
  const edges: ViewEdge[] = [];
  for (const u of users)
    for (const t of tables) {
      const reads = t.readers.includes(u);
      const writes = t.writers.includes(u);
      if (!reads && !writes) continue;
      edges.push({
        id: `access.${u}.${t.id}`,
        from: u,
        to: t.id,
        label: reads && writes ? "reads and writes" : reads ? "reads" : "writes",
        async: false,
      });
    }
  return {
    type: "data",
    title: focus ? `Data view of ${focus}` : "Data view",
    groups,
    nodes,
    edges: edges.sort(byEdge),
  };
}

/**
 * Event view: each topic with its publishers and subscribers. Publishers are the topic's
 * owning component and the senders of async interfaces on it; subscribers their receivers.
 */
export function eventView(records: CatalogRecord[], focus?: string): FlowView {
  const c = new Catalog(records);
  interface Topic {
    id: string;
    label: string;
    legend?: Legend;
    pubs: Map<string, Legend | undefined>;
    subs: Map<string, Legend | undefined>;
  }
  const topics = new Map<string, Topic>();
  const topic = (name: string, id = `topic.${slug(name)}`, status?: string): Topic => {
    let t = topics.get(name);
    if (!t) {
      t = { id, label: name, ...withLegend(status), pubs: new Map(), subs: new Map() };
      topics.set(name, t);
    }
    return t;
  };
  for (const ep of c.endpoints.values())
    if (ep.endpointType === "event-topic") topic(ep.pathOrTopic, ep.id, ep.status);
  for (const i of c.interfaces) {
    if (i.sync !== "async") continue;
    const t = topic(c.topicOf(i));
    if (!t.pubs.has(i.from)) t.pubs.set(i.from, legendOf(i.status));
    if (!t.subs.has(i.to)) t.subs.set(i.to, legendOf(i.status));
  }
  for (const ep of c.endpoints.values()) {
    if (ep.endpointType !== "event-topic") continue;
    const t = topics.get(ep.pathOrTopic)!;
    const known = c.components.has(ep.component) || c.isSystem(ep.component);
    if (known && !t.pubs.has(ep.component)) t.pubs.set(ep.component, t.legend);
  }
  let chosen = [...topics.values()];
  if (focus !== undefined) {
    const byId = chosen.find((t) => t.id === focus);
    const scope = scopeOf(c, focus);
    if (byId) chosen = [byId];
    else if (scope)
      chosen = chosen.filter((t) => [...t.pubs.keys(), ...t.subs.keys()].some((x) => scope.has(x)));
    else throw new ViewError(`"${focus}" isn't in the catalog.`);
  }
  chosen.sort((a, b) => cmp(a.id, b.id));
  const ends = [...new Set(chosen.flatMap((t) => [...t.pubs.keys(), ...t.subs.keys()]))].sort(cmp);
  const nodes: ViewNode[] = [
    ...ends.map((e) => c.endNode(e)),
    ...chosen.map((t): ViewNode => ({
      id: t.id,
      label: t.label,
      kind: "topic",
      ...(t.legend ? { legend: t.legend } : {}),
    })),
  ];
  const edges: ViewEdge[] = [];
  for (const t of chosen) {
    for (const [p, legend] of [...t.pubs].sort((a, b) => cmp(a[0], b[0])))
      edges.push({
        id: `pub.${p}.${t.id}`,
        from: p,
        to: t.id,
        label: "publishes",
        async: true,
        ...(legend ? { legend } : {}),
      });
    for (const [s, legend] of [...t.subs].sort((a, b) => cmp(a[0], b[0])))
      edges.push({
        id: `sub.${t.id}.${s}`,
        from: t.id,
        to: s,
        label: "delivers to",
        async: true,
        ...(legend ? { legend } : {}),
      });
  }
  return {
    type: "event",
    title: focus ? `Event view of ${focus}` : "Event view",
    groups: [],
    nodes,
    edges,
  };
}

/**
 * Sequence view for an impact path: the records in the order given (components, systems,
 * interfaces, tables, topics). Between neighbours it draws every interface between them in
 * its real direction, else the table access, else a note that no link is known.
 */
export function sequenceView(records: CatalogRecord[], ids: string[]): SequenceView {
  const c = new Catalog(records);
  if (ids.length === 0) throw new ViewError("Name at least one record for the sequence.");
  const participants = new Map<string, SequenceView["participants"][number]>();
  const steps: SequenceStep[] = [];
  const topics = new Map(
    [...c.endpoints.values()].filter((e) => e.endpointType === "event-topic").map((e) => [e.id, e]),
  );
  const add = (id: string) => {
    if (participants.has(id)) return;
    const rec = c.byId.get(id);
    const label =
      rec?.kind === "System"
        ? rec.name
        : rec?.kind === "Endpoint" && rec.endpointType === "event-topic"
          ? rec.pathOrTopic
          : id;
    participants.set(id, { id, label, ...withLegend(rec?.status) });
  };
  const message = (from: string, to: string, label: string, async: boolean, status?: string) =>
    steps.push({ kind: "message", from, to, label, async, ...withLegend(status) });
  const access = (comp: string, table: Table) => {
    const r = table.readers.includes(comp);
    const w = table.writers.includes(comp);
    return r && w ? "reads and writes" : r ? "reads" : w ? "writes" : undefined;
  };
  const link = (a: string, b: string) => {
    const between = (x: string, y: string) =>
      c.interfaces
        .filter((i) => c.same(x, i.from) && c.same(y, i.to))
        .sort((p, q) => cmp(c.interfaceLabel(p), c.interfaceLabel(q)) || cmp(p.id, q.id));
    for (const [x, y] of [
      [a, b],
      [b, a],
    ] as const) {
      const found = between(x, y);
      if (found.length > 0) {
        for (const i of found) message(x, y, c.interfaceLabel(i), i.sync === "async", i.status);
        return;
      }
    }
    for (const [comp, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const rec = c.byId.get(other);
      if (rec?.kind === "Table") {
        const how = access(comp, rec);
        if (how) return message(comp, other, how, false);
      }
      const t = topics.get(other);
      if (t) {
        const on = c.interfaces.filter((i) => i.sync === "async" && c.topicOf(i) === t.pathOrTopic);
        if (t.component === comp || on.some((i) => c.same(comp, i.from)))
          return message(comp, other, "publishes", true);
        if (on.some((i) => c.same(comp, i.to))) return message(other, comp, "delivers to", true);
      }
    }
    steps.push({ kind: "note", over: [a, b], text: `No known link between ${a} and ${b}` });
  };

  let prev: string | undefined;
  for (const raw of ids) {
    const rec = c.byId.get(raw);
    if (!rec && !c.isSystem(raw)) throw new ViewError(`"${raw}" isn't in the catalog.`);
    if (rec?.kind === "Interface") {
      add(rec.from);
      add(rec.to);
      message(rec.from, rec.to, c.interfaceLabel(rec), rec.sync === "async", rec.status);
      prev = rec.to;
      continue;
    }
    let id = raw;
    if (rec?.kind === "Endpoint" && rec.endpointType !== "event-topic") id = rec.component;
    else if (
      rec &&
      rec.kind !== "Component" &&
      rec.kind !== "System" &&
      rec.kind !== "Table" &&
      rec.kind !== "Endpoint"
    )
      throw new ViewError(
        `${raw} is a ${rec.kind}; a sequence shows components, systems, interfaces, endpoints, tables and topics.`,
      );
    add(id);
    if (prev !== undefined && prev !== id) link(prev, id);
    prev = id;
  }
  return {
    type: "sequence",
    title: `Sequence view: ${ids.join(", ")}`,
    participants: [...participants.values()],
    steps,
  };
}

/** Build a named view; the CLI's entry point. */
export function buildView(records: CatalogRecord[], name: ViewName, focus?: string): View {
  switch (name) {
    case "context":
      return contextView(records);
    case "container":
      if (!focus) throw new ViewError("A container view needs a system: --focus <system>.");
      return containerView(records, focus);
    case "data":
      return dataView(records, focus);
    case "event":
      return eventView(records, focus);
    case "sequence":
      if (!focus) throw new ViewError("A sequence view needs record ids: --focus <id>,<id>,...");
      return sequenceView(
        records,
        focus
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
  }
}

export { slug as viewSlug };
