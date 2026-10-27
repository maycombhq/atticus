import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { knowledgeDirOf, knowledgeRelOf, writeFileAtomic, type OrgPack } from "@maycombhq/core";
import { readPage, type KnowledgePage, type SyncResult, type WikiSource } from "./sources.js";

/**
 * Dated snapshots of knowledge sources (ADR 0083). `atticus sources sync` reads each source
 * (read-only, through its adapter) and copies every page it may read to
 * `knowledge/snapshots/<source>/<date>/`, with `snapshot.yaml` listing the pages and their
 * hashes. The knowledge scan reads only snapshots, so a scan never reaches a wiki and the same
 * snapshot always gives the scan the same pages.
 *
 * ADR 0130: snapshots are committed, so at a dozen wikis a full copy per sync bloats the
 * metarepo. A snapshot copies only the pages new or changed since the source's snapshot before
 * it; an unchanged page is listed with `in: <date>`, the snapshot whose folder holds its copy.
 * Readers follow it: a page's path is always where its copy is.
 */

export const SNAPSHOT_FILE = "snapshot.yaml";

export const SnapshotManifest = z.strictObject({
  /** 2 (ADR 0130): a page may be copied in an earlier snapshot (`in`). */
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  source: z.string().min(1),
  /** The snapshot's date (the folder name). */
  date: z.iso.date(),
  takenAt: z.iso.datetime({ offset: true }),
  type: z.string().min(1),
  location: z.string().min(1),
  owner: z.string().optional(),
  /** A git wiki's commit the pages were read at (ADR 0101). */
  commit: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/)
    .optional(),
  tags: z
    .strictObject({
      kinds: z.array(z.string()).default([]),
      frameworks: z.array(z.string()).default([]),
    })
    .default({ kinds: [], frameworks: [] }),
  pages: z.array(
    z.strictObject({
      /** The page's path inside the source. */
      page: z.string().min(1),
      /** The copy's file name inside the snapshot folder. */
      file: z.string().min(1),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      title: z.string().optional(),
      date: z.string().optional(),
      classification: z.string().optional(),
      /** The earlier snapshot (its date) whose folder holds this page's copy, unchanged since. */
      in: z.iso.date().optional(),
    }),
  ),
  /** Pages the sync didn't copy (above the classification limit), path and reason only. */
  skipped: z.array(z.strictObject({ page: z.string(), reason: z.string() })).default([]),
});
export type SnapshotManifest = z.infer<typeof SnapshotManifest>;

export interface Snapshot {
  manifest: SnapshotManifest;
  /** The snapshot folder, relative to the root with forward slashes. */
  dir: string;
  /** The pages, read from the copies; `path` is the copy's root-relative path. */
  pages: KnowledgePage[];
}

const fileFor = (page: string) => (/\.(md|markdown)$/i.test(page) ? page : `${page}.md`);
const safe = (p: string) =>
  p
    .split("/")
    .filter((s) => s && s !== "." && s !== "..")
    .join("/");

/** The tags of a source as stored with its snapshot. */
export const sourceTags = (w: WikiSource) => ({
  kinds: w.tags?.kinds ?? [],
  frameworks: w.tags?.frameworks ?? [],
});

/**
 * Copy what a sync read to one dated snapshot per source. A snapshot of the same source on the
 * same date is replaced whole. Returns each snapshot's folder (root-relative) and page count.
 */
export async function writeSnapshots(o: {
  root: string;
  orgPack: Pick<OrgPack, "sources">;
  sync: SyncResult;
  /** The snapshot date (YYYY-MM-DD) and time, from the caller's clock. */
  takenAt: string;
  /** Only these sources; default every source the sync read. */
  sources?: string[];
  /** Each git wiki's commit read, by source id (ADR 0101). */
  commits?: Record<string, string>;
}): Promise<{ source: string; dir: string; pages: number; copied: number }[]> {
  const date = o.takenAt.slice(0, 10);
  const out: { source: string; dir: string; pages: number; copied: number }[] = [];
  for (const w of o.orgPack.sources.wikis) {
    if (o.sources && !o.sources.includes(w.id)) continue;
    const pages = o.sync.pages.filter((p) => p.source === w.id);
    if (!pages.length && o.sync.problems.some((p) => p.source === w.id)) continue;
    const rel = `${knowledgeRelOf(o.root)}/snapshots/${w.id}/${date}`;
    const dir = join(o.root, ...rel.split("/"));
    // The snapshot before this one: an unchanged page points at the folder that holds its copy.
    const before = await previousCopies(o.root, w.id, date);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    let copied = 0;
    const manifest: SnapshotManifest = {
      schemaVersion: 2,
      source: w.id,
      date,
      takenAt: o.takenAt,
      type: w.type,
      location: w.location,
      ...(w.owner ? { owner: w.owner } : {}),
      ...(o.commits?.[w.id] ? { commit: o.commits[w.id] } : {}),
      tags: sourceTags(w),
      pages: [],
      skipped: o.sync.skipped
        .filter((s) => s.source === w.id)
        .map((s) => ({ page: s.path, reason: s.reason })),
    };
    for (const p of pages) {
      const file = safe(fileFor(p.pagePath));
      const was = before.get(p.pagePath);
      const keep = was && was.sha256 === p.hash && was.file === file ? was.in : undefined;
      if (!keep) {
        await writeFileAtomic(join(dir, ...file.split("/")), p.text ?? "");
        copied++;
      }
      manifest.pages.push({
        page: p.pagePath,
        file,
        sha256: p.hash,
        ...(p.title ? { title: p.title } : {}),
        ...(p.date ? { date: p.date } : {}),
        classification: p.classification,
        ...(keep ? { in: keep } : {}),
      });
    }
    await writeFileAtomic(join(dir, SNAPSHOT_FILE), stringify(manifest));
    out.push({ source: w.id, dir: rel, pages: pages.length, copied });
  }
  return out;
}

/**
 * The pages of a source's newest snapshot before `date` whose copy is still on disk, by page:
 * the hash, the file and the snapshot (date) whose folder holds the copy.
 */
async function previousCopies(
  root: string,
  source: string,
  date: string,
): Promise<Map<string, { sha256: string; file: string; in: string }>> {
  const out = new Map<string, { sha256: string; file: string; in: string }>();
  const prev = (await snapshotDates(root, source)).find((d) => d < date);
  if (!prev) return out;
  const m = await readManifest(root, source, prev);
  if (!m) return out;
  for (const p of m.pages) out.set(p.page, { sha256: p.sha256, file: p.file, in: p.in ?? prev });
  return out;
}

/** A snapshot's manifest, undefined when it has none or it doesn't read. */
export async function readManifest(
  root: string,
  source: string,
  date: string,
): Promise<SnapshotManifest | undefined> {
  const dir = join(knowledgeDirOf(root), "snapshots", source, date);
  const text = await readFile(join(dir, SNAPSHOT_FILE), "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  const r = SnapshotManifest.safeParse(parse(text));
  return r.success ? r.data : undefined;
}

/** Where a manifest's page copy is, root-relative: its own snapshot's folder, or the one it is in. */
export const snapshotCopyPath = (
  root: string,
  source: string,
  date: string,
  p: { file: string; in?: string | undefined },
) => `${knowledgeRelOf(root)}/snapshots/${source}/${p.in ?? date}/${p.file}`;

/** The dates a source has snapshots for, newest first. */
export async function snapshotDates(root: string, source: string): Promise<string[]> {
  const dir = join(knowledgeDirOf(root), "snapshots", source);
  return (await readdir(dir).catch(() => [] as string[]))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort()
    .reverse();
}

/** Sources that have at least one snapshot. */
export async function snapshotSources(root: string): Promise<string[]> {
  const dir = join(knowledgeDirOf(root), "snapshots");
  const out: string[] = [];
  for (const s of (await readdir(dir).catch(() => [] as string[])).sort())
    if ((await snapshotDates(root, s)).length) out.push(s);
  return out;
}

/** Read one snapshot (the newest when no date is given). Undefined when there is none. */
export async function readSnapshot(
  root: string,
  source: string,
  date?: string,
): Promise<Snapshot | undefined> {
  const d = date ?? (await snapshotDates(root, source))[0];
  if (!d) return undefined;
  const rel = `${knowledgeRelOf(root)}/snapshots/${source}/${d}`;
  const dir = join(root, ...rel.split("/"));
  const text = await readFile(join(dir, SNAPSHOT_FILE), "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  const manifest = SnapshotManifest.parse(parse(text));
  const pages: KnowledgePage[] = [];
  for (const p of manifest.pages) {
    const path = snapshotCopyPath(root, source, d, p);
    const content = await readFile(join(root, ...path.split("/")), "utf8");
    pages.push(
      readPage({
        source,
        sourceType: manifest.type,
        path,
        pagePath: p.page,
        content,
        ...(p.date ? { updatedAt: p.date } : {}),
      }),
    );
  }
  return { manifest, dir: rel, pages };
}
