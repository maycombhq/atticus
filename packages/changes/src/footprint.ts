import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import type { CatalogRecord, ChangeLifecycle, RecordOf } from "@maycombhq/core";
import { readChangeRepos } from "@maycombhq/workspace";
import type { ChangeContext } from "./context.js";
import { tableWith } from "./markdown.js";
import { changeFolder } from "./store.js";

/**
 * What a change touches, resolved against the catalog: the union of what change.yaml
 * declares and what its artifacts say (the Systems table in proposal.md, the hops in
 * interfaces.md, the tables in data.md, and repos.yaml). Deterministic: files only.
 */
export interface Footprint {
  systems: string[];
  components: string[];
  interfaces: { id: string; status: "planned-new" | "planned-modify" | "planned-retire" }[];
  dataStores: string[];
  tables: string[];
  records: string[];
  repos: string[];
  /** Touched systems outside the organisation (boundary vendor). */
  vendors: string[];
  /** Catalog data with a personal classification that the change touches. */
  personal: { id: string; classification: string; field?: string }[];
}

/**
 * Which classifications count as personal, and where that comes from (R5). The change policy's
 * `privacy.classifications` when the org set them in its own levels (one of them is a level of
 * pack.yaml's `classification`); else that list and the pack's levels above internal (with the
 * built-in four, confidential and restricted).
 */
export function personalLevels(ctx: {
  orgPack: { pack?: { classification: string[] } };
  policy: { privacy: { classifications: string[] } };
}): { levels: string[]; from: "change-policy" | "pack-levels" } {
  const pack = ctx.orgPack.pack?.classification ?? [
    "public",
    "internal",
    "confidential",
    "restricted",
  ];
  const policy = ctx.policy.privacy.classifications;
  if (policy.some((c) => pack.includes(c.toLowerCase())))
    return { levels: policy, from: "change-policy" };
  const i = pack.indexOf("internal");
  return {
    levels: [...new Set([...policy, ...(i >= 0 ? pack.slice(i + 1) : [])])],
    from: "pack-levels",
  };
}

const STATUSES = new Set(["planned-new", "planned-modify", "planned-retire"]);

async function read(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

/** A table cell as an id: no backticks or markup, lower case, catalog slug rules. */
const cellId = (s: string) => s.replace(/[`*]/g, "").trim().split(/\s+/)[0]!.toLowerCase();
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]+/g, "-");

const sorted = (s: Iterable<string>) => [...new Set(s)].sort();

export async function changeFootprint(
  ctx: ChangeContext,
  change: ChangeLifecycle,
): Promise<Footprint> {
  const dir = changeFolder(ctx.root, change.id);
  const byId = new Map<string, CatalogRecord>(ctx.records.map((r) => [r.id, r]));
  const get = <K extends CatalogRecord["kind"]>(kind: K, id: string) => {
    const r = byId.get(id);
    return r?.kind === kind ? (r as RecordOf<K>) : undefined;
  };
  const profileSystems = new Map(
    ctx.orgPack.profiles.flatMap((p) => p.profile?.systems ?? []).map((s) => [s.id, s]),
  );
  const isSystem = (id: string) => get("System", id) !== undefined || profileSystems.has(id);

  const systems = new Set(change.systems);
  const components = new Set<string>();
  const interfaces = new Map<string, Footprint["interfaces"][number]["status"]>();
  const dataStores = new Set(change.touches.dataStores);
  const tables = new Set(change.touches.tables);
  const repos = new Set(change.touches.repos);

  const ref = (id: string) => {
    const c = get("Component", id);
    if (c) {
      components.add(c.id);
      systems.add(c.system);
    } else if (isSystem(id)) systems.add(id);
  };

  // proposal.md: the Systems table
  const proposal = await read(join(dir, "proposal.md"));
  for (const id of findSystemsTable(proposal)) if (isSystem(id)) systems.add(id);

  // interfaces.md and change.yaml
  for (const i of change.touches.interfaces) interfaces.set(i.id, i.status);
  for (const row of tableWith(await read(join(dir, "interfaces.md")), ["interface id"])) {
    const id = cellId(row["interface id"] ?? "");
    const status = cellId(row.status ?? "");
    for (const end of [row.caller, row.callee]) if (end) ref(cellId(end));
    if (get("Interface", id))
      interfaces.set(
        id,
        STATUSES.has(status)
          ? (status as Footprint["interfaces"][number]["status"])
          : "planned-modify",
      );
  }
  for (const id of interfaces.keys()) {
    const i = get("Interface", id);
    if (i) {
      ref(i.from);
      ref(i.to);
    }
  }

  // data.md
  for (const row of tableWith(await read(join(dir, "data.md")), ["data store", "table"])) {
    const store = cellId(row["data store"] ?? "");
    const table = cellId(row.table ?? "");
    if (store) dataStores.add(store);
    if (table) tables.add(table.includes(".") ? slug(table) : `${store}.${slug(table)}`);
  }
  for (const id of tables) {
    const t = get("Table", id);
    if (t) {
      dataStores.add(t.dataStore);
      if (t.ownerComponent) ref(t.ownerComponent);
    }
  }
  for (const id of dataStores) {
    const s = get("DataStore", id);
    if (s?.ownerComponent) ref(s.ownerComponent);
  }

  // repos
  for (const id of components) {
    const c = get("Component", id);
    if (c?.repo) repos.add(c.repo);
  }
  try {
    const cr = await readChangeRepos(ctx.root, change.id);
    for (const r of cr?.repos ?? []) repos.add(r.id);
  } catch {
    // an unreadable repos.yaml is the workspace's to report
  }

  const vendors = [...systems].filter(
    (s) => (get("System", s)?.boundary ?? profileSystems.get(s)?.boundary) === "vendor",
  );

  // personal data: columns of touched tables, touched columns, schema fields of touched
  // interfaces, and the columns the change's own target flows classify (R5)
  const personalSet = new Set(personalLevels(ctx).levels.map((c) => c.toLowerCase()));
  const personal: Footprint["personal"] = [];
  for (const f of (await readdir(join(dir, "target-flows")).catch(() => [] as string[])).sort()) {
    if (!f.endsWith(".yaml")) continue;
    let doc: unknown;
    try {
      doc = parse(await read(join(dir, "target-flows", f)));
    } catch {
      continue; // a target flow that doesn't read is the stage's to report
    }
    const steps = (doc as { steps?: unknown } | null)?.steps;
    for (const s of Array.isArray(steps) ? steps : []) {
      const store = (s as { store?: { table?: unknown; classification?: unknown } } | null)?.store;
      if (!store || typeof store.table !== "string") continue;
      const cls = store.classification;
      if (!cls || typeof cls !== "object") continue;
      for (const [col, level] of Object.entries(cls as Record<string, unknown>))
        if (
          typeof level === "string" &&
          personalSet.has(level.toLowerCase()) &&
          !personal.some((p) => p.id === store.table && p.field === col)
        )
          personal.push({ id: store.table, classification: level, field: col });
    }
  }
  for (const r of ctx.records) {
    if (r.kind !== "Column" || !r.classification) continue;
    if (!tables.has(r.table) && !change.touches.records.includes(r.id)) continue;
    if (personalSet.has(r.classification.toLowerCase()))
      personal.push({ id: r.id, classification: r.classification });
  }
  for (const id of interfaces.keys()) {
    const ep = get("Interface", id)?.endpoint;
    for (const s of (ep && get("Endpoint", ep)?.schemaRefs) || []) {
      for (const f of get("Schema", s)?.fields ?? []) {
        if (f.classification && personalSet.has(f.classification.toLowerCase()))
          personal.push({ id: s, classification: f.classification, field: f.name });
      }
    }
  }
  personal.sort((a, b) => `${a.id}#${a.field ?? ""}`.localeCompare(`${b.id}#${b.field ?? ""}`));

  return {
    systems: sorted(systems),
    components: sorted(components),
    interfaces: [...interfaces]
      .map(([id, status]) => ({ id, status }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    dataStores: sorted(dataStores),
    tables: sorted(tables),
    records: sorted(change.touches.records),
    repos: sorted(repos),
    vendors: vendors.sort(),
    personal,
  };
}

/** First-column ids of the proposal's Systems table (its first header starts with "system"). */
function findSystemsTable(text: string): string[] {
  for (const headerSet of [["system (catalog id)"], ["system"]]) {
    const rows = tableWith(text, headerSet);
    if (rows.length) return rows.map((r) => cellId(r[headerSet[0]!] ?? "")).filter(Boolean);
  }
  return [];
}
