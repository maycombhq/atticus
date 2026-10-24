import { z } from "zod";
import type { CatalogRecord } from "./catalog.js";
import { interfaceId, normalizePath, slugify } from "./identity.js";
import { canonicalize } from "./serialize.js";
import type { EvidenceT } from "./schema/common.js";
import { Fact, FactsFile, type FactOf } from "./schema/facts.js";
import { NEVER_CHECKED_STEPS } from "./schema/kinds.js";

/**
 * The facts file (ADR 0124): read, write and project into catalog C1.
 *
 * `parseFacts` reads JSONL (or a JSON array) and refuses anything the schema refuses, with the
 * line it was on. `serializeFacts` writes one canonical line per fact, sorted by id, so the same
 * facts give the same bytes. `projectFacts` turns facts into C1 records deterministically:
 * nothing downstream of C1 has to know facts exist.
 */

export interface FactIssue {
  line?: number;
  factId?: string;
  code: string;
  message: string;
}

export type ParseFactsResult = { ok: true; facts: Fact[] } | { ok: false; issues: FactIssue[] };

export function parseFacts(text: string): ParseFactsResult {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) {
    const r = FactsFile.safeParse(JSON.parse(trimmed));
    if (r.success) return { ok: true, facts: r.data };
    return { ok: false, issues: r.error.issues.map((i) => issueOf(i)) };
  }
  const facts: Fact[] = [];
  const issues: FactIssue[] = [];
  const lines = trimmed === "" ? [] : trimmed.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = i + 1;
    if (raw.trim() === "") return;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      issues.push({ line, code: "not-json", message: (e as Error).message });
      return;
    }
    const r = Fact.safeParse(json);
    if (r.success) facts.push(r.data);
    else for (const iss of r.error.issues) issues.push({ line, ...issueOf(iss) });
  });
  const seen = new Map<string, number>();
  facts.forEach((f, i) => {
    const first = seen.get(f.id);
    if (first !== undefined)
      issues.push({ factId: f.id, code: "duplicate-id", message: `fact id repeated at ${i + 1}` });
    else seen.set(f.id, i);
  });
  return issues.length ? { ok: false, issues } : { ok: true, facts };
}

function issueOf(i: z.core.$ZodIssue): FactIssue {
  return { code: i.code, message: `${i.path.join(".") || "(root)"}: ${i.message}` };
}

/** One canonical JSON line per fact, sorted by id; the same facts give the same bytes. */
export function serializeFacts(facts: readonly Fact[]): string {
  const sorted = [...facts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sorted.map((f) => JSON.stringify(canonicalize(f, ["kind", "id"]))).join("\n") + "\n";
}

// ---------------------------------------------------------------- projection

export interface ProjectOptions {
  /** The System every projected Component belongs to. Default: the repo's slug. */
  system?: string;
  /** Overrides the facts' own `repo` as the evidence repo (a renamed clone, say). */
  repo?: string;
}

export interface ProjectResult {
  records: CatalogRecord[];
  issues: FactIssue[];
}

type Entry = FactOf<"entry">;
type Store = FactOf<"store">;
type Field = FactOf<"field">;

const idPart = (text: string) => slugify(text).replace(/\./g, "-");

function evidenceOf(f: Fact, source: EvidenceT["source"], side?: EvidenceT["side"]): EvidenceT {
  return {
    source,
    repo: f.repo,
    path: f.cite.file,
    line: f.cite.line,
    commit: f.commit,
    ...(side ? { side } : {}),
    by: f.by,
  };
}

function citeEvidence(
  f: Fact,
  cite: { file: string; line: number },
  source: EvidenceT["source"],
): EvidenceT {
  return { source, repo: f.repo, path: cite.file, line: cite.line, commit: f.commit, by: f.by };
}

const confidenceOf = (f: Fact): "verified" | "inferred" =>
  f.conf === "declared" ? "verified" : "inferred";

function triggerKind(t: Entry["entryType"]) {
  switch (t) {
    case "event-topic":
    case "mq-queue":
      return "listener" as const;
    case "batch-job":
    case "function":
      return "job" as const;
    case "screen":
      return "action" as const;
    default:
      return "endpoint" as const;
  }
}

/**
 * Facts to C1. Ids are made from the claims, so the same facts give the same ids:
 * Endpoint `<component>.<method-path>`, Interface `if-<hash>`, DataStore `<store>`,
 * Table `<store>.<table>`, Column `<store>.<table>.<column>`, Schema `<endpoint>.<side>`,
 * Deployment `<component>.<env>`, Setting `<component>.<key>`, Flow `<component>.<name>`.
 */
export function projectFacts(input: readonly Fact[], opts: ProjectOptions = {}): ProjectResult {
  const facts = [...input].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const issues: FactIssue[] = [];
  const byId = new Map(facts.map((f) => [f.id, f] as const));
  const repoOf = (f: Fact) => opts.repo ?? f.repo;
  const componentOf = (f: Fact) => idPart(f.component ?? repoOf(f));
  const systemOf = (f: Fact) => idPart(opts.system ?? repoOf(f));

  const dangling = (from: Fact, ref: string | undefined, field: string) => {
    if (ref !== undefined && !byId.has(ref)) {
      issues.push({
        factId: from.id,
        code: "dangling-ref",
        message: `${field} names "${ref}", which is no fact in this file`,
      });
      return true;
    }
    return false;
  };

  // ids the projection gives each fact, so flows and fields can refer to them
  const catalogIdOf = new Map<string, string>();

  const out: CatalogRecord[] = [];
  const common = (f: Fact) => ({
    schemaVersion: 2 as const,
    status: "current" as const,
    confidence: confidenceOf(f),
  });

  // ---- components
  const components = new Map<string, { f: Fact; screen: boolean }>();
  for (const f of facts) {
    if (f.kind === "field") continue; // a field belongs to its owner's component
    const c = componentOf(f);
    const cur = components.get(c);
    const screen = f.kind === "entry" && f.entryType === "screen";
    if (!cur) components.set(c, { f, screen });
    else if (screen) cur.screen = true;
  }
  for (const [id, { f, screen }] of components) {
    out.push({
      kind: "Component",
      ...common(f),
      id,
      system: systemOf(f),
      repo: repoOf(f),
      type: screen ? "spa" : "service",
      evidence: [evidenceOf(f, "code")],
    } as CatalogRecord);
  }

  // ---- entries -> Endpoint
  for (const f of facts) {
    if (f.kind !== "entry") continue;
    const component = componentOf(f);
    const name =
      f.entryType === "event-topic" || f.entryType === "mq-queue"
        ? `on-${idPart(f.path)}`
        : idPart(`${f.method ?? ""} ${f.path}`);
    const id = `${component}.${name}`;
    catalogIdOf.set(f.id, id);
    const isPath = f.entryType !== "event-topic" && f.entryType !== "mq-queue";
    out.push({
      kind: "Endpoint",
      ...common(f),
      id,
      component,
      endpointType: f.entryType === "screen" ? "rest" : f.entryType,
      ...(f.method ? { method: f.method.toUpperCase() } : {}),
      pathOrTopic: f.path,
      ...(isPath ? { normalizedPath: normalizePath(f.path) } : {}),
      schemaRefs: [],
      ...(f.auth ? { auth: f.auth } : {}),
      evidence: [evidenceOf(f, "code", "callee")],
    } as CatalogRecord);
  }

  // ---- calls -> Interface or Unresolved
  for (const f of facts) {
    if (f.kind !== "call") continue;
    dangling(f, f.from, "from");
    const from = componentOf(f);
    const method = f.method?.toUpperCase();
    if (f.to) {
      const to = idPart(f.to);
      const id = interfaceId(from, to, method, f.path);
      catalogIdOf.set(f.id, id);
      const async = f.sync === "async" || f.callType === "event-topic" || f.callType === "mq-queue";
      out.push({
        kind: "Interface",
        ...common(f),
        id,
        from,
        to,
        via:
          f.callType === "event-topic"
            ? "event-bus"
            : f.callType === "mq-queue"
              ? "mq"
              : f.callType === "sftp"
                ? "sftp"
                : f.callType === "webhook"
                  ? "webhook"
                  : "direct",
        ...(method ? { method } : {}),
        normalizedPath: normalizePath(f.path),
        sync: async ? "async" : "sync",
        direction: "outbound",
        conflicts: [],
        evidence: [evidenceOf(f, "code", "caller")],
      } as CatalogRecord);
    } else {
      const id = `unresolved.${idPart(f.id)}`;
      catalogIdOf.set(f.id, id);
      issues.push({
        factId: f.id,
        code: "unresolved-target",
        message: `the call ${method ?? ""} ${f.path} names no target component; it is kept as Unresolved until the estate join or a person names one`,
      });
      out.push({
        kind: "Unresolved",
        ...common(f),
        id,
        unresolvedKind: "call",
        raw: [method, f.host ?? f.base, f.path].filter(Boolean).join(" "),
        owner: from,
        evidence: [evidenceOf(f, "code", "caller")],
      } as CatalogRecord);
    }
  }

  // ---- stores -> DataStore, Table
  const stores = new Map<string, { f: Store; tables: Set<string> }>();
  const tables = new Map<
    string,
    { f: Store; readers: Set<string>; writers: Set<string>; ev: EvidenceT[] }
  >();
  for (const f of facts) {
    if (f.kind !== "store") continue;
    dangling(f, f.under, "under");
    const storeId = idPart(f.store);
    const tableId = `${storeId}.${idPart(f.name)}`;
    catalogIdOf.set(f.id, tableId);
    const s = stores.get(storeId) ?? { f, tables: new Set<string>() };
    s.tables.add(f.name);
    stores.set(storeId, s);
    const t = tables.get(tableId) ?? { f, readers: new Set(), writers: new Set(), ev: [] };
    (f.op === "read" ? t.readers : t.writers).add(componentOf(f));
    t.ev.push(evidenceOf(f, "code"));
    tables.set(tableId, t);
  }
  for (const [id, s] of stores) {
    out.push({
      kind: "DataStore",
      ...common(s.f),
      id,
      storeType: s.f.storeType ?? "relational",
      ownerComponent: componentOf(s.f),
      entitiesHeld: [...s.tables].sort(),
      evidence: [evidenceOf(s.f, "code")],
    } as CatalogRecord);
  }
  for (const [id, t] of tables) {
    out.push({
      kind: "Table",
      ...common(t.f),
      id,
      dataStore: idPart(t.f.store),
      name: t.f.name,
      tableKind: t.f.tableKind ?? "table",
      ownerComponent: componentOf(t.f),
      readers: [...t.readers].sort(),
      writers: [...t.writers].sort(),
      evidence: t.ev,
    } as CatalogRecord);
  }

  // ---- fields -> Column, Schema, FieldMapping
  const schemas = new Map<string, { owner: Fact; ref: string; side: string; fields: Field[] }>();
  for (const f of facts) {
    if (f.kind !== "field") continue;
    if (dangling(f, f.owner, "owner")) continue;
    dangling(f, f.mappedTo, "mappedTo");
    const owner = byId.get(f.owner)!;
    if (owner.kind === "store") {
      const tableId = catalogIdOf.get(owner.id)!;
      out.push({
        kind: "Column",
        ...common(f),
        id: `${tableId}.${idPart(f.name)}`,
        table: tableId,
        name: f.name,
        type: f.type ?? "unknown",
        ...(f.required !== undefined ? { nullable: !f.required } : {}),
        ...(f.default !== undefined ? { default: f.default } : {}),
        ...(f.classification ? { classification: f.classification } : {}),
        evidence: [evidenceOf(f, "migration")],
      } as CatalogRecord);
      continue;
    }
    const ownerId = catalogIdOf.get(owner.id);
    if (!ownerId) continue;
    const side = f.side ?? "request";
    const key = `${ownerId}.${side}`;
    const s = schemas.get(key) ?? { owner, ref: ownerId, side, fields: [] };
    s.fields.push(f);
    schemas.set(key, s);
    if (f.mappedTo && owner.kind === "call") {
      const target = byId.get(f.mappedTo);
      if (target && target.kind === "field") {
        out.push({
          kind: "FieldMapping",
          ...common(f),
          id: `${ownerId}.${idPart(f.name)}-to-${idPart(target.name)}`,
          interface: ownerId,
          sourceField: f.name,
          targetField: target.name,
          ...(f.transform ? { transform: f.transform } : {}),
          evidence: [evidenceOf(f, "code")],
        } as CatalogRecord);
      }
    }
  }
  for (const [id, s] of schemas) {
    out.push({
      kind: "Schema",
      ...common(s.fields[0]!),
      id,
      format: "other",
      ref: s.ref,
      fields: s.fields.map((f) => ({
        name: f.name,
        ...(f.type ? { type: f.type } : {}),
        ...(f.classification ? { classification: f.classification } : {}),
      })),
      evidence: s.fields.map((f) => evidenceOf(f, "code")),
    } as CatalogRecord);
    if (s.owner.kind === "entry") {
      const ep = out.find((r) => r.kind === "Endpoint" && r.id === s.ref);
      if (ep && ep.kind === "Endpoint") ep.schemaRefs = [...ep.schemaRefs, id].sort();
    }
  }

  // ---- deploy -> Deployment
  for (const f of facts) {
    if (f.kind !== "deploy") continue;
    const component = componentOf(f);
    out.push({
      kind: "Deployment",
      ...common(f),
      id: `${component}.${idPart(f.env ?? f.platform)}`,
      component,
      env: f.env ?? "default",
      platform: f.platform,
      ...(f.replicas !== undefined ? { replicas: f.replicas } : {}),
      networkPolicies: [],
      evidence: [evidenceOf(f, "infrastructure")],
    } as CatalogRecord);
  }

  // ---- config -> Setting
  for (const f of facts) {
    if (f.kind !== "config") continue;
    const component = componentOf(f);
    out.push({
      kind: "Setting",
      ...common(f),
      id: `${component}.${slugify(f.key)}`,
      component,
      settingKind: f.settingKind,
      key: f.key,
      valueOrRef: f.value ?? f.source ?? "",
      ...(f.target ? { target: idPart(f.target) } : {}),
      evidence: [evidenceOf(f, "config")],
    } as CatalogRecord);
  }

  // ---- flow -> Flow
  for (const f of facts) {
    if (f.kind !== "flow") continue;
    if (dangling(f, f.entry, "entry")) continue;
    const entry = byId.get(f.entry)!;
    if (entry.kind !== "entry") {
      issues.push({
        factId: f.id,
        code: "flow-entry-kind",
        message: "a flow's entry is an entry fact",
      });
      continue;
    }
    const component = componentOf(f);
    const refsOf = (ref: string | undefined): string[] => {
      if (ref === undefined) return [];
      if (dangling(f, ref, "steps[].ref")) return [];
      const target = byId.get(ref)!;
      if (target.kind === "field") {
        const owner = byId.get(target.owner);
        if (!owner) return [];
        if (owner.kind === "store") return [`${catalogIdOf.get(owner.id)}.${idPart(target.name)}`];
        const ownerId = catalogIdOf.get(owner.id);
        return ownerId ? [`${ownerId}.${target.side ?? "request"}`] : [];
      }
      const id = catalogIdOf.get(ref);
      return id ? [id] : [];
    };
    out.push({
      kind: "Flow",
      schemaVersion: 2 as const,
      id: `${component}.${idPart(f.name)}`,
      status: "current",
      confidence: confidenceOf(f),
      evidence: [],
      component,
      name: f.name,
      trigger: {
        kind: triggerKind(entry.entryType),
        ref: catalogIdOf.get(entry.id),
        what: [entry.method?.toUpperCase(), entry.path].filter(Boolean).join(" "),
        evidence: [evidenceOf(entry, "code")],
      },
      steps: f.steps.map((s) => {
        const target = s.ref ? byId.get(s.ref) : undefined;
        const toOf =
          (s.kind === "call-out" || s.kind === "publish") && target?.kind === "call"
            ? {
                to: {
                  component: target.to ? idPart(target.to) : catalogIdOf.get(target.id)!,
                  entry: [target.method?.toUpperCase(), target.path].filter(Boolean).join(" "),
                },
              }
            : {};
        const storeOf =
          (s.kind === "read" || s.kind === "lookup" || s.kind === "write") &&
          target?.kind === "store"
            ? { store: { table: catalogIdOf.get(target.id)!, columns: target.columns ?? [] } }
            : {};
        const checkable = !(NEVER_CHECKED_STEPS as readonly string[]).includes(s.kind);
        return {
          kind: s.kind,
          what: s.what,
          refs: refsOf(s.ref),
          ...toOf,
          ...storeOf,
          evidence: [citeEvidence(f, s.cite, "code")],
          ...(f.verified === "line" && checkable ? { confirmedBy: "check" } : {}),
        };
      }),
      errors: f.errors.map((e) => ({
        when: e.when,
        then: e.then,
        evidence: [citeEvidence(f, e.cite, "code")],
      })),
      family: [],
      template: "facts@1",
    } as CatalogRecord);
  }

  const order = new Map(
    [
      "System",
      "Component",
      "Endpoint",
      "Interface",
      "Unresolved",
      "Schema",
      "FieldMapping",
      "DataStore",
      "Table",
      "Column",
      "Deployment",
      "Setting",
      "Flow",
    ].map((k, i) => [k, i] as const),
  );
  out.sort((a, b) => {
    const ka = order.get(a.kind) ?? 99;
    const kb = order.get(b.kind) ?? 99;
    return ka !== kb ? ka - kb : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return { records: out, issues };
}
