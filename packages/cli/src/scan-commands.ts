import { join } from "node:path";
import { acquireLock, catalogDirOf, LockHeldError } from "@maycombhq/core";
import { loadRepos } from "@maycombhq/workspace";
import { driftAfterScan, type DriftAfterScan } from "@maycombhq/speckit";
import {
  diffCatalogs,
  diffIsEmpty,
  readCatalog,
  scanEstate,
  writeCatalog,
  type CatalogDiff,
} from "@maycombhq/scanner";
import type { Output } from "./commands.js";

/** The lines a person reads for a catalog diff: + added, - removed, ~ changed (fields). */
export function diffLines(d: CatalogDiff): string[] {
  if (diffIsEmpty(d)) return ["No catalog changes."];
  const lines = [
    `${d.added.length} added, ${d.removed.length} removed, ${d.changed.length} changed, ${d.evidenceOnly.length} with new evidence only`,
    ...d.added.map((r) => `+ ${r.kind}/${r.id}`),
    ...d.removed.map((r) => `- ${r.kind}/${r.id}`),
    ...d.changed.map((r) => `~ ${r.kind}/${r.id} (${r.fields.join(", ")})`),
  ];
  return lines;
}

export interface ScanCommandOptions {
  repos?: string[];
  full?: boolean;
  dryRun?: boolean;
  json?: boolean;
  /** Skip the drift check for open changes in build or qa that runs after the catalog is written. */
  noDrift?: boolean;
  /** List every warning (files left out, rules that couldn't fill a template), not just the count. */
  warnings?: boolean;
}

function driftLine(d: DriftAfterScan): string {
  const head = `Drift check for ${d.change} (${d.state})`;
  if (d.error) return `${head} couldn't run: ${d.error}`;
  if (d.round === undefined) return `${head}: no drift.`;
  const what = `${d.open} open finding${d.open === 1 ? "" : "s"}${d.blocking ? ` (${d.blocking} blocking)` : ""}`;
  return `${head}: ${what} in review/drift/${d.round}${d.unchanged ? ", nothing new" : ""}.`;
}

/**
 * atticus scan: scan every repo's base clone, merge, and write catalog/generated.
 * Exit 0 ok, 1 when any repo, extractor, dialect or record had a problem, 2 for usage.
 */
export async function scanCommand(
  root: string,
  o: ScanCommandOptions,
  io: Output,
): Promise<number> {
  if (o.repos && o.repos.length > 0) {
    const known = new Set((await loadRepos(root)).map((r) => r.id));
    const unknown = o.repos.filter((r) => !known.has(r));
    if (unknown.length > 0) {
      io.err(`Not in any repos.manifest.yaml: ${unknown.join(", ")}`);
      return 2;
    }
  }
  // One scan at a time per metarepo; a scan whose process is gone was cut short.
  let lock: Awaited<ReturnType<typeof acquireLock>> | undefined;
  if (!o.dryRun) {
    try {
      lock = await acquireLock(root, "scan", "scan");
    } catch (e) {
      if (e instanceof LockHeldError) {
        io.err(e.message);
        return 1;
      }
      throw e;
    }
    if (lock.interrupted)
      io.err(
        `The last scan (started ${lock.interrupted.startedAt}) stopped before it finished; this one brings the catalog up to date.`,
      );
  }
  try {
    return await scanLocked(root, o, io);
  } finally {
    await lock?.release();
  }
}

async function scanLocked(root: string, o: ScanCommandOptions, io: Output): Promise<number> {
  const out = join(catalogDirOf(root), "generated");
  const before = await readCatalog(out);
  const started = Date.now();
  const scan = await scanEstate({
    root,
    ...(o.repos ? { repos: o.repos } : {}),
    ...(o.full ? { cache: null } : {}),
  });
  const diff = diffCatalogs(before.records, scan.records);
  const write = o.dryRun ? undefined : await writeCatalog(out, scan.records);
  // The drift check reads the catalog just written, so it runs only when one was.
  const drift = write && !o.noDrift ? await driftAfterScan(root) : [];
  const problems = [
    ...before.problems.map((p) => ({ source: `catalog/generated/${p.file}`, message: p.message })),
    ...scan.problems,
  ];
  // Warnings don't fail the scan, but they are what it couldn't read: never dropped silently.
  // The same file left out by several extractors is one warning.
  const seen = new Set<string>();
  const warnings = scan.repos.flatMap((r) =>
    r.warnings
      .map((w) => ({ repo: r.repo, ...w }))
      .filter((w) => {
        const k = `${w.repo}\u0000${w.path ?? ""}\u0000${w.message}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }),
  );
  if (o.json) {
    io.out(
      JSON.stringify(
        {
          stats: scan.stats,
          diff,
          problems,
          warnings,
          coverage: scan.coverage,
          notes: scan.notes,
          written: write !== undefined,
          files: write ?? null,
          drift,
        },
        null,
        2,
      ),
    );
  } else {
    const s = scan.stats;
    io.out(
      `Scanned ${s.repos} repos in ${((Date.now() - started) / 1000).toFixed(1)}s (${s.ranRuns} extractor runs, ${s.cachedRuns} from cache)`,
    );
    io.out(
      `${s.records} records: ${s.interfaces} interfaces (${s.verified} verified), ${s.unresolved} loose ends`,
    );
    const joined = scan.coverage.reduce((n, c) => n + c.joined, 0);
    const found = joined + scan.coverage.reduce((n, c) => n + c.open, 0);
    const unread = scan.coverage.reduce((n, c) => n + c.unreadFiles, 0);
    io.out(
      `Joined ${joined} of ${found} calls, listeners and endpoints found (${found ? Math.round((joined / found) * 100) : 100}%)` +
        (unread
          ? `; ${unread} file${unread === 1 ? " uses" : "s use"} a client library with nothing read (atticus scan --warnings)`
          : ""),
    );
    for (const l of diffLines(diff)) io.out(l);
    if (write)
      io.out(
        `catalog/generated: ${write.written} written, ${write.unchanged} unchanged, ${write.removed} removed`,
      );
    else io.out("Dry run: nothing written.");
    for (const d of drift) io.out(driftLine(d));
    for (const n of scan.notes) io.out(`note: ${n}`);
    if (o.warnings)
      for (const w of warnings)
        io.out(`warning: ${w.repo}: ${w.path ? `${w.path}: ` : ""}${w.message}`);
    else if (warnings.length)
      io.out(
        `${warnings.length} warning${warnings.length === 1 ? "" : "s"}: atticus scan --warnings lists ${warnings.length === 1 ? "it" : "them"}`,
      );
    for (const p of problems)
      io.err(`${"repo" in p && p.repo ? `${p.repo}: ` : ""}${p.source}: ${p.message}`);
  }
  return problems.length > 0 ? 1 : 0;
}

/** atticus catalog diff <a> <b>: exit 0 when the catalogs hold the same facts and evidence, 1 otherwise. */
export async function catalogDiff(
  a: string,
  b: string,
  json: boolean,
  io: Output,
): Promise<number> {
  const [x, y] = await Promise.all([readCatalog(a), readCatalog(b)]);
  for (const p of [...x.problems, ...y.problems]) io.err(`${p.file}: ${p.message}`);
  const d = diffCatalogs(x.records, y.records);
  if (json) io.out(JSON.stringify(d, null, 2));
  else for (const l of diffLines(d)) io.out(l);
  return diffIsEmpty(d) && x.problems.length + y.problems.length === 0 ? 0 : 1;
}
