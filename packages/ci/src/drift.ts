import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
  catalogDirOf,
  loadOrgPack,
  mergeCatalog,
  normalizePath,
  orgPackDirOf,
  type CatalogRecord,
  type ChangeLifecycle,
  type Dialect,
  type OrgPack,
  type RecordOf,
} from "@maycombhq/core";
import {
  BUILT_IN_EXTRACTORS,
  dialectExtractor,
  loadShippedDialects,
  runDialectTests,
  SHIPPED_DIALECTS_DIR,
} from "@maycombhq/extractors";
import { changeFolder, changeStore } from "@maycombhq/changes";
import { readChangeFiles, readDataChanges, readHops } from "@maycombhq/naysayer";
import { readCatalog } from "@maycombhq/scanner";
import { DEFAULT_IGNORES, fsRepo, scanRepo, type Extractor } from "@maycombhq/sdk";
import { checkoutState, type GitRunner } from "@maycombhq/workspace";
import { ignored, loadCiConfig, type CiConfig } from "./config.js";

/**
 * The pipeline drift check (the plan's "drift check"): in a code repo's pipeline, scan that
 * repo with the deterministic extractors and dialects only (no network, no AI), and compare
 * what it serves, calls, publishes and stores with the committed catalog.
 *
 * The repo's records are merged the way a full scan would, with every other repo's records
 * from the committed catalog as context (so a call through the gateway resolves to the same
 * interface), and the comparison looks only at this repo's own surface on both sides:
 * endpoints it serves, calls it makes, topics it owns and subscribes to, tables and columns
 * it defines or uses, and loose ends it leaves.
 *
 * - added: in the code, not in the catalog nor in an approved change's design;
 * - removed: in the catalog, gone from the code (unless an approved change retires it);
 * - changed: the same thing with another method, path, auth, pattern, route, type or access;
 * - unknown: a new loose end (a call or event Atticus can't follow);
 * - planned: new or gone as an approved change's design says (reported, never drift).
 */

export const DRIFT_SCHEMA_VERSION = 1 as const;

export type DriftKind = "added" | "removed" | "changed" | "unknown" | "planned";
export type DriftSubject =
  "endpoint" | "call" | "subscription" | "topic" | "table" | "column" | "migration" | "loose-end";

export interface DriftItem {
  kind: DriftKind;
  subject: DriftSubject;
  /** The record id (code side for added and changed, catalog side for removed). */
  id: string;
  summary: string;
  /** For changed: each field with the catalog's and the code's value. */
  changes?: { field: string; catalog?: string; code?: string }[];
  /** For planned: the change whose design has it. */
  change?: string;
  evidence: { path?: string; line?: number }[];
}

export interface DriftReport {
  schemaVersion: typeof DRIFT_SCHEMA_VERSION;
  repo: string;
  components: string[];
  /** block: drift fails the pipeline; warn: drift is reported only. */
  mode: "block" | "warn";
  /** True when there is drift (anything but planned items). */
  drift: boolean;
  counts: Record<DriftKind, number>;
  items: DriftItem[];
  /** Approved changes whose designs were compared. */
  changes: string[];
  scanned: { commit: string; records: number; extractors: string[] };
  problems: string[];
}

export class DriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriftError";
  }
}

export interface DriftOptions {
  /** The code repo's checkout. */
  repoDir: string;
  /**
   * The committed catalog: a metarepo root (org pack, catalog and changes), or a copy of its
   * catalog folder (holding generated/), or the generated folder itself.
   */
  catalog: string;
  /** The repo id in the manifest; default: the manifest entry whose id is the folder's name. */
  repo?: string;
  /** Override the org pack's mode with warn-only. */
  warnOnly?: boolean;
  /** The scanned commit; default read with git (or zeros when the folder isn't a checkout). */
  commit?: string;
  git?: GitRunner;
  scannedAt?: string;
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Where the catalog files are, and the metarepo root when there is one. */
export function resolveCatalog(p: string): { root?: string; generated: string } {
  const abs = resolve(p);
  if (isDir(join(abs, "org-pack")) || isDir(join(abs, ".atticus", "org-pack")))
    return { root: abs, generated: join(catalogDirOf(abs), "generated") };
  if (isDir(join(abs, "generated"))) return { generated: join(abs, "generated") };
  return { generated: abs };
}

/** Dialects that pass their own tests: shipped ones, replaced by org-pack ones of the same name. */
async function usableDialects(
  op: OrgPack,
  orgPackDir: string | undefined,
  problems: string[],
): Promise<Dialect[]> {
  const own = new Set(op.dialects.map((d) => d.name));
  const shipped = (await loadShippedDialects().catch(() => [] as Dialect[])).filter(
    (d) => !own.has(d.name),
  );
  const all = [
    ...shipped.map((d) => ({ d, dir: SHIPPED_DIALECTS_DIR })),
    ...op.dialects.map((d) => ({ d, dir: join(orgPackDir ?? ".", "dialects") })),
  ];
  const byName = new Map(all.map(({ d }) => [d.name, d]));
  const ok: Dialect[] = [];
  for (const { d, dir } of all) {
    const failures = await runDialectTests(d, dir, byName).catch((e: Error) => [
      { test: "(load)", message: e.message },
    ]);
    if (failures.length) {
      for (const f of failures) problems.push(`dialect ${d.name}: test "${f.test}": ${f.message}`);
      continue;
    }
    ok.push(d);
  }
  return ok;
}

// ------------------------------------------------------------------ the repo's surface

interface SurfaceItem {
  subject: DriftSubject;
  id: string;
  label: string;
  fields: Record<string, string | undefined>;
  /** For pairing an unmatched old and new item (component and method; caller and callee). */
  pair?: string;
  record: CatalogRecord;
}

const fromRepo = (r: CatalogRecord, repo: string, side?: (s: string | undefined) => boolean) =>
  r.evidence.some((e) => e.repo === repo && (!side || side(e.side)));

const evOf = (r: CatalogRecord, repo: string) =>
  r.evidence
    .filter((e) => e.repo === repo && e.path)
    .slice(0, 3)
    .map((e) => ({ path: e.path!, ...(e.line ? { line: e.line } : {}) }));

function surface(records: readonly CatalogRecord[], repo: string, components: Set<string>) {
  const out = new Map<string, SurfaceItem>();
  const add = (s: SurfaceItem) => out.set(`${s.subject}|${s.id}`, s);
  for (const r of records) {
    if (r.status === "retired") continue;
    if (r.kind === "Endpoint") {
      const e = r as RecordOf<"Endpoint">;
      if (!fromRepo(e, repo, (s) => s !== "caller")) continue;
      if (e.endpointType === "event-topic")
        add({
          subject: "topic",
          id: e.id,
          label: `topic ${e.pathOrTopic}`,
          fields: { owner: e.component },
          record: e,
        });
      else
        add({
          subject: "endpoint",
          id: e.id,
          label: `${e.method ? `${e.method} ` : ""}${e.pathOrTopic} on ${e.component}`,
          fields: {
            method: e.method,
            path: e.normalizedPath ?? normalizePath(e.pathOrTopic),
            auth: e.auth,
          },
          pair: `${e.component}|${e.method ?? ""}`,
          record: e,
        });
    } else if (r.kind === "Interface") {
      const i = r as RecordOf<"Interface">;
      if (fromRepo(i, repo, (s) => s === "caller"))
        add({
          subject: "call",
          id: i.id,
          label:
            i.sync === "async"
              ? `${i.from} publishes ${i.normalizedPath} to ${i.to}`
              : `${i.from} calls ${i.to} ${i.method ? `${i.method} ` : ""}${i.normalizedPath}`,
          fields: {
            to: i.to,
            via: i.via,
            route: i.route,
            method: i.method,
            path: i.normalizedPath,
            auth: i.auth,
            pattern: i.pattern?.code,
          },
          pair: `${i.from}|${i.to}|${i.sync}`,
          record: i,
        });
      else if (i.sync === "async" && fromRepo(i, repo, (s) => s === "callee"))
        add({
          subject: "subscription",
          id: i.id,
          label: `${i.to} subscribes to ${i.normalizedPath} from ${i.from}`,
          fields: { from: i.from, topic: i.normalizedPath },
          record: i,
        });
    } else if (r.kind === "Table") {
      const t = r as RecordOf<"Table">;
      if (!fromRepo(t, repo)) continue;
      const mine = (l: string[]) =>
        l
          .filter((c) => components.has(c))
          .sort()
          .join(",") || undefined;
      add({
        subject: "table",
        id: t.id,
        label: `table ${t.id}`,
        fields: { readers: mine(t.readers), writers: mine(t.writers) },
        record: t,
      });
    } else if (r.kind === "Column") {
      const c = r as RecordOf<"Column">;
      if (!fromRepo(c, repo)) continue;
      add({
        subject: "column",
        id: c.id,
        label: `column ${c.id}`,
        fields: {
          type: c.type.toLowerCase().replace(/\s+/g, ""),
          nullable: c.nullable === undefined ? undefined : String(c.nullable),
        },
        record: c,
      });
    } else if (r.kind === "Migration") {
      const m = r as RecordOf<"Migration">;
      if (!fromRepo(m, repo)) continue;
      add({
        subject: "migration",
        id: m.id,
        label: `migration ${m.file.split("/").pop()}`,
        fields: { operations: m.operations.join("; ") || undefined },
        record: m,
      });
    } else if (r.kind === "Unresolved") {
      const u = r as RecordOf<"Unresolved">;
      if (!fromRepo(u, repo) && !(u.owner && components.has(u.owner))) continue;
      add({
        subject: "loose-end",
        id: u.id,
        label: `${u.unresolvedKind} ${u.raw}${u.owner ? ` from ${u.owner}` : ""}`,
        fields: {},
        record: u,
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------ approved designs

interface PlannedHop {
  change: string;
  caller: string;
  callee: string;
  method?: string;
  path?: string;
  topic?: string;
  status: string;
}
interface PlannedData {
  change: string;
  table: string;
  store: string;
  columns: string[];
  newTable: boolean;
  migration: string;
}

const APPROVED = new Set([
  "plan",
  "build",
  "qa",
  "release-ready",
  "released",
  "post-release-review",
]);

async function approvedDesigns(root: string | undefined) {
  const hops: PlannedHop[] = [];
  const data: PlannedData[] = [];
  const changes: string[] = [];
  if (!root) return { hops, data, changes };
  let list: ChangeLifecycle[];
  try {
    list = await changeStore(root).list();
  } catch {
    return { hops, data, changes };
  }
  for (const c of list.filter((x) => APPROVED.has(x.state))) {
    changes.push(c.id);
    const files = await readChangeFiles(changeFolder(root, c.id));
    for (const h of readHops(files)) {
      const topic = /^(publish|subscribe|send|receive)\s+(\S+)/i.exec(h.operation.trim())?.[2];
      hops.push({
        change: c.id,
        caller: h.caller,
        callee: h.callee,
        ...(h.method ? { method: h.method } : {}),
        ...(h.path ? { path: normalizePath(h.path) } : {}),
        ...(topic ? { topic } : {}),
        status: h.status,
      });
    }
    for (const d of readDataChanges(files))
      data.push({
        change: c.id,
        table: d.tableId,
        store: d.store,
        columns: d.newColumns.map((x) => x.name.toLowerCase()),
        newTable: d.newTable,
        migration: d.migration.replace(/[`*]/g, "").trim(),
      });
  }
  return { hops, data, changes };
}

const NEW = new Set(["planned-new", "planned-modify"]);

function plannedBy(
  item: SurfaceItem,
  kind: "added" | "removed" | "changed" | "unknown",
  d: { hops: PlannedHop[]; data: PlannedData[] },
): string | undefined {
  const ok = (h: PlannedHop) =>
    kind === "removed" ? h.status === "planned-retire" : NEW.has(h.status);
  const r = item.record as Record<string, unknown>;
  switch (item.subject) {
    case "call": {
      const i = item.record as RecordOf<"Interface">;
      return d.hops.find(
        (h) =>
          ok(h) &&
          h.caller === i.from &&
          h.callee === i.to &&
          (i.sync === "async"
            ? h.topic === i.normalizedPath
            : h.method === i.method && h.path === normalizePath(i.normalizedPath)),
      )?.change;
    }
    case "subscription": {
      const i = item.record as RecordOf<"Interface">;
      return d.hops.find(
        (h) => ok(h) && h.topic === i.normalizedPath && (h.callee === i.to || h.caller === i.from),
      )?.change;
    }
    case "endpoint": {
      const e = item.record as RecordOf<"Endpoint">;
      const path = e.normalizedPath ?? normalizePath(e.pathOrTopic);
      return d.hops.find(
        (h) => ok(h) && h.callee === e.component && h.method === e.method && h.path === path,
      )?.change;
    }
    case "topic": {
      const e = item.record as RecordOf<"Endpoint">;
      return d.hops.find((h) => ok(h) && h.topic === e.pathOrTopic)?.change;
    }
    case "table":
      return kind === "removed"
        ? undefined
        : d.data.find((x) => x.table === item.id && (x.newTable || kind === "changed"))?.change;
    case "column": {
      const c = item.record as RecordOf<"Column">;
      return kind === "removed"
        ? undefined
        : d.data.find((x) => x.table === c.table && x.columns.includes(c.name.toLowerCase()))
            ?.change;
    }
    case "migration": {
      if (kind === "removed") return undefined;
      const m = item.record as RecordOf<"Migration">;
      const file = m.file.split("/").pop() ?? "";
      return d.data.find(
        (x) =>
          (x.migration && x.migration === file) ||
          (x.store === m.dataStore &&
            m.operations.some((op) => {
              const t = /^(?:create|alter) table (\S+)/.exec(op)?.[1];
              return (
                !!t && x.table === `${m.dataStore}.${t.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
              );
            })),
      )?.change;
    }
    case "loose-end": {
      const raw = String(r.raw ?? "");
      const m = /^([A-Z]+)\s+(\S+)/.exec(raw);
      const owner = String(r.owner ?? "");
      return d.hops.find((h) => {
        if (!ok(h) || (owner && h.caller !== owner)) return false;
        if (m && h.method && h.path) {
          const url = normalizePath(m[2]!.replace(/^[a-z]+:\/\/[^/]+/i, ""));
          return h.method === m[1] && (url === h.path || url.endsWith(h.path));
        }
        return !!h.topic && raw.trim() === h.topic;
      })?.change;
    }
  }
}

// ------------------------------------------------------------------ the check

/** A catalog record without what this repo told it (the scan says that now), or undefined. */
function strip(r: CatalogRecord, repo: string, components: Set<string>): CatalogRecord | undefined {
  const evidence = r.evidence.filter((e) => e.repo !== repo);
  if (!evidence.length) return undefined;
  if (r.kind === "Table")
    return {
      ...r,
      evidence,
      readers: r.readers.filter((c) => !components.has(c)),
      writers: r.writers.filter((c) => !components.has(c)),
    };
  return { ...r, evidence } as CatalogRecord;
}

/**
 * The other end of each event interface in the catalog, as the loose end another repo's scan
 * left: merge pairs it with this repo's publish or subscribe, as in a full scan.
 */
function otherEnds(records: readonly CatalogRecord[], repo: string, components: Set<string>) {
  const out: CatalogRecord[] = [];
  for (const r of records) {
    if (r.kind !== "Interface" || r.sync !== "async") continue;
    const ends = [
      { kind: "event-publish", owner: r.from, side: "caller" },
      { kind: "event-subscribe", owner: r.to, side: "callee" },
    ];
    for (const e of ends) {
      if (components.has(e.owner)) continue;
      const evidence = r.evidence.filter(
        (x) => x.side === e.side && x.repo !== repo && x.source === "code",
      );
      if (!evidence.length) continue;
      const hash = createHash("sha256").update(`${r.id}|${e.kind}`).digest("hex").slice(0, 10);
      out.push({
        kind: "Unresolved",
        schemaVersion: 2,
        id: `${e.owner}.${e.kind}.ctx-${hash}`.slice(0, 120),
        status: "current",
        confidence: "inferred",
        unresolvedKind: e.kind,
        raw: r.normalizedPath,
        owner: e.owner,
        evidence,
      } as CatalogRecord);
    }
  }
  return out;
}

const CONTEXT_SKIP = new Set([
  "Interface",
  "Unresolved",
  "Capability",
  "GlossaryTerm",
  "OwnerQuestion",
]);

export async function repoDrift(o: DriftOptions): Promise<DriftReport> {
  const repoDir = resolve(o.repoDir);
  if (!isDir(repoDir)) throw new DriftError(`There is no folder ${o.repoDir} to check.`);
  const where = resolveCatalog(o.catalog);
  if (!isDir(where.generated))
    throw new DriftError(
      `There is no catalog at ${o.catalog}. Give the metarepo checkout or its catalog folder with --catalog.`,
    );
  const problems: string[] = [];
  const orgPackDir = where.root ? orgPackDirOf(where.root) : undefined;
  const op = await loadOrgPack(orgPackDir ?? join(where.generated, "__no-org-pack__"));
  if (orgPackDir)
    for (const p of op.problems)
      problems.push(`org-pack/${p.file}: ${p.path ? `${p.path}: ` : ""}${p.message}`);
  const loaded = await loadCiConfig(orgPackDir);
  problems.push(...loaded.problems);
  const cfg: CiConfig = loaded.config;

  const catalog = await readCatalog(where.generated);
  for (const p of catalog.problems) problems.push(`catalog ${p.file}: ${p.message}`);
  if (catalog.records.length === 0)
    throw new DriftError(`The catalog at ${o.catalog} has no records; scan the estate first.`);

  const manifest = op.profiles.flatMap((p) => p.repos?.repos ?? []);
  const repoId = o.repo ?? basename(repoDir);
  const listed = manifest.find((r) => r.id === repoId);
  if (!listed && manifest.length && o.repo)
    problems.push(
      `${repoId} isn't in the repos manifest; checking it without its type and dialects.`,
    );
  // Without the manifest (a fetched copy of the catalog), the catalog says which component the
  // repo builds, so the scan names it the same way.
  const fromCatalog = catalog.records.filter(
    (r): r is RecordOf<"Component"> => r.kind === "Component" && r.repo === repoId,
  );
  const entry:
    { type?: string; component?: string; system?: string; dialects: string[] } | undefined =
    listed ??
    (fromCatalog.length === 1
      ? { component: fromCatalog[0]!.id, system: fromCatalog[0]!.system, dialects: [] }
      : undefined);

  let commit = o.commit;
  if (!commit) {
    try {
      commit = existsSync(join(repoDir, ".git"))
        ? (await checkoutState(repoDir, o.git)).commit
        : "0".repeat(40);
    } catch {
      commit = "0".repeat(40);
    }
  }
  if (!/^[0-9a-f]{7,64}$/.test(commit)) commit = "0".repeat(40);

  const dialects = await usableDialects(op, orgPackDir, problems);
  const byName = new Map(dialects.map((d) => [d.name, d]));
  const extractors: Extractor[] = [
    ...BUILT_IN_EXTRACTORS,
    ...dialects
      .filter(
        (d) =>
          (entry?.dialects ?? []).includes(d.name) ||
          (entry?.type ? d.appliesTo.repoTypes.includes(entry.type) : false),
      )
      .map((d) => dialectExtractor(d, byName)),
  ];
  // A metarepo checked out inside the repo is not the repo's code.
  const inside = relative(repoDir, resolve(o.catalog)).split(/[\\/]/);
  const skip = inside[0] && inside[0] !== ".." && !isAbsolute(inside.join("/")) ? [inside[0]] : [];
  const scan = await scanRepo({
    repo: fsRepo(repoId, repoDir, commit, { ignore: [...DEFAULT_IGNORES, ".atticus", ...skip] }),
    extractors,
    dialects: entry?.dialects ?? [],
    scannedAt: o.scannedAt ?? new Date().toISOString(),
    repoInfo: {
      ...(entry?.component ? { component: entry.component } : {}),
      ...(entry?.system ? { system: entry.system } : {}),
      ...(entry?.type ? { repoType: entry.type } : {}),
    },
  });
  for (const run of scan.runs.filter((x) => x.status === "failed"))
    problems.push(`${run.extractor} failed on ${repoId}`);

  const components = new Set<string>([
    ...(entry?.component ? [entry.component] : []),
    ...scan.records.filter((r) => r.kind === "Component").map((r) => r.id),
    ...catalog.records
      .filter((r) => r.kind === "Component" && (r as RecordOf<"Component">).repo === repoId)
      .map((r) => r.id),
  ]);
  // Every other repo's records from the catalog are the context the merge resolves against.
  const context = catalog.records
    .filter((r) => !CONTEXT_SKIP.has(r.kind))
    .map((r) => strip(r, repoId, components))
    .filter((r): r is CatalogRecord => !!r);
  const merged = mergeCatalog({
    records: [...context, ...otherEnds(catalog.records, repoId, components), ...scan.records],
    repos: manifest.map((r) => ({
      id: r.id,
      type: r.type,
      ...(r.component ? { component: r.component } : {}),
      ...(r.system ? { system: r.system } : {}),
    })),
    // Without the org pack (a fetched copy of the catalog), the catalog's systems stand in for
    // the profile's.
    systems: orgPackDir
      ? op.profiles.flatMap((p) => p.profile?.systems ?? [])
      : catalog.records
          .filter((r): r is RecordOf<"System"> => r.kind === "System")
          .map((x) => ({
            id: x.id,
            name: x.name,
            boundary: x.boundary,
            ...(x.owner ? { owner: x.owner } : {}),
            aliases: [],
          })),
    patterns: op.patterns,
  });
  if (!orgPackDir)
    problems.push(
      "There is no org pack with this catalog, so patterns (inferred from the org pack) aren't compared.",
    );

  const before = surface(catalog.records, repoId, components);
  const after = surface(merged.records, repoId, components);
  if (!orgPackDir)
    for (const m of [before, after]) for (const s of m.values()) delete s.fields.pattern;
  const designs = await approvedDesigns(where.root);

  const items: DriftItem[] = [];
  const push = (
    kind: DriftKind,
    s: SurfaceItem,
    summary: string,
    extra: Partial<DriftItem> = {},
  ) => {
    if (ignored(s.id, cfg.drift.ignore)) return;
    const planned = kind === "planned" ? undefined : plannedBy(s, kind, designs);
    items.push({
      kind: planned ? "planned" : kind,
      subject: s.subject,
      id: s.id,
      summary: planned ? `${summary} (planned by ${planned})` : summary,
      ...extra,
      ...(planned ? { change: planned } : {}),
      evidence: evOf(s.record, repoId),
    });
  };
  const diff = (a: SurfaceItem, b: SurfaceItem) =>
    Object.keys({ ...a.fields, ...b.fields })
      .sort()
      .filter((f) => (a.fields[f] ?? "") !== (b.fields[f] ?? ""))
      .map((f) => ({
        field: f,
        ...(a.fields[f] !== undefined ? { catalog: a.fields[f] } : {}),
        ...(b.fields[f] !== undefined ? { code: b.fields[f] } : {}),
      }));
  const describe = (ch: { field: string; catalog?: string; code?: string }[]) =>
    ch.map((c) => `${c.field} ${c.catalog ?? "(none)"} → ${c.code ?? "(none)"}`).join(", ");

  const gone: SurfaceItem[] = [];
  const fresh: SurfaceItem[] = [];
  for (const [k, a] of before) {
    const b = after.get(k);
    if (!b) gone.push(a);
    else {
      const ch = diff(a, b);
      if (ch.length) push("changed", b, `${b.label} changed: ${describe(ch)}.`, { changes: ch });
    }
  }
  for (const [k, b] of after) if (!before.has(k)) fresh.push(b);
  // An old and a new item that are the only ones of their pair (same caller and callee, same
  // component and method) are one thing whose path or method changed.
  const pairs = (l: SurfaceItem[]) => {
    const m = new Map<string, SurfaceItem[]>();
    for (const s of l)
      if (s.pair) m.set(`${s.subject}|${s.pair}`, [...(m.get(`${s.subject}|${s.pair}`) ?? []), s]);
    return m;
  };
  const gp = pairs(gone);
  const fp = pairs(fresh);
  const paired = new Set<SurfaceItem>();
  for (const [k, olds] of gp) {
    const news = fp.get(k);
    if (olds.length !== 1 || news?.length !== 1) continue;
    const ch = diff(olds[0]!, news[0]!);
    push("changed", news[0]!, `${olds[0]!.label} changed: ${describe(ch)}.`, { changes: ch });
    paired.add(olds[0]!).add(news[0]!);
  }
  for (const a of gone.filter((x) => !paired.has(x)))
    push("removed", a, `${a.label} is in the catalog but no longer in the code.`);
  for (const b of fresh.filter((x) => !paired.has(x)))
    push(
      b.subject === "loose-end" ? "unknown" : "added",
      b,
      b.subject === "loose-end"
        ? `${b.label}: Atticus can't tell where it goes.`
        : `${b.label} is in the code but not in the catalog.`,
    );

  const ORDER: DriftKind[] = ["added", "changed", "removed", "unknown", "planned"];
  items.sort(
    (a, b) =>
      ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) ||
      a.subject.localeCompare(b.subject) ||
      a.id.localeCompare(b.id),
  );
  const counts = Object.fromEntries(
    ORDER.map((k) => [k, items.filter((i) => i.kind === k).length]),
  ) as Record<DriftKind, number>;
  return {
    schemaVersion: DRIFT_SCHEMA_VERSION,
    repo: repoId,
    components: [...components].sort(),
    mode: o.warnOnly ? "warn" : cfg.drift.mode,
    drift: items.some((i) => i.kind !== "planned"),
    counts,
    items,
    changes: designs.changes,
    scanned: {
      commit,
      records: scan.records.length,
      extractors: extractors.map((x) => x.id).sort(),
    },
    problems,
  };
}

/** Exit code for a report: 0 clean (or warn-only), 1 drift that blocks. */
export const driftExitCode = (r: DriftReport) => (r.drift && r.mode === "block" ? 1 : 0);
