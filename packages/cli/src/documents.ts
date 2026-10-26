import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  catalogDirOf,
  inputsDirOf,
  knowledgeRelOf,
  loadOrgPack,
  orgPackDirOf,
  type CatalogRecord,
} from "@maycombhq/core";
import { scanInputs } from "@maycombhq/intake";
import { readKnowledge, readSnapshot } from "@maycombhq/knowledge";
import { readCatalog } from "@maycombhq/scanner";
import { INPUTS_SOURCE_ID } from "./inputs-knowledge.js";

/**
 * The Documents tab (ADR 0122 item 2): every file in the metarepo's inputs/, with what intake
 * made of it (its kind, the systems it names, duplicates and versions), whether the knowledge
 * source read it (from the newest inputs/ snapshot, with the reason when it didn't), and the
 * knowledge items that quote it, proposed or verified. Files only: nothing is read again here.
 */

export type DocumentState = "read" | "skipped" | "not-synced";

export interface DocumentView {
  /** Relative to the metarepo, starting with inputs/. */
  path: string;
  /** What intake found it is: document, spreadsheet, diagram, openapi, image... */
  kind: string;
  title?: string;
  systems: string[];
  state: DocumentState;
  /** Why it wasn't read (skipped), from the snapshot. */
  reason?: string;
  duplicateOf?: string;
  /** The newer version's path. */
  supersededBy?: string;
  /** In inputs/inbox/: dropped, not filed yet. */
  inbox: boolean;
  /** The file's last change on disk (ISO), for its age. */
  modifiedAt?: string;
  /** The knowledge items that quote it, and how many a person verified. */
  items: { id: string; title: string; verified: boolean }[];
}

export interface DocumentList {
  documents: DocumentView[];
  /** The newest snapshot of inputs/, or null when it was never synced. */
  snapshot: { date: string } | null;
  /** What brings the list up to date: sync, then the knowledge scan. */
  commands: string[];
}

const titleOf = (r: CatalogRecord) =>
  ("title" in r && typeof r.title === "string" && r.title) ||
  ("name" in r && typeof r.name === "string" && r.name) ||
  r.id;

export async function listDocuments(root: string): Promise<DocumentList> {
  const dir = inputsDirOf(root);
  const commands = [
    `atticus sources sync --source ${INPUTS_SOURCE_ID}`,
    `atticus knowledge scan --source ${INPUTS_SOURCE_ID}`,
  ];
  const there = await stat(dir).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (!there) return { documents: [], snapshot: null, commands };
  const op = await loadOrgPack(orgPackDirOf(root));
  // The baseline's records (generated and curated), never a branch scanned beside it (ADR 0123).
  const records: CatalogRecord[] = [];
  for (const part of ["generated", "curated"])
    records.push(
      ...(await readCatalog(join(catalogDirOf(root), part), { cacheRoot: root }).then(
        (c) => c.records,
        () => [] as CatalogRecord[],
      )),
    );
  const intake = await scanInputs({
    root,
    orgPack: op,
    inputsDir: dir,
    records,
    scannedAt: "1970-01-01T00:00:00Z",
  });
  const byId = new Map(intake.documents.filter((d) => d.id).map((d) => [d.id!, d.path]));
  const snap = await readSnapshot(root, INPUTS_SOURCE_ID).catch(() => undefined);
  const read = new Set(snap?.manifest.pages.map((p) => `inputs/${p.page}`) ?? []);
  const skipped = new Map(snap?.manifest.skipped.map((s) => [s.page, s.reason]) ?? []);
  // The snapshot copy each page was kept as, back to its file: items cite the copy.
  const fileOf = new Map(snap?.manifest.pages.map((p) => [p.file, `inputs/${p.page}`]) ?? []);
  const copy = new RegExp(
    `^${knowledgeRelOf(root).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/snapshots/${INPUTS_SOURCE_ID}/[^/]+/(.+)$`,
  );
  const k = await readKnowledge(root, { cacheRoot: root }).catch(() => undefined);
  const itemsOf = new Map<string, DocumentView["items"]>();
  for (const item of k?.items ?? []) {
    const files = new Set(
      item.evidence
        .map((e) => (e.path ? copy.exec(e.path)?.[1] : undefined))
        .filter((f): f is string => !!f)
        .map((f) => fileOf.get(f))
        .filter((p): p is string => !!p),
    );
    const review = k!.reviews[item.id];
    for (const f of files)
      itemsOf.set(f, [
        ...(itemsOf.get(f) ?? []),
        {
          id: item.id,
          title: titleOf(item as unknown as CatalogRecord),
          verified: review?.state === "verified" || review?.state === "corrected",
        },
      ]);
  }
  const documents: DocumentView[] = [];
  for (const d of [...intake.documents].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const at = await stat(join(dir, ...d.path.replace(/^inputs\//, "").split("/"))).catch(
      () => undefined,
    );
    const reason = skipped.get(d.path);
    documents.push({
      path: d.path,
      kind: d.classification,
      ...(d.title ? { title: d.title } : {}),
      systems: d.systems,
      state: read.has(d.path) ? "read" : reason ? "skipped" : "not-synced",
      ...(reason ? { reason } : {}),
      ...(d.duplicateOf ? { duplicateOf: d.duplicateOf } : {}),
      ...(d.supersededBy ? { supersededBy: byId.get(d.supersededBy) ?? d.supersededBy } : {}),
      inbox: d.path.startsWith("inputs/inbox/"),
      ...(at ? { modifiedAt: at.mtime.toISOString() } : {}),
      items: itemsOf.get(d.path) ?? [],
    });
  }
  return { documents, snapshot: snap ? { date: snap.manifest.date } : null, commands };
}
