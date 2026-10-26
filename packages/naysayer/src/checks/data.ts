import { z } from "zod";
import { PERSONAL_DATA_SPEC, personalItem, type JudgeItem } from "@maycombhq/ai";
import { docOf, readDataChanges } from "../artifacts.js";
import type { CriticContext } from "../context.js";
import {
  contentLines,
  headingAt,
  isFilledDoc,
  sectionLines,
  sectionMatching,
  type Doc,
} from "../doc.js";
import {
  escapeRe,
  hasWord,
  lineEvidence,
  questionOwner,
  recordEvidence,
  sentence,
  type DeterministicCheckDef,
  type Evidence,
  type Hit,
} from "../hits.js";

const DATA = "data.md";

function rowLocator(doc: Doc, line: number, field?: string) {
  const heading = headingAt(doc, line);
  return { line, ...(heading ? { heading } : {}), ...(field ? { field } : {}) };
}

/** Data stores the change touches: its footprint, plus migrations and table.column names in design.md and tasks.md. */
function touchedStores(ctx: CriticContext): { stores: string[]; evidence: Evidence[] } {
  const stores = new Set(ctx.footprint.dataStores);
  for (const t of ctx.footprint.tables) {
    const rec = ctx.get("Table", t);
    if (rec) stores.add(rec.dataStore);
  }
  const evidence: Evidence[] = [];
  const tables = ctx.records.filter((r) => r.kind === "Table");
  for (const rel of ["design.md", "tasks.md"]) {
    const doc = docOf(ctx.files, rel);
    if (!doc) continue;
    for (const l of contentLines(doc)) {
      const migration = /\bV\d+__\w+\.sql\b/.test(l.text);
      const table = tables.find((t) =>
        new RegExp(`\\b${escapeRe(t.name)}\\.[a-z_]+`, "i").test(l.text),
      );
      if (!migration && !table) continue;
      if (table) stores.add(table.dataStore);
      else for (const s of ctx.footprint.dataStores) stores.add(s);
      if (evidence.length < 2) evidence.push(lineEvidence(doc, l.n));
    }
  }
  return { stores: [...stores].sort(), evidence };
}

/**
 * Whether the change's footprint was read from the stages' own files (ADR 0124 addendum
 * B-change): a target flow is where a schema change is declared on that path.
 */
const onStagePath = (ctx: CriticContext) =>
  ctx.footprint.from.some((f) => f.startsWith("target-flows/"));

/** Whether its target flows change the schema: a new table, a migration, or a column with a type. */
const changesSchema = (ctx: CriticContext) =>
  ctx.footprint.signals.some((s) => s.factor === "schema");

export const dataDocPresent: DeterministicCheckDef = {
  id: "data-doc-present",
  question: "complete",
  description:
    "When the change's target flows change a data store's schema, data.md exists and is filled in.",
  params: z.strictObject({}),
  run(ctx) {
    const { stores, evidence } = touchedStores(ctx);
    if (stores.length === 0) return { hits: [], subjects: [] };
    // ADR 0006 addendum (2026-10-26): on the stage path the architecture stage writes data.md
    // from the target flows, and only when a step changes the schema. A change that reads or
    // writes columns the catalog already has never gets one, so it is never asked for one: the
    // design's own Data changes section is the artifact. Nothing is weakened — a schema change
    // still blocks, and a change off the stage path (a person's own data.md) is asked as before.
    if (onStagePath(ctx) && !changesSchema(ctx)) return { hits: [], subjects: stores };
    const doc = docOf(ctx.files, DATA);
    if (doc && isFilledDoc(doc)) return { hits: [], subjects: stores };
    const hit: Hit = {
      kind: "issue",
      artifact: DATA,
      locator: { record: stores[0]! },
      summary: sentence(
        `The change touches ${stores.join(", ")} but data.md is ${doc ? "still the template" : "missing"}.`,
      ),
      why: "Every data change is described against the current database design: tables, columns, migrations, classification and retention.",
      // The stage writes data.md from the target flows, so on that path the fix is to run it,
      // not to write the document by hand (ADR 0006 addendum 2026-10-26).
      fix: {
        text: onStagePath(ctx)
          ? `Run atticus change architecture ${ctx.change.id}: it writes data.md from the target flows (the Changes table, backfill, classification and retention). Edit the flows, never data.md.`
          : "Write data.md: the Changes table, backfill, classification and retention, and other readers and writers.",
      },
      evidence: [...stores.filter((s) => ctx.byId.has(s)).map(recordEvidence), ...evidence],
      key: "data-doc",
    };
    if (hit.evidence.length === 0) hit.evidence.push({ source: "artifact", path: "change.yaml" });
    return { hits: [hit], subjects: stores };
  },
};

const NO_MIGRATION = /^(|-|—|none|n\/a|tbd|todo)$/i;

export const dataMigrationNamed: DeterministicCheckDef = {
  id: "data-migration-named",
  question: "ship",
  description: "Every row in data.md's Changes table names the migration that makes it.",
  params: z.strictObject({}),
  run(ctx) {
    const doc = docOf(ctx.files, DATA);
    if (!doc) return { hits: [], subjects: [] };
    const hits: Hit[] = [];
    for (const r of readDataChanges(ctx.files)) {
      if (!NO_MIGRATION.test(r.migration.trim())) continue;
      if (/^no (data )?change/i.test(r.change.trim())) continue;
      hits.push({
        kind: "issue",
        artifact: DATA,
        locator: rowLocator(doc, r.line, "migration"),
        summary: sentence(`The change to ${r.store}.${r.table} names no migration.`),
        why: "A schema change without a migration is applied by hand or not at all, and can't be reviewed or rolled back.",
        fix: {
          text: `Name the migration file (for example V<n>__${r.newTable ? "create" : "alter"}_${r.table}.sql) in the Migration column.`,
        },
        evidence: [lineEvidence(doc, r.line)],
        key: `migration|${r.line}`,
      });
    }
    return { hits, subjects: [] };
  },
};

/**
 * The personal-data items of a change's new columns (ADR 0117 addendum): one per column, with
 * whether data.md already classifies it as personal by name (a fact that settles it). Judged
 * before the checks run, so the check reads the verdicts.
 */
export function personalItems(ctx: CriticContext): JudgeItem[] {
  const doc = docOf(ctx.files, DATA);
  if (!doc) return [];
  const section = sectionMatching(doc, /classif/i);
  const lines = section ? sectionLines(doc, section) : [];
  const personalLine = (c: string) =>
    lines.some((l) => hasWord(l.text, c) && ctx.personalClasses.some((p) => hasWord(l.text, p)));
  return readDataChanges(ctx.files).flatMap((r) =>
    r.newColumns.map((c) =>
      personalItem({
        column: c.name,
        table: r.table,
        type: c.type,
        classifiedPersonal: personalLine(c.name),
      }),
    ),
  );
}

export const dataColumnsClassified: DeterministicCheckDef = {
  id: "data-columns-classified",
  question: "safe",
  description:
    "Every new column has a classification in data.md; columns judged to hold personal data are classified as personal by name, and a person is asked of those no one has judged.",
  params: z.strictObject({ personalHints: z.array(z.string()).optional() }),
  run(ctx, p) {
    const doc = docOf(ctx.files, DATA);
    if (!doc) return { hits: [], subjects: [] };
    const section = sectionMatching(doc, /classif/i);
    const lines = section ? sectionLines(doc, section) : [];
    const terms = [...new Set([...ctx.classifications, ...ctx.personalClasses])];
    const hasTerm = (t: string, set = terms) => set.some((c) => hasWord(t, c));
    const hits: Hit[] = [];
    for (const r of readDataChanges(ctx.files)) {
      if (r.newColumns.length === 0) continue;
      const names = r.newColumns.map((c) => c.name);
      const tableLines = lines.filter(
        (l) =>
          hasWord(l.text, r.table) && hasTerm(l.text) && !names.some((n) => hasWord(l.text, n)),
      );
      const colLines = (c: string) => lines.filter((l) => hasWord(l.text, c) && hasTerm(l.text));
      // Personal data is a judgment (ADR 0117 addendum); an org's own hints are its rule, a
      // fact it declared: a column whose name has one of them is personal.
      const hints = ((p.personalHints as string[] | undefined) ?? []).map((h) => h.toLowerCase());
      const byHint = (c: string) =>
        c
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .some((x) => hints.includes(x));
      const typeOf = (c: string) => r.newColumns.find((x) => x.name === c)?.type;
      const verdict = (c: string) =>
        byHint(c)
          ? "yes"
          : ctx.judged(
              PERSONAL_DATA_SPEC.kind,
              personalItem({ column: c, table: r.table, type: typeOf(c) }).inputs,
            );
      const classifiedPersonal = (c: string) =>
        colLines(c).some((l) => hasTerm(l.text, ctx.personalClasses));
      const personal = names.filter((c) => !classifiedPersonal(c) && verdict(c) === "yes");
      const unjudged = names.filter((c) => {
        const v = verdict(c);
        return !classifiedPersonal(c) && (v === undefined || v === "unsure");
      });
      const unclassified = names.filter(
        (c) => !personal.includes(c) && colLines(c).length === 0 && tableLines.length === 0,
      );
      const ev = [
        lineEvidence(doc, r.line),
        ...tableLines.slice(0, 1).map((l) => lineEvidence(doc, l.n)),
      ];
      if (personal.length)
        hits.push({
          kind: "issue",
          artifact: DATA,
          locator: rowLocator(doc, r.line, "classification"),
          summary: sentence(
            `${personal.join(", ")} in ${r.table} ${personal.length > 1 ? "look" : "looks"} like personal data but ${personal.length > 1 ? "are" : "is"} not classified as personal.`,
          ),
          why: `Personal data needs its own classification (${ctx.personalClasses.join(", ")}) so the privacy approval, masking and retention rules apply; a table-wide "internal" doesn't cover it.`,
          fix: {
            text: `Classify ${personal.join(", ")} by name under "Backfill, classification and retention" (for example: "${personal[0]} is personal"), or don't store it.`,
          },
          evidence: ev,
          key: `classify-personal|${r.line}`,
        });
      if (unjudged.length)
        hits.push({
          kind: "knowledge-gap",
          artifact: DATA,
          locator: rowLocator(doc, r.line, "classification"),
          summary: sentence(
            `No one has judged whether ${unjudged.join(", ")} in ${r.table} ${unjudged.length > 1 ? "hold" : "holds"} personal data.`,
          ),
          why: `Personal data needs its own classification (${ctx.personalClasses.join(", ")}). Whether a column holds it is a judgment about meaning; no model was asked (or it couldn't tell), so a person decides rather than a word list.`,
          fix: {
            text: `Classify each of ${unjudged.join(", ")} that holds personal data by name under "Backfill, classification and retention".`,
          },
          evidence: ev,
          question: {
            text: `Which of ${unjudged.join(", ")} in ${r.table} hold personal data?`,
            owner: questionOwner(ctx, r.tableId),
          },
          subject: r.tableId,
          key: `classify-personal-unjudged|${r.line}`,
        });
      if (unclassified.length)
        hits.push({
          kind: "issue",
          artifact: DATA,
          locator: rowLocator(doc, r.line, "classification"),
          summary: sentence(
            `New columns of ${r.table} have no classification: ${unclassified.join(", ")}.`,
          ),
          why: `Every new field is classified (${ctx.classifications.join(", ")}) so access and retention follow from it.`,
          fix: { text: `Classify each new column under "Backfill, classification and retention".` },
          evidence: ev,
          key: `classify|${r.line}`,
        });
    }
    return { hits, subjects: [] };
  },
};

const RETENTION =
  /\b(retain|retained|retention|kept for|keep .* for|deleted? after|purged?|archived? after)\b/i;

export const dataRetentionStated: DeterministicCheckDef = {
  id: "data-retention-stated",
  question: "safe",
  description: "Every new table says how long its rows are kept.",
  params: z.strictObject({}),
  run(ctx) {
    const doc = docOf(ctx.files, DATA);
    if (!doc) return { hits: [], subjects: [] };
    const section = sectionMatching(doc, /retention/i);
    const lines = section ? sectionLines(doc, section) : [];
    const hits: Hit[] = [];
    const subjects = new Set<string>();
    for (const r of readDataChanges(ctx.files)) {
      if (ctx.get("Table", r.tableId)) subjects.add(r.tableId);
      if (!r.newTable) continue;
      if (lines.some((l) => hasWord(l.text, r.table) && RETENTION.test(l.text))) continue;
      hits.push({
        kind: "issue",
        artifact: DATA,
        locator: rowLocator(doc, r.line, "retention"),
        summary: sentence(
          `The new table ${r.store}.${r.table} doesn't say how long its rows are kept.`,
        ),
        why: "Without a retention period rows are kept forever, which breaks the data-retention obligations and grows the table without bound.",
        fix: {
          text: `Say under "Backfill, classification and retention" how long ${r.table} rows are kept and how they are deleted.`,
        },
        evidence: [
          lineEvidence(doc, r.line),
          ...(section ? [lineEvidence(doc, section.line)] : []),
        ],
        key: `retention|${r.line}`,
      });
    }
    return { hits, subjects: [...subjects].sort() };
  },
};
