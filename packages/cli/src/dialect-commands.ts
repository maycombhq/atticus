import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { stringify } from "yaml";
import { RecordId, orgPackDirOf } from "@maycombhq/core";
import {
  candidateAnnotations,
  dialectFilePath,
  exportKit,
  formatGrade,
  gradeDialect,
  loadDialectFile,
  runDialectOnRepo,
  scaffoldDialect,
  surveyRepos,
  testDialect,
  type LoadedDialect,
} from "@maycombhq/assistant-kit";
import {
  SYNTAX_LANGUAGES,
  syntaxLanguageOf,
  syntaxOutline,
  type SyntaxLanguage,
} from "@maycombhq/extractors";
import type { Output } from "./commands.js";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const shown = (root: string, file: string) => relative(root, file).split(sep).join("/");
const isDir = (p: string) =>
  stat(p)
    .then((s) => s.isDirectory())
    .catch(() => false);

/**
 * atticus dialect new <name> --from <repo>...: survey the repos and write a scaffold to
 * org-pack/dialects/<name>.yaml. Never overwrites. Exit 0 written, 1 file exists, 2 usage.
 */
export async function dialectNew(
  root: string,
  name: string,
  repoDirs: string[],
  io: Output,
): Promise<number> {
  if (!RecordId.safeParse(name).success) {
    io.err(
      'A dialect name is a lowercase slug (a-z, 0-9, ".", "_" and "-"), for example: forge-messaging',
    );
    return 2;
  }
  if (repoDirs.length === 0) {
    io.err(
      "dialect new needs at least one repo folder, for example: atticus dialect new house --from repos/a repos/b",
    );
    return 2;
  }
  const dirs = repoDirs.map((d) => resolve(d));
  for (const d of dirs) {
    if (!(await isDir(d))) {
      io.err(`${d} is not a folder.`);
      return 2;
    }
  }
  const file = join(orgPackDirOf(root), "dialects", `${name}.yaml`);
  const existing = await dialectFilePath(join(orgPackDirOf(root)), name);
  if (existing) {
    io.err(
      `${shown(root, existing)} already exists; it was left as it is. Choose another name or edit that file.`,
    );
    return 1;
  }
  const survey = await surveyRepos(dirs);
  await mkdir(join(orgPackDirOf(root), "dialects"), { recursive: true });
  await writeFile(file, scaffoldDialect(name, survey), { encoding: "utf8", flag: "wx" });
  const house = survey.annotations.filter((a) => !a.known).length;
  io.out(
    `Wrote ${shown(root, file)} from ${plural(survey.repos.length, "repo")}: ${survey.marker ? `marker ${survey.marker}` : "no marker every repo has"}, ${plural(house, "framework annotation")}, ${plural(candidateAnnotations(survey).length, "candidate rule")}, ${plural(survey.configKeys.length, "config key")}.`,
  );
  io.out(`Next: finish the rules and write tests, then run atticus dialect test ${name}.`);
  return 0;
}

/** Load org-pack/dialects/<name>.yaml, printing why when it can't be used. */
async function load(
  root: string,
  name: string,
  io: Output,
  allowNoTests: boolean,
): Promise<LoadedDialect | undefined> {
  const file = await dialectFilePath(join(orgPackDirOf(root)), name);
  if (!file) {
    io.err(
      `No dialect file org-pack/dialects/${name}.yaml. Create one with: atticus dialect new ${name} --from <repo>...`,
    );
    return undefined;
  }
  const loaded = await loadDialectFile(file, { allowNoTests, checkFileName: true });
  if (!loaded.dialect) {
    const yamlProblem = loaded.problems.find(
      (p) => p.path === "" && p.message.startsWith("not valid YAML"),
    );
    if (yamlProblem) io.err(`${shown(root, file)} is ${yamlProblem.message}`);
    else {
      io.err(`${shown(root, file)} is not a valid dialect (contract C2):`);
      for (const p of loaded.problems) io.err(`  ${p.path ? `${p.path}: ` : ""}${p.message}`);
    }
    return undefined;
  }
  return loaded;
}

/**
 * atticus dialect test <name>: validate the dialect and run its tests, printing pass or
 * FAIL per test. Exit 0 all pass, 1 problems or failures.
 */
export async function dialectTest(root: string, name: string, io: Output): Promise<number> {
  const loaded = await load(root, name, io, false);
  if (!loaded) return 1;
  const d = loaded.dialect!;
  io.out(
    `Testing dialect ${d.name} ${d.version}: ${plural(d.rules.length, "rule")}, ${plural(d.tests.length, "test")}`,
  );
  const results = await testDialect(d, loaded.dir, loaded.parents);
  for (const r of results) {
    io.out(`  ${r.passed ? "pass" : "FAIL"}  ${r.name}`);
    for (const f of r.failures) io.out(`          ${f}`);
  }
  const failed = results.filter((r) => !r.passed).length;
  if (failed === 0) {
    io.out(`${plural(results.length, "test")} passed.`);
    return 0;
  }
  io.out(
    `${failed} of ${plural(results.length, "test")} failed. To see what the rules produce from a repo: atticus dialect run ${d.name} <repo>`,
  );
  return 1;
}

/** Fields worth showing: the engine's bookkeeping and empty defaults are left out. */
function shownFields(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    kind: record.kind,
    id: record.id,
    confidence: record.confidence,
  };
  for (const [k, v] of Object.entries(record)) {
    if (["kind", "id", "confidence", "schemaVersion", "status", "evidence"].includes(k)) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) continue;
    out[k] = v;
  }
  return out;
}

/**
 * atticus dialect run <name> <repo>: print the records the dialect produces from one repo,
 * as YAML ready for a test's expect list. Exit 0 ok, 1 when a record fails C1 or the
 * dialect fails.
 */
export async function dialectRun(
  root: string,
  name: string,
  repoDir: string,
  o: { json?: boolean },
  io: Output,
): Promise<number> {
  const dir = resolve(repoDir);
  if (!(await isDir(dir))) {
    io.err(`${dir} is not a folder.`);
    return 2;
  }
  const loaded = await load(root, name, io, true);
  if (!loaded) return 1;
  const d = loaded.dialect!;
  const run = await runDialectOnRepo(d, loaded.parents, dir);
  if (o.json) {
    io.out(
      JSON.stringify(
        {
          applies: run.applies,
          records: run.records.map((r) => r.record),
          warnings: run.warnings,
          rejected: run.rejected,
          ...(run.error ? { error: run.error } : {}),
        },
        null,
        2,
      ),
    );
    return run.rejected.length > 0 || run.error ? 1 : 0;
  }
  if (!run.applies) {
    io.out(
      `The marker ${d.appliesTo.marker} is not in ${run.repo}, so the dialect does not apply there. 0 records.`,
    );
    return 0;
  }
  if (run.error) io.err(`The dialect failed: ${run.error}`);
  for (const { record, rule } of run.records) {
    const fields = shownFields(record as unknown as Record<string, unknown>);
    const lines = stringify([fields], { lineWidth: 0 }).trimEnd().split("\n");
    for (const l of lines) io.out(l);
    const ev = record.evidence[0];
    io.out(`  # from ${ev?.path ?? "?"}:${ev?.line ?? "?"}${rule ? ` (rule ${rule})` : ""}`);
  }
  for (const w of run.warnings) io.out(`warning: ${w.message}${w.path ? ` (${w.path})` : ""}`);
  for (const r of run.rejected) {
    const rec = r.record as {
      kind?: string;
      id?: string;
      evidence?: { path?: string; line?: number }[];
    };
    const at = rec.evidence?.[0];
    io.out(
      `invalid: ${rec.kind ?? "?"} ${rec.id ?? "?"} from ${at?.path ?? "?"}:${at?.line ?? "?"}: ${r.issues.map((i) => `${i.path ? `${i.path}: ` : ""}${i.message}`).join("; ")}`,
    );
  }
  io.out(
    `${plural(run.records.length, "record")} from ${run.repo}.${loaded.noTests ? " This dialect has no tests yet; atticus dialect test fails until it has one." : ""}`,
  );
  return run.rejected.length > 0 || run.error ? 1 : 0;
}

/** atticus dialect kit <dir>: export the build kit for an assistant. */
export async function dialectKit(outDir: string, io: Output): Promise<number> {
  const files = await exportKit(outDir);
  io.out(`Wrote the dialect build kit (${files.length} files) to ${outDir}`);
  return 0;
}

/**
 * atticus dialect grade <file> <eval-dir>: grade a dialect against an eval folder (the M2
 * exit check). Exit 0 pass, 1 fail. Not part of the kit: the assistant never sees expected.yaml.
 */
export async function dialectGrade(file: string, evalDir: string, io: Output): Promise<number> {
  const g = await gradeDialect(resolve(file), resolve(evalDir));
  for (const l of formatGrade(g)) io.out(l);
  return g.pass ? 0 : 1;
}

/**
 * atticus dialect tree <file> [--language l]: print a file's syntax tree, with the node names a
 * syntax match's query uses (ADR 0060).
 */
export async function dialectTree(
  file: string,
  o: { language?: string },
  io: Output,
): Promise<number> {
  const lang = (o.language ?? syntaxLanguageOf(file)) as SyntaxLanguage | undefined;
  if (!lang || !(SYNTAX_LANGUAGES as readonly string[]).includes(lang)) {
    io.err(
      `No grammar for ${file}${o.language ? ` (${o.language})` : ""}. Grammars: ${SYNTAX_LANGUAGES.join(", ")}.`,
    );
    return 2;
  }
  const text = await readFile(resolve(file), "utf8").catch(() => undefined);
  if (text === undefined) {
    io.err(`${file} can't be read.`);
    return 2;
  }
  io.out(await syntaxOutline(lang, text, Number.MAX_SAFE_INTEGER));
  return 0;
}
