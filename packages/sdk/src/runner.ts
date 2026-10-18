import { parseRecord, type CatalogRecord, type RecordIssue } from "@maycombhq/core";
import type { ScanCache, ScanCacheKey } from "./cache.js";
import type { Extractor, RepoHandle, ScanContext } from "./plugin.js";

export interface ScanRepoOptions {
  repo: RepoHandle;
  extractors: readonly Extractor[];
  /** Dialect ids that apply to this repo (from repos.manifest.yaml). */
  dialects?: readonly string[];
  /** One timestamp for the whole scan, so every record of a run carries the same one. */
  scannedAt?: string;
  cache?: ScanCache;
  /** The checkout has uncommitted changes: results are neither read from nor written to the cache. */
  dirty?: boolean;
  /** Hash of configuration that changes an extractor's output, e.g. its dialect rule files. */
  configFor?: (extractor: Extractor) => string | undefined;
  /** What the manifest says about the repo; passed to extractors and part of the cache key. */
  repoInfo?: { component?: string; system?: string; repoType?: string };
}

export type RunStatus = "ran" | "cached" | "skipped" | "failed";

export interface ExtractorRun {
  extractor: string;
  version: string;
  status: RunStatus;
  records: number;
  rejected: number;
  warnings: number;
  durationMs: number;
  error?: string;
}

export interface RepoScan {
  repo: string;
  commit: string;
  scannedAt: string;
  /** Valid records from every extractor, sorted by kind, id, then extractor. */
  records: CatalogRecord[];
  runs: ExtractorRun[];
  warnings: { extractor: string; message: string; path?: string }[];
  rejected: { extractor: string; record: unknown; issues: RecordIssue[] }[];
}

const EVIDENCE_FROM_REPO = new Set([
  "code",
  "config",
  "spec",
  "gateway",
  "event-config",
  "infrastructure",
  "pipeline",
  "migration",
]);

/**
 * Fill in what the runner knows so extractors don't repeat it: the repo, commit, scan time
 * and "id@version" of the extractor on every piece of evidence read from this repo.
 * Values an extractor set itself are kept.
 */
export function stampEvidence(
  record: unknown,
  repo: RepoHandle,
  extractor: string,
  scannedAt: string,
): unknown {
  if (record === null || typeof record !== "object") return record;
  const r = record as { evidence?: unknown };
  if (!Array.isArray(r.evidence)) return record;
  return {
    ...r,
    evidence: r.evidence.map((e: unknown) => {
      if (e === null || typeof e !== "object") return e;
      const ev = { ...(e as Record<string, unknown>) };
      if (typeof ev.source !== "string" || !EVIDENCE_FROM_REPO.has(ev.source)) return ev;
      ev.repo ??= repo.name;
      if (ev.repo === repo.name) {
        ev.commit ??= repo.commit;
        ev.scannedAt ??= scannedAt;
      }
      ev.extractor ??= extractor;
      return ev;
    }),
  };
}

async function hasClaimedFiles(repo: RepoHandle, claims: readonly string[]): Promise<boolean> {
  for await (const _ of repo.listFiles(claims)) return true;
  return false;
}

function compareRecords(
  a: { r: CatalogRecord; x: string },
  b: { r: CatalogRecord; x: string },
): number {
  const ka = `${a.r.kind}\u0000${a.r.id}\u0000${a.x}`;
  const kb = `${b.r.kind}\u0000${b.r.id}\u0000${b.x}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/**
 * Scan one repo with every extractor. Each extractor runs in isolation: one that throws is
 * reported as failed and the others still run. Every emitted record is stamped and
 * validated against contract C1; invalid ones are reported, never returned. Results come
 * from the cache when the commit, extractor version, dialects and configuration are
 * unchanged. Output order is deterministic.
 */
export async function scanRepo(options: ScanRepoOptions): Promise<RepoScan> {
  const { repo } = options;
  const dialects = [...(options.dialects ?? [])].sort();
  const scannedAt = options.scannedAt ?? new Date().toISOString();
  const useCache = options.cache !== undefined && !options.dirty;

  const seenIds = new Set<string>();
  for (const x of options.extractors) {
    if (seenIds.has(x.id)) throw new Error(`extractor ${x.id} is registered twice`);
    seenIds.add(x.id);
  }

  const out: RepoScan = {
    repo: repo.name,
    commit: repo.commit,
    scannedAt,
    records: [],
    runs: [],
    warnings: [],
    rejected: [],
  };
  const collected: { r: CatalogRecord; x: string }[] = [];

  for (const extractor of [...options.extractors].sort((a, b) => a.id.localeCompare(b.id))) {
    const tag = `${extractor.id}@${extractor.version}`;
    const started = Date.now();
    const run: ExtractorRun = {
      extractor: extractor.id,
      version: extractor.version,
      status: "ran",
      records: 0,
      rejected: 0,
      warnings: 0,
      durationMs: 0,
    };
    const key: ScanCacheKey = {
      repo: repo.name,
      commit: repo.commit,
      extractor: extractor.id,
      version: extractor.version,
      dialects,
      config: [options.configFor?.(extractor) ?? "", JSON.stringify(options.repoInfo ?? {})].join(
        "|",
      ),
    };

    try {
      const hit = useCache ? await options.cache!.get(key) : undefined;
      if (hit) {
        run.status = "cached";
        run.records = hit.records.length;
        run.rejected = hit.rejected;
        run.warnings = hit.warnings.length;
        for (const r of hit.records) collected.push({ r, x: extractor.id });
        for (const w of hit.warnings) out.warnings.push({ extractor: extractor.id, ...w });
      } else if (!(await hasClaimedFiles(repo, extractor.claims))) {
        run.status = "skipped";
      } else {
        const records: CatalogRecord[] = [];
        const warnings: { message: string; path?: string }[] = [];
        const ids = new Set<string>();
        let rejected = 0;
        const info = options.repoInfo ?? {};
        const ctx: ScanContext = {
          dialects,
          ...(info.component ? { component: info.component } : {}),
          ...(info.system ? { system: info.system } : {}),
          ...(info.repoType ? { repoType: info.repoType } : {}),
          scannedAt,
          warn: (message, path) =>
            warnings.push(path === undefined ? { message } : { message, path }),
        };
        for await (const emitted of extractor.scan(repo, ctx)) {
          const parsed = parseRecord(stampEvidence(emitted, repo, tag, scannedAt));
          if (!parsed.ok) {
            rejected++;
            out.rejected.push({ extractor: extractor.id, record: emitted, issues: parsed.issues });
            continue;
          }
          const id = `${parsed.record.kind}/${parsed.record.id}`;
          if (ids.has(id)) {
            warnings.push({ message: `emitted ${id} more than once; kept the first` });
            continue;
          }
          ids.add(id);
          records.push(parsed.record);
        }
        run.records = records.length;
        run.rejected = rejected;
        run.warnings = warnings.length;
        for (const r of records) collected.push({ r, x: extractor.id });
        for (const w of warnings) out.warnings.push({ extractor: extractor.id, ...w });
        if (useCache) await options.cache!.put(key, { records, warnings, rejected });
      }
    } catch (err) {
      run.status = "failed";
      run.error = err instanceof Error ? err.message : String(err);
      // Drop anything this extractor produced before failing: partial output is misleading.
      for (let i = collected.length - 1; i >= 0; i--)
        if (collected[i]!.x === extractor.id) collected.splice(i, 1);
      for (let i = out.warnings.length - 1; i >= 0; i--)
        if (out.warnings[i]!.extractor === extractor.id) out.warnings.splice(i, 1);
      for (let i = out.rejected.length - 1; i >= 0; i--)
        if (out.rejected[i]!.extractor === extractor.id) out.rejected.splice(i, 1);
      run.rejected = 0;
      run.warnings = 0;
      run.records = 0;
    }
    run.durationMs = Date.now() - started;
    out.runs.push(run);
  }

  out.records = collected.sort(compareRecords).map((c) => c.r);
  return out;
}
