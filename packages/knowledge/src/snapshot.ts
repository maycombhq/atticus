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
 */

export const SNAPSHOT_FILE = "snapshot.yaml";

export const SnapshotManifest = z.strictObject({
  schemaVersion: z.literal(1),
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
}): Promise<{ source: string; dir: string; pages: number }[]> {
  const date = o.takenAt.slice(0, 10);
  const out: { source: string; dir: string; pages: number }[] = [];
  for (const w of o.orgPack.sources.wikis) {
    if (o.sources && !o.sources.includes(w.id)) continue;
    const pages = o.sync.pages.filter((p) => p.source === w.id);
    if (!pages.length && o.sync.problems.some((p) => p.source === w.id)) continue;
    const rel = `${knowledgeRelOf(o.root)}/snapshots/${w.id}/${date}`;
    const dir = join(o.root, ...rel.split("/"));
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const manifest: SnapshotManifest = {
      schemaVersion: 1,
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
      await writeFileAtomic(join(dir, ...file.split("/")), p.text ?? "");
      manifest.pages.push({
        page: p.pagePath,
        file,
        sha256: p.hash,
        ...(p.title ? { title: p.title } : {}),
        ...(p.date ? { date: p.date } : {}),
        classification: p.classification,
      });
    }
    await writeFileAtomic(join(dir, SNAPSHOT_FILE), stringify(manifest));
    out.push({ source: w.id, dir: rel, pages: pages.length });
  }
  return out;
}

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
    const content = await readFile(join(dir, ...p.file.split("/")), "utf8");
    pages.push(
      readPage({
        source,
        sourceType: manifest.type,
        path: `${rel}/${p.file}`,
        pagePath: p.page,
        content,
        ...(p.date ? { updatedAt: p.date } : {}),
      }),
    );
  }
  return { manifest, dir: rel, pages };
}
