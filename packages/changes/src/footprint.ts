import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { LineCounter, isMap, isSeq, parse, parseDocument } from "yaml";
import {
  readFlow,
  specFlowFiles,
  type CatalogRecord,
  type ChangeLifecycle,
  type RecordOf,
} from "@maycombhq/core";
import { readChangeRepos } from "@maycombhq/workspace";
import type { ChangeContext } from "./context.js";
import { tableWith } from "./markdown.js";
import type { SignalFactor } from "./policy.js";
import { changeFolder } from "./store.js";

/**
 * Something a change's deltas do that the risk score weighs (ADR 0124 addendum B-change): what it
 * is, in words, and the step that does it, `target-flows/<flow>.yaml:<line>`.
 */
export interface RiskSignal {
  factor: SignalFactor;
  detail: string;
  cite: string;
}

/** A flow the change touches: changed, new or removed by a target flow, or only read. */
export interface FootprintFlow {
  id: string;
  repo?: string;
  change: "modify" | "new" | "remove" | "read";
}

/**
 * What a change touches, resolved against the catalog. Deterministic: files only.
 *
 * On the stage path (ADR 0087) it comes from what the stages write: feature.yaml's placement, the
 * target flows (flows, entries, calls, tables, columns, fields, outside systems) and tasks.md's
 * repos (ADR 0124 addendum B-change). A change on the change-draft path, or a legacy change that
 * has them, adds what its artifacts say: the Systems table in proposal.md, the hops in
 * interfaces.md, the tables in data.md. change.yaml's own `systems` and `touches` (what a person
 * declared) and repos.yaml are always added.
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
  /** The flows the change changes, adds, removes or only reads (feature.yaml, target flows). */
  flows: FootprintFlow[];
  /** Catalog Endpoints its flows start at or call. */
  entries: string[];
  /** Entries its steps start at or call that the catalog doesn't have: `<component> <entry>`. */
  newEntries: string[];
  /** Catalog Interfaces its steps call without changing them. */
  calls: string[];
  /** Columns its steps read or write, `<table>.<column>`. */
  columns: string[];
  /** Field names its added and changed steps send, return, read, check or map. */
  fields: string[];
  /** Systems outside the estate its steps call: a vendor, a model provider. */
  outside: { id: string; entries: string[]; cite: string }[];
  /** What its deltas do that the risk score weighs, each citing its step. */
  signals: RiskSignal[];
  /** The change's files this was read from, relative to its folder. */
  from: string[];
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

/** An identifier, a sentence or a path as lower-case words: `customerId` is customer and id. */
export const wordsOf = (s: string): string[] =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** `POST /a/{id}` as its method and its path with every parameter written `{}`. */
function entryParts(entry: string): { method?: string; path: string } {
  const m = /^\s*([A-Za-z]+)\s+(\S+)/.exec(entry);
  const norm = (p: string) => p.replace(/\{[^}]*\}/g, "{}").replace(/:[A-Za-z_]\w*/g, "{}");
  return m ? { method: m[1]!.toUpperCase(), path: norm(m[2]!) } : { path: norm(entry.trim()) };
}

const str = (x: unknown): string | undefined => (typeof x === "string" && x ? x : undefined);
const strs = (x: unknown): string[] =>
  Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : [];
const obj = (x: unknown): Record<string, unknown> | undefined =>
  x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : undefined;

const FIELD_LISTS = ["sends", "returns", "reads", "checks", "from", "to", "required"] as const;

/** A step's words cut to a quote: the first 90 characters. */
const quote = (s: string) => (s.length > 90 ? `${s.slice(0, 87).trimEnd()}...` : s);

interface Today {
  repo: string;
  flow: RecordOf<"Flow">;
}

/**
 * Today's flows, by id, read one at a time. A change touches a handful of flows and an estate's
 * specs hold hundreds, so the index comes from the file names (`specs/<repo>/<id>.yaml`) and a
 * flow is parsed only when something asks for it. Each parse is kept for the context's life.
 */
interface SpecIndex {
  /** Today's flow of that id, with the repo whose spec holds it; undefined when there is none. */
  get(id: string): Promise<Today | undefined>;
  /** Whether some repo's spec holds a flow of that component (ADR 0079: its id starts with it). */
  hasComponent(id: string): Promise<boolean>;
  /** Whether that repo's spec holds a flow. */
  hasRepo(id: string): Promise<boolean>;
}

const specCache = new WeakMap<ChangeContext, Promise<SpecIndex>>();

/** The lazy index of today's flows (built once per context). */
function specIndex(ctx: ChangeContext): Promise<SpecIndex> {
  let p = specCache.get(ctx);
  if (!p) {
    p = (async () => {
      const files = await specFlowFiles(ctx.root).catch(
        () => new Map<string, { repo: string; file: string }>(),
      );
      const read = new Map<string, Today | undefined>();
      const get = async (id: string): Promise<Today | undefined> => {
        if (read.has(id)) return read.get(id);
        const f = files.get(id);
        const flow = f ? await readFlow(ctx.root, f.repo, id).catch(() => undefined) : undefined;
        const today = flow && f ? { repo: f.repo, flow } : undefined;
        read.set(id, today);
        return today;
      };
      const ids = [...files.keys()];
      return {
        get,
        hasComponent: async (id) => {
          for (const flowId of ids) {
            if (!flowId.startsWith(`${id}.`)) continue;
            if ((await get(flowId))?.flow.component === id) return true;
          }
          return false;
        },
        hasRepo: async (id) => {
          for (const flowId of ids)
            if (files.get(flowId)!.repo === id && (await get(flowId))) return true;
          return false;
        },
      };
    })();
    specCache.set(ctx, p);
  }
  return p;
}

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
  const from = new Set<string>();

  const ref = (id: string) => {
    const c = get("Component", id);
    if (c) {
      components.add(c.id);
      systems.add(c.system);
    } else if (isSystem(id)) systems.add(id);
  };

  // proposal.md: the Systems table
  const proposal = await read(join(dir, "proposal.md"));
  const proposed = findSystemsTable(proposal);
  if (proposed.length) from.add("proposal.md");
  for (const id of proposed) if (isSystem(id)) systems.add(id);

  // interfaces.md and change.yaml
  for (const i of change.touches.interfaces) interfaces.set(i.id, i.status);
  const hops = tableWith(await read(join(dir, "interfaces.md")), ["interface id"]);
  if (hops.length) from.add("interfaces.md");
  for (const row of hops) {
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

  // data.md
  const rows = tableWith(await read(join(dir, "data.md")), ["data store", "table"]);
  if (rows.length) from.add("data.md");
  for (const row of rows) {
    const store = cellId(row["data store"] ?? "");
    const table = cellId(row.table ?? "");
    if (store) dataStores.add(store);
    if (table) tables.add(table.includes(".") ? slug(table) : `${store}.${slug(table)}`);
  }

  // The stage path (B-change): feature.yaml, target-flows/ and tasks.md.
  const staged = await stageFootprint(ctx, dir, { get, isSystem, profileSystems, ref });
  for (const f of staged.from) from.add(f);
  for (const r of staged.repos) repos.add(r);
  for (const t of staged.tables) tables.add(t);
  for (const [id, status] of staged.interfaces) if (!interfaces.has(id)) interfaces.set(id, status);

  for (const id of interfaces.keys()) {
    const i = get("Interface", id);
    if (i) {
      ref(i.from);
      ref(i.to);
    }
  }
  for (const id of tables) {
    const t = get("Table", id);
    if (t) {
      dataStores.add(t.dataStore);
      if (t.ownerComponent) ref(t.ownerComponent);
    } else {
      // A table the change adds: its data store is the id's first part, when the catalog has it.
      const store = id.split(".")[0]!;
      if (get("DataStore", store)) dataStores.add(store);
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
  for (const s of staged.stores) {
    for (const [col, level] of Object.entries(s.classification))
      if (
        personalSet.has(level.toLowerCase()) &&
        !personal.some((p) => p.id === s.table && p.field === col)
      )
        personal.push({ id: s.table, classification: level, field: col });
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

  // A store step on a column the catalog classifies as personal is personal data too (B-change).
  const signals = [...staged.signals];
  for (const s of staged.stores) {
    if (signals.some((x) => x.factor === "personal-data" && x.cite === s.cite)) continue;
    const classified = s.columns.filter((c) => {
      const level =
        s.classification[c] ?? get("Column", `${s.table}.${c}`)?.classification ?? undefined;
      return level !== undefined && personalSet.has(level.toLowerCase());
    });
    if (classified.length)
      signals.push({
        factor: "personal-data",
        detail: `${s.kind} of ${s.table} (${classified.join(", ")} classified personal)`,
        cite: s.cite,
      });
  }
  // A change across repos deploys in an order (B-change; its deploy order, B-arch).
  const spread = sorted(staged.repos);
  if (spread.length > 1)
    signals.push({
      factor: "spread",
      detail: `${spread.length} repos (${spread.join(", ")})`,
      cite: staged.deployFile ?? staged.from.find((f) => f.startsWith("target-flows/")) ?? "",
    });

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
    flows: staged.flows,
    entries: sorted(staged.entries),
    newEntries: sorted(staged.newEntries),
    calls: sorted([...staged.calls].filter((id) => !interfaces.has(id))),
    columns: sorted(staged.columns),
    fields: sorted(staged.fields),
    outside: staged.outside,
    signals,
    from: sorted(from),
  };
}

interface StoreTouch {
  table: string;
  columns: string[];
  classification: Record<string, string>;
  kind: string;
  cite: string;
}

interface Staged {
  from: string[];
  flows: FootprintFlow[];
  repos: Set<string>;
  tables: Set<string>;
  columns: Set<string>;
  fields: Set<string>;
  entries: Set<string>;
  newEntries: Set<string>;
  calls: Set<string>;
  interfaces: Map<string, Footprint["interfaces"][number]["status"]>;
  outside: Footprint["outside"];
  stores: StoreTouch[];
  signals: RiskSignal[];
  deployFile?: string;
}

/**
 * What the stages' own files say a change touches (B-change): feature.yaml's flows and new
 * flows, each target flow's component, entry, calls, stores and fields, tasks.md's repos, and
 * the risk signals of each added or changed step, cited by its line.
 */
async function stageFootprint(
  ctx: ChangeContext,
  dir: string,
  h: {
    get: <K extends CatalogRecord["kind"]>(kind: K, id: string) => RecordOf<K> | undefined;
    isSystem: (id: string) => boolean;
    profileSystems: Map<string, { boundary: string }>;
    ref: (id: string) => void;
  },
): Promise<Staged> {
  const out: Staged = {
    from: [],
    flows: [],
    repos: new Set(),
    tables: new Set(),
    columns: new Set(),
    fields: new Set(),
    entries: new Set(),
    newEntries: new Set(),
    calls: new Set(),
    interfaces: new Map(),
    outside: [],
    stores: [],
    signals: [],
  };
  const files = (await readdir(join(dir, "target-flows")).catch(() => [] as string[]))
    .filter((f) => f.endsWith(".yaml"))
    .sort();
  const featureText = await read(join(dir, "feature.yaml"));
  const tasksText = await read(join(dir, "tasks.md"));
  if (!files.length && !featureText && !tasksText) return out;

  const { get, isSystem, profileSystems, ref } = h;
  const specs = await specIndex(ctx);
  const catalogRepos = new Set<string>();
  for (const r of ctx.records)
    if (r.kind === "Component" && (r as RecordOf<"Component">).repo)
      catalogRepos.add((r as RecordOf<"Component">).repo!);
  const authWords = new Set(ctx.policy.risk.signals.auth.map((w) => w.toLowerCase()));
  const personalWords = new Set(ctx.policy.risk.signals.personal.map((w) => w.toLowerCase()));
  const endpoints = ctx.records.filter((r) => r.kind === "Endpoint") as RecordOf<"Endpoint">[];
  const ifaces = ctx.records.filter((r) => r.kind === "Interface") as RecordOf<"Interface">[];
  const flows = new Map<string, FootprintFlow>();

  /** A target outside the estate: a vendor system, or nothing the catalog or specs know. */
  const outsideOf = async (id: string): Promise<boolean> => {
    const c = get("Component", id);
    if (c) return get("System", c.system)?.boundary === "vendor";
    if (isSystem(id))
      return (get("System", id)?.boundary ?? profileSystems.get(id)?.boundary) === "vendor";
    if (catalogRepos.has(id)) return false;
    return !(await specs.hasComponent(id)) && !(await specs.hasRepo(id));
  };
  const endpointOf = (component: string, entry: string) => {
    const e = entryParts(entry);
    return endpoints.find(
      (x) =>
        x.component === component &&
        (!e.method || !x.method || x.method.toUpperCase() === e.method) &&
        (x.normalizedPath === e.path || entryParts(x.pathOrTopic ?? "").path === e.path),
    );
  };
  const interfaceOf = (fromC: string, to: string, entry: string) => {
    const e = entryParts(entry);
    return ifaces.find(
      (x) =>
        x.from === fromC &&
        x.to === to &&
        (!e.method || !x.method || x.method.toUpperCase() === e.method) &&
        x.normalizedPath === e.path,
    );
  };
  const outside = new Map<string, { entries: Set<string>; cite: string }>();

  for (const f of files) {
    const rel = `target-flows/${f}`;
    const text = await read(join(dir, "target-flows", f));
    const lines = new LineCounter();
    let doc;
    try {
      doc = parseDocument(text, { lineCounter: lines });
    } catch {
      continue; // a target flow that doesn't read is the stage's to report
    }
    if (doc.errors.length) continue;
    const d = obj(doc.toJS());
    const flowId = str(d?.flow);
    if (!d || !flowId) continue;
    out.from.push(rel);
    const lineOf = (node: unknown): number | undefined => {
      const r = (node as { range?: [number, number, number] } | null)?.range;
      return r ? lines.linePos(r[0]).line : undefined;
    };
    const stepNodes = (() => {
      const top = doc.contents;
      const s = isMap(top) ? top.get("steps", true) : undefined;
      return isSeq(s) ? s.items : [];
    })();
    const keyLine = (key: string) => {
      const top = doc.contents;
      if (!isMap(top)) return undefined;
      const pair = top.items.find((p) => (p.key as { value?: unknown } | null)?.value === key);
      return lineOf(pair?.key);
    };

    const today = await specs.get(flowId);
    const change = (str(d.change) ?? "modify") as FootprintFlow["change"];
    const repo = str(d.repo) ?? today?.repo;
    const prefix = flowId.split(".")[0]!;
    const component =
      today?.flow.component ??
      (get("Component", prefix) || (await specs.hasComponent(prefix)) ? prefix : undefined);
    flows.set(flowId, { id: flowId, ...(repo ? { repo } : {}), change });
    if (repo) out.repos.add(repo);
    if (component) ref(component);

    // Its entry: today's trigger, or the new flow's own.
    const trigger = today?.flow.trigger.ref;
    if (trigger && get("Endpoint", trigger)) out.entries.add(trigger);
    else {
      const entry = str(obj(d.trigger)?.entry);
      if (entry && component) {
        const ep = endpointOf(component, entry);
        if (ep) out.entries.add(ep.id);
        else out.newEntries.add(`${component} ${entry}`);
      }
    }
    if (strs(d.consumers).length || change === "remove")
      out.signals.push({
        factor: "breaking",
        detail:
          change === "remove"
            ? `flow ${flowId} is removed`
            : `flow ${flowId} breaks ${strs(d.consumers).join(", ")}`,
        cite: `${rel}:${keyLine(strs(d.consumers).length ? "consumers" : "change") ?? 1}`,
      });

    const steps = Array.isArray(d.steps) ? d.steps : [];
    // In order, one step at a time: a step's target may have to be looked up in the specs.
    for (const [i, raw] of steps.entries()) {
      const s = obj(raw);
      if (!s) continue;
      const cite = `${rel}:${lineOf(stepNodes[i]) ?? 1}`;
      const op = str(s.op) ?? "add";
      const n = typeof s.step === "number" ? s.step : undefined;
      const was = op !== "add" && n ? today?.flow.steps[n - 1] : undefined;
      const kind = str(s.kind) ?? was?.kind ?? "step";
      const what = str(s.what) ?? was?.what ?? "";
      const live = op === "add" || op === "change";

      // The table and columns it reads or writes.
      const store = obj(s.store);
      const table = str(store?.table) ?? was?.store?.table;
      if (table) {
        out.tables.add(table);
        const cols = store ? strs(store.columns) : (was?.store?.columns ?? []);
        for (const c of cols) out.columns.add(`${table}.${c}`);
        const classification: Record<string, string> = {};
        for (const [c, v] of Object.entries(obj(store?.classification) ?? {}))
          if (typeof v === "string") classification[c] = v;
        out.stores.push({ table, columns: cols, classification, kind, cite });
        if (live) {
          const hit = [...wordsOf(table), ...cols.flatMap(wordsOf)].filter((w) =>
            personalWords.has(w),
          );
          if (hit.length)
            out.signals.push({
              factor: "personal-data",
              detail: `${kind} of ${table} (${[...new Set(hit)].join(", ")})`,
              cite,
            });
          const added = Object.keys(obj(store?.types) ?? {});
          if (store?.new === true || str(store?.migration) || added.length)
            out.signals.push({
              factor: "schema",
              detail:
                store?.new === true
                  ? `new table ${table}`
                  : added.length
                    ? `${table} gains ${added.join(", ")}`
                    : `migration ${str(store?.migration)} on ${table}`,
              cite,
            });
        }
      }

      // Where a call-out or publish goes.
      const to = obj(s.to) ?? (was?.to as Record<string, unknown> | undefined);
      const target = str(to?.component);
      const entry = str(to?.entry) ?? "";
      if (target) {
        if (await outsideOf(target)) {
          if (isSystem(target)) ref(target);
          const o = outside.get(target) ?? { entries: new Set<string>(), cite };
          if (entry) o.entries.add(entry);
          outside.set(target, o);
          if (live)
            out.signals.push({
              factor: "outside-call",
              detail: `${target}${entry ? ` (${entry}${to?.new === true ? ", new" : ""})` : ""}`,
              cite,
            });
        } else {
          ref(target);
          const ep = entry ? endpointOf(target, entry) : undefined;
          if (ep) out.entries.add(ep.id);
          else if (entry && to?.new === true) out.newEntries.add(`${target} ${entry}`);
        }
        const iface = component && entry ? interfaceOf(component, target, entry) : undefined;
        if (iface) {
          if (op === "remove") out.interfaces.set(iface.id, "planned-retire");
          else if (op === "change") out.interfaces.set(iface.id, "planned-modify");
          else out.calls.add(iface.id);
        }
      }

      if (!live) continue;
      const fields = obj(s.fields) ?? {};
      const names = FIELD_LISTS.flatMap((k) => strs(fields[k]));
      for (const name of names) out.fields.add(name);

      // Who may do what: the step's words, its fields and the folders and files it goes in. Prose
      // and paths are split on punctuation only, so a class named in passing (DeathScope) isn't
      // read as a word of it; a status code (401, 403) counts only where a step validates.
      const paths = [str(s.at), str(s.new), ...strs(Array.isArray(s.uses) ? s.uses : [s.uses])]
        .filter((p): p is string => !!p)
        .map((p) => p.replace(/:\d+$/, ""));
      const plain = (t: string) =>
        t
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter(Boolean);
      const authHit = [...plain(what), ...names.flatMap(wordsOf), ...paths.flatMap(plain)].filter(
        (w) => authWords.has(w) && (kind === "validate" || !/^\d+$/.test(w)),
      );
      if (authHit.length)
        out.signals.push({
          factor: "auth",
          detail: `${kind} step "${quote(what)}" (${[...new Set(authHit)].join(", ")})`,
          cite,
        });
      // Personal data in the fields it carries (the store's own names are weighed above).
      const fieldHit = names.flatMap(wordsOf).filter((w) => personalWords.has(w));
      if (
        fieldHit.length &&
        !out.signals.some((x) => x.factor === "personal-data" && x.cite === cite)
      )
        out.signals.push({
          factor: "personal-data",
          detail: `${kind} step carries ${[...new Set(fieldHit)].join(", ")}`,
          cite,
        });
      if (s.breaking === true || strs(fields.required).length)
        out.signals.push({
          factor: "breaking",
          detail: strs(fields.required).length
            ? `${kind} step now requires ${strs(fields.required).join(", ")}`
            : `${kind} step "${quote(what)}" is marked breaking`,
          cite,
        });
    }
  }

  // feature.yaml: the flows it changes or reads, and the repos of its new flows.
  if (featureText) {
    let placed: Record<string, unknown> | undefined;
    try {
      placed = obj(parse(featureText));
    } catch {
      placed = undefined; // a placement that doesn't read is the stage's to report
    }
    if (placed) {
      out.from.push("feature.yaml");
      for (const raw of Array.isArray(placed.flows) ? placed.flows : []) {
        const fl = obj(raw);
        const id = str(fl?.id);
        if (!id || flows.has(id)) continue;
        const today = await specs.get(id);
        const read = str(fl?.how) === "read";
        flows.set(id, {
          id,
          ...(today ? { repo: today.repo } : {}),
          change: read ? "read" : "modify",
        });
        if (read || !today) continue;
        out.repos.add(today.repo);
        ref(today.flow.component);
        const trigger = today.flow.trigger.ref;
        if (trigger && get("Endpoint", trigger)) out.entries.add(trigger);
      }
      for (const raw of Array.isArray(placed.newFlows) ? placed.newFlows : []) {
        const repo = str(obj(raw)?.repo);
        if (repo) out.repos.add(repo);
      }
    }
  }

  // tasks.md: the repos its tasks are grouped under (a repo the specs or the catalog know).
  const taskRepos: string[] = [];
  for (const m of tasksText.matchAll(/^##\s+(\S+)\s*$/gm))
    if (catalogRepos.has(m[1]!) || (await specs.hasRepo(m[1]!))) taskRepos.push(m[1]!);
  if (taskRepos.length) {
    out.from.push("tasks.md");
    for (const r of taskRepos) out.repos.add(r);
  }

  if (
    await readFile(join(dir, "stage", "architecture-deploy.yaml")).then(
      () => true,
      () => false,
    )
  )
    out.deployFile = "stage/architecture-deploy.yaml";

  out.flows = [...flows.values()].sort((a, b) => a.id.localeCompare(b.id));
  out.outside = [...outside]
    .map(([id, o]) => ({ id, entries: sorted(o.entries), cite: o.cite }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/** First-column ids of the proposal's Systems table (its first header starts with "system"). */
function findSystemsTable(text: string): string[] {
  for (const headerSet of [["system (catalog id)"], ["system"]]) {
    const rows = tableWith(text, headerSet);
    if (rows.length) return rows.map((r) => cellId(r[headerSet[0]!] ?? "")).filter(Boolean);
  }
  return [];
}
