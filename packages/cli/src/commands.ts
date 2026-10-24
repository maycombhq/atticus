import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  catalogJsonSchemas,
  deserializeRecord,
  aiJsonSchemas,
  executorJsonSchemas,
  openApiDocument,
  loadOrgPack,
  orgPackJsonSchemas,
  rulesJsonSchemas,
  workspaceJsonSchemas,
  recordPath,
  serializeRecord,
} from "@maycombhq/core";

export interface Output {
  out(line: string): void;
  err(line: string): void;
  /**
   * What a step says as data beside its lines, for a tool that runs it (`--handoff --json`):
   * the run it handed off or waits on, how many pages a batched scan left. Never read back from
   * the printed words.
   */
  report?(fact: StepFact): void;
}

/** One fact a step reports as data (Output.report). */
export type StepFact = { handoff: { runId: string; lens?: string } } | { pagesLeft: number };

/**
 * Write JSON Schema files: one per record kind under `<dir>/catalog/`, and the workspace
 * files under `<dir>/workspace/`. Returns the number written.
 */
export async function schemaExport(dir: string, io: Output): Promise<number> {
  const groups: [string, Record<string, object>][] = [
    ["catalog", catalogJsonSchemas()],
    ["workspace", workspaceJsonSchemas()],
    ["rules", rulesJsonSchemas()],
    ["orgpack", orgPackJsonSchemas()],
    ["ai", aiJsonSchemas()],
    ["executors", executorJsonSchemas()],
  ];
  let n = 0;
  for (const [group, schemas] of groups) {
    await mkdir(join(dir, group), { recursive: true });
    for (const [name, schema] of Object.entries(schemas)) {
      await writeFile(
        join(dir, group, `${name}.json`),
        JSON.stringify(schema, null, 2) + "\n",
        "utf8",
      );
      n++;
    }
  }
  await mkdir(join(dir, "api"), { recursive: true });
  await writeFile(
    join(dir, "api", "openapi.json"),
    JSON.stringify(openApiDocument(), null, 2) + "\n",
    "utf8",
  );
  io.out(`Wrote ${n} schemas and the API document to ${dir}`);
  return n;
}

async function* yamlFiles(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* yamlFiles(full);
    else if (e.isFile() && /\.ya?ml$/i.test(e.name)) yield full;
  }
}

export interface ValidateSummary {
  files: number;
  invalid: number;
  misplaced: number;
  notCanonical: number;
  fixed: number;
}

/**
 * Validate every record file under a catalog folder: schema (C1), file location
 * (kind/id.yaml) and canonical formatting. With fix, rewrites non-canonical files.
 */
export async function catalogValidate(
  dir: string,
  options: { fix?: boolean },
  io: Output,
): Promise<ValidateSummary> {
  const summary: ValidateSummary = {
    files: 0,
    invalid: 0,
    misplaced: 0,
    notCanonical: 0,
    fixed: 0,
  };
  for await (const file of yamlFiles(dir)) {
    summary.files++;
    const rel = relative(dir, file).split(sep).join("/");
    const text = await readFile(file, "utf8");
    const result = deserializeRecord(text);
    if (!result.ok) {
      summary.invalid++;
      for (const issue of result.issues)
        io.err(`${rel}: ${issue.path || "(root)"}: ${issue.message}`);
      continue;
    }
    const expected = recordPath(result.record);
    if (rel !== expected && !rel.endsWith("/" + expected)) {
      summary.misplaced++;
      io.err(`${rel}: should be at ${expected}`);
    }
    const canonical = serializeRecord(result.record);
    if (canonical !== text.replace(/\r\n/g, "\n")) {
      if (options.fix) {
        await writeFile(file, canonical, "utf8");
        summary.fixed++;
        io.out(`${rel}: rewritten in canonical form`);
      } else {
        summary.notCanonical++;
        io.err(`${rel}: not in canonical form (run with --fix)`);
      }
    }
  }
  const problems = summary.invalid + summary.misplaced + summary.notCanonical;
  io.out(
    `${summary.files} files checked: ${problems === 0 ? "all valid" : `${problems} with problems`}` +
      (summary.fixed ? `, ${summary.fixed} fixed` : ""),
  );
  return summary;
}

/** Validate an org pack: every file against C6, C2 and C3, plus cross-file references. */
export async function orgPackValidate(dir: string, io: Output): Promise<number> {
  const op = await loadOrgPack(dir);
  for (const p of op.problems) io.err(`${p.file}${p.path ? ` (${p.path})` : ""}: ${p.message}`);
  const counts = [
    `${op.profiles.length} profiles`,
    `${op.patterns.length} patterns`,
    `${op.dialects.length} dialects`,
    `${op.checklists.length} checklist packs`,
    `${op.skills.length} skills`,
    `${op.serviceRequests.length} request templates`,
    ...(op.repoTypes.length ? [`${op.repoTypes.length} repo types`] : []),
  ].join(", ");
  io.out(`${counts}${op.defaulted.length ? `; defaults used for ${op.defaulted.join(", ")}` : ""}`);
  io.out(op.problems.length === 0 ? "Org pack is valid" : `${op.problems.length} problems`);
  return op.problems.length === 0 ? 0 : 1;
}
