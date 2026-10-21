import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { PluginExpected, type OrgPack, type ScannerPlugin } from "@maycombhq/core";
import {
  configHash,
  fsRepo,
  readPinnedEntry,
  sandboxedExtractor,
  scanRepo,
  type Extractor,
  type RepoScan,
} from "@maycombhq/sdk";

/**
 * Scanner plugins (ADR 0080): org-pack/plugins/<id>/, plain JavaScript the AI wrote as a
 * reviewed change. The scanner uses one only when its entry file matches the pin and its
 * golden tests pass, then runs it sandboxed (@maycombhq/sdk sandboxedExtractor) after the
 * built-ins, on the repos it applies to.
 */

export interface UsablePlugin {
  manifest: ScannerPlugin;
  dir: string;
  extractor: Extractor;
  /** Changes when the code or the limits change, so cached results aren't reused. */
  config: string;
}

export interface PluginTestResult {
  name: string;
  failures: string[];
}

const TEST_COMMIT = "0".repeat(40);
const TEST_AT = "2026-01-01T00:00:00Z";

/** JSON with object keys sorted, so a golden file's field order doesn't matter. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  );
}

/** The plugin as the sandbox runs it. */
export function pluginExtractor(manifest: ScannerPlugin, source: string): Extractor {
  return sandboxedExtractor({
    id: manifest.id,
    version: manifest.version,
    emits: manifest.emits,
    limits: manifest.limits,
    source,
    entry: manifest.entry,
  });
}

/**
 * Run a plugin against its golden files: test/<case>/repo/ and test/<case>/expected.yaml.
 * Each expected record must be produced with the fields listed; with `exact` (the default)
 * nothing else may be.
 */
export async function runPluginTests(
  dir: string,
  manifest: ScannerPlugin,
  source: string,
): Promise<PluginTestResult[]> {
  const cases = (await readdir(join(dir, "test"), { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const extractor = pluginExtractor(manifest, source);
  const results: PluginTestResult[] = [];
  for (const name of cases) {
    const failures: string[] = [];
    const caseDir = join(dir, "test", name);
    let want: PluginExpected;
    try {
      const parsed = PluginExpected.safeParse(
        parse(await readFile(join(caseDir, "expected.yaml"), "utf8")) ?? {},
      );
      if (!parsed.success) {
        results.push({
          name,
          failures: parsed.error.issues.map(
            (i) => `expected.yaml ${i.path.map(String).join(".")}: ${i.message}`,
          ),
        });
        continue;
      }
      want = parsed.data;
    } catch (e) {
      results.push({ name, failures: [`can't read expected.yaml: ${(e as Error).message}`] });
      continue;
    }
    const c = want.context;
    const scan = await scanRepo({
      repo: fsRepo(name, join(caseDir, "repo"), TEST_COMMIT),
      extractors: [extractor],
      dialects: c?.dialects ?? [],
      scannedAt: TEST_AT,
      repoInfo: {
        ...(c?.component ? { component: c.component } : {}),
        ...(c?.system ? { system: c.system } : {}),
        ...(c?.repoType ? { repoType: c.repoType } : {}),
      },
    });
    for (const run of scan.runs.filter((r) => r.status === "failed"))
      failures.push(run.error ?? "failed");
    for (const r of scan.rejected)
      failures.push(
        `produced an invalid record: ${r.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
      );
    const byId = new Map(
      scan.records.map((r) => [`${r.kind}/${r.id}`, r as unknown as Record<string, unknown>]),
    );
    for (const e of want.expect) {
      const got = byId.get(`${e.kind}/${e.id}`);
      if (!got) {
        failures.push(
          `expected ${e.kind} ${e.id}, got ${[...byId.keys()].join(", ") || "nothing"}`,
        );
        continue;
      }
      for (const [k, v] of Object.entries(e))
        if (canonical(got[k]) !== canonical(v))
          failures.push(`${e.id}.${k}: expected ${canonical(v)}, got ${canonical(got[k])}`);
    }
    if (want.exact) {
      const listed = new Set(want.expect.map((e) => `${e.kind}/${e.id}`));
      for (const k of byId.keys()) if (!listed.has(k)) failures.push(`${k} isn't expected`);
    }
    for (const id of want.absent)
      if (scan.records.some((r) => r.id === id)) failures.push(`${id} should not be produced`);
    results.push({ name, failures });
  }
  return results;
}

/** Does the plugin apply to this repo: its type ("*" for any), or a dialect it uses. */
export function pluginApplies(
  manifest: ScannerPlugin,
  repo: { type: string; dialects: readonly string[] },
): boolean {
  const a = manifest.appliesTo;
  return (
    a.repoTypes.includes("*") ||
    a.repoTypes.includes(repo.type) ||
    a.dialects.some((d) => repo.dialects.includes(d))
  );
}

/**
 * The org pack's enabled plugins that may run: pinned, unchanged since the pin, with golden
 * tests that pass (re-tested before each scan). Every other one is a problem, not used.
 */
export async function usablePlugins(
  op: OrgPack,
): Promise<{ plugins: UsablePlugin[]; problems: { source: string; message: string }[] }> {
  const plugins: UsablePlugin[] = [];
  const problems: { source: string; message: string }[] = [];
  for (const { manifest, dir } of op.plugins) {
    if (!manifest.enabled) continue;
    const source = `plugin ${manifest.id}`;
    const notUsed = (message: string) =>
      problems.push({ source, message: `${message}; the plugin is not used` });
    const entry = await readPinnedEntry(dir, manifest);
    if (!entry.ok) {
      notUsed(entry.message);
      continue;
    }
    const results = await runPluginTests(dir, manifest, entry.source);
    if (results.length === 0) {
      notUsed("has no golden tests (test/<case>/repo/ and expected.yaml)");
      continue;
    }
    const failed = results.flatMap((r) => r.failures.map((f) => `test "${r.name}": ${f}`));
    if (failed.length > 0) {
      for (const f of failed) notUsed(f);
      continue;
    }
    plugins.push({
      manifest,
      dir,
      extractor: pluginExtractor(manifest, entry.source),
      config: configHash({ plugin: `${manifest.sha256}|${JSON.stringify(manifest.limits)}` }),
    });
  }
  return { plugins, problems };
}

/** One repo's scan with the plugins' run added after the built-ins'. */
export function withPluginScan(scan: RepoScan, extra: RepoScan): RepoScan {
  return {
    ...scan,
    records: [...scan.records, ...extra.records].sort((a, b) =>
      a.kind === b.kind ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.kind < b.kind ? -1 : 1,
    ),
    runs: [...scan.runs, ...extra.runs],
    warnings: [...scan.warnings, ...extra.warnings],
    rejected: [...scan.rejected, ...extra.rejected],
  };
}
