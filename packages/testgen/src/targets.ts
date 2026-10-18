import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ChangeRepos } from "@maycombhq/core";
import type { PlanContext } from "@maycombhq/planner";
import { baseClonePath, changeWorktreesDir, worktreePath } from "@maycombhq/workspace";
import type { StoryContext } from "./story.js";

/**
 * Where a repo's files are for this story, newest first: the task worktree of the story's
 * task in that repo (`workspace/.worktrees/<change>/.tasks/<task>/<repo>/`), the change
 * worktree (repos.yaml, or the conventional folder), then the base clone. Generated tests go
 * into the first worktree found; with none, into the change folder's `tests/`.
 */

export interface RepoPlace {
  repo: string;
  /** Absolute folder, or undefined when the repo isn't checked out here. */
  dir?: string;
  kind: "task-worktree" | "worktree" | "base-clone" | "none";
  /** The task whose worktree it is. */
  task?: string;
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export function repoPlace(
  ctx: PlanContext,
  story: StoryContext,
  repo: string,
  changeRepos: ChangeRepos | undefined,
): RepoPlace {
  for (const t of story.tasks.filter((x) => x.repo === repo)) {
    const d = join(changeWorktreesDir(ctx.root, ctx.change.id), ".tasks", t.id, repo);
    if (isDir(d)) return { repo, dir: d, kind: "task-worktree", task: t.id };
  }
  const listed = changeRepos?.repos.find((r) => r.id === repo);
  for (const d of [
    ...(listed ? [join(ctx.root, ...listed.worktree.split("/"))] : []),
    worktreePath(ctx.root, ctx.change.id, repo),
  ])
    if (isDir(d)) return { repo, dir: d, kind: "worktree" };
  const base = baseClonePath(ctx.root, repo);
  if (isDir(base)) return { repo, dir: base, kind: "base-clone" };
  return { repo, kind: "none" };
}

export type Language = "java" | "node";

const JAVA_TYPES = /java|jvm|kotlin|spring|quarkus|micronaut|jakarta|scala/i;
const NODE_TYPES =
  /node|spa|frontend|react|angular|vue|svelte|next|nest|express|typescript|javascript/i;

/** Which language a repo's tests are in: from its files when checked out, else its type. */
export function languageOf(place: RepoPlace, type: string | undefined): Language | undefined {
  if (place.dir) {
    const has = (p: string) => existsSync(join(place.dir!, p));
    if (has("pom.xml") || has("build.gradle") || has("build.gradle.kts") || has("src/main/java"))
      return "java";
    if (has("package.json")) return "node";
  }
  if (type && JAVA_TYPES.test(type)) return "java";
  if (type && NODE_TYPES.test(type)) return "node";
  return undefined;
}

/** jest when the repo's package.json uses it and not vitest; vitest otherwise. */
export function nodeRunner(place: RepoPlace): "vitest" | "jest" {
  if (!place.dir) return "vitest";
  try {
    const pkg = JSON.parse(readFileSync(join(place.dir, "package.json"), "utf8")) as Record<
      string,
      Record<string, string> | undefined
    >;
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.vitest) return "vitest";
    if (deps.jest) return "jest";
  } catch {
    // no package.json: the default
  }
  return "vitest";
}
