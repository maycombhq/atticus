import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { RecordId, toCanonicalYaml } from "@maycombhq/core";
import type { AiRuntime } from "@maycombhq/ai";
import { writeFileAtomic } from "@maycombhq/changes";
import { loadPlanContext } from "@maycombhq/planner";
import { readChangeRepos } from "@maycombhq/workspace";
import { TestgenError } from "./errors.js";
import { BUILT_IN_GENERATORS, generatorsFor, type TestGenerator } from "./generators/index.js";
import { writeGenerated, type WriteAction } from "./header.js";
import { buildTestModel, type TestCase, type TestModel } from "./model.js";
import { nameTests, type NamingResult } from "./names.js";
import { loadStory } from "./story.js";

/**
 * `atticus tests generate <change> <story>`: build the story's test model, name it (the test
 * writer, replayed in tests), render it with the generic generators and the repo's framework,
 * and write the files into the story's task worktree or change worktree for each repo, or the
 * change folder's `tests/<story>/` when the repo isn't checked out. Generated files carry a
 * header and are never overwritten after a person edits them unless `force`. A manifest at
 * `tests/<story>/manifest.yaml` in the change folder says which file holds which case, for
 * traceability.
 */

export interface GenerateOptions {
  /** A concrete generator id for every repo (junit5-restassured, vitest-fetch, jest-fetch, a plugin's), or gherkin/json for the generic ones only. */
  framework?: string;
  force?: boolean;
  /** Write nothing; say what would change. */
  check?: boolean;
  runtime?: AiRuntime;
  /** A hand-off run of the test writer to take the names from. */
  resume?: string;
  now?: Date;
  /** Framework plugins, chosen before the built-ins. */
  generators?: readonly TestGenerator[];
}

export interface GeneratedOutput {
  repo: string;
  /** Where the files went: the repo's task or change worktree, or the change folder. */
  where: "task-worktree" | "worktree" | "change-folder";
  generator: string;
  /** Metarepo-relative, "/"-separated. */
  path: string;
  action: WriteAction;
  written: boolean;
  cases: string[];
}

export interface GenerateResult {
  change: string;
  story: string;
  model: TestModel;
  names: NamingResult;
  files: GeneratedOutput[];
  /** Metarepo-relative path of the manifest (not written in check mode). */
  manifest: string;
  notes: string[];
  gaps: string[];
}

export const ManifestFile = z.strictObject({
  schemaVersion: z.literal(1),
  change: RecordId,
  story: RecordId,
  strategy: z.array(z.string()),
  names: z.enum(["ai", "fallback"]),
  files: z.array(
    z.strictObject({
      path: z.string().min(1),
      repo: z.string(),
      generator: z.string().min(1),
      cases: z.array(z.string()),
    }),
  ),
  cases: z.array(
    z.strictObject({
      id: z.string().min(1),
      type: z.enum(["acceptance", "api", "contract", "data", "event"]),
      repo: z.string(),
      name: z.string(),
      criterion: z.number().int().positive().optional(),
      scenario: z.string().optional(),
      endpoint: z.string().optional(),
      interface: z.string().optional(),
      method: z.string().optional(),
      path: z.string().optional(),
      table: z.string().optional(),
      topic: z.string().optional(),
      role: z.string().optional(),
    }),
  ),
});
export type ManifestFile = z.infer<typeof ManifestFile>;

const posix = (p: string) => p.split(sep).join("/");

function manifestCase(c: TestCase, repo: string): ManifestFile["cases"][number] {
  const base = { id: c.id, type: c.type, repo, name: c.name };
  switch (c.type) {
    case "acceptance":
      return {
        ...base,
        criterion: c.criterion,
        ...(c.trace ? { scenario: `${c.trace.file}:${c.trace.line}` } : {}),
      };
    case "api":
      return {
        ...base,
        ...(c.scenario ? { criterion: Number(c.scenario.replace(/^acceptance\.c/, "")) } : {}),
        method: c.method,
        path: c.path,
        ...(c.endpoint ? { endpoint: c.endpoint } : {}),
        ...(c.interfaceId ? { interface: c.interfaceId } : {}),
      };
    case "contract":
      return {
        ...base,
        role: c.role,
        ...(c.method ? { method: c.method } : {}),
        ...(c.path ? { path: c.path } : {}),
        ...(c.topic ? { topic: c.topic } : {}),
        ...(c.interfaceId ? { interface: c.interfaceId } : {}),
      };
    case "data":
      return { ...base, table: c.tableId };
    case "event":
      return {
        ...base,
        topic: c.topic,
        role: c.role,
        ...(c.interfaceId ? { interface: c.interfaceId } : {}),
      };
  }
}

export async function generateTests(
  root: string,
  changeId: string,
  storyId: string,
  o: GenerateOptions = {},
): Promise<GenerateResult> {
  const known = [...(o.generators ?? []), ...BUILT_IN_GENERATORS].map((g) => g.id);
  if (o.framework && !known.includes(o.framework))
    throw new TestgenError(
      "invalid",
      `There is no test framework ${o.framework}. Frameworks: ${known.join(", ")}.`,
    );
  const ctx = await loadPlanContext(root, changeId, { requireApprovedDesign: false }).catch(
    (e: Error) => {
      throw new TestgenError("not-found", e.message);
    },
  );
  if (ctx.change.state === "archived")
    throw new TestgenError(
      "refused",
      `${ctx.change.id} is archived; its tests can't be generated again.`,
    );
  const story = await loadStory(ctx, storyId);
  const changeRepos = await readChangeRepos(root, changeId);
  const model = buildTestModel(ctx, story, changeRepos);
  const names = await nameTests(model, {
    ...(o.runtime ? { runtime: o.runtime } : {}),
    orgPack: ctx.lifecycle.orgPack,
    now: o.now ?? new Date(),
    ...(o.resume ? { resume: o.resume } : {}),
  });
  const changeRel = posix(relative(root, ctx.dir));
  const source = `${changeRel}/${story.path}`;
  const files: GeneratedOutput[] = [];
  const notes = [...model.notes];
  for (const repo of model.repos) {
    const inWorktree = repo.place.kind === "task-worktree" || repo.place.kind === "worktree";
    const dir = inWorktree
      ? repo.place.dir!
      : join(ctx.dir, "tests", story.id, ...(repo.repo ? [repo.repo] : []));
    const where: GeneratedOutput["where"] = inWorktree
      ? (repo.place.kind as "task-worktree" | "worktree")
      : "change-folder";
    const chosen = generatorsFor(repo, {
      ...(o.framework ? { framework: o.framework } : {}),
      ...(o.generators ? { plugins: o.generators } : {}),
    });
    if (chosen.note) notes.push(chosen.note);
    for (const g of chosen.generators) {
      const rendered = g.render(model, repo, { source });
      const results = await writeGenerated(dir, rendered, {
        ...(o.force ? { force: true } : {}),
        ...(o.check ? { check: true } : {}),
      });
      results.forEach((r, i) =>
        files.push({
          repo: repo.repo,
          where,
          generator: g.id,
          path: posix(relative(root, join(dir, ...r.path.split("/")))),
          action: r.action,
          written: r.written,
          cases: rendered[i]!.cases ?? [],
        }),
      );
    }
  }
  for (const f of files.filter((x) => x.action === "kept-edited"))
    notes.push(`${f.path} was edited by a person, so it was kept; use --force to replace it.`);
  for (const f of files.filter((x) => x.action === "kept-not-generated"))
    notes.push(`${f.path} wasn't written by Atticus, so it was kept; use --force to replace it.`);

  const manifestRel = `${changeRel}/tests/${story.id}/manifest.yaml`;
  if (!o.check) {
    const m = ManifestFile.parse({
      schemaVersion: 1,
      change: model.change,
      story: story.id,
      strategy: model.strategy.required,
      names: names.by,
      files: files.map((f) => ({
        path: f.path,
        repo: f.repo,
        generator: f.generator,
        cases: f.cases,
      })),
      cases: model.repos.flatMap((r) => r.cases.map((c) => manifestCase(c, r.repo))),
    });
    await writeFileAtomic(
      join(root, ...manifestRel.split("/")),
      toCanonicalYaml(m, ["schemaVersion", "change", "story"]),
    );
  }
  return {
    change: model.change,
    story: story.id,
    model,
    names,
    files,
    manifest: manifestRel,
    notes: [...new Set(notes)],
    gaps: model.gaps,
  };
}

/** Every test manifest of a change (tests/<story>/manifest.yaml). */
export async function readManifests(
  changeDir: string,
): Promise<{ manifests: ManifestFile[]; problems: string[] }> {
  const manifests: ManifestFile[] = [];
  const problems: string[] = [];
  let dirs: string[];
  try {
    dirs = (await readdir(join(changeDir, "tests"), { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return { manifests, problems };
  }
  for (const d of dirs) {
    const text = await readFile(join(changeDir, "tests", d, "manifest.yaml"), "utf8").catch(
      () => undefined,
    );
    if (text === undefined) continue;
    const r = ManifestFile.safeParse(parse(text));
    if (r.success) manifests.push(r.data);
    else problems.push(`tests/${d}/manifest.yaml: ${r.error.issues[0]?.message ?? "invalid"}`);
  }
  return { manifests, problems };
}
