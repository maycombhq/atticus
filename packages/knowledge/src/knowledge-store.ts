import { readdir, readFile, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse, stringify } from "yaml";
import {
  deserializeRecord,
  knowledgeDirOf,
  knowledgeKindOf,
  readParsedFiles,
  recordPath,
  SCHEMA_VERSION,
  serializeRecord,
  writeFileAtomic,
  type CatalogRecord,
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
import { checkQuote } from "./quotes.js";
import type { RescanPlan } from "./rescan.js";
import { applyReview, itemMeaning, readReviews, type ReviewSummary } from "./reviews.js";
import type { Snapshot } from "./snapshot.js";

/**
 * Where the knowledge scan's results live (ADR 0083): one canonical record file per item at
 * `knowledge/items/<kind>/<id>.yaml` (Pattern, ProcessDefinition, Decision), and
 * `knowledge/scan.yaml` with what the scan flagged: conflicts, superseded pages, quarantined
 * text and the items that failed their checks. Scanning one source replaces only that
 * source's items and flags; a rescan (ADR 0101) replaces only the items of the pages it read
 * again, and records what changed. People's reviews (`knowledge/reviews/`) are applied when the
 * items are read.
 */

export const KNOWLEDGE_REPORT = "scan.yaml";

/** What a scan changed in the items (ADR 0101). */
export interface KnowledgeChanges {
  added: string[];
  changed: string[];
  removed: string[];
}

export interface KnowledgeReport {
  schemaVersion: 1;
  scannedAt: string;
  /** Each source's snapshot read; `hashes` are its pages' sha-256, for the next rescan. */
  snapshots: { source: string; date: string; pages: number; hashes?: Record<string, string> }[];
  /** What the last scan changed, and when. */
  changes?: KnowledgeChanges & { at: string };
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

export interface KnowledgeRead {
  /**
   * The items as people reviewed them: corrections applied, rejected ones left out. With
   * `raw`, the scan's own records, every one, as they are on disk.
   */
  items: KnowledgeRecord[];
  /** Items a person rejected (empty with `raw`). */
  rejected: KnowledgeRecord[];
  /** Each reviewed item's review, by id. */
  reviews: Record<string, ReviewSummary>;
  report?: KnowledgeReport;
  problems: { file: string; message: string }[];
}

/**
 * Read the knowledge items, people's reviews of them and the last scan's report. `cacheRoot` is
 * the metarepo this run is working in, and the only place the parses are kept (record-cache.ts);
 * a read of another team's estate names no root, and then nothing is written into it.
 */
export async function readKnowledge(
  root: string,
  o: { raw?: boolean; cacheRoot?: string } = {},
): Promise<KnowledgeRead> {
  const dir = join(knowledgeDirOf(root), "items");
  const items: KnowledgeRecord[] = [];
  const problems: { file: string; message: string }[] = [];
  // The item files are read at once, and one whose size and time haven't changed since the last
  // run isn't parsed again (record-cache.ts): a scanned wiki leaves hundreds of items, and
  // every command that reads the knowledge read them all.
  for (const p of await readParsedFiles<CatalogRecord>({
    dir,
    files: await files(dir),
    name: "knowledge",
    version: `c1@${SCHEMA_VERSION}`,
    cacheRoot: o.cacheRoot,
    parse: (text) => {
      const r = deserializeRecord(text);
      return r.ok
        ? { ok: true, value: r.record }
        : { ok: false, message: r.issues.map((i) => `${i.path}: ${i.message}`).join("; ") };
    },
  })) {
    if (p.problem !== undefined) problems.push({ file: p.rel, message: p.problem });
    else if (isKnowledgeRecord(p.value!)) items.push(p.value!);
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
  const reviews: Record<string, ReviewSummary> = {};
  const rejected: KnowledgeRecord[] = [];
  let shown = items;
  if (!o.raw) {
    const r = await readReviews(root);
    problems.push(...r.problems);
    shown = [];
    for (const item of items) {
      const a = applyReview(item, r.reviews.get(item.id));
      if (a.summary) reviews[item.id] = a.summary;
      if (a.summary?.state === "rejected") rejected.push(a.item);
      else shown.push(a.item);
    }
  }
  return { items: shown, rejected, reviews, ...(report ? { report } : {}), problems };
}

const sourceOf = (r: KnowledgeRecord) => r.quote?.source;

/**
 * Write a scan's items and report. Items and flags of the sources it read are replaced; other
 * sources' are kept. With a rescan's plan, only the items and flags of the pages it read again
 * (or that are gone) are replaced. `snapshots` (the snapshots the scan came from, whole) give
 * each page's hash for the next rescan. What changed is returned and kept in the report.
 */
export async function writeKnowledge(
  root: string,
  result: KnowledgeScanResult,
  scannedAt: string,
  o: { snapshots?: Snapshot[]; plan?: RescanPlan } = {},
): Promise<{ written: number; removed: number; changes: KnowledgeChanges }> {
  const plan = o.plan;
  const scanned = new Set([
    ...result.snapshots.map((x) => x.source),
    ...(plan ? [...Object.keys(plan.changed), ...Object.keys(plan.removed)] : []),
  ]);
  /** Pages whose items and flags this scan replaces, by source; undefined: the whole source. */
  const replaced = (source: string): Set<string> | undefined =>
    plan ? new Set([...(plan.changed[source] ?? []), ...(plan.removed[source] ?? [])]) : undefined;
  // A page the prompt had no room for wasn't read: what was read from it before stays.
  const unread = new Set((result.leftOut ?? []).map((l) => `${l.source}/${l.page}`));
  const touches = (source: string | undefined, page: string | undefined) => {
    if (source === undefined || !scanned.has(source)) return false;
    if (page !== undefined && unread.has(`${source}/${page}`)) return false;
    const pages = replaced(source);
    return !pages || page === undefined || pages.has(page);
  };
  const before = await readKnowledge(root, { raw: true, cacheRoot: root });
  // An item a person kept from a search stays while its quote is still on its page.
  const pageText = (source: string, page: string) =>
    o.snapshots?.find((x) => x.manifest.source === source)?.pages.find((p) => p.pagePath === page)
      ?.text;
  const stillQuoted = (r: KnowledgeRecord) => {
    if (!r.flags?.some((f) => f.startsWith("found:")) || !r.quote) return false;
    const text = pageText(r.quote.source, r.quote.page);
    return text !== undefined && checkQuote(text, r.quote.text, r.quote.section).ok;
  };
  const keep = before.items.filter((r) => !touches(sourceOf(r), r.quote?.page) || stillQuoted(r));
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

  // What changed, by id: an item is changed when what it means changed (not where it was read).
  const was = new Map(before.items.map((r) => [r.id, itemMeaning(r)]));
  const now = new Map(all.map((r) => [r.id, itemMeaning(r)]));
  const changes: KnowledgeChanges = {
    added: [...now.keys()].filter((id) => !was.has(id)).sort(),
    changed: [...now.keys()].filter((id) => was.has(id) && was.get(id) !== now.get(id)).sort(),
    removed: [...was.keys()].filter((id) => !now.has(id)).sort(),
  };

  const old = before.report;
  const other = <
    T extends { source?: string; page?: string; pages?: { source: string; page?: string }[] },
  >(
    xs: T[] = [],
  ) =>
    xs.filter((x) =>
      x.pages ? x.pages.every((p) => !touches(p.source, p.page)) : !touches(x.source, x.page),
    );
  /**
   * The pages recorded as read: every page of the snapshot, except those a batched scan left for
   * the next and those its prompt had no room for (they keep what the last scan recorded, if
   * anything, so the next scan reads them).
   */
  const hashesAfter = (w: Snapshot, source: string): Record<string, string> => {
    const left = new Set([
      ...(plan?.deferred[source] ?? []),
      ...(result.leftOut ?? []).filter((l) => l.source === source).map((l) => l.page),
    ]);
    const was = old?.snapshots.find((x) => x.source === source)?.hashes ?? {};
    // With a plan, a page is read when the plan read it; one it didn't plan (as it was, or left
    // out of this run) keeps what was recorded.
    const read = plan ? new Set(plan.changed[source] ?? []) : undefined;
    const out: Record<string, string> = {};
    for (const p of w.manifest.pages) {
      const now = !left.has(p.page) && (!read || read.has(p.page) || was[p.page] === p.sha256);
      if (now) out[p.page] = p.sha256;
      else if (was[p.page] !== undefined) out[p.page] = was[p.page]!;
    }
    return out;
  };
  const read = new Map(result.snapshots.map((x) => [x.source, x]));
  const whole = new Map((o.snapshots ?? []).map((x) => [x.manifest.source, x]));
  const snapshots = [
    ...(old?.snapshots ?? []).filter((x) => !scanned.has(x.source) && !whole.has(x.source)),
    ...[...new Set([...read.keys(), ...whole.keys()])].map((source) => {
      const w = whole.get(source);
      const r = read.get(source);
      return {
        source,
        date: w?.manifest.date ?? r!.date,
        pages: w?.manifest.pages.length ?? r!.pages,
        ...(w ? { hashes: hashesAfter(w, source) } : {}),
      };
    }),
  ];
  const report: KnowledgeReport = {
    schemaVersion: 1,
    scannedAt,
    snapshots,
    changes: { at: scannedAt, ...changes },
    conflicts: [...other(old?.conflicts), ...result.conflicts],
    superseded: [
      ...(old?.superseded ?? []).filter((x) => !touches(x.old.source, x.old.page)),
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
  return { written, removed, changes };
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
      (!tag || r.tags.includes(tag) || ("framework" in r && r.framework?.toLowerCase() === tag)),
  );
}

/** The title an item shows. */
export const itemTitle = (r: KnowledgeRecord) =>
  r.kind === "Pattern" || r.kind === "Party" || r.kind === "Product" ? r.name : r.title;
