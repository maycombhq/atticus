import { createHash } from "node:crypto";
import { z } from "zod";
import type { CatalogRecord } from "./catalog.js";
import { interfaceId, normalizePath, slugify } from "./identity.js";
import { canonicalize } from "./serialize.js";
import { SCHEMA_VERSION, type EvidenceT } from "./schema/common.js";
import {
  configSecretField,
  credentialLike,
  Fact,
  FactsFile,
  looksLikeSecret,
  type FactOf,
} from "./schema/facts.js";
import { hasSecretShape, redactSecrets } from "./cite.js";
import { NEVER_CHECKED_STEPS } from "./schema/kinds.js";
import { migrationOf, type MigrationFile } from "./migration-files.js";
import { normalizeFactPaths } from "./fact-paths.js";

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
    // Round 46: a JSON array cut short (a write interrupted) is a refused file, never a throw.
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch (e) {
      return { ok: false, issues: [{ code: "not-json", message: (e as Error).message }] };
    }
    const r = FactsFile.safeParse(normalizeFactPaths(json));
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
      json = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    } catch (e) {
      issues.push({ line, code: "not-json", message: (e as Error).message });
      return;
    }
    const r = Fact.safeParse(normalizeFactPaths(json));
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

const REDACTED = "<redacted>";

/**
 * A facts file's line as it may be kept where people read it (`<repo>.rejected.jsonl`), beta.25
 * review: a config fact any of whose fields carries a secret (`configSecretField`, beta.24's value
 * check included, or a quote `redactSecrets` changes) has its value, source, parts and quote
 * redacted, the rest kept as written. A line that isn't JSON is redacted as a line of code is,
 * and any quoted literal that reads as a credential goes too. Anything else is kept as it is.
 */
export function redactFactLine(raw: string): string {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return redactSecrets(raw).replace(/"((?:[^"\\]|\\.){6,})"/g, (all, v: string) =>
      credentialLike(v) || hasSecretShape(v) ? `"${REDACTED}"` : all,
    );
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return raw;
  const f = json as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const cite =
    f.cite && typeof f.cite === "object" && !Array.isArray(f.cite)
      ? (f.cite as Record<string, unknown>)
      : {};
  const withs = Array.isArray(cite.with) ? (cite.with as unknown[]) : [];
  const parts = withs.map((w) =>
    w && typeof w === "object" ? str((w as Record<string, unknown>).value) : undefined,
  );
  const key = str(f.key);
  const strings = [str(f.value), str(f.source), ...parts].filter((x): x is string => !!x);
  const quote = str(cite.quote);
  // A quote under a secret's key holding a credential-like word (`"value": "q8Zt…"`).
  const quoteHolds =
    quote !== undefined &&
    key !== undefined &&
    looksLikeSecret(key, "x") &&
    quote.split(/[\s"'`:=,;{}()<>[\]]+/).some((w) => credentialLike(w));
  const secret =
    (key !== undefined &&
      !!configSecretField({
        key,
        value: str(f.value),
        source: str(f.source),
        target: str(f.target),
        env: str(f.env),
        cite: { with: parts.flatMap((v) => (v === undefined ? [] : [{ value: v }])) },
      })) ||
    strings.some((s) => hasSecretShape(s)) ||
    quoteHolds ||
    (quote !== undefined && redactSecrets(quote) !== quote);
  if (!secret) return raw;
  const out: Record<string, unknown> = { ...f };
  if (str(f.value) !== undefined) out.value = REDACTED;
  if (str(f.source) !== undefined) out.source = REDACTED;
  if (Object.keys(cite).length) {
    const c: Record<string, unknown> = { ...cite };
    if (c.quote !== undefined) c.quote = REDACTED;
    if (withs.length)
      c.with = withs.map((w) =>
        w && typeof w === "object" ? { ...(w as object), value: REDACTED } : REDACTED,
      );
    out.cite = c;
  }
  return JSON.stringify(out);
}

/** A line of a facts file that isn't a fact, with its number, its text and what is wrong. */
export type BadFactLine = { line: number; raw: string; issues: FactIssue[] };

/**
 * One line of a facts file: the fact it holds, or what is wrong with it, or neither when the line
 * is blank. `seen` holds the ids read so far and gains this one, so a repeated id keeps its first
 * line. The whole of reading a line is here, so a reader that streams the file (ADR 0124 addendum
 * A-room) and one that has the text in hand give the same facts and the same issues.
 */
export function parseFactLine(
  raw: string,
  line: number,
  seen: Set<string>,
): { fact?: Fact; bad?: BadFactLine } {
  if (raw.trim() === "") return {};
  // A byte-order mark, which PowerShell 5.1 writes at the head of a UTF-8 file, isn't the fact's.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    const message = text.includes("\u0000")
      ? "the file is UTF-16 (PowerShell's Out-File writes it): save it as UTF-8, one JSON fact per line"
      : (e as Error).message;
    return { bad: { line, raw, issues: [{ line, code: "not-json", message }] } };
  }
  const r = Fact.safeParse(normalizeFactPaths(json));
  if (!r.success)
    return {
      bad: { line, raw, issues: r.error.issues.map((iss) => ({ line, ...issueOf(iss) })) },
    };
  if (seen.has(r.data.id))
    return {
      bad: {
        line,
        raw,
        issues: [
          {
            line,
            factId: r.data.id,
            code: "duplicate-id",
            message: `fact id ${r.data.id} is used on an earlier line`,
          },
        ],
      },
    };
  seen.add(r.data.id);
  return { fact: r.data };
}

/**
 * Read a JSONL facts file line by line, keeping every line that reads and returning the others
 * with their issues, so one bad line (a capital in an id, a missing field) costs that fact, not
 * the whole read (feedback from the A4 run). A repeated id keeps its first line.
 *
 * This takes the whole file as one string; a big repo's facts are read a line at a time instead
 * (`streamFacts` in the CLI, ADR 0124 addendum A-room), through the same `parseFactLine`.
 */
export function parseFactsLines(text: string): {
  facts: Fact[];
  bad: BadFactLine[];
} {
  const facts: Fact[] = [];
  const bad: BadFactLine[] = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const r = parseFactLine(raw, i + 1, seen);
    if (r.fact) facts.push(r.fact);
    else if (r.bad) bad.push(r.bad);
  });
  return { facts, bad };
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
  /**
   * The catalog id each fact became, by fact id, in id order (fields that became a Column or a
   * Schema field are left out). A writer follows them through the catalog merge (ADR 0124, A3b).
   */
  ids: Record<string, string>;
}

type Entry = FactOf<"entry">;
type Store = FactOf<"store">;
type Field = FactOf<"field">;

const idPart = (text: string) => slugify(text).replace(/\./g, "-");

/** A name as a part of a projected catalog id: its slug, with dots made dashes (a component, a store). */
export const factIdPart = idPart;

/** The Endpoint id an entry fact projects to in its component (`projectFacts`). */
export function entryEndpointId(f: FactOf<"entry">, component: string): string {
  const name =
    f.entryType === "event-topic" || f.entryType === "mq-queue"
      ? `on-${idPart(f.path)}`
      : idPart(`${f.method ?? ""} ${f.path}`);
  return `${component}.${name}`;
}

/**
 * A call's normalised path: a gRPC method stays `package.Service/Method` and a SOAP operation
 * `Contract/Operation` (a client may write either with a leading slash); an HTTP path loses a parameter's optional marker and constraint first
 * (`{brandId:int?}`), so the `?` isn't read as a query string.
 */
export function callPath(callType: string, path: string): string {
  if (callType === "grpc" || callType === "soap") return path.trim().replace(/^\/+/, "");
  return normalizePath(path);
}

const shortHash = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex").slice(0, 8);

/** What a record claims, without where it was seen: two records that differ here aren't one. */
function claimOf(r: CatalogRecord): string {
  const { evidence: _e, confidence: _c, ...rest } = r as CatalogRecord & { confidence?: unknown };
  return JSON.stringify(canonicalize(rest));
}

/**
 * Round 47: records of one kind and id that claim different things (other than their evidence
 * and confidence) would be merged into one, silently, by the catalog merge. Each such id is
 * reported, with the facts that made it; the same claim seen on several lines is one record and
 * is not reported.
 */
function duplicateRecords(out: readonly CatalogRecord[], ids: Record<string, string>): FactIssue[] {
  const claims = new Map<string, Set<string>>();
  for (const r of out) {
    // A REST endpoint is keyed by its component, method and normalised path in the merge, not by
    // this id, so two routes that slug alike stay two there.
    if (r.kind === "Endpoint" && r.endpointType === "rest") continue;
    const k = `${r.kind}|${r.id}`;
    claims.set(k, (claims.get(k) ?? new Set()).add(claimOf(r)));
  }
  const issues: FactIssue[] = [];
  for (const [k, seen] of claims) {
    if (seen.size < 2) continue;
    const kind = k.slice(0, k.indexOf("|"));
    const id = k.slice(k.indexOf("|") + 1);
    const by = Object.keys(ids).filter((f) => ids[f] === id);
    issues.push({
      ...(by[0] ? { factId: by[0] } : {}),
      code: "duplicate-record",
      message: `${kind} ${id} is made by ${by.length ? by.join(", ") : "several facts"}, which say different things; the catalog merge would join them into one`,
    });
  }
  return issues;
}

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
 * The `auth` an entry fact may put in the catalog (ADR 0124 addendum A-uncited): the claim stands
 * in C1 only where a line is cited for it (`authCite`), or where a person made the fact, since
 * that is their own word, marked as theirs. The facts file keeps what its writer wrote either
 * way; this is the gate on the way into the catalog, so the catalog never says an auth no line
 * was cited for, and the verifier's `authUncited` warning stays until a line is cited.
 */
export function catalogAuth(f: FactOf<"entry">): FactOf<"entry">["auth"] {
  if (f.auth === undefined) return undefined;
  return f.authCite || f.by === "person" ? f.auth : undefined;
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
    schemaVersion: SCHEMA_VERSION,
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
  // ADR 0163: an owner term is the identifier the organisation knows the component's system by,
  // kept as a flag (`term:<term>=<value>`, C1's existing optional field), cited on its line.
  const owned = new Map<string, FactOf<"term">[]>();
  for (const f of facts)
    if (f.kind === "term" && f.role === "owner")
      owned.set(componentOf(f), [...(owned.get(componentOf(f)) ?? []), f]);
  // ADR 0180: what a component is, said by a component fact citing its signal; else the old
  // reading (a screen makes a spa, the rest services).
  const typed = new Map<string, FactOf<"component">>();
  for (const f of facts)
    if (f.kind === "component" && !typed.has(componentOf(f))) typed.set(componentOf(f), f);
  for (const [id, { f, screen }] of components) {
    const terms = owned.get(id) ?? [];
    const t = typed.get(id);
    const flags = [...new Set(terms.map((t) => `term:${t.term}=${t.value}`))].sort();
    out.push({
      kind: "Component",
      ...common(f),
      id,
      system: systemOf(f),
      repo: repoOf(f),
      type: t?.type ?? (screen ? "spa" : "service"),
      ...(flags.length ? { flags } : {}),
      evidence: [
        evidenceOf(f, "code"),
        ...(t && t !== f ? [evidenceOf(t, "code")] : []),
        ...terms.filter((x) => x !== f).map((x) => evidenceOf(x, "code")),
      ],
    } as CatalogRecord);
  }

  // ---- entries -> Endpoint
  for (const f of facts) {
    if (f.kind !== "entry") continue;
    const component = componentOf(f);
    const id = entryEndpointId(f, component);
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
      // A-uncited: an auth no line is cited for stays in the facts file and out of the catalog.
      ...(catalogAuth(f) ? { auth: catalogAuth(f) } : {}),
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
      // A target a person set (a pairing on the canvas, or "this link is wrong"): their word,
      // flagged as such and with their evidence beside the code's (ADR 0135, 0174).
      const byPerson = f.by === "person";
      out.push({
        kind: "Interface",
        ...common(f),
        id,
        from,
        to,
        ...(byPerson ? { flags: ["joined-by-person"] } : {}),
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
        normalizedPath: callPath(f.callType, f.path),
        sync: async ? "async" : "sync",
        direction: "outbound",
        conflicts: [],
        evidence: byPerson
          ? [
              evidenceOf(f, "code", "caller"),
              {
                source: "manual",
                repo: f.repo,
                path: f.cite.file,
                line: f.cite.line,
                by: "person",
              },
            ]
          : [evidenceOf(f, "code", "caller")],
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
  // ---- migrations (B-places): a column or store fact cited in a migration file
  type MigrationTable = { cols: { name: string; line: number }[]; quotes: string[] };
  type FoundMigration = {
    store: string;
    file: string;
    found: MigrationFile;
    tables: Map<string, MigrationTable>;
    ev: EvidenceT[];
    declared: boolean;
  };
  const migrations = new Map<string, FoundMigration>();
  for (const f of facts) {
    const store =
      f.kind === "store"
        ? f
        : f.kind === "field" && byId.get(f.owner)?.kind === "store"
          ? (byId.get(f.owner) as Store)
          : undefined;
    if (!store) continue;
    const found = migrationOf(f.cite.file);
    if (!found) continue;
    const storeId = idPart(store.store);
    const id = `${storeId}.v${slugify(found.version)}`;
    const m: FoundMigration = migrations.get(id) ?? {
      store: storeId,
      file: f.cite.file,
      found,
      tables: new Map(),
      ev: [],
      declared: true,
    };
    const t: MigrationTable = m.tables.get(store.name) ?? { cols: [], quotes: [] };
    if (f.kind === "field" && !t.cols.some((c) => c.name === f.name))
      t.cols.push({ name: f.name, line: f.cite.line });
    if (f.cite.quote) t.quotes.push(f.cite.quote);
    m.tables.set(store.name, t);
    m.ev.push(evidenceOf(f, "migration"));
    if (f.conf !== "declared") m.declared = false;
    migrations.set(id, m);
  }
  for (const [id, m] of migrations) {
    out.push({
      kind: "Migration",
      schemaVersion: SCHEMA_VERSION,
      status: "current",
      confidence: m.declared ? "verified" : "inferred",
      id,
      dataStore: m.store,
      version: m.found.version,
      tool: m.found.tool,
      file: m.file,
      // What the facts say the file does to each table: the verb only when a quote states it.
      operations: [...m.tables].map(([name, t]) => {
        const q = t.quotes.join(" ");
        const verb = /create[_ ]?table/i.test(q)
          ? "create table"
          : /(add|alter|drop|rename)[_ ]?(table|column)/i.test(q)
            ? "alter table"
            : "table";
        const cols = [...t.cols].sort((a, b) => a.line - b.line).map((c) => c.name);
        return `${verb} ${name}${cols.length ? ` (${cols.join(", ")})` : ""}`;
      }),
      evidence: [...m.ev].sort((a, b) => (a.line ?? 0) - (b.line ?? 0)),
    } as CatalogRecord);
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
        // ADR 0125: true and false are both facts; left out, the field's required is unknown.
        ...(f.required !== undefined ? { required: f.required } : {}),
      })),
      evidence: s.fields.map((f) => evidenceOf(f, "code")),
    } as CatalogRecord);
    if (s.owner.kind === "entry") {
      const ep = out.find((r) => r.kind === "Endpoint" && r.id === s.ref);
      if (ep && ep.kind === "Endpoint") ep.schemaRefs = [...ep.schemaRefs, id].sort();
    }
  }

  // ---- deploy -> Deployment
  // Round 47: two deploy facts of one component whose `<env ?? platform>` is the same but which
  // say different things (kubernetes and lambda, both for prod) are two Deployments, so each
  // gets its platform after its env (`<component>.<env>.<platform>`; an id part has no dots, so
  // this can't meet a plain `<component>.<env>`).
  const deployBase = (f: FactOf<"deploy">) => `${componentOf(f)}.${idPart(f.env ?? f.platform)}`;
  const deployShapes = new Map<string, Set<string>>();
  for (const f of facts)
    if (f.kind === "deploy")
      deployShapes.set(
        deployBase(f),
        (deployShapes.get(deployBase(f)) ?? new Set()).add(`${f.env ?? ""}\u0000${f.platform}`),
      );
  for (const f of facts) {
    if (f.kind !== "deploy") continue;
    const component = componentOf(f);
    const base = deployBase(f);
    const id =
      (deployShapes.get(base)?.size ?? 0) > 1
        ? `${component}.${idPart(f.env ?? "default")}.${idPart(f.platform)}`
        : base;
    catalogIdOf.set(f.id, id);
    out.push({
      kind: "Deployment",
      ...common(f),
      id,
      component,
      env: f.env ?? "default",
      platform: f.platform,
      ...(f.replicas !== undefined ? { replicas: f.replicas } : {}),
      networkPolicies: [],
      evidence: [evidenceOf(f, "infrastructure")],
    } as CatalogRecord);
  }

  // ---- config -> Setting
  // Round 47: `<env>.<key>` and a dotted key (`x` for prod, and `prod.x`), or two keys that slug
  // the same (`DB_URL`, `db_url`), meet on one id; each of them then gets a short hash of its
  // env and key after it, so neither is merged into the other.
  const settingBase = (f: FactOf<"config">) =>
    `${componentOf(f)}.${f.env ? `${slugify(f.env)}.` : ""}${slugify(f.key)}`;
  const settingShapes = new Map<string, Set<string>>();
  for (const f of facts)
    if (f.kind === "config")
      settingShapes.set(
        settingBase(f),
        (settingShapes.get(settingBase(f)) ?? new Set()).add(`${f.env ?? ""}\u0000${f.key}`),
      );
  // Round 49: two facts of one key and env that say different things (`url` read from both
  // `gateway.url` and `audit.url` of one file) are two settings, not one the merge would join:
  // each gets a short hash of its file and line after it too, and the clash is reported.
  const settingSaid = (f: FactOf<"config">) =>
    JSON.stringify([f.settingKind, f.value ?? null, f.source ?? null, f.target ?? null]);
  const settingClaims = new Map<string, { said: Set<string>; by: string[] }>();
  const shapeOf = (f: FactOf<"config">) => `${settingBase(f)}\u0000${f.env ?? ""}\u0000${f.key}`;
  for (const f of facts)
    if (f.kind === "config") {
      const c = settingClaims.get(shapeOf(f)) ?? { said: new Set<string>(), by: [] };
      c.said.add(settingSaid(f));
      c.by.push(f.id);
      settingClaims.set(shapeOf(f), c);
    }
  for (const [shape, c] of settingClaims)
    if (c.said.size > 1)
      issues.push({
        factId: c.by[0]!,
        code: "duplicate-record",
        message: `Setting ${shape.slice(0, shape.indexOf("\u0000"))} is made by ${c.by.join(", ")}, which say different things; each keeps a Setting of its own, its id given its line's hash: write each key's full path to tell them apart`,
      });
  for (const f of facts) {
    if (f.kind !== "config") continue;
    const component = componentOf(f);
    const base = settingBase(f);
    const keyed =
      (settingShapes.get(base)?.size ?? 0) > 1
        ? `${base}-${shortHash(`${f.env ?? ""}\u0000${f.key}`)}`
        : base;
    const id =
      (settingClaims.get(shapeOf(f))?.said.size ?? 0) > 1
        ? `${keyed}-${shortHash(`${f.cite.file}\u0000${f.cite.line}`)}`
        : keyed;
    catalogIdOf.set(f.id, id);
    out.push({
      kind: "Setting",
      ...common(f),
      id,
      component,
      ...(f.env ? { env: f.env } : {}),
      settingKind: f.settingKind,
      key: f.key,
      valueOrRef: f.value ?? f.source ?? "",
      ...(f.target ? { target: idPart(f.target) } : {}),
      evidence: [evidenceOf(f, "config")],
    } as CatalogRecord);
  }

  // ---- framework -> nothing of its own (ADR 0124 addendum A-framework): no C1 record holds
  // what a repo is built on, and a field on Component would be a C1 bump with a migration. A
  // framework fact still gives its repo or module a Component above, as every other kind does;
  // the views read the framework facts themselves.

  // ---- flow -> Flow
  /** A call's request fields, by name. */
  const sentBy = new Map<string, string[]>();
  for (const f of facts)
    if (
      f.kind === "field" &&
      (f.side ?? "request") === "request" &&
      byId.get(f.owner)?.kind === "call"
    )
      sentBy.set(f.owner, [...(sentBy.get(f.owner) ?? []), f.name]);
  /** The fields a step names through its ref: the field it checks or uses, or what a call-out sends. */
  const dataOf = (kind: string, target: Fact | undefined) => {
    if (target?.kind === "field") {
      const slot =
        kind === "validate"
          ? "checks"
          : kind === "respond"
            ? "returns"
            : kind === "call-out" || kind === "publish"
              ? "sends"
              : "reads";
      return { [slot]: [target.name] };
    }
    if (target?.kind === "call" && (kind === "call-out" || kind === "publish")) {
      const sends = sentBy.get(target.id);
      return sends?.length ? { sends: [...sends].sort() } : undefined;
    }
    return undefined;
  };
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
    const flowId = `${component}.${idPart(f.name)}`;
    catalogIdOf.set(f.id, flowId);
    out.push({
      kind: "Flow",
      schemaVersion: 2 as const,
      id: flowId,
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
            : s.kind === "call-out" && target?.kind === "config"
              ? // B-fixes: a call through a cloud SDK with no path cites its client's setting:
                // it goes to the setting's target when it names one, else to the setting.
                {
                  to: {
                    component: target.target ? idPart(target.target) : catalogIdOf.get(target.id)!,
                    entry: target.key,
                  },
                }
              : {};
        const storeOf =
          (s.kind === "read" || s.kind === "lookup" || s.kind === "write") &&
          target?.kind === "store"
            ? { store: { table: catalogIdOf.get(target.id)!, columns: target.columns ?? [] } }
            : {};
        const data = dataOf(s.kind, target);
        const checkable = !(NEVER_CHECKED_STEPS as readonly string[]).includes(s.kind);
        return {
          kind: s.kind,
          what: s.what,
          refs: refsOf(s.ref),
          ...toOf,
          ...(data ? { data } : {}),
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
      "Migration",
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
  const ids: Record<string, string> = {};
  for (const id of [...catalogIdOf.keys()].sort()) ids[id] = catalogIdOf.get(id)!;
  issues.push(...duplicateRecords(out, ids));
  return { records: out, issues, ids };
}
