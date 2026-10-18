import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse } from "yaml";
import {
  RECORD_KINDS,
  SCHEMA_VERSION,
  catalogDirOf,
  parseRecord,
  recordPath,
  recordReferences,
  serializeRecord,
  type CatalogRecord,
} from "@maycombhq/core";
import { Results, type ConformanceReport } from "./report.js";

const isDir = async (p: string) => (await stat(p).catch(() => undefined))?.isDirectory() ?? false;

async function yamlFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string) {
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (/\.ya?ml$/.test(e.name)) out.push(full);
    }
  }
  await walk(dir);
  return out;
}

/** The catalog folder: the target itself when it holds generated/ or curated/, else the metarepo's. */
export async function catalogFolder(target: string): Promise<string> {
  if ((await isDir(join(target, "generated"))) || (await isDir(join(target, "curated"))))
    return target;
  return catalogDirOf(target);
}

/**
 * Conformance of a catalog folder to C1 (ADR 0003, 0005, 0031, 0040): every file is a valid
 * record at the current schema version, in canonical form, at `<generated|curated>/<kind>/<id>.yaml`;
 * ids are unique per kind; generated records carry evidence; curated/ holds only curated
 * decisions; and references that point at nothing are reported (warnings: a catalog may
 * legitimately refer to a record another team's catalog holds).
 */
export async function checkCatalog(target: string): Promise<ConformanceReport> {
  const res = new Results();
  const dir = await catalogFolder(target);
  const hasGenerated = await isDir(join(dir, "generated"));
  const hasCurated = await isDir(join(dir, "curated"));
  if (!hasGenerated && !hasCurated) {
    res.fail("catalog.layout", `No generated/ or curated/ folder in ${dir}.`);
    return res.report("catalog", target);
  }
  res.pass("catalog.layout", "The catalog has generated/ and curated/ folders where present.");

  const records: { rec: CatalogRecord; file: string }[] = [];
  for (const full of await yamlFiles(dir)) {
    const file = relative(dir, full).split(sep).join("/");
    const folder = file.split("/")[0];
    if (folder !== "generated" && folder !== "curated") continue;
    const text = await readFile(full, "utf8");
    let data: unknown;
    try {
      data = parse(text);
    } catch (e) {
      res.fail("catalog.yaml", `Not valid YAML: ${(e as Error).message.split("\n")[0]}`, file);
      continue;
    }
    const kind = (data as { kind?: unknown } | null)?.kind;
    if (typeof kind !== "string" || !(RECORD_KINDS as string[]).includes(kind)) {
      res.warn("catalog.kind", "Not a catalog record (no known kind); ignored.", file);
      continue;
    }
    const p = parseRecord(data);
    if (!p.ok) {
      res.fail(
        "catalog.schema",
        `Doesn't match C1: ${p.issues.map((i) => `${i.path || "(record)"}: ${i.message}`).join("; ")}`,
        file,
      );
      continue;
    }
    const rec = p.record;
    if ((data as { schemaVersion?: unknown }).schemaVersion !== SCHEMA_VERSION)
      res.fail(
        "catalog.version",
        `Written at schema version ${String((data as { schemaVersion?: unknown }).schemaVersion)}; the current version is ${SCHEMA_VERSION} (run atticus catalog migrate).`,
        file,
      );
    else if (serializeRecord(rec) !== text)
      res.fail(
        "catalog.canonical",
        "Not in canonical form (key order, defaults or quoting).",
        file,
      );
    const want = `${folder}/${recordPath(rec)}`;
    if (file !== want) res.fail("catalog.path", `Should be at ${want}.`, file);
    if (folder === "curated" && rec.kind !== "CuratedDecision")
      res.fail("catalog.folder", "Only curated decisions belong in curated/.", file);
    if (folder === "generated" && rec.kind === "CuratedDecision")
      res.fail("catalog.folder", "A curated decision belongs in curated/.", file);
    if (rec.kind !== "CuratedDecision" && rec.evidence.length === 0)
      res.fail(
        "catalog.evidence",
        "A generated record needs at least one piece of evidence.",
        file,
      );
    for (const e of rec.evidence)
      if (!e.path && !e.by)
        res.warn(
          "catalog.evidence",
          `Evidence from ${e.source} names no file and no person.`,
          file,
        );
    records.push({ rec, file });
  }
  for (const c of ["catalog.version", "catalog.canonical", "catalog.path", "catalog.folder"])
    res.passUnlessFailed(c, CHECK_PASS[c]!);

  const seen = new Map<string, string>();
  for (const { rec, file } of records) {
    const key = `${rec.kind}|${rec.id}`;
    const first = seen.get(key);
    if (first) res.fail("catalog.unique-id", `Same ${rec.kind} id as ${first}.`, file);
    else seen.set(key, file);
  }
  res.passUnlessFailed("catalog.unique-id", "Every id is unique within its kind.");

  const ids = new Set(records.map((r) => r.rec.id));
  for (const { rec, file } of records) {
    const refs =
      rec.kind === "CuratedDecision"
        ? [{ field: "target", id: rec.target }]
        : recordReferences(rec);
    for (const r of refs)
      if (!ids.has(r.id))
        res.warn(
          "catalog.references",
          `${r.field} points at ${r.id}, which isn't in this catalog.`,
          file,
        );
  }
  if (!res.list.some((r) => r.check === "catalog.references"))
    res.pass("catalog.references", "Every reference resolves to a record in the catalog.");
  res.passUnlessFailed("catalog.evidence", "Every generated record carries evidence.");
  res.pass("catalog.count", `${records.length} record${records.length === 1 ? "" : "s"} read.`);
  return res.report("catalog", target);
}

const CHECK_PASS: Record<string, string> = {
  "catalog.version": "Every record is written at the current schema version.",
  "catalog.canonical": "Every record file is in canonical form.",
  "catalog.path": "Every file is at <folder>/<kind>/<id>.yaml.",
  "catalog.folder": "Generated records and curated decisions are in their own folders.",
};
