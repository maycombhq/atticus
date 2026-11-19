import { JOINED_BY_PERSON, type RecordKind } from "@maycombhq/core";
import type { CatalogIndex } from "./catalog-index.js";

export interface GraphNode {
  id: string;
  kind: RecordKind;
  label: string;
  status: string;
  system?: string;
}
export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  via: string;
  pattern?: string;
  confidence: "verified" | "inferred" | "asserted";
  status: string;
}

interface Hop {
  id: string;
  from: string;
  to: string;
  via: string;
  pattern?: string;
  confidence: GraphEdge["confidence"];
  status: string;
}

/**
 * Systems, components and the interfaces between them (the API's getGraph). With a focus (a
 * component or a system) only what is within `depth` interface hops of it, in either direction.
 */
export function graph(
  ix: CatalogIndex,
  o: { focus?: string; depth?: number; status?: string } = {},
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const hops: Hop[] = (
    ix.db
      .prepare(
        `SELECT id, json_extract(json, '$.from') AS "from", json_extract(json, '$.to') AS "to", json_extract(json, '$.via') AS via,
                json_extract(json, '$.pattern.code') AS pattern, confidence, status
         FROM records WHERE kind = 'Interface'${o.status ? " AND status = ?" : ""} ORDER BY id`,
      )
      .all(...(o.status ? [o.status] : [])) as unknown as (Hop & { pattern: string | null })[]
  ).map((h) => ({ ...h, pattern: h.pattern ?? undefined }));
  // What a module builds on (ADR 0068): a build-time link, drawn and followed like a call.
  for (const c of ix.db
    .prepare(
      `SELECT id, json_extract(json, '$.uses') AS uses, confidence, status FROM records
       WHERE kind = 'Component' AND json_extract(json, '$.uses') IS NOT NULL${o.status ? " AND status = ?" : ""} ORDER BY id`,
    )
    .all(...(o.status ? [o.status] : [])) as unknown as {
    id: string;
    uses: string;
    confidence: GraphEdge["confidence"];
    status: string;
  }[])
    for (const to of JSON.parse(c.uses) as string[])
      hops.push({
        id: `uses.${c.id}.${to}`,
        from: c.id,
        to,
        via: "uses",
        confidence: c.confidence,
        status: c.status,
      });
  const nodeRows = ix.db
    .prepare(
      "SELECT kind, id, name, status, system FROM records WHERE kind IN ('System', 'Component') ORDER BY kind DESC, id",
    )
    .all() as unknown as {
    kind: RecordKind;
    id: string;
    name: string;
    status: string;
    system: string | null;
  }[];
  const nodes = new Map(nodeRows.map((n) => [n.id, n]));
  const systemOf = (id: string) => nodes.get(id)?.system ?? undefined;

  let keep: Set<string>;
  if (o.focus) {
    const start = nodes.get(o.focus);
    if (!start) return { nodes: [], edges: [] };
    keep = new Set(
      start.kind === "System"
        ? [
            start.id,
            ...nodeRows
              .filter((n) => n.kind === "Component" && n.system === start.id)
              .map((n) => n.id),
          ]
        : [start.id],
    );
    let frontier = [...keep];
    for (let d = 0; d < (o.depth ?? 1); d++) {
      const next: string[] = [];
      for (const h of hops) {
        if (frontier.includes(h.from) && !keep.has(h.to)) next.push(h.to);
        if (frontier.includes(h.to) && !keep.has(h.from)) next.push(h.from);
      }
      for (const n of next) keep.add(n);
      frontier = next;
    }
  } else keep = new Set([...nodes.keys(), ...hops.flatMap((h) => [h.from, h.to])]);

  // Show the system of every component kept, so components group under their systems.
  for (const id of [...keep]) {
    const s = systemOf(id);
    if (s && nodes.get(id)?.kind === "Component") keep.add(s);
  }
  const outNodes: GraphNode[] = [...keep]
    .filter((id) => nodes.has(id))
    .map((id) => {
      const n = nodes.get(id)!;
      return {
        id,
        kind: n.kind,
        label: n.name,
        status: n.status,
        ...(n.kind === "Component" && n.system ? { system: n.system } : {}),
      };
    })
    .sort((a, b) => (a.kind === b.kind ? (a.id < b.id ? -1 : 1) : a.kind === "System" ? -1 : 1));
  const edges = hops
    .filter((h) => keep.has(h.from) && keep.has(h.to))
    .map(({ pattern, ...e }) => ({ ...e, ...(pattern ? { pattern } : {}) }));
  return { nodes: outNodes, edges };
}

export interface Affected {
  id: string;
  kind: RecordKind;
  /** The records from the root to this one. */
  path: string[];
  reason: string;
  owner?: string;
}
export interface Gap {
  record: string;
  field: string;
  question: string;
}

/**
 * What a change to a record reaches (the API's getImpact). Each step follows a dependency:
 * - a column or index → its table; a table → the components that read or write it;
 * - an endpoint, component or system → the interfaces that call it, and each call → its caller;
 * - a publisher (or its topic) → the event interfaces it publishes on, and each → its subscriber;
 * - a gateway route → the interfaces through it; a schema → endpoints that use it;
 * - anything → settings that target it, field mappings of an interface, foreign keys into a table.
 * Gaps are facts that would sharpen the answer: calls seen at one end only, systems without an
 * owner, and loose ends held by an affected component.
 */
export function impact(
  ix: CatalogIndex,
  rootId: string,
  depth = 4,
  o: {
    /**
     * An owner the caller knows where the record's system has none in the catalog: the manifest's
     * repo owner, a profile system's (b30 proof run: the OWNER column was empty on an estate
     * whose manifests name every repo's owner).
     */
    owner?: (r: { kind: string; id: string; system?: string }) => string | undefined;
  } = {},
): { root: string; affected: Affected[]; gaps: Gap[] } | undefined {
  const roots = ix.find(rootId);
  if (roots.length === 0) return undefined;
  const root = roots[0]!;
  const recordOf = (kind: string, id: string) =>
    ix.get(kind, id) as unknown as Record<string, unknown> | undefined;
  const anyRecord = (id: string) =>
    ix.find(id)[0] as unknown as Record<string, unknown> | undefined;

  /** The records affected one step from r, with why. */
  const step = (r: Record<string, unknown>): { kind: string; id: string; reason: string }[] => {
    const out: { kind: string; id: string; reason: string }[] = [];
    const id = String(r.id);
    if (r.kind === "Column" || r.kind === "IndexConstraint")
      out.push({ kind: "Table", id: String(r.table), reason: `${id} is part of it` });
    if (r.kind === "Table") {
      for (const c of (r.readers as string[]) ?? [])
        out.push({ kind: "", id: c, reason: `reads ${id}` });
      for (const c of (r.writers as string[]) ?? [])
        if (!((r.readers as string[]) ?? []).includes(c))
          out.push({ kind: "", id: c, reason: `writes ${id}` });
    }
    // A call depends on its callee; an event's subscriber depends on its publisher.
    if (r.kind === "Interface") {
      if (r.sync === "async")
        out.push({
          kind: "",
          id: String(r.to),
          reason: `receives ${String(r.normalizedPath)} from ${String(r.from)}`,
        });
      else
        out.push({
          kind: "",
          id: String(r.from),
          reason: `calls ${String(r.to)}${r.method ? ` (${String(r.method)} ${String(r.normalizedPath)})` : ""}`,
        });
    }
    const isAsync = (interfaceId: string) => recordOf("Interface", interfaceId)?.sync === "async";
    for (const ref of ix.referencesTo(id)) {
      const k = ref.kind;
      const f = ref.field;
      if (k === "Interface" && f === "endpoint")
        out.push({
          kind: k,
          id: ref.id,
          reason: isAsync(ref.id) ? `carries ${id}` : `calls ${id}`,
        });
      else if (k === "Interface" && f === "to" && r.kind !== "Endpoint" && !isAsync(ref.id))
        out.push({ kind: k, id: ref.id, reason: `calls ${id}` });
      else if (k === "Interface" && f === "from" && r.kind !== "Endpoint" && isAsync(ref.id))
        out.push({ kind: k, id: ref.id, reason: `carries events published by ${id}` });
      else if (k === "Interface" && f === "route")
        out.push({ kind: k, id: ref.id, reason: `goes through ${id}` });
      else if (k === "Endpoint" && f === "schemaRefs[]")
        out.push({ kind: k, id: ref.id, reason: `uses schema ${id}` });
      else if (k === "Setting" && f === "target")
        out.push({ kind: k, id: ref.id, reason: `is a setting for calls to ${id}` });
      else if (k === "FieldMapping" && f === "interface")
        out.push({ kind: k, id: ref.id, reason: `maps fields of ${id}` });
      else if (k === "IndexConstraint" && f === "references.table")
        out.push({ kind: k, id: ref.id, reason: `is a foreign key into ${id}` });
    }
    // A system is changed through its components: their callers are affected too.
    if (r.kind === "System")
      for (const c of ix
        .referencesTo(id)
        .filter((x) => x.kind === "Component" && x.field === "system"))
        out.push(...step(recordOf("Component", c.id) ?? {}).map((s) => ({ ...s })));
    return out;
  };

  const ownerOf = (kind: string, id: string): string | undefined => {
    const s = ix.systemOf(kind, id);
    const sys = s ? (recordOf("System", s) as { owner?: string } | undefined) : undefined;
    return sys?.owner ?? o.owner?.({ kind, id, ...(s ? { system: s } : {}) });
  };

  const seen = new Set<string>([`${root.kind}|${root.id}`]);
  const affected: Affected[] = [];
  let frontier: { r: Record<string, unknown>; path: string[] }[] = [
    { r: root as unknown as Record<string, unknown>, path: [root.id] },
  ];
  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const next: typeof frontier = [];
    for (const { r, path } of frontier) {
      for (const s of step(r)) {
        const rec = s.kind ? recordOf(s.kind, s.id) : anyRecord(s.id);
        const kind = (rec?.kind as RecordKind | undefined) ?? (s.kind as RecordKind);
        const key = `${kind}|${s.id}`;
        if (seen.has(key) || !rec) continue;
        seen.add(key);
        const p = [...path, s.id];
        const owner = ownerOf(kind, s.id);
        affected.push({ id: s.id, kind, path: p, reason: s.reason, ...(owner ? { owner } : {}) });
        next.push({ r: rec, path: p });
      }
    }
    frontier = next;
  }

  const gaps: Gap[] = [];
  const gapKeys = new Set<string>();
  const addGap = (g: Gap) => {
    const k = `${g.record}|${g.field}`;
    if (gapKeys.has(k)) return;
    gapKeys.add(k);
    gaps.push(g);
  };
  for (const a of affected) {
    const rec = recordOf(a.kind, a.id)!;
    // A link a person paired was answered already (ADR 0174): it isn't asked again.
    const paired = Array.isArray(rec.flags) && rec.flags.includes(JOINED_BY_PERSON);
    if (a.kind === "Interface" && rec.confidence === "inferred" && !paired)
      addGap({
        record: a.id,
        field: "confidence",
        question: `Only one end of this call was seen. Does ${String(rec.from)} really call ${String(rec.to)}?`,
      });
    const s = ix.systemOf(a.kind, a.id);
    if (s && (a.kind === "Component" || a.kind === "System")) {
      const sys = recordOf("System", s) as { owner?: string; name?: string } | undefined;
      if (sys && !sys.owner)
        addGap({ record: s, field: "owner", question: `Who owns ${sys.name ?? s}?` });
    }
    if (a.kind === "Component")
      for (const u of ix.db
        .prepare(
          "SELECT json FROM records WHERE kind = 'Unresolved' AND json_extract(json, '$.owner') = ? ORDER BY id",
        )
        .all(a.id) as { json: string }[]) {
        const x = JSON.parse(u.json) as { id: string; raw: string };
        addGap({
          record: x.id,
          field: "raw",
          question: `${a.id} has a loose end Atticus couldn't follow (${x.raw}). Where does it go?`,
        });
      }
  }
  return { root: root.id, affected, gaps };
}

/**
 * Who receives a topic or an entry (b30 proof run: `ask "who consumes the topic …"` gave the whole
 * impact walk, so callers of the consumer sat beside the real receiver). `affected` is the walk
 * as impact gives it, unchanged (C4 stays additive). Two keys are added beside it: `receivers`,
 * the components one interface away (an event's subscribers, a call's callers), and `further`,
 * what a change reaches past a receiver, which receives nothing from the root.
 */
export function receiversOf(
  ix: CatalogIndex,
  rootId: string,
  depth = 4,
  o: Parameters<typeof impact>[3] = {},
):
  | { root: string; receivers: Affected[]; affected: Affected[]; further: Affected[]; gaps: Gap[] }
  | undefined {
  const r = impact(ix, rootId, depth, o);
  if (!r) return undefined;
  // root, the interface that names it, the component at its other end.
  const via = new Set(
    r.affected.filter((a) => a.path.length === 2 && a.kind === "Interface").map((a) => a.id),
  );
  const receivers = r.affected.filter(
    (a) => a.path.length === 3 && a.kind !== "Interface" && via.has(a.path[1]!),
  );
  const further = r.affected.filter((a) => a.path.length > 3);
  return { root: r.root, affected: r.affected, receivers, further, gaps: r.gaps };
}

/**
 * What a word names in the map when no record has it as its id: the one Endpoint whose path or
 * topic is exactly it (the lookup the door check uses, ADR 0201 addendum), or the ids of the
 * several that have it. Undefined when none has.
 */
export function namedRecord(
  ix: CatalogIndex,
  name: string,
): { id: string } | { several: string[] } | undefined {
  const ids = (
    ix.db
      .prepare(
        "SELECT DISTINCT id FROM records WHERE kind = 'Endpoint' AND json_extract(json, '$.pathOrTopic') = ? ORDER BY id",
      )
      .all(name) as { id: string }[]
  ).map((r) => r.id);
  return ids.length === 0 ? undefined : ids.length === 1 ? { id: ids[0]! } : { several: ids };
}

/** What is said when an id the map has is also the name of another record: a topic or an entry. */
export function alsoNamed(id: string, other: string, topic: boolean): string {
  return `${id} is also the name of the ${topic ? "topic" : "entry"} ${other}.`;
}

/**
 * The one lookup `impact`, `show`, `walk` and `show_code` make of what they are given (the review
 * of b30/proof-fixes): the id itself when the map has it (`records`: a catalog record, for
 * impact; `nodes`: anything the index holds, for the context tools), said to be also a topic's
 * or an entry's name when another record has that name; else the one record whose name it is,
 * said so; else the ids of the several records with that name. Undefined when none.
 */
export function mapIdOf(
  ix: CatalogIndex,
  id: string,
  by: "records" | "nodes",
): { id: string; said: string[] } | { several: string[] } | undefined {
  const has = (x: string) => (by === "records" ? ix.find(x).length : ix.nodes(x).length) > 0;
  const named = namedRecord(ix, id);
  const topic = (x: string) =>
    (ix.get("Endpoint", x) as { endpointType?: string } | undefined)?.endpointType ===
    "event-topic";
  if (has(id))
    return {
      id,
      said:
        named && "id" in named && named.id !== id ? [alsoNamed(id, named.id, topic(named.id))] : [],
    };
  if (!named) return undefined;
  if ("several" in named) return named;
  return has(named.id) ? { id: named.id, said: [namedAs(id, named.id)] } : undefined;
}

/** What is said of a name several records have: which, and to name the one meant. */
export function severalNamed(name: string, ids: string[]): string {
  return `${name} is the name of several records of the map (${ids.join(", ")}). Name the id of the one meant.`;
}

/** What is said first when a name stood for its record's id. */
export function namedAs(name: string, id: string): string {
  return `${name} is the name of ${id}.`;
}

/** The edit distance between two words, given up on past `max`. */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, n) => n);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let least = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(
        prev[j]! + 1,
        row[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      row.push(v);
      if (v < least) least = v;
    }
    if (least > max) return max + 1;
    prev = row;
  }
  return prev[b.length]!;
}

/**
 * The ids nearest to one the map lacks, for "did you mean": the map's systems, components and
 * repos (and `more`, the manifests' repos) within a few letters of it, nearest first.
 */
export function nearestIds(ix: CatalogIndex, id: string, more: string[] = [], limit = 3): string[] {
  const word = id.toLowerCase();
  const max = Math.max(1, Math.min(3, Math.floor(word.length / 4)));
  const known = (
    ix.db
      .prepare(
        "SELECT DISTINCT id FROM records WHERE kind IN ('System', 'Component', 'Endpoint', 'DataStore', 'Table') ORDER BY id",
      )
      .all() as { id: string }[]
  ).map((r) => r.id);
  return [...new Set([...known, ...more])]
    .filter((k) => k !== id)
    .map((k) => ({ k, d: distance(word, k.toLowerCase(), max) }))
    .filter((x) => x.d <= max)
    .sort((a, b) => a.d - b.d || (a.k < b.k ? -1 : 1))
    .slice(0, limit)
    .map((x) => x.k);
}
