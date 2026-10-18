import { stat } from "node:fs/promises";
import { join } from "node:path";
import { loadOrgPack, orgPackDirOf } from "@maycombhq/core";
import { runDialectTests } from "@maycombhq/extractors";
import { Results, type ConformanceReport } from "./report.js";

const isDir = async (p: string) => (await stat(p).catch(() => undefined))?.isDirectory() ?? false;

/** The org-pack folder: a metarepo's (or adopted repo's) when the target holds one, else the target. */
export async function orgPackFolder(target: string): Promise<string> {
  if (
    (await isDir(join(target, "org-pack"))) ||
    (await isDir(join(target, ".atticus", "org-pack")))
  )
    return orgPackDirOf(target);
  return target;
}

/**
 * Conformance of an org pack to C6 (ADR 0012): every file matches its schema, the cross-file
 * rules hold (roles named by gates and change types exist, patterns and procedures are
 * consistent, and so on, as `loadOrgPack` checks them), and every dialect in the pack passes
 * its own tests (C2). Files the pack leaves out fall back to built-in defaults; they are listed,
 * not failed.
 */
export async function checkOrgPack(target: string): Promise<ConformanceReport> {
  const res = new Results();
  const dir = await orgPackFolder(target);
  if (!(await isDir(dir))) {
    res.fail("orgpack.folder", `No org-pack folder at ${dir}.`);
    return res.report("org-pack", target);
  }
  const pack = await loadOrgPack(dir);
  for (const p of pack.problems)
    res.fail(
      p.path ? "orgpack.schema" : "orgpack.file",
      `${p.path ? `${p.path}: ` : ""}${p.message}`,
      p.file,
    );
  res.passUnlessFailed("orgpack.file", "Every org-pack file reads as YAML or Markdown.");
  res.passUnlessFailed("orgpack.schema", "Every file matches C6 and the cross-file rules hold.");
  if (!pack.pack) res.warn("orgpack.manifest", "No pack.yaml: the pack has no name or version.");
  else res.pass("orgpack.manifest", `Pack ${pack.pack.name} ${pack.pack.version}.`);
  if (pack.defaulted.length > 0)
    res.pass("orgpack.defaults", `Built-in defaults used for: ${pack.defaulted.join(", ")}.`);

  const byName = new Map(pack.dialects.map((d) => [d.name, d]));
  for (const d of pack.dialects) {
    const failures = await runDialectTests(d, join(dir, "dialects"), byName);
    for (const f of failures)
      res.fail(
        "orgpack.dialect-tests",
        `${d.name}: ${f.test}: ${f.message}`,
        `dialects/${d.name}.yaml`,
      );
  }
  res.passUnlessFailed(
    "orgpack.dialect-tests",
    pack.dialects.length > 0
      ? `Every dialect passes its tests (${pack.dialects.map((d) => d.name).join(", ")}).`
      : "No dialects in the pack.",
  );
  res.pass(
    "orgpack.count",
    `${pack.gates.gates.length} gates, ${pack.changeTypes.types.length} change types, ${pack.patterns.length} patterns, ${pack.dialects.length} dialects, ${pack.checklists.length} checklists, ${pack.procedures.length} procedures.`,
  );
  return res.report("org-pack", target);
}
