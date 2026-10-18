import { z } from "zod";
import { interfaceId } from "./identity.js";
import { RECORD_SCHEMAS, type RecordKind } from "./schema/kinds.js";

const schemas = Object.values(RECORD_SCHEMAS) as unknown as [
  (typeof RECORD_SCHEMAS)[RecordKind],
  ...(typeof RECORD_SCHEMAS)[RecordKind][],
];

/** Any catalog record, discriminated by `kind`. */
export const CatalogRecord = z.discriminatedUnion("kind", schemas);
export type CatalogRecord = z.infer<typeof CatalogRecord>;
export type RecordOf<K extends RecordKind> = Extract<CatalogRecord, { kind: K }>;

export interface RecordIssue {
  path: string;
  message: string;
}

export type ParseResult =
  { ok: true; record: CatalogRecord } | { ok: false; issues: RecordIssue[] };

/** Rules that span fields and can't be expressed in the per-kind schema. */
function crossFieldIssues(record: CatalogRecord): RecordIssue[] {
  const issues: RecordIssue[] = [];
  if (record.kind === "Interface") {
    const expected = interfaceId(record.from, record.to, record.method, record.normalizedPath);
    if (record.id !== expected) {
      issues.push({
        path: "id",
        message: `Interface id must be ${expected} (hash of from, to, method and normalizedPath)`,
      });
    }
  }
  if (record.kind === "Deployment" && record.autoscaling) {
    if (record.autoscaling.min > record.autoscaling.max) {
      issues.push({
        path: "autoscaling",
        message: "autoscaling.min is greater than autoscaling.max",
      });
    }
  }
  if (record.confidence === "asserted" && record.kind !== "CuratedDecision") {
    const hasPerson = record.evidence.some((e) => e.source === "manual");
    if (!hasPerson) {
      issues.push({
        path: "evidence",
        message: "asserted records need manual evidence saying who stated them",
      });
    }
  }
  return issues;
}

/** Validate unknown input as a catalog record. Never throws. */
export function parseRecord(input: unknown): ParseResult {
  const result = CatalogRecord.safeParse(input);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    };
  }
  const extra = crossFieldIssues(result.data);
  if (extra.length > 0) return { ok: false, issues: extra };
  return { ok: true, record: result.data };
}

/** Folder (under catalog/generated or catalog/curated) and file name for a record. */
export function recordPath(record: Pick<CatalogRecord, "kind" | "id">): string {
  return `${record.kind.toLowerCase()}/${record.id}.yaml`;
}
