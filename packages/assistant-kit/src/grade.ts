import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { loadDialectFile } from "./load.js";
import { runDialectOnRepo, testDialect, type DialectTestResult } from "./run.js";

/**
 * The M2 exit evaluation: does a dialect an assistant wrote from the kit alone do the job?
 * It must be valid C2, ship tests that pass (and that expect something), and produce
 * exactly the hand-written expected records from every eval repo, including a held-out
 * repo the assistant never saw, which catches rules that name the eval repos' values.
 */

export interface ExpectedRecord {
  kind: string;
  id: string;
  [field: string]: unknown;
}

export interface EvalExpectations {
  dialect: string;
  repos: { path: string; records: ExpectedRecord[] }[];
}

export interface RepoGrade {
  path: string;
  expected: number;
  /** Expected records produced with every listed field right. */
  matched: number;
  /** Records produced of the kinds the expectations cover. */
  produced: number;
  missing: string[];
  wrong: { record: string; field: string; expected: unknown; got: unknown }[];
  extra: string[];
  rejected: string[];
  warnings: string[];
}

export interface GradeResult {
  pass: boolean;
  dialect?: { name: string; version: string };
  problems: string[];
  tests: DialectTestResult[];
  repos: RepoGrade[];
  expected: number;
  matched: number;
  produced: number;
  precision: number;
  recall: number;
}

const key = (r: { kind: string; id: string }) => `${r.kind}/${r.id}`;

export async function loadExpectations(evalDir: string): Promise<EvalExpectations> {
  const e = parse(await readFile(join(evalDir, "expected.yaml"), "utf8")) as EvalExpectations;
  if (!e || typeof e.dialect !== "string" || !Array.isArray(e.repos))
    throw new Error(`${join(evalDir, "expected.yaml")} needs dialect and repos`);
  return e;
}

/** Grade a candidate dialect file against an eval folder (expected.yaml and its repos). */
export async function gradeDialect(dialectFile: string, evalDir: string): Promise<GradeResult> {
  const want = await loadExpectations(evalDir);
  const kinds = new Set(want.repos.flatMap((r) => r.records.map((x) => x.kind)));
  const expected = want.repos.reduce((n, r) => n + r.records.length, 0);
  const result: GradeResult = {
    pass: false,
    problems: [],
    tests: [],
    repos: [],
    expected,
    matched: 0,
    produced: 0,
    precision: 0,
    recall: 0,
  };

  const loaded = await loadDialectFile(dialectFile);
  result.problems.push(
    ...loaded.problems.map((p) => (p.path ? `${p.path}: ${p.message}` : p.message)),
  );
  const d = loaded.dialect;
  if (!d) return result;
  result.dialect = { name: d.name, version: d.version };
  if (d.name !== want.dialect)
    result.problems.push(`the task asks for a dialect named ${want.dialect}, not ${d.name}`);

  result.tests = await testDialect(d, loaded.dir, loaded.parents);
  if (d.tests.every((t) => t.expect.length === 0))
    result.problems.push(
      "the dialect's tests expect no records; at least one test must list the records it expects",
    );

  for (const repo of want.repos) {
    const g: RepoGrade = {
      path: repo.path,
      expected: repo.records.length,
      matched: 0,
      produced: 0,
      missing: [],
      wrong: [],
      extra: [],
      rejected: [],
      warnings: [],
    };
    result.repos.push(g);
    const dir = join(evalDir, ...repo.path.split("/"));
    if (
      !(await stat(dir)
        .then((s) => s.isDirectory())
        .catch(() => false))
    ) {
      result.problems.push(`eval repo ${repo.path} is missing`);
      g.missing.push(...repo.records.map(key));
      continue;
    }
    const run = await runDialectOnRepo(d, loaded.parents, dir);
    if (run.error) result.problems.push(`${repo.path}: the dialect failed: ${run.error}`);
    g.warnings = run.warnings.map((w) => `${w.message}${w.path ? ` (${w.path})` : ""}`);
    g.rejected = run.rejected.map((r) => {
      const rec = r.record as { kind?: string; id?: string };
      return `${rec.kind ?? "?"}/${rec.id ?? "?"}: ${r.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`;
    });
    const got = new Map(
      run.records
        .map((x) => x.record as unknown as Record<string, unknown> & { kind: string; id: string })
        .filter((r) => kinds.has(r.kind))
        .map((r) => [key(r), r]),
    );
    g.produced = got.size;
    const wanted = new Set(repo.records.map(key));
    for (const w of repo.records) {
      const r = got.get(key(w));
      if (!r) {
        g.missing.push(key(w));
        continue;
      }
      const diffs = Object.entries(w)
        .filter(([f, v]) => JSON.stringify(r[f]) !== JSON.stringify(v))
        .map(([field, v]) => ({ record: key(w), field, expected: v, got: r[field] }));
      if (diffs.length === 0) g.matched++;
      else g.wrong.push(...diffs);
    }
    g.extra = [...got.keys()].filter((k) => !wanted.has(k));
  }

  result.matched = result.repos.reduce((n, r) => n + r.matched, 0);
  result.produced = result.repos.reduce((n, r) => n + r.produced, 0);
  result.recall = expected === 0 ? 1 : result.matched / expected;
  result.precision =
    result.produced === 0 ? (expected === 0 ? 1 : 0) : result.matched / result.produced;
  result.pass =
    result.problems.length === 0 &&
    result.tests.length > 0 &&
    result.tests.every((t) => t.passed) &&
    result.repos.every(
      (r) =>
        r.missing.length === 0 &&
        r.wrong.length === 0 &&
        r.extra.length === 0 &&
        r.rejected.length === 0,
    );
  return result;
}

/** A grade as lines a person reads; the last line is the verdict. */
export function formatGrade(g: GradeResult): string[] {
  const L: string[] = [];
  if (g.dialect) L.push(`Dialect ${g.dialect.name} ${g.dialect.version}`);
  for (const p of g.problems) L.push(`problem: ${p}`);
  if (g.tests.length > 0) {
    const failed = g.tests.filter((t) => !t.passed);
    L.push(`Tests: ${g.tests.length - failed.length} of ${g.tests.length} passed`);
    for (const t of failed) for (const f of t.failures) L.push(`  FAIL ${t.name}: ${f}`);
  }
  for (const r of g.repos) {
    L.push(
      `${r.path}: ${r.matched} of ${r.expected} expected records right, ${r.produced} produced`,
    );
    for (const m of r.missing) L.push(`  missing ${m}`);
    for (const w of r.wrong)
      L.push(
        `  wrong ${w.record}.${w.field}: expected ${JSON.stringify(w.expected)}, got ${JSON.stringify(w.got)}`,
      );
    for (const x of r.extra) L.push(`  extra ${x}`);
    for (const x of r.rejected) L.push(`  invalid ${x}`);
    for (const x of r.warnings) L.push(`  warning ${x}`);
  }
  L.push(
    `${g.pass ? "PASS" : "FAIL"}: ${g.matched} of ${g.expected} expected records, precision ${g.precision.toFixed(2)}, recall ${g.recall.toFixed(2)}`,
  );
  return L;
}
