import { z } from "zod";
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

export const dataDocPresent: DeterministicCheckDef = {
  id: "data-doc-present",
  description: "When the change touches a data store, data.md exists and is filled in.",
  params: z.strictObject({}),
  run(ctx) {
    const { stores, evidence } = touchedStores(ctx);
    if (stores.length === 0) return { hits: [], subjects: [] };
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
      fix: {
        text: "Write data.md: the Changes table, backfill, classification and retention, and other readers and writers.",
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

const PERSONAL_PARTS = [
  "email",
  "mail",
  "phone",
  "mobile",
  "name",
  "firstname",
  "lastname",
  "surname",
  "address",
  "street",
  "postcode",
  "zip",
  "birth",
  "dob",
  "ssn",
  "passport",
  "national",
  "iban",
  "ip",
];

/** Column names that look like personal data, by their parts (changed_by_email → email). */
export function looksPersonal(column: string, hints: string[] = PERSONAL_PARTS): boolean {
  const parts = column.toLowerCase().split(/[^a-z0-9]+/);
  return parts.some((p) => hints.includes(p));
}

export const dataColumnsClassified: DeterministicCheckDef = {
  id: "data-columns-classified",
  description:
    "Every new column has a classification in data.md; columns that look like personal data are classified as personal by name.",
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
      const personal = names.filter(
        (c) =>
          looksPersonal(c, p.personalHints as string[] | undefined) &&
          !colLines(c).some((l) => hasTerm(l.text, ctx.personalClasses)),
      );
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
