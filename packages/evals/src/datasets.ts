import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import { referenceAnswers } from "./fixtures.js";
import { SUITES, type CaseDef } from "./suites.js";
import type { EvalCase } from "./types.js";

/**
 * Datasets: one YAML file per agent family in this package's `datasets/` folder, plus an
 * organisation's own in `org-pack/evals/*.yaml`. A dataset names its suite and lists cases with
 * params, expectations, and where the mock answer and replay recordings come from (paths in
 * the Atticus checkout for the built-in datasets: they reuse the fixtures, never copy them).
 */

export const DATASETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "datasets");

const Mode = z.enum(["mock", "replay", "live"]);

const CaseFile = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  agent: z.string().min(1),
  description: z.string().min(1),
  modes: z.array(Mode).min(1).default(["mock", "replay", "live"]),
  aiGraded: z.boolean().default(true),
  tags: z.array(z.string()).default([]),
  params: z.record(z.string(), z.unknown()).default({}),
  expect: z.record(z.string(), z.unknown()).default({}),
  /** The mock runtime's answer: a recordings folder (by agent), a file, or the text. */
  reference: z
    .union([
      z.strictObject({ recordings: z.string().min(1) }),
      z.strictObject({ file: z.string().min(1) }),
      z.strictObject({ output: z.string() }),
    ])
    .optional(),
  /** Folder of replay recordings, relative to the checkout (or the dataset for org datasets). */
  recordings: z.string().optional(),
});

export const DatasetFile = z.strictObject({
  schemaVersion: z.literal(1),
  suite: z.enum(Object.keys(SUITES) as [string, ...string[]]),
  description: z.string().min(1),
  cases: z.array(CaseFile).min(1),
});
export type DatasetFile = z.infer<typeof DatasetFile>;

export interface LoadedDatasets {
  cases: EvalCase[];
  problems: string[];
  /** Built-in datasets left out because the fixtures they read aren't here. */
  unavailable: string[];
}

async function load(
  file: string,
  label: string,
  baseDir: string | undefined,
  out: LoadedDatasets,
): Promise<void> {
  let ds: DatasetFile;
  try {
    const r = DatasetFile.safeParse(parse(await readFile(file, "utf8")));
    if (!r.success) {
      out.problems.push(
        `${label}: ${r.error.issues.map((i) => `${i.path.join(".") || "(file)"} ${i.message}`).join("; ")}`,
      );
      return;
    }
    ds = r.data;
  } catch (e) {
    out.problems.push(`${label}: ${(e as Error).message.split("\n")[0]}`);
    return;
  }
  if (ds.suite !== "generic" && !baseDir) {
    out.unavailable.push(`${label}: its fixtures are in the Atticus checkout, which isn't here`);
    return;
  }
  const at = (p: string) => (baseDir ? join(baseDir, p) : join(dirname(file), p));
  for (const c of ds.cases) {
    let reference: Record<string, string> | undefined;
    if (c.reference && "recordings" in c.reference)
      reference = referenceAnswers(at(c.reference.recordings));
    else if (c.reference && "file" in c.reference)
      reference = { [c.agent]: await readFile(at(c.reference.file), "utf8").catch(() => "") };
    else if (c.reference && "output" in c.reference) reference = { [c.agent]: c.reference.output };
    const def: CaseDef = {
      id: c.id,
      agent: c.agent,
      description: c.description,
      modes: c.modes,
      aiGraded: c.aiGraded,
      tags: c.tags,
      params: c.params,
      expect: c.expect,
      ...(reference ? { reference } : {}),
      ...(c.recordings ? { recordings: at(c.recordings) } : {}),
      source: label,
    };
    if (out.cases.some((x) => x.id === def.id)) {
      out.problems.push(`${label}: case ${def.id} is already defined`);
      continue;
    }
    out.cases.push(SUITES[ds.suite]!(def, baseDir ?? dirname(file)));
  }
}

/** The built-in datasets (when the checkout's fixtures are here) and the org pack's. */
export async function loadDatasets(o: {
  repoRoot?: string;
  orgPackDir?: string;
  dir?: string;
}): Promise<LoadedDatasets> {
  const out: LoadedDatasets = { cases: [], problems: [], unavailable: [] };
  const dir = o.dir ?? DATASETS_DIR;
  for (const n of (await readdir(dir).catch(() => [] as string[]))
    .filter((x) => /\.ya?ml$/.test(x))
    .sort())
    await load(
      join(dir, n),
      `datasets/${n}`,
      o.repoRoot && existsSync(join(o.repoRoot, "fixtures")) ? o.repoRoot : undefined,
      out,
    );
  if (o.orgPackDir) {
    const od = join(o.orgPackDir, "evals");
    for (const n of (await readdir(od).catch(() => [] as string[]))
      .filter((x) => /\.ya?ml$/.test(x))
      .sort())
      await load(join(od, n), `org-pack/evals/${n}`, undefined, out);
  }
  return out;
}
