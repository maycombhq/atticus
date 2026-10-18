import { parseRecord, type CatalogRecord, type RecordIssue } from "@maycombhq/core";

/**
 * Contract C4 (v0): the plugin interfaces. Extractors read files and emit catalog records.
 * They never call a network service or an AI model, so every scan is deterministic.
 */

/** Read-only view of one repository at one commit. */
export interface RepoHandle {
  /** Repo name from the repo manifest. */
  readonly name: string;
  /** Commit SHA being scanned. */
  readonly commit: string;
  /** Repo-relative paths matching the extractor's claims. */
  listFiles(globs: readonly string[]): AsyncIterable<string>;
  readText(path: string): Promise<string>;
}

export interface ScanContext {
  /** Dialects that apply to this repo, by name. */
  readonly dialects: readonly string[];
  /** ISO timestamp of this scan, for evidence. */
  readonly scannedAt: string;
  /** Report a problem without failing the scan. */
  warn(message: string, path?: string): void;
}

export interface Extractor {
  /** Stable id, e.g. "spring". */
  readonly id: string;
  /** Semver; part of the scan cache key and of every record's evidence. */
  readonly version: string;
  /** File globs this extractor reads. */
  readonly claims: readonly string[];
  scan(repo: RepoHandle, ctx: ScanContext): AsyncIterable<CatalogRecord>;
}

export interface Ingestor {
  readonly id: string;
  readonly version: string;
  /** Return a confidence 0..1 that this file is something the ingestor understands. */
  sniff(fileName: string, head: Uint8Array): number;
  ingest(fileName: string, content: Uint8Array, ctx: ScanContext): AsyncIterable<CatalogRecord>;
}

/** Identity helper so plugin files get type checking with no boilerplate. */
export function defineExtractor(extractor: Extractor): Extractor {
  if (!/^[a-z][a-z0-9-]*$/.test(extractor.id)) {
    throw new Error(`extractor id "${extractor.id}" must be a lowercase slug`);
  }
  if (!/^\d+\.\d+\.\d+(-[0-9a-z.-]+)?$/i.test(extractor.version)) {
    throw new Error(`extractor version "${extractor.version}" must be semver`);
  }
  if (extractor.claims.length === 0) {
    throw new Error(`extractor "${extractor.id}" must claim at least one file glob`);
  }
  return extractor;
}

export interface CollectedScan {
  records: CatalogRecord[];
  rejected: { record: unknown; issues: RecordIssue[] }[];
  warnings: { message: string; path?: string }[];
}

/**
 * Run one extractor over one repo and validate everything it emits against contract C1.
 * Invalid records are collected, never written.
 */
export async function runExtractor(
  extractor: Extractor,
  repo: RepoHandle,
  options: { dialects?: string[]; scannedAt?: string } = {},
): Promise<CollectedScan> {
  const out: CollectedScan = { records: [], rejected: [], warnings: [] };
  const ctx: ScanContext = {
    dialects: options.dialects ?? [],
    scannedAt: options.scannedAt ?? new Date().toISOString(),
    warn: (message, path) => out.warnings.push(path ? { message, path } : { message }),
  };
  for await (const emitted of extractor.scan(repo, ctx)) {
    const result = parseRecord(emitted);
    if (result.ok) out.records.push(result.record);
    else out.rejected.push({ record: emitted, issues: result.issues });
  }
  return out;
}

/** An in-memory repo, for plugin tests and the fixture ecosystem. */
export function memoryRepo(
  name: string,
  commit: string,
  files: Record<string, string>,
): RepoHandle {
  const paths = Object.keys(files).sort();
  return {
    name,
    commit,
    async *listFiles(globs) {
      const matchers = globs.map(globToRegExp);
      for (const p of paths) if (matchers.some((m) => m.test(p))) yield p;
    },
    async readText(path) {
      const text = files[path];
      if (text === undefined) throw new Error(`no such file: ${path}`);
      return text;
    },
  };
}

/** Minimal glob support: "**" spans folders, "*" stays within one, "?" is one character. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
