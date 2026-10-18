import { parseRecord, type CatalogRecord, type RecordOf } from "./catalog.js";

/**
 * Curated decisions applied over generated records: the last step of building the catalog.
 *
 * Generated records are rebuilt from code on every scan; a person's decision lives in
 * `catalog/curated/` and is replayed over them each time, so it survives rescans.
 *
 * - alias: changes no record (name resolution reads it).
 * - assert: sets fields from `value` on the target; the record becomes `asserted`, with
 *   manual evidence naming who.
 * - suppress: drops the target. A suppress whose value names a scope (`{ diagram }` or
 *   `{ triage }`) only hides the record from that comparison and changes nothing here.
 * - resolve-conflict: sets the chosen value of each field and clears that `conflicts` entry.
 *   The record keeps its confidence when the choice is what it already said (usually what the
 *   code says); otherwise it becomes `asserted`.
 * - classify: sets `classification` on a Column (value: a name) or on Schema fields
 *   (value: `{ field: name }`).
 *
 * Decisions apply in time order (then id), so a later decision wins. One that can't apply
 * (missing target, wrong value shape, a result that fails C1) is reported and skipped; the
 * catalog never takes a half-applied decision. Pure and deterministic.
 */

export type CuratedDecisionRecord = RecordOf<"CuratedDecision">;

export interface CuratedProblem {
  decision: string;
  target: string;
  message: string;
}

export interface CuratedResult {
  records: CatalogRecord[];
  /** Ids of the decisions that applied (aliases and scoped suppressions included). */
  applied: string[];
  /** Ids of the records a suppress decision dropped. */
  suppressed: string[];
  problems: CuratedProblem[];
}

type Rec = Record<string, unknown> & { kind: string; id: string; evidence: unknown[] };

/** Fields an assert may never set: identity and provenance belong to the catalog. */
const PROTECTED = ["kind", "id", "schemaVersion", "confidence", "evidence"];
/** Scopes a suppress can be limited to. */
const SCOPES = ["diagram", "triage"];

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function applyCurated(
  records: CatalogRecord[],
  decisions: readonly CatalogRecord[],
): CuratedResult {
  const list = (decisions as CatalogRecord[])
    .filter((d): d is CuratedDecisionRecord => d.kind === "CuratedDecision")
    .filter((d) => d.status === "current")
    .sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at < b.at ? -1 : 1));
  const work = records.filter((r) => r.kind !== "CuratedDecision").map((r) => r as unknown as Rec);
  const current = new Map<number, Rec>(work.map((r, i) => [i, r]));
  const dropped = new Set<number>();
  const out: CuratedResult = { records: [], applied: [], suppressed: [], problems: [] };

  for (const d of list) {
    const problem = (message: string) =>
      out.problems.push({ decision: d.id, target: d.target, message });
    const hits = [...current.entries()].filter(([i, r]) => !dropped.has(i) && r.id === d.target);
    const value = d.value;

    if (d.action === "alias") {
      const names = Array.isArray(value) ? value : [value];
      if (names.length === 0 || names.some((n) => typeof n !== "string" || n.length === 0)) {
        problem("an alias needs a name or a list of names");
        continue;
      }
      out.applied.push(d.id);
      continue;
    }
    if (d.action === "suppress" && isObject(value) && SCOPES.some((s) => s in value)) {
      out.applied.push(d.id);
      continue;
    }
    if (hits.length === 0) {
      problem(`${d.target} isn't in the catalog`);
      continue;
    }
    if (hits.length > 1) {
      problem(
        `${d.target} names ${hits.length} records (${hits.map(([, r]) => r.kind).join(", ")})`,
      );
      continue;
    }
    const [index, target] = hits[0]!;
    if (d.action === "suppress") {
      dropped.add(index);
      out.suppressed.push(target.id);
      out.applied.push(d.id);
      continue;
    }

    const manual = { source: "manual", by: d.by };
    const withManual = (r: Rec): Rec => ({
      ...r,
      evidence: [
        ...r.evidence.filter(
          (e) => !(isObject(e) && e.source === "manual" && e.by === d.by && !e.path),
        ),
        manual,
      ],
    });
    let next: Rec | undefined;

    if (d.action === "assert") {
      if (!isObject(value)) {
        problem("an assert needs a value of field names and values");
        continue;
      }
      const bad = Object.keys(value).find((k) => PROTECTED.includes(k));
      if (bad) {
        problem(`an assert can't change ${bad}`);
        continue;
      }
      next = withManual({ ...target, ...structuredClone(value), confidence: "asserted" });
    } else if (d.action === "resolve-conflict") {
      if (!isObject(value) || Object.keys(value).length === 0) {
        problem("resolving a conflict needs a value of field names and chosen values");
        continue;
      }
      const conflicts = (Array.isArray(target.conflicts) ? target.conflicts : []) as {
        field: string;
        values: string[];
      }[];
      let changed = false;
      let failed = false;
      for (const [field, chosen] of Object.entries(value)) {
        const c = conflicts.find((x) => x.field === field);
        if (!c) {
          problem(`${target.id} has no open conflict on ${field}`);
          failed = true;
          break;
        }
        if (!c.values.includes(String(chosen))) {
          problem(
            `${JSON.stringify(chosen)} isn't one of the conflicting values for ${field} (${c.values.join(", ")})`,
          );
          failed = true;
          break;
        }
        if (target[field] !== chosen) changed = true;
      }
      if (failed) continue;
      next = withManual({
        ...target,
        ...structuredClone(value),
        conflicts: conflicts.filter((c) => !(c.field in value)),
        ...(changed ? { confidence: "asserted" } : {}),
      });
    } else if (d.action === "classify") {
      if (target.kind === "Column") {
        if (typeof value !== "string" || value.length === 0) {
          problem("classifying a column needs a classification name");
          continue;
        }
        next = withManual({ ...target, classification: value, confidence: "asserted" });
      } else if (target.kind === "Schema") {
        if (!isObject(value) || Object.values(value).some((v) => typeof v !== "string")) {
          problem("classifying schema fields needs a value of field names and classifications");
          continue;
        }
        const fields = (target.fields ?? []) as { name: string; classification?: string }[];
        const missing = Object.keys(value).find((k) => !fields.some((f) => f.name === k));
        if (missing) {
          problem(`${target.id} has no field ${missing}`);
          continue;
        }
        next = withManual({
          ...target,
          fields: fields.map((f) =>
            f.name in value ? { ...f, classification: value[f.name] as string } : f,
          ),
          confidence: "asserted",
        });
      } else {
        problem(`classify applies to a Column or a Schema, not ${article(target.kind)}`);
        continue;
      }
    }
    if (!next) continue;
    const parsed = parseRecord(next);
    if (!parsed.ok) {
      problem(
        `the result isn't a valid ${target.kind}: ${parsed.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
      );
      continue;
    }
    current.set(index, parsed.record as unknown as Rec);
    out.applied.push(d.id);
  }

  out.records = [...current.entries()]
    .filter(([i]) => !dropped.has(i))
    .map(([, r]) => r as unknown as CatalogRecord);
  return out;
}

const article = (kind: string) => (/^[AEIOU]/.test(kind) ? `an ${kind}` : `a ${kind}`);
