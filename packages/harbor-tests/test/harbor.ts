import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { loadOrgPack, parseRecord, type CatalogRecord, type OrgPack } from "@maycombhq/core";
import { scanEstate, type EstateScan } from "@maycombhq/scanner";

/** fixtures/harbor: the second reference ecosystem (ADR 0035 point 3). */
export const HARBOR = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/harbor");
/** The Harbor metarepo root: org-pack/ lives here; the wiki is at ../inputs/wiki. */
export const HARBOR_ROOT = join(HARBOR, "metarepo");
export const ORG_PACK = join(HARBOR_ROOT, "org-pack");
export const SCANNED_AT = "2026-10-18T09:00:00Z";

export const read = (p: string) => readFileSync(join(HARBOR, p), "utf8");
export const expectedFile = <T>(file: string): T => parse(read(join("expected", file))) as T;

export type Row = Record<string, unknown> & { kind: string; id: string };

/** The hand-written expected catalog, as written (no defaults filled in). */
export const expectedRows = (): Row[] =>
  (parse(read("expected/scan.yaml")) as Row[]).map((r) => ({ ...r }));

/**
 * ADR 0040 values the C1 schema on this main may not accept yet. Harbor is written in that
 * vocabulary; until the schema has it, a record using one is parsed with a stand-in value (to
 * fill C1's defaults) and then given its real value back.
 */
const NEW_VALUES: { kind: string; field: string; values: string[]; standIn: string }[] = [
  {
    kind: "Endpoint",
    field: "endpointType",
    values: ["graphql", "websocket", "sse", "webhook", "function", "transaction"],
    standIn: "rest",
  },
  { kind: "Interface", field: "via", values: ["mesh", "webhook"], standIn: "other" },
  { kind: "Setting", field: "settingKind", values: ["schedule"], standIn: "config" },
];

/** The ADR 0040 additions a row uses (field names), empty for a version-1 record. */
export function newVocabulary(row: Row): string[] {
  const out: string[] = [];
  for (const n of NEW_VALUES)
    if (row.kind === n.kind && n.values.includes(String(row[n.field]))) out.push(n.field);
  if (row.kind === "Deployment" && "ingress" in row) out.push("ingress");
  return out;
}

/** Parse one expected row with C1's defaults, keeping ADR 0040 values the schema may lack. */
export function toRecord(row: Row): CatalogRecord {
  const full = { schemaVersion: 1, status: "current", ...row };
  const strict = parseRecord(full);
  if (strict.ok) return strict.record;
  const used = newVocabulary(row);
  if (!used.length) throw new Error(`${row.id}: ${JSON.stringify(strict.issues)}`);
  const lowered: Record<string, unknown> = { ...full };
  for (const n of NEW_VALUES) if (used.includes(n.field)) lowered[n.field] = n.standIn;
  delete lowered.ingress;
  const p = parseRecord(lowered);
  if (!p.ok) throw new Error(`${row.id}: ${JSON.stringify(p.issues)}`);
  const back: Record<string, unknown> = { ...p.record };
  for (const f of used) back[f] = row[f];
  return back as unknown as CatalogRecord;
}

/** The expected Harbor catalog as records (C1 defaults filled, ADR 0040 values kept). */
export const harborRecords = (): CatalogRecord[] => expectedRows().map(toRecord);

let scanned: Promise<EstateScan> | undefined;

/** A full scan of Harbor (repos and inputs/) with this main's extractors; once per test file. */
export function scanHarbor(): Promise<EstateScan> {
  scanned ??= (async () =>
    scanEstate({
      root: await mkdtemp(join(tmpdir(), "atticus-harbor-")),
      orgPack: ORG_PACK,
      repoDir: (id) => join(HARBOR, "repos", id),
      repoState: async () => ({ commit: "b".repeat(40), dirty: false }),
      cache: null,
      scannedAt: SCANNED_AT,
      inputsDir: join(HARBOR, "inputs"),
    }))();
  return scanned;
}

export async function harborPack(): Promise<OrgPack> {
  const op = await loadOrgPack(ORG_PACK);
  if (op.problems.length) throw new Error(JSON.stringify(op.problems));
  return op;
}

export const harborSystems = (op: OrgPack) => op.profiles.flatMap((p) => p.profile?.systems ?? []);

export interface Discrepancy {
  id: string;
  found_by: "reconcile" | "critic" | "knowledge-gap" | "intake";
  what: string;
  refs: string[];
}

export interface DiagramEdgeTruth {
  cell: string;
  from: string;
  to: string;
  label?: string;
  pattern: string | null;
  method?: string;
  path?: string;
  topic?: string;
  legend?: string;
}

export interface ExpectedInputs {
  diagrams: { file: string; page: string; boxes: string[]; edges: DiagramEdgeTruth[] }[];
  aliases: Record<string, string | null>;
  patterns: string[];
  documentConflicts: { doc: string; claim: string; code: string }[];
  documentOnlyFacts: { system: string; fact: string; becomes: string }[];
  documents: {
    path: string;
    classification: string;
    status: string;
    systems: string[];
    supersededBy?: string;
  }[];
  triage: { id: string; kind: string; records: string[] }[];
}

const evKey = (e: Record<string, unknown>) =>
  `${String(e.repo ?? "")}:${String(e.path ?? "")}:${String(e.line ?? "")}:${String(e.side ?? "")}`;

export interface Comparison {
  missing: string[];
  extra: string[];
  fieldDiffs: string[];
  evidenceDiffs: string[];
}

/**
 * Compare scanned records with expected ones, field for field; evidence as a set of
 * (repo, path, line, side), ignoring commit, scan time, extractor and dialect tags.
 */
export function compare(
  actual: CatalogRecord[],
  expected: CatalogRecord[],
  opts: { ignoreFields?: Record<string, string[]> } = {},
): Comparison {
  const out: Comparison = { missing: [], extra: [], fieldDiffs: [], evidenceDiffs: [] };
  const act = new Map(actual.map((r) => [`${r.kind}/${r.id}`, r as unknown as Row]));
  const exp = new Map(expected.map((r) => [`${r.kind}/${r.id}`, r as unknown as Row]));
  for (const [k, e] of exp) {
    const a = act.get(k);
    if (!a) {
      out.missing.push(k);
      continue;
    }
    const ignore = new Set(["evidence", ...(opts.ignoreFields?.[e.kind] ?? [])]);
    for (const f of [...new Set([...Object.keys(e), ...Object.keys(a)])].sort()) {
      if (ignore.has(f)) continue;
      if (JSON.stringify(a[f]) !== JSON.stringify(e[f]))
        out.fieldDiffs.push(
          `${k}.${f}: expected ${JSON.stringify(e[f])}, got ${JSON.stringify(a[f])}`,
        );
    }
    const ea = new Set(((a.evidence as Record<string, unknown>[]) ?? []).map(evKey));
    const ee = new Set(((e.evidence as Record<string, unknown>[]) ?? []).map(evKey));
    const lacking = [...ee].filter((x) => !ea.has(x));
    const surplus = [...ea].filter((x) => !ee.has(x));
    if (lacking.length + surplus.length > 0)
      out.evidenceDiffs.push(`${k}: missing [${lacking.join(", ")}] extra [${surplus.join(", ")}]`);
  }
  for (const k of act.keys()) if (!exp.has(k)) out.extra.push(k);
  return out;
}
