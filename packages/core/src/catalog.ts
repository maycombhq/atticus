import { z } from "zod";
import { interfaceId } from "./identity.js";
import { NEVER_CHECKED_STEPS, RECORD_SCHEMAS, type RecordKind } from "./schema/kinds.js";

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
  if (record.kind === "Flow") issues.push(...flowIssues(record));
  if (
    record.confidence === "asserted" &&
    record.kind !== "CuratedDecision" &&
    record.kind !== "Flow"
  ) {
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

/**
 * A Flow's rules across fields (ADR 0079): its id starts with its component; `to` is for a
 * call-out or publish and `store` for a read, lookup or write; the citation check can't
 * confirm a transform, branch or validation; a family doesn't list the flow's own trigger.
 */
function flowIssues(f: RecordOf<"Flow">): RecordIssue[] {
  const issues: RecordIssue[] = [];
  if (!f.id.startsWith(`${f.component}.`) || f.id.length <= f.component.length + 1)
    issues.push({
      path: "id",
      message: `a Flow's id is <component>.<flow>: ${f.component}.<flow>`,
    });
  f.steps.forEach((s, i) => {
    if (s.to && s.kind !== "call-out" && s.kind !== "publish")
      issues.push({
        path: `steps.${i}.to`,
        message: "only a call-out or publish goes to a target",
      });
    if ((s.kind === "call-out" || s.kind === "publish") && !s.to)
      issues.push({ path: `steps.${i}.to`, message: `a ${s.kind} names where it goes` });
    if (s.store && s.kind !== "read" && s.kind !== "lookup" && s.kind !== "write")
      issues.push({
        path: `steps.${i}.store`,
        message: "only a read, lookup or write touches a store",
      });
    // ADR 0095: a loop or retry says which steps it repeats, by their numbers in the flow.
    if (s.repeats && s.kind !== "loop" && s.kind !== "retry")
      issues.push({
        path: `steps.${i}.repeats`,
        message: "only a loop or retry repeats steps",
      });
    else if (s.repeats && (s.repeats.from > s.repeats.to || s.repeats.to > f.steps.length))
      issues.push({
        path: `steps.${i}.repeats`,
        message: `repeats names steps from 1 to ${f.steps.length}, the first no later than the last`,
      });
    if (s.confirmedBy === "check" && (NEVER_CHECKED_STEPS as readonly string[]).includes(s.kind))
      issues.push({
        path: `steps.${i}.confirmedBy`,
        message: `the citation check can't confirm a ${s.kind}, only that its lines exist`,
      });
  });
  f.errors.forEach((e, i) => {
    if (e.confirmedBy === "check")
      issues.push({
        path: `errors.${i}.confirmedBy`,
        message: "the citation check can't confirm an error path, only that its lines exist",
      });
  });
  if (f.trigger.ref && f.family.includes(f.trigger.ref))
    issues.push({
      path: "family",
      message: "the family lists the other triggers, not the flow's own",
    });
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
