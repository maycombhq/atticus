import type { Api, CatalogRecord, EvidenceT, RecordOf } from "@maycombhq/core";

/**
 * The estate as one hierarchy (ADR 0081, plan 4.6): estate → system → repo → component →
 * element (endpoint, topic, client, store → table, deployment), built from the catalog records,
 * with typed atomic edges between the deepest nodes they touch. A view opens one node: its
 * children (lazily, one level by default) and its edges, each lifted to the nearest node the
 * view shows, parallel edges merged with a count. Pure and deterministic: the same records in
 * any order give the same views.
 */

type Lens = Api.GraphLensT;
type Kind = Api.HierKindT;
type HierNode = Api.HierNodeT;
type HierEdge = Api.HierEdgeT;
type Evidence = Api.HierEvidenceT;
type EdgeType = HierEdge["type"];

interface Raw {
  id: string;
  kind: Kind;
  label: string;
  parent?: string;
  record?: CatalogRecord;
  state: HierNode["state"];
  gaps: string[];
  evidence: Evidence[];
  properties: HierNode["properties"];
  next?: HierNode["next"];
}

interface Atom {
  from: string;
  to: string;
  type: EdgeType;
  sync?: "sync" | "async";
  via?: string;
  evidence: Evidence[];
  gaps: string[];
}

/** The model a view is cut from: build it once per catalog read. */
export interface Estate {
  nodes: Map<string, Raw>;
  kids: Map<string, string[]>;
  atoms: Atom[];
  /** Per lens: the nodes the lens shows. */
  visible: Map<Lens, Set<string>>;
}

export interface NodeViewOptions {
  lens: Lens;
  depth?: number;
  /** Every "uses" edge instead of the transitive reduction. */
  all?: boolean;
}

/** A refusal for a node the estate (or the lens) doesn't have. */
export class NoSuchNode extends Error {}

const KIND_ORDER: readonly Kind[] = [
  "estate",
  "system",
  "repo",
  "component",
  "endpoint",
  "topic",
  "client",
  "store",
  "table",
  "deployment",
  "environment",
  "unknown",
];

const LENS_KINDS: Record<Lens, ReadonlySet<Kind>> = {
  architecture: new Set([
    "estate",
    "system",
    "repo",
    "component",
    "endpoint",
    "topic",
    "client",
    "store",
    "unknown",
  ]),
  repo: new Set([
    "estate",
    "system",
    "repo",
    "component",
    "endpoint",
    "topic",
    "client",
    "store",
    "table",
    "unknown",
  ]),
  data: new Set(["estate", "system", "repo", "component", "store", "table", "unknown"]),
  integration: new Set([
    "estate",
    "system",
    "repo",
    "component",
    "endpoint",
    "topic",
    "client",
    "unknown",
  ]),
  infrastructure: new Set(["estate", "system", "repo", "component", "deployment", "environment"]),
};

const LENS_EDGES: Record<Lens, ReadonlySet<EdgeType>> = {
  architecture: new Set(["calls", "publishes", "subscribes", "uses", "reads", "writes"]),
  repo: new Set(["calls", "publishes", "subscribes", "uses", "reads", "writes", "references"]),
  data: new Set(["reads", "writes", "references"]),
  integration: new Set(["calls", "publishes", "subscribes"]),
  infrastructure: new Set(["deployed-to"]),
};

/** Lenses that show only the part of the estate their elements and edges touch. */
const LENS_ANCHORS: Partial<Record<Lens, ReadonlySet<Kind>>> = {
  data: new Set(["store", "table"]),
  integration: new Set(["endpoint", "topic", "client"]),
  infrastructure: new Set(["deployment", "environment"]),
};

/** Beyond this many nodes a detailed view groups or switches to focus (the spike's limit). */
const DETAILED_LIMIT = 60;
const MAX_EVIDENCE = 5;
const TOPIC_TYPES = new Set(["event-topic", "mq-queue"]);

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 120) || "x";

/** The layout file name for a view: `<lens>.<node>` (or `<lens>.focus.<node>`), ":" as "-". */
export function viewKey(lens: Lens, node: string, mode: "node" | "focus" = "node"): string {
  return [lens, ...(mode === "focus" ? ["focus"] : []), node.replace(/:/g, "-")].join(".");
}

function evidenceOf(es: readonly EvidenceT[]): Evidence[] {
  return es.map((e) => ({
    source: e.source,
    ...(e.repo ? { repo: e.repo } : {}),
    at: e.path ? (e.line ? `${e.path}:${e.line}` : e.path) : (e.repo ?? e.source),
  }));
}

function mergeEvidence(...lists: Evidence[][]): Evidence[] {
  const seen = new Map<string, Evidence>();
  for (const l of lists)
    for (const e of l) seen.set(`${e.repo ?? ""}\u0000${e.at}\u0000${e.source}`, e);
  return [...seen.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, e]) => e)
    .slice(0, MAX_EVIDENCE);
}

const STATE: Record<string, HierNode["state"]> = {
  current: "current",
  "planned-new": "new",
  "planned-modify": "changed",
  "planned-retire": "retired",
  retired: "retired",
};

function recordGaps(r: CatalogRecord): string[] {
  const g: string[] = [];
  if (r.confidence === "inferred") g.push("inferred");
  for (const f of r.flags ?? []) g.push(f);
  return g;
}

const props = (o: Record<string, unknown>): HierNode["properties"] => {
  const out: HierNode["properties"] = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      if (v.length) out[k] = v.map(String);
    } else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return out;
};

const all = <K extends CatalogRecord["kind"]>(rs: CatalogRecord[], k: K) =>
  rs
    .filter((r): r is RecordOf<K> => r.kind === k)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** Build the hierarchy and its atomic edges from the catalog. */
export function buildEstate(records: CatalogRecord[]): Estate {
  const nodes = new Map<string, Raw>();
  const atoms: Atom[] = [];
  const add = (n: Raw) => {
    if (!nodes.has(n.id)) nodes.set(n.id, n);
    return n.id;
  };
  const fromRecord = (
    r: CatalogRecord,
    id: string,
    kind: Kind,
    label: string,
    parent: string,
    p: Record<string, unknown>,
    extraGaps: string[] = [],
  ): Raw => ({
    id,
    kind,
    label,
    parent,
    record: r,
    state: STATE[r.status] ?? "current",
    gaps: [...recordGaps(r), ...extraGaps],
    evidence: evidenceOf(r.evidence),
    properties: props({ ...p, confidence: r.confidence }),
    next: {
      command: `atticus impact ${r.id}`,
      why: "See what a change here reaches, with owners and open questions.",
    },
  });

  add({
    id: "estate",
    kind: "estate",
    label: "Estate",
    state: "current",
    gaps: [],
    evidence: [],
    properties: {},
    next: {
      command: "atticus map <repo>",
      why: "Read a repo again when its code has changed: your assistant writes its facts, then atticus verify <repo> --write puts them here.",
    },
  });

  const systemRecords = new Map(all(records, "System").map((s) => [s.id, s]));
  const components = new Map(all(records, "Component").map((c) => [c.id, c]));
  // A catalog read from facts (ADR 0124) has no System record: its components carry the system
  // the manifest names, and its calls may name an outside system no component is (a model
  // provider, a vendor). Both are drawn as systems (a real metarepo, 2026-10-25).
  const named = new Set<string>();
  for (const c of components.values()) if (!systemRecords.has(c.system)) named.add(c.system);
  const outside = new Set<string>();
  for (const i of all(records, "Interface"))
    for (const end of [i.from, i.to])
      if (!components.has(end) && !systemRecords.has(end) && !named.has(end)) outside.add(end);
  const systems = new Set([...systemRecords.keys(), ...named, ...outside]);
  for (const id of [...named, ...outside].sort())
    add({
      id: `system:${id}`,
      kind: "system",
      label: id,
      parent: "estate",
      state: "current",
      gaps: [],
      evidence: [],
      properties: { boundary: outside.has(id) ? "outside" : "product" },
      next: outside.has(id)
        ? {
            command: `atticus query "kind:interface to:${id}"`,
            why: "List the calls made to it: it is outside the estate, named by the code that calls it.",
          }
        : {
            command: `atticus query "system:${id}"`,
            why: "List what the catalog holds of it: the manifest names it, and no System record says more yet.",
          },
    });

  for (const s of systemRecords.values())
    add({
      ...fromRecord(s, `system:${s.id}`, "system", s.name || s.id, "estate", {
        boundary: s.boundary,
        owner: s.owner,
        repos: s.repos,
        tags: s.tags,
      }),
      next: {
        command: `atticus guide ${s.id}`,
        why: "Read the system's guide: its parts, calls, data and what isn't known yet.",
      },
    });

  // Repos: the first system (by id) that lists one owns it; else the system of a component in it.
  const repoSystem = new Map<string, string>();
  for (const s of systemRecords.values())
    for (const repo of s.repos) if (!repoSystem.has(repo)) repoSystem.set(repo, s.id);
  for (const c of components.values())
    if (c.repo && !repoSystem.has(c.repo)) repoSystem.set(c.repo, c.system);
  const repoNode = (repo: string) => `repo:${slug(repo)}`;
  for (const [repo, sys] of [...repoSystem.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const parent = systems.has(sys) ? `system:${sys}` : "estate";
    const ev = [...components.values()]
      .filter((c) => c.repo === repo)
      .flatMap((c) => evidenceOf(c.evidence).filter((e) => !e.repo || e.repo === repo));
    add({
      id: repoNode(repo),
      kind: "repo",
      label: repo,
      parent,
      state: "current",
      gaps: parent === "estate" ? ["no-system"] : [],
      evidence: mergeEvidence(ev),
      properties: { name: repo },
      next: {
        command: `atticus map ${repo}`,
        why: "Read the repo again when its code has changed; Map › Trust says how far its map is trusted now.",
      },
    });
  }

  const unknown = (ref: string) =>
    add({
      id: `unknown:${slug(ref)}`,
      kind: "unknown",
      label: ref,
      parent: "estate",
      state: "current",
      gaps: ["not-in-catalog"],
      evidence: [],
      properties: {},
      next: {
        command: `atticus query "refs:${ref}"`,
        why: "Find the records that name it; the catalog has no record of its own for it.",
      },
    });
  /** A component, or failing that a system, by record id. */
  const partNode = (ref: string) =>
    components.has(ref) ? `component:${ref}` : systems.has(ref) ? `system:${ref}` : unknown(ref);

  for (const c of components.values()) {
    const gaps: string[] = [];
    let parent: string;
    if (c.repo) parent = repoNode(c.repo);
    else {
      gaps.push("no-repo");
      parent = systems.has(c.system) ? `system:${c.system}` : "estate";
    }
    if (!systems.has(c.system)) gaps.push("no-system");
    add(
      fromRecord(
        c,
        `component:${c.id}`,
        "component",
        c.id,
        parent,
        { type: c.type, runtime: c.runtime, repo: c.repo, path: c.path },
        gaps,
      ),
    );
  }

  const endpointNode = new Map<string, string>();
  for (const e of all(records, "Endpoint")) {
    const topic = TOPIC_TYPES.has(e.endpointType);
    const id = `${topic ? "topic" : "endpoint"}:${e.id}`;
    const gaps: string[] = [];
    let parent = `component:${e.component}`;
    if (!components.has(e.component)) {
      gaps.push("no-component");
      parent = systems.has(e.component) ? `system:${e.component}` : "estate";
    }
    add(
      fromRecord(
        e,
        id,
        topic ? "topic" : "endpoint",
        !topic && e.method ? `${e.method} ${e.pathOrTopic}` : e.pathOrTopic,
        parent,
        {
          endpointType: e.endpointType,
          method: e.method,
          pathOrTopic: e.pathOrTopic,
          auth: e.auth,
        },
        gaps,
      ),
    );
    endpointNode.set(e.id, id);
  }

  const storeNode = new Map<string, string>();
  for (const d of all(records, "DataStore")) {
    const owner = d.ownerComponent && components.has(d.ownerComponent);
    const id = `store:${d.id}`;
    add(
      fromRecord(
        d,
        id,
        "store",
        d.id,
        owner ? `component:${d.ownerComponent}` : "estate",
        { storeType: d.storeType, entitiesHeld: d.entitiesHeld },
        owner ? [] : ["no-owner"],
      ),
    );
    storeNode.set(d.id, id);
  }

  const tables = all(records, "Table");
  for (const t of tables) {
    const store = storeNode.get(t.dataStore);
    add(
      fromRecord(
        t,
        `table:${t.id}`,
        "table",
        t.name,
        store ?? "estate",
        { tableKind: t.tableKind, retention: t.retention, dataStore: t.dataStore },
        store ? [] : ["no-store"],
      ),
    );
  }

  for (const d of all(records, "Deployment")) {
    const env = `environment:${slug(d.env)}`;
    add({
      id: env,
      kind: "environment",
      label: d.env,
      parent: "estate",
      state: "current",
      gaps: [],
      evidence: [],
      properties: { env: d.env },
      next: {
        command: `atticus query "kind:deployment env:${d.env}"`,
        why: "List what is deployed here.",
      },
    });
    const parent = components.has(d.component) ? `component:${d.component}` : "estate";
    const id = add(
      fromRecord(
        d,
        `deployment:${d.id}`,
        "deployment",
        `${d.env} on ${d.platform}`,
        parent,
        { env: d.env, platform: d.platform, replicas: d.replicas },
        parent === "estate" ? ["no-component"] : [],
      ),
    );
    atoms.push({
      from: id,
      to: env,
      type: "deployed-to",
      evidence: evidenceOf(d.evidence),
      gaps: recordGaps(d),
    });
  }

  for (const i of all(records, "Interface")) {
    const from = partNode(i.from);
    const to = partNode(i.to);
    const ev = evidenceOf(i.evidence);
    const gaps = [...recordGaps(i), ...(i.conflicts.length ? ["conflicts"] : [])];
    const target = i.endpoint ? endpointNode.get(i.endpoint) : undefined;
    if (target?.startsWith("topic:")) {
      atoms.push({ from, to: target, type: "publishes", evidence: ev, gaps });
      atoms.push({ from: to, to: target, type: "subscribes", evidence: ev, gaps });
      continue;
    }
    let caller = from;
    if (from.startsWith("component:")) {
      caller = add({
        id: `client:${i.from}.${slug(i.to)}`,
        kind: "client",
        label: `Calls ${i.to}`,
        parent: from,
        state: "current",
        gaps: [],
        evidence: [],
        properties: { target: i.to },
        next: {
          command: `atticus query "kind:interface from:${i.from} to:${i.to}"`,
          why: "List each call this client makes.",
        },
      });
      const c = nodes.get(caller)!;
      const callerSide = evidenceOf(i.evidence.filter((x) => x.side === "caller"));
      c.evidence = mergeEvidence(c.evidence, callerSide.length ? callerSide : ev);
      c.gaps = [...new Set([...c.gaps, ...gaps])].sort();
    }
    atoms.push({
      from: caller,
      to: target ?? to,
      type: "calls",
      sync: i.sync,
      via: i.via,
      evidence: ev,
      gaps: [...gaps, ...(i.endpoint && !target ? ["no-endpoint"] : [])],
    });
  }

  for (const c of components.values())
    for (const u of c.uses ?? [])
      atoms.push({
        from: `component:${c.id}`,
        to: partNode(u),
        type: "uses",
        evidence: evidenceOf(c.evidence),
        gaps: recordGaps(c),
      });

  for (const t of tables) {
    const ev = evidenceOf(t.evidence);
    const part = (ref: string) => {
      const n = partNode(ref);
      const repo = components.get(ref)?.repo;
      const mine = repo ? ev.filter((e) => e.repo === repo) : [];
      return { n, ev: mine.length ? mine : ev };
    };
    for (const r of t.readers) {
      const p = part(r);
      atoms.push({
        from: p.n,
        to: `table:${t.id}`,
        type: "reads",
        evidence: p.ev,
        gaps: recordGaps(t),
      });
    }
    for (const w of t.writers) {
      const p = part(w);
      atoms.push({
        from: p.n,
        to: `table:${t.id}`,
        type: "writes",
        evidence: p.ev,
        gaps: recordGaps(t),
      });
    }
  }

  const tableIds = new Set(tables.map((t) => t.id));
  for (const k of all(records, "IndexConstraint")) {
    if (k.constraintKind !== "foreign-key" || !k.references) continue;
    if (!tableIds.has(k.table)) continue;
    atoms.push({
      from: `table:${k.table}`,
      to: tableIds.has(k.references.table)
        ? `table:${k.references.table}`
        : unknown(k.references.table),
      type: "references",
      evidence: evidenceOf(k.evidence),
      gaps: recordGaps(k),
    });
  }

  // Children, in a stable order: by kind, then id.
  const kids = new Map<string, string[]>();
  for (const n of nodes.values()) {
    if (!n.parent) continue;
    if (!nodes.has(n.parent)) n.parent = "estate";
    const l = kids.get(n.parent) ?? [];
    l.push(n.id);
    kids.set(n.parent, l);
  }
  const rank = (id: string) => KIND_ORDER.indexOf(nodes.get(id)!.kind);
  for (const l of kids.values())
    l.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  for (const n of nodes.values()) n.gaps = [...new Set(n.gaps)].sort();

  const est: Estate = { nodes, kids, atoms, visible: new Map() };
  for (const lens of Object.keys(LENS_KINDS) as Lens[]) est.visible.set(lens, visibleIn(est, lens));
  return est;
}

function visibleIn(est: Estate, lens: Lens): Set<string> {
  const kinds = LENS_KINDS[lens];
  const anchors = LENS_ANCHORS[lens];
  const ok = (id: string) => kinds.has(est.nodes.get(id)!.kind);
  if (!anchors) return new Set([...est.nodes.keys()].filter(ok));
  // Only the part the lens's elements and edges touch, with every ancestor of it.
  const seeds = new Set<string>();
  for (const n of est.nodes.values()) if (anchors.has(n.kind)) seeds.add(n.id);
  for (const a of est.atoms)
    if (LENS_EDGES[lens].has(a.type)) {
      seeds.add(a.from);
      seeds.add(a.to);
    }
  const out = new Set<string>(["estate"]);
  for (const s of seeds)
    for (let id: string | undefined = s; id; id = est.nodes.get(id)?.parent)
      if (ok(id)) out.add(id);
  return out;
}

const ancestors = (est: Estate, id: string): string[] => {
  const out: string[] = [];
  for (let p = est.nodes.get(id)?.parent; p; p = est.nodes.get(p)?.parent) out.unshift(p);
  return out;
};

/** The nearest node the lens shows: the node itself or an ancestor. */
const lift = (est: Estate, lens: Lens, id: string): string => {
  const vis = est.visible.get(lens)!;
  let cur: string | undefined = id;
  while (cur && !vis.has(cur)) cur = est.nodes.get(cur)?.parent;
  return cur ?? "estate";
};

const kidsIn = (est: Estate, lens: Lens, id: string) =>
  (est.kids.get(id) ?? []).filter((k) => est.visible.get(lens)!.has(k));

function toNode(est: Estate, lens: Lens, id: string): HierNode {
  const r = est.nodes.get(id)!;
  return {
    id: r.id,
    kind: r.kind,
    label: r.label,
    ...(r.parent ? { parent: r.parent } : {}),
    childCount: kidsIn(est, lens, id).length,
    state: r.state,
    gaps: r.gaps,
    evidence: r.evidence,
    properties: r.properties,
    ...(r.record ? { record: { kind: r.record.kind, id: r.record.id } } : {}),
    ...(r.next ? { next: r.next } : {}),
  };
}

function need(est: Estate, lens: Lens, id: string) {
  if (!est.nodes.has(id)) throw new NoSuchNode(`There is no node ${id}.`);
  if (!est.visible.get(lens)!.has(id))
    throw new NoSuchNode(`There is no node ${id} in the ${lens} lens.`);
}

/** Merge atoms (already mapped to view nodes) into edges: one per type and pair, with a count. */
function merge(mapped: { from: string; to: string; atom: Atom }[]): HierEdge[] {
  const by = new Map<string, HierEdge>();
  for (const { from, to, atom } of mapped) {
    const id = `${atom.type}:${from}>${to}`;
    const e = by.get(id);
    if (!e) {
      by.set(id, {
        id,
        from,
        to,
        type: atom.type,
        ...(atom.sync ? { sync: atom.sync } : {}),
        ...(atom.via ? { via: atom.via } : {}),
        count: 1,
        state: "current",
        gaps: [...new Set(atom.gaps)].sort(),
        evidence: mergeEvidence(atom.evidence),
      });
      continue;
    }
    e.count++;
    if (atom.sync && e.sync !== atom.sync) e.sync = "mixed";
    if (atom.via && e.via !== atom.via) e.via = "mixed";
    e.gaps = [...new Set([...e.gaps, ...atom.gaps])].sort();
    e.evidence = mergeEvidence(e.evidence, atom.evidence);
  }
  return [...by.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Drop a "uses" edge A→C when A reaches C through other "uses" edges. */
function reduceUses(edges: HierEdge[]): { edges: HierEdge[]; hidden: number } {
  const uses = edges.filter((e) => e.type === "uses");
  const out = new Map<string, string[]>();
  for (const e of uses) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  const reachesWithout = (from: string, to: string, skip: HierEdge) => {
    const seen = new Set<string>();
    const stack = (out.get(from) ?? []).filter((n) => !(from === skip.from && n === skip.to));
    while (stack.length) {
      const n = stack.pop()!;
      if (n === to) return true;
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(...(out.get(n) ?? []));
    }
    return false;
  };
  const drop = new Set(uses.filter((e) => reachesWithout(e.from, e.to, e)).map((e) => e.id));
  return { edges: edges.filter((e) => !drop.has(e.id)), hidden: drop.size };
}

/** One node of the estate with its children (to `depth` levels) and its edges inside and out. */
export function nodeView(est: Estate, id: string, o: NodeViewOptions): Api.GraphNodeViewT {
  const { lens } = o;
  const depth = Math.max(1, Math.min(3, o.depth ?? 1));
  need(est, lens, id);
  const shown: string[] = [];
  let level = [id];
  for (let d = 0; d < depth; d++) {
    level = level.flatMap((n) => kidsIn(est, lens, n));
    shown.push(...level);
  }
  const shownSet = new Set(shown);
  const upToN = [...ancestors(est, id), id];
  const inside = (x: string) => x === id || ancestors(est, x).includes(id);
  const place = (x: string): string => {
    if (x === id) return x;
    if (inside(x)) {
      let cur: string | undefined = x;
      while (cur && !shownSet.has(cur) && cur !== id) cur = est.nodes.get(cur)?.parent;
      return cur ?? id;
    }
    if (upToN.includes(x)) return x;
    const ax = [...ancestors(est, x), x];
    let i = 0;
    while (i < ax.length && ax[i] === upToN[i]) i++;
    return ax[i] ?? x;
  };
  const types = LENS_EDGES[lens];
  const mapped: { from: string; to: string; atom: Atom }[] = [];
  for (const atom of est.atoms) {
    if (!types.has(atom.type)) continue;
    const a = lift(est, lens, atom.from);
    const b = lift(est, lens, atom.to);
    if (!inside(a) && !inside(b)) continue;
    const from = place(a);
    const to = place(b);
    if (from === to) continue;
    mapped.push({ from, to, atom });
  }
  let edges = merge(mapped);
  let hidden = 0;
  if (!o.all) ({ edges, hidden } = reduceUses(edges));
  const outside = [...new Set(edges.flatMap((e) => [e.from, e.to]))]
    .filter((n) => n !== id && !shownSet.has(n))
    .sort();
  const children = shown.map((n) => toNode(est, lens, n));
  const firstTable = children.find((c) => c.kind === "table");
  const suggest =
    lens === "data" && firstTable
      ? { mode: "focus" as const, id: firstTable.id }
      : shown.length + outside.length > DETAILED_LIMIT
        ? { mode: "group" as const }
        : undefined;
  return {
    lens,
    node: toNode(est, lens, id),
    path: ancestors(est, id).map((n) => toNode(est, lens, n)),
    children,
    outside: outside.map((n) => toNode(est, lens, n)),
    edges,
    reduced: !o.all,
    hiddenEdges: hidden,
    ...(suggest ? { suggest } : {}),
  };
}

/** A node and its direct neighbours in the lens, with every edge between them. */
export function focusView(est: Estate, id: string, o: { lens: Lens }): Api.GraphFocusViewT {
  const { lens } = o;
  need(est, lens, id);
  const inside = (x: string) => x === id || ancestors(est, x).includes(id);
  const types = LENS_EDGES[lens];
  const ends = est.atoms
    .filter((a) => types.has(a.type))
    .map((atom) => {
      const a = lift(est, lens, atom.from);
      const b = lift(est, lens, atom.to);
      return { from: inside(a) ? id : a, to: inside(b) ? id : b, atom };
    })
    .filter((e) => e.from !== e.to);
  const near = new Set<string>();
  for (const e of ends) {
    if (e.from === id) near.add(e.to);
    if (e.to === id) near.add(e.from);
  }
  const set = new Set([id, ...near]);
  return {
    lens,
    node: toNode(est, lens, id),
    path: ancestors(est, id).map((n) => toNode(est, lens, n)),
    neighbours: [...near].sort().map((n) => toNode(est, lens, n)),
    edges: merge(ends.filter((e) => set.has(e.from) && set.has(e.to))),
  };
}
