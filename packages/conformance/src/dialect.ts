import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { Dialect } from "@maycombhq/core";
import { runDialectTests } from "@maycombhq/extractors";
import { Results, type ConformanceReport } from "./report.js";

/**
 * Conformance of one dialect rule file to C2 (ADR 0011, 0016): it matches the schema, the
 * dialects it extends are found next to it, and its own tests pass. A dialect whose tests fail
 * doesn't load in a scan, so a failing test fails the run.
 */
export async function checkDialect(file: string): Promise<ConformanceReport> {
  const res = new Results();
  let data: unknown;
  try {
    data = parse(await readFile(file, "utf8"));
  } catch (e) {
    res.fail(
      "dialect.yaml",
      `Can't read this file as YAML: ${(e as Error).message.split("\n")[0]}`,
    );
    return res.report("dialect", file);
  }
  const p = Dialect.safeParse(data);
  if (!p.success) {
    for (const i of p.error.issues)
      res.fail("dialect.schema", `${i.path.join(".") || "(file)"}: ${i.message}`);
    return res.report("dialect", file);
  }
  const d = p.data;
  res.pass("dialect.schema", `Dialect ${d.name} ${d.version} matches C2.`);

  // Parents are other dialect files in the same folder.
  const parents = new Map<string, Dialect>();
  const dir = dirname(file);
  for (const n of (await readdir(dir).catch(() => [] as string[])).filter((x) =>
    /\.ya?ml$/.test(x),
  )) {
    try {
      const other = Dialect.safeParse(parse(await readFile(join(dir, n), "utf8")));
      if (other.success && other.data.name !== d.name) parents.set(other.data.name, other.data);
    } catch {
      // not a dialect: ignore
    }
  }
  const missing = d.extends.filter((x) => !parents.has(x));
  if (missing.length > 0)
    res.fail("dialect.extends", `Extends ${missing.join(", ")}, which isn't in the same folder.`);
  else if (d.extends.length > 0) res.pass("dialect.extends", `Extends ${d.extends.join(", ")}.`);

  if (d.tests.length === 0) res.fail("dialect.tests", "A dialect must ship at least one test.");
  else if (missing.length > 0)
    res.fail("dialect.tests", "Tests not run: they need the dialects it extends.");
  else {
    const failures = await runDialectTests(d, dir, parents);
    for (const f of failures) res.fail("dialect.tests", `${f.test}: ${f.message}`);
    res.passUnlessFailed("dialect.tests", `All ${d.tests.length} tests pass.`);
  }
  return res.report("dialect", file);
}
