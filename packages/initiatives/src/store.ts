import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import {
  catalogDirOf,
  IsoDate,
  IsoDateTime,
  parseRecord,
  RecordId,
  recordPath,
  serializeRecord,
  stateDirOf,
  toCanonicalYaml,
  type CatalogRecord,
  type RecordOf,
} from "@maycombhq/core";
import { readCatalog } from "@maycombhq/scanner";

/**
 * Where an initiative lives.
 *
 * Initiative, Party and Commitment are C1 record kinds, and they are people's decisions, not
 * facts a scan finds: so they are curated records, one file per record at
 * `<catalog>/curated/<kind>/<id>.yaml` (ADR 0003, ADR 0026). Scans never write there, the
 * index reads them with the rest of the catalog, and they change by PR like any curated
 * decision. Each is `asserted` with manual evidence naming who made it.
 *
 * What is not a record (the journey's plan with its dates, the system cards sent to other
 * teams) is kept beside the change folders in `initiatives/<id>/` (in `.atticus/initiatives/`
 * in a repo adopted in place), so it is reviewed and versioned with the initiative.
 */

export type InitiativeRecord = RecordOf<"Initiative">;
export type CommitmentRecord = RecordOf<"Commitment">;
export type PartyRecord = RecordOf<"Party">;

export const curatedDirOf = (root: string) => join(catalogDirOf(root), "curated");
export const initiativesDirOf = (root: string) => join(stateDirOf(root), "initiatives");
export const initiativeDir = (root: string, id: string) => join(initiativesDirOf(root), id);
export const planPath = (root: string, id: string) => join(initiativeDir(root, id), "plan.yaml");

export class InitiativeError extends Error {
  constructor(
    message: string,
    readonly code: "not-found" | "invalid" | "exists" | "usage" = "invalid",
  ) {
    super(message);
    this.name = "InitiativeError";
  }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  try {
    await writeFile(tmp, text, "utf8");
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** Write a curated record in canonical form. Throws when it breaks C1. */
export async function writeCurated(root: string, record: CatalogRecord): Promise<string> {
  const p = parseRecord(record);
  if (!p.ok)
    throw new InitiativeError(
      `${record.kind} ${record.id}: ${p.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
    );
  const rel = recordPath(p.record);
  await writeAtomic(join(curatedDirOf(root), rel), serializeRecord(p.record));
  return `catalog/curated/${rel}`;
}

export interface CatalogView {
  records: CatalogRecord[];
  problems: string[];
  get<K extends CatalogRecord["kind"]>(kind: K, id: string): RecordOf<K> | undefined;
  all<K extends CatalogRecord["kind"]>(kind: K): RecordOf<K>[];
}

/** The catalog as files: generated records, then curated ones (initiatives, parties, questions). */
export async function readView(root: string): Promise<CatalogView> {
  const dir = catalogDirOf(root);
  const gen = await readCatalog(join(dir, "generated"));
  const cur = await readCatalog(join(dir, "curated"));
  const records = [...gen.records, ...cur.records];
  const problems = [
    ...gen.problems.map((p) => `catalog/generated/${p.file}: ${p.message}`),
    ...cur.problems.map((p) => `catalog/curated/${p.file}: ${p.message}`),
  ];
  const key = (k: string, id: string) => `${k}|${id}`;
  const byKey = new Map(records.map((r) => [key(r.kind, r.id), r]));
  return {
    records,
    problems,
    get: (kind, id) => byKey.get(key(kind, id)) as never,
    all: (kind) => records.filter((r) => r.kind === kind) as never,
  };
}

/** Manual evidence for a record a person made. */
export const manualEvidence = (by: string) => [
  { source: "manual" as const, by: by.replace(/^@/, "") },
];

// ------------------------------------------------------------------ the plan file

export const PlanItem = z.strictObject({
  /** The step id, or `<step>.<system>` for a step done once per system. */
  key: z.string().min(1),
  step: RecordId,
  phase: RecordId,
  kind: z.enum(["change", "commitment", "request", "task"]),
  what: z.string().min(1),
  /** The system the item is for, when the step is done per system. */
  system: RecordId.optional(),
  party: RecordId.optional(),
  commitment: RecordId.optional(),
  change: RecordId.optional(),
  milestone: z.enum(["design", "build", "release-ready", "released"]).optional(),
  template: RecordId.optional(),
  owner: z.string().optional(),
  days: z.number().int().min(0),
  /** Where the number of days came from, cited. */
  leadTime: z.string().min(1),
  after: z.array(z.string()).default([]),
  start: IsoDate,
  due: IsoDate,
});
export type PlanItem = z.infer<typeof PlanItem>;

export const PlanFile = z.strictObject({
  schemaVersion: z.literal(1),
  initiative: RecordId,
  journey: z.string().min(1),
  /** Where the journey template came from: built-in or an org-pack file. */
  journeySource: z.string().min(1),
  target: RecordId,
  targetRelease: IsoDate,
  createdAt: IsoDateTime,
  by: z.string().min(1),
  items: z.array(PlanItem),
  /** Tasks a person recorded as done: key → who and when. */
  done: z
    .record(z.string(), z.strictObject({ at: IsoDateTime, by: z.string().min(1) }))
    .default({}),
  /** Items a person recorded as started (a request sent, a team asked): key → day. */
  started: z.record(z.string(), IsoDate).default({}),
  notes: z.array(z.string()).default([]),
});
export type PlanFile = z.infer<typeof PlanFile>;

const PLAN_LEADING = [
  "schemaVersion",
  "initiative",
  "journey",
  "journeySource",
  "target",
  "targetRelease",
  "createdAt",
  "by",
  "key",
  "step",
  "phase",
  "kind",
  "what",
  "system",
  "party",
  "commitment",
  "change",
  "milestone",
  "template",
  "owner",
  "days",
  "leadTime",
  "after",
  "start",
  "due",
];

export async function writePlan(root: string, plan: PlanFile): Promise<string> {
  const p = PlanFile.parse(plan);
  await writeAtomic(planPath(root, p.initiative), toCanonicalYaml(p, PLAN_LEADING));
  return `initiatives/${p.initiative}/plan.yaml`;
}

export async function readPlan(root: string, id: string): Promise<PlanFile | undefined> {
  let text: string;
  try {
    text = await readFile(planPath(root, id), "utf8");
  } catch {
    return undefined;
  }
  const r = PlanFile.safeParse(parse(text));
  if (!r.success)
    throw new InitiativeError(
      `initiatives/${id}/plan.yaml: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    );
  return r.data;
}

export const slugOf = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
