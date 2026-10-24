import {
  endpointKey,
  schemaFieldsOf,
  systemOf,
  type Estate,
  type SchemaFieldOf,
} from "./estate.js";
import type { StageIssue } from "./loop.js";
import type { DeltaStep, FlowDelta } from "./schema.js";

/**
 * The contract deltas of a change's target flows, and who they break (ADR 0124 addendum B-arch).
 * A contract change is breaking when the facts say so: a field today's response returns is
 * gone, the entry reads a field in place of one it read, the entry or response step is removed,
 * the flow is removed, a column the catalog has gets another type, or the entry requires a new
 * request field or one the catalog has as optional (ADR 0125). The drafter may also mark a step
 * breaking (a field whose meaning changes). Every breaking change lists its consumers, and those
 * are taken from the map: an Interface record's caller, a spec flow that calls the entry, the
 * trigger's caller, a table's readers and writers and the spec flows that store into it. A
 * consumer the map knows that the draft leaves out is handed back to the drafter.
 */

type Rec = Estate["records"][number] & Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const fold = (c: string) => c.replace(/[_-]/g, "").toLowerCase();
const leaf = (f: string) => fold(f.split(".").at(-1)!);
const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();
/** "a, b and c". */
const all = (xs: string[]) =>
  xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : (xs[0] ?? "");
const bare = (s: string) => s.trim().replace(/[.!?]+$/, "");

/** A call's entry as the catalog keys it: "METHOD /path" folded, or a topic as written. */
const entryKey = (entry: string) =>
  /^\s*[A-Za-z]+\s+\S/.test(entry) ? endpointKey(entry) : entry.trim();

/** An endpoint as people write it: "POST /orders", or its topic. */
export function endpointName(e: Estate, id: string): string {
  const r = e.byId.get(id);
  const path = str(r?.pathOrTopic) ?? id;
  const method = str(r?.method);
  return method ? `${method} ${path}` : path;
}

/**
 * Who calls an endpoint today, from the map: the callers of Interface records to it, the
 * components of spec flows with a call-out or publish to it, and the caller its own flow's
 * trigger names. The serving component and `own` are left out.
 */
export function endpointConsumers(e: Estate, endpoint: string, own?: string): string[] {
  const ep = e.byId.get(endpoint);
  if (ep?.kind !== "Endpoint") return [];
  const component = str(ep.component);
  const system = component ? systemOf(e, component) : undefined;
  const key = entryKey(endpointName(e, endpoint));
  const out = new Set<string>();
  for (const r of e.records as Rec[]) {
    if (r.kind !== "Interface" || typeof r.from !== "string") continue;
    const path = str(r.normalizedPath) ?? "";
    const same =
      r.endpoint === endpoint ||
      (!r.endpoint &&
        r.to === component &&
        entryKey(`${str(r.method) ?? ""} ${path}`.trim()) === key);
    if (same) out.add(r.from);
  }
  for (const f of e.flows) {
    const caller = f.flow.trigger.ref === endpoint ? f.flow.trigger.caller?.ref : undefined;
    if (caller) out.add(caller);
    for (const s of f.flow.steps) {
      if (s.kind !== "call-out" && s.kind !== "publish") continue;
      const to = s.to;
      const hit =
        s.refs.includes(endpoint) ||
        (!!to &&
          (to.entry === endpoint ||
            ((to.component === component || (!!system && to.component === system)) &&
              entryKey(to.entry) === key)));
      if (hit) out.add(f.flow.component);
    }
  }
  if (component) out.delete(component);
  if (own) out.delete(own);
  return sorted(out);
}

/**
 * Who reads or writes a table today, from the map: the Table record's readers and writers, and
 * the components of spec flows that read, look up or write it. `own` is left out.
 */
export function tableConsumers(e: Estate, table: string, own?: string): string[] {
  const t = e.byId.get(table);
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  const out = new Set<string>(t?.kind === "Table" ? [...list(t.readers), ...list(t.writers)] : []);
  for (const f of e.flows)
    for (const s of f.flow.steps) if (s.store?.table === table) out.add(f.flow.component);
  if (own) out.delete(own);
  return sorted(out);
}

/**
 * The request fields the catalog has for an endpoint (ADR 0125): its request Schema's, or its
 * message Schema's for a topic, with `required` where the catalog knows it.
 */
export function requestFieldsOf(e: Estate, endpoint: string): SchemaFieldOf[] {
  const request = schemaFieldsOf(e, endpoint, "request");
  return request.length ? request : schemaFieldsOf(e, endpoint, "message");
}

/**
 * Why an entry step's required fields break who calls it (ADR 0125): a field neither today's
 * entry step reads nor the catalog's request Schema has is a new required field; one the
 * catalog has with `required: false` is made required. A field the catalog already requires,
 * or one it has with required unknown, or one today's flow reads that the catalog doesn't
 * describe, says nothing: an unknown is never taken for optional.
 */
function requiredWhy(required: string[], reads: string[], have: SchemaFieldOf[]): string[] {
  const known = new Map(have.map((f) => [leaf(f.name), f] as const));
  const read = new Set(reads.map(leaf));
  const added = required.filter((f) => !known.has(leaf(f)) && !read.has(leaf(f)));
  const made = required.filter((f) => known.get(leaf(f))?.required === false);
  return [
    ...(added.length ? [`it requires a new field ${all(added)}`] : []),
    ...(made.length ? [`it makes ${all(made)} required`] : []),
  ];
}

/** A column type as compared: case and spaces folded, and the common spellings of one type. */
function typeKey(t: string): string {
  const k = t.toLowerCase().replace(/\s+/g, "");
  return k
    .replace(/^integer\b/, "int")
    .replace(/^boolean\b/, "bool")
    .replace(/^charactervarying/, "varchar");
}

/** A column of a catalog table that a step gives another type than the catalog's. */
export interface Retyped {
  column: string;
  from: string;
  to: string;
}

/**
 * The columns a step gives another type than the catalog's Column record has: a type change,
 * cited to that record. A table the catalog doesn't have, or a type written as the catalog
 * writes it, is none.
 */
export function retypedColumns(e: Estate, store: DeltaStep["store"]): Retyped[] {
  if (!store || store.new) return [];
  const have = new Map<string, string>();
  for (const r of e.records as Rec[])
    if (r.kind === "Column" && r.table === store.table && typeof r.type === "string")
      have.set(str(r.name) ?? r.id.split(".").at(-1)!, r.type);
  const out: Retyped[] = [];
  for (const [column, to] of Object.entries(store.types ?? {})) {
    const from = have.get(column);
    if (from !== undefined && typeKey(from) !== typeKey(to)) out.push({ column, from, to });
  }
  return out;
}

/** A breaking change to a contract: a flow's entry, or a table. */
export interface BreakingChange {
  kind: "endpoint" | "table";
  flow: string;
  repo: string;
  /** The Endpoint or Table record id; undefined when today's trigger cites no endpoint. */
  id?: string;
  /** "POST /orders", or the table id. */
  name: string;
  /** Why it breaks, in plain words: "no longer returns reservationId". */
  why: string[];
  /** Who the map shows using it, the flow's own component left out. */
  consumers: string[];
  /** Who the map shows using it, the flow's own component too. */
  seen: string[];
  /** The consumers the draft lists. */
  listed: string[];
  /** The finding's target: the flow, or flow#n for a step's change to a table. */
  target: string;
  /** The delta step, from 1, for a table's change. */
  change?: number;
}

/** The breaking contract changes of a change's target flows, in the order the deltas give them. */
export function breakingChanges(deltas: FlowDelta[], e: Estate): BreakingChange[] {
  const out: BreakingChange[] = [];
  for (const d of deltas) {
    if (d.change === "new") continue;
    const today = e.flowById.get(d.flow)?.flow;
    if (!today) continue;
    const own = today.component;
    const ref = today.trigger.ref;
    const ep = ref && e.byId.get(ref)?.kind === "Endpoint" ? ref : undefined;
    // ---- the flow's own entry
    const why: string[] = [];
    if (d.change === "remove") why.push("the flow is removed");
    d.steps.forEach((s, i) => {
      const was = s.step ? today.steps[s.step - 1] : undefined;
      const kind = s.kind ?? was?.kind;
      if (s.store) return;
      if (s.op === "remove" && was?.kind === "entry") why.push("its entry step is removed");
      if (s.op === "remove" && was?.kind === "respond") why.push("its response step is removed");
      if (s.op === "change" && was && kind === "respond" && s.fields?.returns) {
        const now = new Set(s.fields.returns.map(leaf));
        const gone = (was.data?.returns ?? []).filter((f) => !now.has(leaf(f)));
        if (gone.length) why.push(`it no longer returns ${all(gone)}`);
      }
      if (s.op === "change" && was && kind === "entry" && s.fields?.reads) {
        const before = was.data?.reads ?? [];
        const now = new Set(s.fields.reads.map(leaf));
        const gone = before.filter((f) => !now.has(leaf(f)));
        const added = s.fields.reads.filter((f) => !before.some((b) => leaf(b) === leaf(f)));
        if (gone.length && added.length)
          why.push(`its entry reads ${all(added)} in place of ${all(gone)}`);
      }
      // ADR 0125: a new required request field, or one made required, against the catalog.
      if (s.op !== "remove" && kind === "entry" && s.fields?.required?.length)
        why.push(
          ...requiredWhy(
            s.fields.required,
            was?.kind === "entry" ? (was.data?.reads ?? []) : [],
            ep ? requestFieldsOf(e, ep) : [],
          ),
        );
      if (s.breaking && s.op !== "remove")
        why.push(`change ${i + 1} is marked breaking${s.why?.trim() ? `: ${bare(s.why)}` : ""}`);
    });
    if (why.length) {
      out.push({
        kind: "endpoint",
        flow: d.flow,
        repo: d.repo,
        ...(ep ? { id: ep } : {}),
        name: ep ? endpointName(e, ep) : d.flow,
        why,
        consumers: ep ? endpointConsumers(e, ep, own) : [],
        seen: ep ? endpointConsumers(e, ep) : [],
        listed: d.consumers ?? [],
        target: d.flow,
      });
    }
    // ---- each table a step changes the type of a column of
    d.steps.forEach((s, i) => {
      if (!s.store || s.op === "remove" || e.byId.get(s.store.table)?.kind !== "Table") return;
      const why = retypedColumns(e, s.store).map(
        (r) => `it changes the type of ${r.column} from ${r.from} to ${r.to}`,
      );
      if (s.breaking)
        why.push(`change ${i + 1} is marked breaking${s.why?.trim() ? `: ${bare(s.why)}` : ""}`);
      if (!why.length) return;
      out.push({
        kind: "table",
        flow: d.flow,
        repo: d.repo,
        id: s.store.table,
        name: s.store.table,
        why,
        consumers: tableConsumers(e, s.store.table, own),
        seen: tableConsumers(e, s.store.table),
        listed: s.store.consumers ?? [],
        target: `${d.flow}#${i + 1}`,
        change: i + 1,
      });
    });
  }
  return out;
}

/**
 * Check 2: every breaking change lists the consumers the map knows; a consumer listed that the
 * catalog doesn't have is handed back; one the map doesn't show using it is a note. A breaking
 * change whose flow names no endpoint as its trigger is a note too: the map can't name callers.
 */
export function consumerIssues(deltas: FlowDelta[], e: Estate): StageIssue[] {
  const out: StageIssue[] = [];
  const breaking = breakingChanges(deltas, e);
  for (const c of breaking) {
    const why = c.why.join("; ");
    const missing = c.consumers.filter((x) => !c.listed.includes(x));
    if (c.kind === "endpoint" && !c.id)
      out.push({
        rule: "delta.contract-uncited",
        target: c.target,
        message: `Flow ${c.flow} changes its entry in a way that breaks who calls it (${why}), but today's flow names no endpoint as its trigger, so the map can't say who calls it. A person checks its callers.`,
        blocking: false,
        repo: c.repo,
      });
    if (missing.length)
      out.push({
        rule: "delta.consumer-missing",
        target: c.target,
        message:
          c.kind === "endpoint"
            ? `Flow ${c.flow} changes ${c.name} in a way that breaks who calls it today (${why}), but doesn't list ${all(missing)}, which the map shows calling it. List every caller under consumers: [${c.consumers.join(", ")}].`
            : `Change ${c.change} to ${c.flow} changes ${c.name} in a way that breaks who uses it today (${why}), but doesn't list ${all(missing)}, which the map shows reading or writing it. List them under store.consumers on that step: [${c.consumers.join(", ")}].`,
        blocking: true,
        repo: c.repo,
      });
  }
  // Every consumer the draft lists, breaking or not, is one the catalog has.
  const listedAt = (d: FlowDelta) => [
    { target: d.flow, who: `Flow ${d.flow}`, ids: d.consumers ?? [], step: undefined },
    ...d.steps.map((s, i) => ({
      target: `${d.flow}#${i + 1}`,
      who: `Change ${i + 1} to ${d.flow}`,
      ids: s.store?.consumers ?? [],
      step: i + 1,
    })),
  ];
  for (const d of deltas)
    for (const l of listedAt(d)) {
      const c = breaking.find((b) => b.target === l.target);
      for (const id of l.ids) {
        if (!e.byId.has(id))
          out.push({
            rule: "delta.unknown-consumer",
            target: `${l.target}:${id}`,
            message: `${l.who} lists consumer ${id}, which isn't in the catalog. List components from the index.`,
            blocking: true,
            repo: d.repo,
          });
        else if (c?.id && !c.seen.includes(id))
          out.push({
            rule: "delta.consumer-unseen",
            target: `${l.target}:${id}`,
            message:
              c.kind === "endpoint"
                ? `${l.who} lists ${id} as a consumer of ${c.name}, but the map doesn't show ${id} calling it. Keep it if a document says so: the map may be missing the call.`
                : `${l.who} lists ${id} as a consumer of ${c.name}, but the map doesn't show ${id} reading or writing it. Keep it if a document says so: the map may be missing it.`,
            blocking: false,
            repo: d.repo,
          });
      }
    }
  return out;
}

/** design.md's section on the breaking changes and who they break, or nothing when none. */
export function renderBreaking(deltas: FlowDelta[], e: Estate): string[] {
  const list = breakingChanges(deltas, e);
  if (!list.length) return [];
  const used = (c: BreakingChange) => {
    const who = sorted([...c.consumers, ...c.listed]);
    return who.length ? ` Used by ${all(who)}.` : " The map shows nobody using it.";
  };
  const why = (c: BreakingChange) => c.why.map((w) => w.replace(/^it /, "")).join("; ");
  return [
    "## Breaking changes",
    "",
    "Each change below breaks who uses it today; the map names them.",
    "",
    ...list.map(
      (c) =>
        `- ${c.name} (${c.kind === "table" ? `change ${c.change} to ${c.flow}` : c.flow}): ${why(c)}.${used(c)}`,
    ),
    "",
  ];
}
