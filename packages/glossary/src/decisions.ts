import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  parseRecord,
  recordPath,
  serializeRecord,
  type CatalogRecord,
  type RecordOf,
} from "@maycombhq/core";
import { displayTerm, termId, termKey } from "./words.js";

/**
 * People curate the glossary through curated decisions in `catalog/curated/`, replayed on
 * every scan like any other (ADR 0026), so their answers survive rescans and are reviewed in
 * Git. A person runs the command that writes the decision, which is the approval it needs.
 *
 * - define: an assert on the term (`term`, `definition`, optional `owner`); the term becomes
 *   `asserted`, and a term no page or code has is created from it.
 * - link a column: an assert of `glossaryTerm` on the column (contract C1's own field).
 * - link anything else (a schema field `<schema>#<field>`, a feature, another record): an
 *   assert of the term's whole `fields` list, so the later decision wins.
 * - alias: another name for the term (a synonym); the glossary matches code names and page
 *   terms through it.
 */

export type GlossaryDecision = RecordOf<"CuratedDecision">;

export class GlossaryError extends Error {
  constructor(
    readonly code: "invalid" | "not-found",
    message: string,
  ) {
    super(message);
    this.name = "GlossaryError";
  }
}

export interface DecisionOptions {
  by: string;
  at?: string;
  reason?: string;
}

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

function decisionId(prefix: string, key: string): string {
  const id = `${prefix}.${key}`;
  if (id.length <= 120) return id;
  return `${id.slice(0, 110)}-${createHash("sha256").update(id).digest("hex").slice(0, 8)}`;
}

function decision(
  id: string,
  target: string,
  action: GlossaryDecision["action"],
  value: unknown,
  reason: string,
  o: DecisionOptions,
): GlossaryDecision {
  if (!o.by.trim()) throw new GlossaryError("invalid", "Say who decides (--by <handle>).");
  const p = parseRecord({
    schemaVersion: 2,
    kind: "CuratedDecision",
    id,
    status: "current",
    confidence: "asserted",
    evidence: [{ source: "manual", by: o.by }],
    target,
    action,
    value,
    reason: o.reason?.trim() || reason,
    by: o.by,
    at: o.at ?? now(),
  });
  if (!p.ok)
    throw new GlossaryError(
      "invalid",
      `That decision isn't valid: ${p.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
    );
  return p.record as GlossaryDecision;
}

/** The id a term name or id stands for: `term.<slug>`. */
export function resolveTermId(termOrId: string): string {
  const t = termOrId.trim();
  if (/^term\.[a-z0-9][a-z0-9._-]*$/.test(t)) return t;
  const id = termId(t);
  if (id === "term.") throw new GlossaryError("invalid", `"${termOrId}" is not a term.`);
  return id;
}

export function defineDecision(
  term: string,
  definition: string,
  o: DecisionOptions & { owner?: string; existing?: { term: string } },
): GlossaryDecision {
  const def = definition.trim().replace(/\s+/g, " ");
  if (def.length < 3) throw new GlossaryError("invalid", "A definition needs a sentence.");
  const id = resolveTermId(term);
  const name = o.existing?.term ?? (term.startsWith("term.") ? undefined : displayTerm(term));
  return decision(
    decisionId("glossary.define", id.slice("term.".length)),
    id,
    "assert",
    { ...(name ? { term: name } : {}), definition: def, ...(o.owner ? { owner: o.owner } : {}) },
    `Glossary definition of ${name ?? id}`,
    o,
  );
}

export function aliasDecision(
  term: string,
  aliases: readonly string[],
  o: DecisionOptions,
): GlossaryDecision {
  const id = resolveTermId(term);
  const byKey = new Map<string, string>();
  for (const a of aliases.map((x) => x.trim().replace(/\s+/g, " ")).filter(Boolean))
    if (!byKey.has(termKey(a))) byKey.set(termKey(a), a);
  const names = [...byKey.values()].sort();
  if (!names.length) throw new GlossaryError("invalid", "Give at least one other name.");
  return decision(
    decisionId("glossary.alias", id.slice("term.".length)),
    id,
    "alias",
    names,
    `Other names for ${id}`,
    o,
  );
}

/**
 * Link a term to a record. A column gets `glossaryTerm`; anything else joins the term's
 * `fields` (the full list, including what the term already lists).
 */
export function linkDecision(
  term: RecordOf<"GlossaryTerm">,
  recordId: string,
  records: readonly CatalogRecord[],
  o: DecisionOptions,
): GlossaryDecision {
  const byId = new Map(records.map((r) => [r.id, r]));
  const [base, field] = recordId.split("#");
  const target = byId.get(base!);
  if (!target) throw new GlossaryError("not-found", `There is no record ${base} in the catalog.`);
  if (field !== undefined) {
    if (target.kind !== "Schema" || !target.fields.some((f) => f.name === field))
      throw new GlossaryError("not-found", `${base} has no schema field ${field}.`);
  } else if (target.kind === "Column") {
    return decision(
      decisionId("glossary.link", target.id),
      target.id,
      "assert",
      { glossaryTerm: term.id },
      `${target.id} holds the glossary term ${term.term}`,
      o,
    );
  }
  const fields = [...new Set([...term.fields, recordId])].sort();
  return decision(
    decisionId("glossary.fields", term.id.slice("term.".length)),
    term.id,
    "assert",
    { fields },
    `What the glossary term ${term.term} is linked to`,
    o,
  );
}

/** Write decisions to the curated folder; returns paths relative to it. */
export async function writeDecisions(
  curatedDir: string,
  decisions: readonly GlossaryDecision[],
): Promise<string[]> {
  const out: string[] = [];
  for (const d of decisions) {
    const rel = recordPath(d);
    const full = join(curatedDir, ...rel.split("/"));
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, serializeRecord(d), "utf8");
    out.push(rel);
  }
  return out;
}
