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
    const s = await readRepoSpec(root, repo);
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

/** The compact index: features, flows, components and systems, endpoints, tables. */
export function estateIndex(e: Estate): string {
  const recs = e.records as Rec[];
  const of = (k: string) =>
    recs.filter((r) => r.kind === k).sort((a, b) => a.id.localeCompare(b.id));
  const lines = [ESTATE_HEADING, ""];
  for (const k of ["System", "Component", "Capability"])
    for (const r of of(k)) lines.push(estateLine(e, k, r.id, r)!);
  for (const f of [...e.flows].sort((a, b) => a.flow.id.localeCompare(b.flow.id)))
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

/** The system a component (or a system id itself) belongs to. */
export function systemOf(e: Estate, id: string): string | undefined {
  const r = e.byId.get(id);
  if (!r) return undefined;
  if (r.kind === "System") return r.id;
  return str(r.system);
}
