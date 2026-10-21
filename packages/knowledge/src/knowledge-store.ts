import { readdir, readFile, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse, stringify } from "yaml";
import {
  deserializeRecord,
  knowledgeDirOf,
  knowledgeKindOf,
  recordPath,
  serializeRecord,
  writeFileAtomic,
  type KnowledgeKind,
} from "@maycombhq/core";
import {
  isKnowledgeRecord,
  type FailedItem,
  type Injection,
  type KnowledgeConflict,
  type KnowledgeRecord,
  type KnowledgeScanResult,
  type SupersededPage,
} from "./knowledge-scan.js";

/**
 * Where the knowledge scan's results live (ADR 0083): one canonical record file per item at
 * `knowledge/items/<kind>/<id>.yaml` (Pattern, ProcessDefinition, Decision), and
 * `knowledge/scan.yaml` with what the scan flagged: conflicts, superseded pages, quarantined
 * text and the items that failed their checks. Scanning one source replaces only that
 * source's items and flags.
 */

export const KNOWLEDGE_REPORT = "scan.yaml";

export interface KnowledgeReport {
  schemaVersion: 1;
  scannedAt: string;
  snapshots: { source: string; date: string; pages: number }[];
  conflicts: KnowledgeConflict[];
  superseded: SupersededPage[];
  injections: Injection[];
  failed: (FailedItem & { source?: string })[];
}

const toPosix = (p: string) => p.split(sep).join("/");

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string) {
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (/\.ya?ml$/.test(e.name)) out.push(toPosix(relative(dir, full)));
    }
  }
  await walk(dir);
  return out.sort();
}

/** Read the knowledge items and the last scan's report. */
export async function readKnowledge(root: string): Promise<{
  items: KnowledgeRecord[];
  report?: KnowledgeReport;
  problems: { file: string; message: string }[];
}> {
  const dir = join(knowledgeDirOf(root), "items");
  const items: KnowledgeRecord[] = [];
  const problems: { file: string; message: string }[] = [];
  for (const f of await files(dir)) {
    const r = deserializeRecord(await readFile(join(dir, ...f.split("/")), "utf8"));
    if (!r.ok)
      problems.push({
        file: f,
        message: r.issues.map((i) => `${i.path}: ${i.message}`).join("; "),
      });
    else if (isKnowledgeRecord(r.record)) items.push(r.record);
  }
  items.sort((a, b) => a.id.localeCompare(b.id));
  const text = await readFile(join(knowledgeDirOf(root), KNOWLEDGE_REPORT), "utf8").catch(
    () => undefined,
  );
  let report: KnowledgeReport | undefined;
  if (text !== undefined) {
    const data = parse(text) as KnowledgeReport | null;
    if (data && data.schemaVersion === 1) report = data;
    else problems.push({ file: KNOWLEDGE_REPORT, message: "not a knowledge scan report" });
  }
  return { items, ...(report ? { report } : {}), problems };
}

const sourceOf = (r: KnowledgeRecord) => r.quote?.source;

/**
 * Write a scan's items and report. Items and flags of the sources it read are replaced; other
 * sources' are kept.
 */
export async function writeKnowledge(
  root: string,
  result: KnowledgeScanResult,
  scannedAt: string,
): Promise<{ written: number; removed: number }> {
  const scanned = new Set(result.snapshots.map((s) => s.source));
  const before = await readKnowledge(root);
  const keep = before.items.filter((r) => !scanned.has(sourceOf(r) ?? ""));
  const all = [...keep, ...result.items];
  const dir = join(knowledgeDirOf(root), "items");
  const wanted = new Map(all.map((r) => [recordPath(r), serializeRecord(r)]));
  let written = 0;
  for (const [rel, text] of wanted) {
    const full = join(dir, ...rel.split("/"));
    if ((await readFile(full, "utf8").catch(() => undefined)) === text) continue;
    await writeFileAtomic(full, text);
    written++;
  }
  let removed = 0;
  for (const f of await files(dir))
    if (!wanted.has(f)) {
      await rm(join(dir, ...f.split("/")), { force: true });
      removed++;
    }
  const old = before.report;
  const other = <T extends { source?: string; pages?: { source: string }[] }>(xs: T[] = []) =>
    xs.filter((x) =>
      x.pages
        ? x.pages.every((p) => !scanned.has(p.source))
        : x.source === undefined || !scanned.has(x.source),
    );
  const report: KnowledgeReport = {
    schemaVersion: 1,
    scannedAt,
    snapshots: [
      ...(old?.snapshots ?? []).filter((s) => !scanned.has(s.source)),
      ...result.snapshots,
    ],
    conflicts: [...other(old?.conflicts), ...result.conflicts],
    superseded: [
      ...(old?.superseded ?? []).filter((s) => !scanned.has(s.old.source)),
      ...result.superseded,
    ],
    injections: [...other(old?.injections), ...result.injections],
    failed: [
      ...other(old?.failed),
      ...result.failed.map((f) => ({
        ...f,
        ...(result.snapshots.length === 1 ? { source: result.snapshots[0]!.source } : {}),
      })),
    ],
  };
  await writeFileAtomic(join(knowledgeDirOf(root), KNOWLEDGE_REPORT), stringify(report));
  return { written, removed };
}

/** Items with a tag (a source kind, framework or page tag) and of a knowledge kind. */
export function filterItems(
  items: KnowledgeRecord[],
  o: { tag?: string; kind?: KnowledgeKind },
): KnowledgeRecord[] {
  const tag = o.tag?.toLowerCase();
  return items.filter(
    (r) =>
      (!o.kind || knowledgeKindOf(r) === o.kind) &&
      (!tag || r.tags.includes(tag) || r.framework?.toLowerCase() === tag),
  );
}

/** The title an item shows. */
export const itemTitle = (r: KnowledgeRecord) => (r.kind === "Pattern" ? r.name : r.title);
