import { readdir } from "node:fs/promises";
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

/** One flow in a line or two: trigger, then its steps with positions and fields. */
export function flowLine(f: SpecFlow): string {
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
  return `flow ${fl.id} (repo ${f.repo}, component ${fl.component}) "${fl.name}": ${fl.trigger.kind} ${fl.trigger.what}. Steps: ${steps}`;
}

/** The compact index: features, flows, components and systems, endpoints, tables. */
export function estateIndex(e: Estate): string {
  const recs = e.records as Rec[];
  const of = (k: string) =>
    recs.filter((r) => r.kind === k).sort((a, b) => a.id.localeCompare(b.id));
  const lines = [
    "The estate, from the repos' specs and the scanned catalog. Ids are exact: name only these, or say something is new.",
    "",
  ];
  for (const s of of("System"))
    lines.push(
      `system ${s.id}${str(s.name) ? ` "${str(s.name)}"` : ""}${str(s.boundary) ? ` (${str(s.boundary)})` : ""}`,
    );
  for (const c of of("Component"))
    lines.push(
      `component ${c.id}: system ${str(c.system) ?? "?"}${str(c.repo) ? `, repo ${str(c.repo)}` : ""}${str(c.type) ? `, ${str(c.type)}` : ""}`,
    );
  for (const f of of("Capability"))
    lines.push(
      `feature ${f.id} "${str(f.name) ?? f.id}": entry points ${arr(f.entryPoints).join(", ") || "none"}`,
    );
  for (const f of [...e.flows].sort((a, b) => a.flow.id.localeCompare(b.flow.id)))
    lines.push(flowLine(f));
  for (const x of of("Endpoint"))
    lines.push(
      `endpoint ${x.id}: ${str(x.component) ?? "?"} serves ${str(x.method) ?? ""} ${str(x.pathOrTopic) ?? ""}`.replace(
        / {2,}/g,
        " ",
      ),
    );
  for (const t of of("Table")) {
    const cols = recs
      .filter((r) => r.kind === "Column" && str(r.table) === t.id)
      .map((r) => str(r.name) ?? r.id.split(".").pop()!)
      .sort();
    lines.push(`table ${t.id}: columns ${cols.join(", ") || "unknown"}`);
  }
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
