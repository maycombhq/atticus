import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseRecord, type CatalogRecord } from "@maycombhq/core";

/**
 * Scan cache. A scan of one repo by one extractor is a pure function of:
 * the repo commit, the extractor id and version, the dialects in force and a hash of any
 * configuration the extractor reads (for example dialect rule files). Same key, same
 * records, so an unchanged repo is never scanned twice. See ADR 0010.
 */
export interface ScanCacheKey {
  repo: string;
  /** Full commit SHA of a clean checkout. Dirty trees are never cached. */
  commit: string;
  extractor: string;
  version: string;
  dialects: readonly string[];
  /** Hash of configuration that changes the output (rule files, options). Empty when none. */
  config?: string;
}

export interface CachedScan {
  records: CatalogRecord[];
  warnings: { message: string; path?: string }[];
  /** Records the extractor emitted that failed contract C1; kept as a count for reports. */
  rejected: number;
}

export interface ScanCache {
  get(key: ScanCacheKey): Promise<CachedScan | undefined>;
  put(key: ScanCacheKey, value: CachedScan): Promise<void>;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Stable hash of a cache key: dialect order doesn't matter, everything else does. */
export function cacheKeyHash(key: ScanCacheKey): string {
  return sha256(
    JSON.stringify([
      key.repo,
      key.commit,
      key.extractor,
      key.version,
      [...key.dialects].sort(),
      key.config ?? "",
    ]),
  );
}

/** Hash configuration text (for example dialect rule files) into ScanCacheKey.config. */
export function configHash(parts: Record<string, string>): string {
  const sorted = Object.keys(parts)
    .sort()
    .map((k) => [k, parts[k]]);
  return sha256(JSON.stringify(sorted)).slice(0, 16);
}

export function memoryScanCache(): ScanCache & { size(): number } {
  const map = new Map<string, string>();
  return {
    async get(key) {
      const v = map.get(cacheKeyHash(key));
      return v ? (JSON.parse(v) as CachedScan) : undefined;
    },
    async put(key, value) {
      map.set(cacheKeyHash(key), JSON.stringify(value));
    },
    size: () => map.size,
  };
}

interface CacheFile {
  format: 1;
  key: ScanCacheKey;
  keyHash: string;
  /** sha256 of JSON.stringify(value), to detect a truncated or edited file. */
  checksum: string;
  value: CachedScan;
}

const SAFE = /^[A-Za-z0-9._@-]+$/;

/**
 * A scan cache on disk, normally `.index/scan-cache/` in the metarepo (git-ignored).
 * One JSON file per key at `<repo>/<commit>/<extractor>@<version>.<hash>.json`.
 * Writes are atomic (temp file, then rename). A file that fails its checksum or no longer
 * passes contract C1 is treated as a miss, so a corrupt cache can only cost a rescan.
 */
export function fsScanCache(dir: string): ScanCache & {
  /** Remove cached commits of a repo other than those listed. Returns how many were removed. */
  prune(repo: string, keepCommits: readonly string[]): Promise<number>;
} {
  const fileFor = (key: ScanCacheKey) => {
    for (const part of [key.repo, key.commit, key.extractor, key.version]) {
      if (!SAFE.test(part)) throw new Error(`unsafe cache key part: ${part}`);
    }
    const h = cacheKeyHash(key);
    return {
      h,
      path: join(
        dir,
        key.repo,
        key.commit,
        `${key.extractor}@${key.version}.${h.slice(0, 16)}.json`,
      ),
    };
  };

  return {
    async get(key) {
      const { h, path } = fileFor(key);
      let file: CacheFile;
      try {
        file = JSON.parse(await readFile(path, "utf8")) as CacheFile;
      } catch {
        return undefined;
      }
      if (file.format !== 1 || file.keyHash !== h) return undefined;
      if (sha256(JSON.stringify(file.value)) !== file.checksum) return undefined;
      const records: CatalogRecord[] = [];
      for (const r of file.value.records) {
        const parsed = parseRecord(r);
        if (!parsed.ok) return undefined;
        records.push(parsed.record);
      }
      return { ...file.value, records };
    },

    async put(key, value) {
      const { h, path } = fileFor(key);
      const file: CacheFile = {
        format: 1,
        key,
        keyHash: h,
        checksum: sha256(JSON.stringify(value)),
        value,
      };
      await mkdir(join(path, ".."), { recursive: true });
      const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify(file), "utf8");
      await rename(tmp, path);
    },

    async prune(repo, keepCommits) {
      if (!SAFE.test(repo)) throw new Error(`unsafe repo name: ${repo}`);
      const keep = new Set(keepCommits);
      let removed = 0;
      let commits: string[];
      try {
        commits = await readdir(join(dir, repo));
      } catch {
        return 0;
      }
      for (const c of commits) {
        if (!keep.has(c)) {
          await rm(join(dir, repo, c), { recursive: true, force: true });
          removed++;
        }
      }
      return removed;
    },
  };
}
