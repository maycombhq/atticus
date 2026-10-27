import { readdir } from "node:fs/promises";
import type { SourceInput } from "@maycombhq/ai";
import { readRepoSpec, specsDirOf, type CatalogRecord, type FlowRecord } from "@maycombhq/core";

/**
 * The estate as the stages read it (ADR 0087): every repo's spec of flows (ADR 0079) and the
 * catalog, as a compact index the assistant picks from by meaning. Every id the assistant
 * names is checked against this index; nothing it names that isn't here is kept.
 */

type Rec = CatalogRecord & Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const arr = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).map(String) : []);

export interface SpecFlow {
  repo: string;
  flow: FlowRecord;
}

export interface Estate {
  records: CatalogRecord[];
  flows: SpecFlow[];
  /** Ids of catalog records and flows. */
  ids: Set<string>;
  byId: Map<string, Rec>;
  flowById: Map<string, SpecFlow>;
  /** "METHOD /path" of every endpoint the catalog has (paths as written). */
  endpoints: Set<string>;
  /** Files in specs/ that didn't read. */
  problems: string[];
}

/** Read every repo's spec under specs/ and index it with the catalog. */
export async function loadEstate(root: string, records: CatalogRecord[]): Promise<Estate> {
  const flows: SpecFlow[] = [];
  const problems: string[] = [];
  const repos = (await readdir(specsDirOf(root), { withFileTypes: true }).catch(() => []))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const repo of repos) {
    const s = await readRepoSpec(root, repo, { cacheRoot: root });
    for (const f of s.flows) flows.push({ repo, flow: f });
    for (const p of s.problems) problems.push(`${p.file}: ${p.message}`);
  }
  return estateOf(records, flows, problems);
}

export function estateOf(
  records: CatalogRecord[],
  flows: SpecFlow[],
  problems: string[] = [],
): Estate {
  const byId = new Map((records as Rec[]).map((r) => [r.id, r]));
  const flowById = new Map(flows.map((f) => [f.flow.id, f]));
  const endpoints = new Set<string>();
  for (const r of records as Rec[])
    if (r.kind === "Endpoint" && str(r.method) && str(r.pathOrTopic))
      endpoints.add(endpointKey(`${str(r.method)} ${str(r.pathOrTopic)}`));
  return {
    records,
    flows,
    ids: new Set([...byId.keys(), ...flowById.keys()]),
    byId,
    flowById,
    endpoints,
    problems,
  };
}

/** A system outside every repo of the estate that the estate calls: a vendor, a model provider. */
export interface OutsideSystem {
  id: string;
  /** The entries it is called at: each entry's key (endpointKey) to the way it is written. */
  entries: Map<string, string>;
  /** The components that call it. */
  callers: Set<string>;
}

/** The kinds a call's target may be inside the estate; any other id it names is outside. */
const INSIDE = new Set(["Component", "System", "Table", "DataStore", "Endpoint", "Column"]);
const outsideOf = new WeakMap<Estate, Map<string, OutsideSystem>>();

/**
 * The outside systems the estate names as a call's target (ADR 0087 addendum, 2026-10-25): the
 * target a call fact names (its Interface's `to`) and the target a spec flow's call-out or
 * publish names, where the catalog has no Component or System of that id (a model provider,
 * `llm`; a vendor the join couldn't resolve, `unresolved.<call>`). A target flow may call them.
 */
export function outsideSystems(e: Estate): Map<string, OutsideSystem> {
  const had = outsideOf.get(e);
  if (had) return had;
  const out = new Map<string, OutsideSystem>();
  const add = (id: string | undefined, entry: string | undefined, caller: string | undefined) => {
    if (!id || INSIDE.has(e.byId.get(id)?.kind ?? "")) return;
    const o = out.get(id) ?? { id, entries: new Map(), callers: new Set<string>() };
    if (entry?.trim()) {
      const w = entry.trim();
      o.entries.set(/^\s*[A-Za-z]+\s+\S/.test(w) ? endpointKey(w) : w, w);
    }
    if (caller) o.callers.add(caller);
    out.set(id, o);
  };
  for (const r of e.records as Rec[])
    if (r.kind === "Interface")
      add(str(r.to), [str(r.method), str(r.normalizedPath)].filter(Boolean).join(" "), str(r.from));
  for (const f of e.flows)
    for (const s of f.flow.steps) if (s.to) add(s.to.component, s.to.entry, f.flow.component);
  outsideOf.set(e, out);
  return out;
}

/** An outside system as the compact index writes it. */
export function outsideLine(o: OutsideSystem): string {
  const entries = [...new Set(o.entries.values())].sort();
  return `outside system ${o.id}: called by ${[...o.callers].sort().join(", ") || "?"}${entries.length ? ` at ${entries.join(", ")}` : ""}`;
}

/** "get /a/{id}/" → "GET /a/{}": method upper case, parameters and trailing slash folded. */
export function endpointKey(s: string): string {
  const m = /^\s*([A-Za-z]+)\s+(\S+)/.exec(s);
  if (!m) return s.trim();
  const path = m[2]!
    .replace(/\?.*$/, "")
    .replace(/\{[^}]*\}/g, "{}")
    .replace(/(.)\/$/, "$1");
  return `${m[1]!.toUpperCase()} ${path}`;
}

/**
 * A flow's trigger entry (W5): the method and path of the endpoint that starts it, from the
 * catalog's Endpoint record the trigger cites, else the record's id. Undefined without one.
 */
export function triggerEntry(f: SpecFlow, e?: Estate): string | undefined {
  const ref = f.flow.trigger.ref;
  if (!ref) return undefined;
  const r = e?.byId.get(ref);
  const method = str(r?.method);
  const path = str(r?.pathOrTopic);
  return r?.kind === "Endpoint" && path ? `${method ? `${method} ` : ""}${path}` : undefined;
}

/** The flows each endpoint starts, by the endpoint's record id. */
function flowsStartedBy(e: Estate, endpoint: string): string[] {
  return e.flows
    .filter((f) => f.flow.trigger.ref === endpoint)
    .map((f) => f.flow.id)
    .sort();
}

/** A flow's trigger in words, with its entry first when it has one (W5). */
function triggerText(f: SpecFlow, e?: Estate): string {
  const t = f.flow.trigger;
  const entry = triggerEntry(f, e);
  return entry ? `trigger ${entry} (${t.kind} ${t.ref}): ${t.what}` : `${t.kind} ${t.what}`;
}

/** A flow in one line, as the context engine lists one it doesn't give in full: with its trigger entry. */
export function flowSummary(f: SpecFlow, e?: Estate): string {
  const entry = triggerEntry(f, e);
  return `flow ${f.flow.id} (repo ${f.repo}, component ${f.flow.component}) "${f.flow.name}"${entry ? `, trigger ${entry}` : ""}`;
}

/** One flow in a line or two: trigger (its entry first), then its steps with positions and fields. */
export function flowLine(f: SpecFlow, e?: Estate): string {
  const fl = f.flow;
  const steps = fl.steps
    .map((s, i) => {
      const fields = [
        ...(s.data?.sends ?? []),
        ...(s.data?.returns ?? []),
        ...(s.data?.reads ?? []),
        ...(s.store?.columns ?? []),
      ];
      const where = s.to
        ? ` → ${s.to.component} ${s.to.entry}`
        : s.store
          ? ` ${s.store.table}`
          : "";
      return `${i + 1} ${s.kind}${where}${fields.length ? ` [${[...new Set(fields)].join(", ")}]` : ""}`;
    })
    .join("; ");
  return `flow ${fl.id} (repo ${f.repo}, component ${fl.component}) "${fl.name}": ${triggerText(f, e)}. Steps: ${steps}`;
}

/** One record or flow of the estate, as the compact index writes it; undefined for other kinds. */
export function estateLine(e: Estate, kind: string, id: string, rec?: Rec): string | undefined {
  if (kind === "Flow") {
    const f = e.flowById.get(id);
    return f ? flowLine(f, e) : undefined;
  }
  const r = rec ?? (e.records as Rec[]).find((x) => x.kind === kind && x.id === id);
  if (!r) return undefined;
  if (kind === "System")
    return `system ${r.id}${str(r.name) ? ` "${str(r.name)}"` : ""}${str(r.boundary) ? ` (${str(r.boundary)})` : ""}`;
  if (kind === "Component")
    return `component ${r.id}: system ${str(r.system) ?? "?"}${str(r.repo) ? `, repo ${str(r.repo)}` : ""}${str(r.type) ? `, ${str(r.type)}` : ""}`;
  if (kind === "Capability")
    return `feature ${r.id} "${str(r.name) ?? r.id}": entry points ${arr(r.entryPoints).join(", ") || "none"}`;
  if (kind === "Endpoint") {
    const starts = flowsStartedBy(e, r.id);
    return `endpoint ${r.id}: ${str(r.component) ?? "?"} serves ${str(r.method) ?? ""} ${str(r.pathOrTopic) ?? ""}`
      .replace(/ {2,}/g, " ")
      .trimEnd()
      .concat(starts.length ? `; trigger of flow ${starts.join(", ")}` : "");
  }
  if (kind === "Table") {
    const cols = (e.records as Rec[])
      .filter((x) => x.kind === "Column" && str(x.table) === r.id)
      .map((x) => str(x.name) ?? x.id.split(".").pop()!)
      .sort();
    const allowed = allowedValuesOf(e, r.id).map((a) => `${a.column} (${a.values.join(", ")})`);
    return `table ${r.id}: columns ${cols.join(", ") || "unknown"}${allowed.length ? `; allowed values: ${allowed.join("; ")}` : ""}`;
  }
  return undefined;
}

/** A column's allowed values, as the catalog's Column record states them, cited (C1). */
export interface AllowedValues {
  column: string;
  id: string;
  values: string[];
  /** repo:path:line of the line that states them. */
  at: string;
}

/** The allowed values of a table's columns the catalog knows, by column name. */
export function allowedValuesOf(e: Estate, table: string): AllowedValues[] {
  const out: AllowedValues[] = [];
  for (const r of e.records as Rec[]) {
    if (r.kind !== "Column" || str(r.table) !== table) continue;
    const a = r.allowedValues as
      { values?: unknown; evidence?: { repo?: string; path?: string; line?: number } } | undefined;
    const values = arr(a?.values);
    if (!a || !values.length) continue;
    const ev = a.evidence ?? {};
    const at = [ev.repo, ev.path, ev.line].filter((x) => x !== undefined && x !== "").join(":");
    out.push({ column: str(r.name) ?? r.id.split(".").pop()!, id: r.id, values, at });
  }
  return out.sort((x, y) => x.column.localeCompare(y.column));
}

/**
 * The values the code allows in the columns of the tables a step stores into (S2): facts from
 * the catalog, each cited to the migration line that states them, so the model and the lenses
 * read a value the code defines instead of calling it unknown. At most 40 lines.
 */
export function allowedValuesSource(e: Estate, tables: Iterable<string>): SourceInput[] {
  const lines: string[] = [];
  for (const t of [...new Set(tables)].sort())
    for (const a of allowedValuesOf(e, t))
      lines.push(`- ${a.id}: ${a.values.join(", ")}${a.at ? ` (${a.at})` : ""}`);
  if (!lines.length) return [];
  return [
    {
      id: "allowed-values",
      kind: "catalog",
      origin: "the catalog's columns, as their migrations state them (deterministic)",
      text: [
        "The values the code allows in the columns of the tables the change's steps store into, each cited to the line that states them. These values are known: never call one of these unknown or ask what it is.",
        ...lines.slice(0, 40),
        ...(lines.length > 40 ? [`- and ${lines.length - 40} more`] : []),
      ].join("\n"),
      classification: "internal",
      priority: 88,
    },
  ];
}

/** The kinds the compact index lists. */
export const ESTATE_KINDS = ["System", "Component", "Capability", "Flow", "Endpoint", "Table"];

/** The compact index's heading. */
export const ESTATE_HEADING =
  "The estate, from the repos' specs and the scanned catalog. Ids are exact: name only these, or say something is new.";

/**
 * The repos a change's estate context covers (B-run2-fixes 11), in a metarepo several estates
 * share: the repos it touches, every repo of their components' systems, and the repos whose
 * components call theirs or are called by them (the catalog's Interfaces), one hop.
 */
export function scopeRepos(e: Estate, touched: Iterable<string>): Set<string> {
  const recs = e.records as Rec[];
  const repoOf = (id: unknown) => str((e.byId.get(str(id) ?? "") as Rec | undefined)?.repo);
  const out = new Set(touched);
  const systems = new Set(
    recs
      .filter((r) => r.kind === "Component" && out.has(str(r.repo) ?? ""))
      .flatMap((r) => (str(r.system) ? [str(r.system)!] : [])),
  );
  for (const r of recs)
    if (r.kind === "Component" && systems.has(str(r.system) ?? "") && str(r.repo))
      out.add(str(r.repo)!);
  const seed = new Set(out);
  for (const r of recs) {
    if (r.kind !== "Interface") continue;
    const callee =
      repoOf(r.to) ?? repoOf((e.byId.get(str(r.endpoint) ?? "") as Rec | undefined)?.component);
    const caller = repoOf(r.from);
    if (caller && seed.has(caller) && callee) out.add(callee);
    if (callee && seed.has(callee) && caller) out.add(caller);
  }
  return out;
}

/**
 * What of the estate belongs to these repos (B-run2-fixes 11): their components and systems, the
 * endpoints those serve, the tables they own, read or write, the features whose entry points are
 * theirs, and the repos' flows; every other kind of record. The whole estate when no repo is
 * given, or none of the catalog's components is in one.
 */
export function inScope(
  e: Estate,
  repos?: ReadonlySet<string>,
): { records: CatalogRecord[]; flows: SpecFlow[]; outside: string[] } {
  const all = e.records as Rec[];
  const comps = new Set(
    all.filter((r) => r.kind === "Component" && repos?.has(str(r.repo) ?? "")).map((r) => r.id),
  );
  const scoped = !!repos && comps.size > 0;
  if (!scoped) return { records: e.records, flows: e.flows, outside: [] };
  const systems = new Set(
    all.filter((r) => comps.has(r.id)).flatMap((r) => (str(r.system) ? [str(r.system)!] : [])),
  );
  const endpoints = new Set(
    all.filter((r) => r.kind === "Endpoint" && comps.has(str(r.component) ?? "")).map((r) => r.id),
  );
  // The systems some repo's component is in; any other is outside every estate (a vendor).
  const owned = new Set(
    all
      .filter((r) => r.kind === "Component" && str(r.repo) && str(r.system))
      .map((r) => str(r.system)!),
  );
  const cited = (r: Rec) =>
    ((r.evidence ?? []) as { repo?: string }[]).some((x) => !!x.repo && repos!.has(x.repo));
  const keep = (r: Rec): boolean => {
    switch (r.kind) {
      case "System":
        // A vendor's or another outside system (no repo's component is in it) stays: a call to it is a fact of any estate.
        return systems.has(r.id) || !owned.has(r.id);
      case "Component":
        return comps.has(r.id) || !str(r.repo);
      case "Capability":
        return arr(r.entryPoints).some((x) => endpoints.has(x)) || cited(r);
      case "Endpoint":
        return endpoints.has(r.id);
      case "Table":
        return (
          [str(r.ownerComponent), ...arr(r.readers), ...arr(r.writers)].some(
            (c) => !!c && comps.has(c),
          ) || cited(r)
        );
      default:
        return true;
    }
  };
  const flows = e.flows.filter((f) => repos!.has(f.repo));
  return {
    records: all.filter(keep),
    flows,
    outside: [
      ...all.filter((r) => !keep(r)).map((r) => r.id),
      ...e.flows.filter((f) => !repos!.has(f.repo)).map((f) => f.flow.id),
    ].sort(),
  };
}

/**
 * The compact index: features, flows, components and systems, endpoints, tables. With `repos`
 * (B-run2-fixes 11), only what belongs to those repos (`scopeRepos`, `inScope`): another estate's
 * flows in a shared metarepo are no context for a change.
 */
export function estateIndex(e: Estate, repos?: ReadonlySet<string>): string {
  const { records, flows } = inScope(e, repos);
  const recs = records as Rec[];
  const of = (k: string) =>
    recs.filter((r) => r.kind === k).sort((a, b) => a.id.localeCompare(b.id));
  const lines = [ESTATE_HEADING, ""];
  for (const k of ["System", "Component", "Capability"])
    for (const r of of(k)) lines.push(estateLine(e, k, r.id, r)!);
  // The outside systems the components here call (a model provider, a vendor): a call-out's target too.
  const comps = new Set(of("Component").map((r) => r.id));
  for (const o of [...outsideSystems(e).values()].sort((a, b) => a.id.localeCompare(b.id)))
    if ([...o.callers].some((c) => comps.has(c))) lines.push(outsideLine(o));
  for (const f of [...flows].sort((a, b) => a.flow.id.localeCompare(b.flow.id)))
    lines.push(flowLine(f, e));
  for (const k of ["Endpoint", "Table"])
    for (const r of of(k)) lines.push(estateLine(e, k, r.id, r)!);
  if (lines.length === 2) lines.push("Nothing is scanned or specified yet.");
  return lines.join("\n");
}

/** Columns the catalog knows for a table. */
export function columnsOf(e: Estate, table: string): Set<string> {
  return new Set(
    (e.records as Rec[])
      .filter((r) => r.kind === "Column" && str(r.table) === table)
      .map((r) => str(r.name) ?? r.id.split(".").pop()!),
  );
}

/** A schema file a database reads (DDL), not code. */
const SCHEMA_FILE = /\.(sql|ddl|cql|prisma)$/i;

/** A file that declares columns of a table, from the columns' citations. */
export interface DeclaringFile {
  path: string;
  /** The tables' columns it cites, in the order first cited. */
  columns: string[];
  /** Its cited lines, sorted. */
  lines: number[];
}

/**
 * The files that declare these tables' columns (B-run2-fixes 1 and 2), from the columns'
 * citations: the schema file that creates a table (one citing at least half of its columns) and
 * the entity mapped to it (the code file citing the most of its columns and no other table's),
 * not a superclass or a shared model citing one of its columns in passing (at most half as many
 * as the entity, or beside other tables'). Most columns first, then by path.
 * `repo` keeps the citations in that repo (and those that name none). At most `max`.
 */
export function declaringFiles(
  e: Estate,
  tables: readonly string[],
  o: { repo?: string; max?: number } = {},
): DeclaringFile[] {
  const want = new Set(tables);
  const files = new Map<string, { columns: Set<string>; lines: Set<number>; other: number }>();
  let total = 0;
  for (const r of e.records as Rec[]) {
    if (r.kind !== "Column") continue;
    const mine = want.has(str(r.table) ?? "");
    if (mine) total++;
    for (const ev of (r.evidence ?? []) as { path?: string; line?: number; repo?: string }[]) {
      if (!ev.path || (o.repo && ev.repo && ev.repo !== o.repo)) continue;
      const f = files.get(ev.path) ?? { columns: new Set(), lines: new Set(), other: 0 };
      if (!mine) f.other++;
      else {
        f.columns.add(r.id);
        if (ev.line) f.lines.add(ev.line);
      }
      files.set(ev.path, f);
    }
  }
  // Of the code files citing only these tables' columns, the entity cites the most: a superclass
  // declaring one of them (a name, an id) cites fewer than half as many.
  const entity = Math.max(
    0,
    ...[...files]
      .filter(([p, f]) => f.other === 0 && !SCHEMA_FILE.test(p))
      .map(([, f]) => f.columns.size),
  );
  return [...files]
    .filter(
      ([, f]) =>
        f.columns.size > 0 &&
        (f.columns.size * 2 >= total || (f.other === 0 && f.columns.size * 2 >= entity)),
    )
    .sort(([a, x], [b, y]) => y.columns.size - x.columns.size || a.localeCompare(b))
    .slice(0, o.max ?? 6)
    .map(([path, f]) => ({
      path,
      columns: [...f.columns].map((c) => c.split(".").at(-1)!),
      lines: [...f.lines].sort((a, b) => a - b),
    }));
}

/**
 * Whether a table is a key-pattern store (C1 `tableKind: key-pattern`: a cache or key-value
 * store read and written by key): it has no columns and no migrations (B-fixes, problem 4).
 */
export function isKeyPattern(e: Estate, table: string): boolean {
  const r = e.byId.get(table);
  return r?.kind === "Table" && r.tableKind === "key-pattern";
}

/** A field of a catalog Schema record; `required` left out when nobody knows (ADR 0125). */
export interface SchemaFieldOf {
  name: string;
  type?: string;
  required?: boolean;
}

/**
 * The fields of an endpoint's Schema on one side, as `projectFacts` names it
 * (`<endpoint>.request`, `.response`, `.message`), in the record's order; none without one.
 */
export function schemaFieldsOf(
  e: Estate,
  endpoint: string,
  side: "request" | "response" | "message",
): SchemaFieldOf[] {
  const s = e.byId.get(`${endpoint}.${side}`);
  if (s?.kind !== "Schema") return [];
  return s.fields.map((f) => ({
    name: f.name,
    ...(f.type !== undefined ? { type: f.type } : {}),
    ...(f.required !== undefined ? { required: f.required } : {}),
  }));
}

/** The Endpoint records an entry names ("POST /orders", or a topic), parameters folded. */
export function endpointsFor(e: Estate, entry: string): string[] {
  const k = endpointKey(entry);
  return (e.records as Rec[])
    .filter(
      (r) =>
        r.kind === "Endpoint" &&
        str(r.pathOrTopic) !== undefined &&
        endpointKey(`${str(r.method) ?? ""} ${str(r.pathOrTopic)}`.trim()) === k,
    )
    .map((r) => r.id)
    .sort();
}

/** The system a component (or a system id itself) belongs to. */
export function systemOf(e: Estate, id: string): string | undefined {
  const r = e.byId.get(id);
  if (!r) return undefined;
  if (r.kind === "System") return r.id;
  return str(r.system);
}
