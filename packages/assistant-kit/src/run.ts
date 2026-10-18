import { basename, resolve } from "node:path";
import type { CatalogRecord, Dialect, RecordIssue } from "@maycombhq/core";
import { dialectExtractor, runDialectTests } from "@maycombhq/extractors";
import { fsRepo, scanRepo, type RepoHandle } from "@maycombhq/sdk";
import { mergedRules } from "./load.js";

const NO_COMMIT = "0".repeat(40);
/** A fixed timestamp: dialect runs and grading must not depend on the clock. */
const SCANNED_AT = "2026-01-01T00:00:00Z";

export interface DialectTestResult {
  name: string;
  passed: boolean;
  failures: string[];
}

/**
 * Run a dialect's own tests and group the failures by test, so each test can be shown as
 * passed or failed. A load error (a missing parent, a cycle) fails every test.
 */
export async function testDialect(
  dialect: Dialect,
  dir: string,
  parents: Map<string, Dialect> = new Map(),
): Promise<DialectTestResult[]> {
  let failures: { test: string; message: string }[];
  try {
    failures = await runDialectTests(dialect, dir, parents);
  } catch (e) {
    const message = `the dialect could not load: ${(e as Error).message}`;
    return dialect.tests.map((t) => ({ name: t.name, passed: false, failures: [message] }));
  }
  const seen = new Set<string>();
  const out: DialectTestResult[] = [];
  for (const t of dialect.tests) {
    // Failures carry only the test name; tests sharing a name share their failures.
    if (seen.has(t.name)) continue;
    seen.add(t.name);
    const mine = failures.filter((f) => f.test === t.name).map((f) => f.message);
    out.push({ name: t.name, passed: mine.length === 0, failures: mine });
  }
  return out;
}

export interface RunRecord {
  record: CatalogRecord;
  /** The rule that produced it (the first by id when several produce the same record). */
  rule?: string;
}

export interface DialectRun {
  repo: string;
  /** False when the dialect's marker file is not in the repo. */
  applies: boolean;
  records: RunRecord[];
  warnings: { message: string; path?: string }[];
  rejected: { record: unknown; issues: RecordIssue[] }[];
  /** Set when the dialect failed to run at all. */
  error?: string;
}

async function hasFile(repo: RepoHandle, glob: string): Promise<boolean> {
  for await (const _ of repo.listFiles([glob])) return true;
  return false;
}

async function scanWith(repo: RepoHandle, dialect: Dialect, parents: Map<string, Dialect>) {
  return scanRepo({
    repo,
    extractors: [dialectExtractor(dialect, parents)],
    dialects: [dialect.name],
    scannedAt: SCANNED_AT,
  });
}

/**
 * Run a dialect over one repo folder, as the scanner would when the repo lists the dialect.
 * Each record is tagged with the rule that produced it, which the evidence doesn't carry,
 * so an assistant can see which rule to fix.
 */
export async function runDialectOnRepo(
  dialect: Dialect,
  parents: Map<string, Dialect>,
  repoDir: string,
): Promise<DialectRun> {
  const dir = resolve(repoDir);
  const repo = fsRepo(basename(dir), dir, NO_COMMIT);
  const out: DialectRun = {
    repo: repo.name,
    applies: true,
    records: [],
    warnings: [],
    rejected: [],
  };
  if (dialect.appliesTo.marker && !(await hasFile(repo, dialect.appliesTo.marker))) {
    out.applies = false;
    return out;
  }
  let scan;
  try {
    scan = await scanWith(repo, dialect, parents);
  } catch (e) {
    out.error = (e as Error).message;
    return out;
  }
  const failed = scan.runs.find((r) => r.status === "failed");
  if (failed) out.error = failed.error ?? "the dialect failed";
  out.warnings = scan.warnings.map((w) =>
    w.path ? { message: w.message, path: w.path } : { message: w.message },
  );
  out.rejected = scan.rejected.map((r) => ({ record: r.record, issues: r.issues }));

  const ruleOf = new Map<string, string>();
  const rules = mergedRules(dialect, parents);
  if (rules.length > 1) {
    for (const rule of rules) {
      const single = { ...dialect, extends: [], rules: [rule] };
      const s = await scanWith(repo, single, new Map()).catch(() => undefined);
      for (const r of s?.records ?? []) {
        const key = `${r.kind}/${r.id}`;
        if (!ruleOf.has(key)) ruleOf.set(key, rule.id);
      }
    }
  } else if (rules.length === 1) {
    for (const r of scan.records) ruleOf.set(`${r.kind}/${r.id}`, rules[0]!.id);
  }
  out.records = scan.records.map((record) => {
    const rule = ruleOf.get(`${record.kind}/${record.id}`);
    return rule ? { record, rule } : { record };
  });
  return out;
}
