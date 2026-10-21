import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "@maycombhq/changes";
import type { RunSummary } from "@maycombhq/core";
import type { AiRuntime } from "@maycombhq/ai";
import { loadPlanContext, type PlanContext } from "./context.js";
import { PlannerError } from "./errors.js";
import { fallbackProse, writeProse, type StoryProse } from "./prose.js";
import { GENERATED_MARK, renderIndex, renderStory, renderTasks } from "./render.js";
import { buildSkeleton, type PlanSkeleton, type TaskPlan } from "./skeleton.js";
import { draftFor, renderSnow, snowNeeds, type SnowDraft, type SnowNeed } from "./snow.js";

export interface PlanStoriesOptions {
  /** The AI runtime for the prose (replay or mock in tests). Without one, plain prose is used. */
  runtime?: AiRuntime;
  now?: Date;
  /** Replace stories and tasks a person wrote (generated ones are always replaced). */
  force?: boolean;
  /** Finish a hand-off run: the run id `atticus handoff done` completed. */
  resume?: string;
  /** Plan from the design as it stands, before it is approved: draft stories to review. */
  draft?: boolean;
}

export interface PlanStoriesResult {
  change: string;
  state: "written" | "waiting";
  skeleton: PlanSkeleton;
  prose: Map<string, StoryProse>;
  /** Stories whose prose came from the skeleton (no AI answer): a person words them. */
  fallback: string[];
  discarded: { id?: string; reason: string }[];
  /** Change-folder-relative files written. */
  files: string[];
  run?: RunSummary;
  waiting?: { runId: string };
  promptSha256?: string;
}

async function exists(path: string): Promise<boolean> {
  return readFile(path).then(
    () => true,
    () => false,
  );
}

/** Refuse to overwrite planning files a person wrote, unless forced. */
async function guard(ctx: PlanContext, rels: string[], force?: boolean): Promise<void> {
  if (force) return;
  const own: string[] = [];
  for (const rel of rels) {
    const p = join(ctx.dir, rel);
    if (!(await exists(p))) continue;
    const text = await readFile(p, "utf8");
    if (!text.startsWith(GENERATED_MARK)) own.push(rel);
  }
  if (own.length)
    throw new PlannerError(
      "refused",
      `${ctx.change.id} already has planning files a person wrote: ${own.join(", ")}. Re-run with --force to replace them.`,
    );
}

/** Which tasks wait for which service-desk requests: the tasks of the story that has the hop. */
function linkWaits(skeleton: PlanSkeleton, needs: SnowNeed[]): Map<string, string[]> {
  const byNeed = new Map<string, string[]>();
  for (const n of needs) {
    if (!n.hop) continue;
    const story = skeleton.stories.find((s) => s.hops.includes(n.hop!));
    if (!story) continue;
    for (const t of skeleton.tasks.filter((x) => x.story === story.id)) {
      const label = `${n.template.name} for ${n.record} (${n.template.leadTimeDays} days)`;
      if (!t.waitsFor.includes(label)) t.waitsFor.push(label);
      const k = `${n.template.id}|${n.record}`;
      byNeed.set(k, [...(byNeed.get(k) ?? []), t.id]);
    }
  }
  return byNeed;
}

/**
 * Stories and tasks from the change's approved design: the deterministic skeleton, the story
 * writer's prose on top, then `stories/<id>.md`, `stories.md` and `tasks.md`. Stale generated
 * story files are removed. In hand-off mode nothing is written until the person's assistant
 * has produced the prose (`atticus handoff done`, then run again with the run id).
 */
export async function planStories(
  root: string,
  changeId: string,
  o: PlanStoriesOptions = {},
): Promise<PlanStoriesResult> {
  const ctx = await loadPlanContext(
    root,
    changeId,
    o.draft ? { requireApprovedDesign: false } : {},
  );
  const skeleton = buildSkeleton(ctx);
  if (skeleton.stories.length === 0)
    throw new PlannerError(
      "refused",
      `${changeId} has nothing to plan: no spec requirement, no new or changed interface and no data change.`,
    );
  const rels = ["stories.md", "tasks.md", ...skeleton.stories.map((s) => `stories/${s.id}.md`)];
  await guard(ctx, rels, o.force);
  const now = o.now ?? new Date();
  const ai = await writeProse(ctx, skeleton, {
    ...(o.runtime ? { runtime: o.runtime } : {}),
    now,
    ...(o.resume ? { resume: o.resume } : {}),
  });
  const base = {
    change: ctx.change.id,
    skeleton,
    discarded: ai.discarded,
    ...(ai.run ? { run: ai.run } : {}),
    ...(ai.promptSha256 ? { promptSha256: ai.promptSha256 } : {}),
  };
  if (ai.waiting)
    return {
      ...base,
      state: "waiting",
      prose: new Map(),
      fallback: [],
      files: [],
      waiting: ai.waiting,
    };

  const prose = new Map<string, StoryProse>();
  const fallback: string[] = [];
  for (const s of skeleton.stories) {
    const p = ai.prose.get(s.id);
    if (p) prose.set(s.id, p);
    else {
      prose.set(s.id, fallbackProse(ctx, s));
      fallback.push(s.id);
    }
  }
  linkWaits(skeleton, snowNeeds(ctx));

  // Remove generated story files of stories that no longer exist.
  const keep = new Set(skeleton.stories.map((s) => `${s.id}.md`));
  for (const f of await readdir(join(ctx.dir, "stories")).catch(() => [] as string[])) {
    if (keep.has(f) || !f.endsWith(".md")) continue;
    const p = join(ctx.dir, "stories", f);
    if ((await readFile(p, "utf8")).startsWith(GENERATED_MARK) || o.force) await rm(p);
  }
  for (const s of skeleton.stories)
    await writeFileAtomic(
      join(ctx.dir, "stories", `${s.id}.md`),
      renderStory(ctx, s, prose.get(s.id)!),
    );
  await writeFileAtomic(join(ctx.dir, "stories.md"), renderIndex(skeleton, prose));
  await writeFileAtomic(join(ctx.dir, "tasks.md"), renderTasks(skeleton, skeleton.tasks));
  return { ...base, state: "written", prose, fallback, files: rels.sort() };
}

export interface SnowDraftResult {
  change: string;
  drafts: SnowDraft[];
  file: string;
}

/** snow.md from the org pack's request templates and their triggers. */
export async function snowDraft(
  root: string,
  changeId: string,
  o: { force?: boolean } = {},
): Promise<SnowDraftResult> {
  const ctx = await loadPlanContext(root, changeId);
  await guard(ctx, ["snow.md"], o.force);
  const needs = snowNeeds(ctx);
  const drafts = needs.map((n) => draftFor(ctx, n));
  const skeleton = buildSkeleton(ctx);
  const waits = linkWaits(skeleton, needs);
  await writeFileAtomic(join(ctx.dir, "snow.md"), renderSnow(drafts, waits));
  return { change: ctx.change.id, drafts, file: "snow.md" };
}

export type { TaskPlan };
