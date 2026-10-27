import type { OrgPack } from "@maycombhq/core";
import { knowledgeScanRoom } from "./knowledge-scan.js";
import { readKnowledge } from "./knowledge-store.js";
import { planRescan, tokensOf } from "./rescan.js";
import { readSnapshot, type Snapshot } from "./snapshot.js";

/**
 * What a knowledge scan would cost before it runs (ADR 0130), as `atticus map --estimate` says
 * for a read: per source, the pages its newest snapshot holds, those the scan would read (new or
 * changed since the last scan, within the source's `maxPages`), their tokens, and the model calls
 * the batches take; then the whole. Read from the snapshots only: nothing reaches a wiki or a
 * model. Each call is one prompt to the configured model (with Copilot, a premium request).
 */

export interface SourceEstimate {
  source: string;
  /** Pages in the newest snapshot. */
  pages: number;
  /** Pages the next scan reads: new or changed, within the cap. */
  toRead: number;
  /** Pages as they were at the last scan. */
  unchanged: number;
  /** Pages the cap leaves for a later run. */
  capped: number;
  cap?: number;
  tokens: number;
  /** Model calls for this source's pages alone. */
  calls: number;
}

export interface ScanEstimate {
  /** The room for pages in one prompt, in tokens. */
  room: number;
  sources: SourceEstimate[];
  total: { pages: number; toRead: number; tokens: number; calls: number };
  /** Sources with no snapshot yet: sync them first (atticus sources sync). */
  notSynced: string[];
}

/** Batches as the scan fills them: in order, each up to the room, a page bigger than it alone. */
function batches(tokens: number[], room: number): number {
  let n = 0;
  let left = 0;
  for (const t of tokens) {
    if (n === 0 || t > left) {
      n++;
      left = Math.max(0, room - t);
    } else left -= t;
  }
  return n;
}

export async function estimateScan(
  root: string,
  o: {
    orgPack: Pick<OrgPack, "sources" | "agents" | "runtime">;
    /** A batch's room for pages, as `atticus knowledge scan --batch-tokens`; default the reader's. */
    batchTokens?: number;
    /** Every page, as `--full`. */
    full?: boolean;
  },
): Promise<ScanEstimate> {
  const snapshots: Snapshot[] = [];
  const notSynced: string[] = [];
  for (const w of o.orgPack.sources.wikis) {
    const s = await readSnapshot(root, w.id).catch(() => undefined);
    if (s) snapshots.push(s);
    else notSynced.push(w.id);
  }
  const k = await readKnowledge(root, { cacheRoot: root }).catch(() => undefined);
  const caps = Object.fromEntries(
    o.orgPack.sources.wikis.filter((w) => w.maxPages).map((w) => [w.id, w.maxPages!]),
  );
  const plan = planRescan(snapshots, k?.report, k?.items ?? [], {
    ...(o.full ? { full: true } : {}),
    caps,
  });
  const room = o.batchTokens ?? knowledgeScanRoom(snapshots, o.orgPack);
  const all: number[] = [];
  const sources: SourceEstimate[] = [];
  for (const s of snapshots) {
    const id = s.manifest.source;
    const read = new Set(plan.changed[id] ?? []);
    const text = new Map(s.pages.map((p) => [p.pagePath, p.text ?? ""]));
    const tokens = [...read].map((p) => tokensOf(id, p, text.get(p) ?? ""));
    all.push(...tokens);
    const cap = caps[id];
    sources.push({
      source: id,
      pages: s.manifest.pages.length,
      toRead: read.size,
      unchanged: plan.unchanged[id] ?? 0,
      capped: plan.deferred[id]?.length ?? 0,
      ...(cap !== undefined ? { cap } : {}),
      tokens: tokens.reduce((a, b) => a + b, 0),
      calls: tokens.length ? batches(tokens, room) : 0,
    });
  }
  return {
    room,
    sources,
    total: {
      pages: sources.reduce((n, s) => n + s.pages, 0),
      toRead: sources.reduce((n, s) => n + s.toRead, 0),
      tokens: all.reduce((a, b) => a + b, 0),
      calls: all.length ? batches(all, room) : 0,
    },
    notSynced,
  };
}
