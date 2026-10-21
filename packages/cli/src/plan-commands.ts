import { resolve } from "node:path";
import type { Approval, WorkTracker, ServiceDesk } from "@maycombhq/adapters";
import { runtimeForCli, type AiRuntime, type Run } from "@maycombhq/ai";
import { changesRelOf, proposalsRelOf } from "@maycombhq/core";
import {
  draftTemplates,
  metarepoAdapters,
  planStories as plan,
  readStoryEval,
  snowDraft as draftSnow,
  storyBar,
  submitRequests,
  syncWorkItems,
  type PlannedWrite,
  type SyncResult,
} from "@maycombhq/planner";
import type { Output } from "./commands.js";
import { table } from "./index-commands.js";

/**
 * atticus plan stories / plan bar / plan snow / plan submit / ado sync / templates draft.
 * Planning writes only into the change folder (and proposals/ for templates); every write to
 * an outside system goes through an adapter with one approval per write, after a dry run.
 * Exit codes: 0 ok, 1 problems (or something for a person to do), 2 usage.
 */

export interface PlanDeps {
  runtime?: AiRuntime;
  workTracker?: WorkTracker;
  serviceDesk?: ServiceDesk;
  now?: () => Date;
}

const KNOWN = new Set([
  "PlannerError",
  "ChangeError",
  "ChangeFileError",
  "AdapterError",
  "RuntimeConfigError",
  "StepFileError",
]);

function fail(io: Output, e: unknown): number {
  if (e instanceof Error && KNOWN.has(e.name)) {
    io.err(e.message);
    for (const p of (e as { problems?: string[] }).problems ?? []) io.err(`  ${p}`);
    return (e as { code?: string }).code === "invalid" ? 2 : 1;
  }
  throw e;
}

const plural = (n: number, w: string) =>
  `${n} ${n === 1 ? w : w.endsWith("y") && !/[aeiou]y$/.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`}`;
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

async function runtimeOf(
  root: string,
  mode: string | undefined,
  deps: PlanDeps,
): Promise<AiRuntime> {
  if (deps.runtime) return deps.runtime;
  return (await runtimeForCli(root, mode ? { mode } : {})).runtime;
}

/** atticus plan stories <change> [--force] [--resume <run>] [--mode <mode>] [--json] */
export async function planStories(
  root: string,
  changeId: string | undefined,
  o: { force?: boolean; resume?: string; mode?: string; json?: boolean },
  io: Output,
  deps: PlanDeps = {},
): Promise<number> {
  if (!changeId) {
    io.err(
      "Usage: atticus plan stories <change> [--force] [--resume <run>] [--mode <mode>] [--json]",
    );
    return 2;
  }
  try {
    const runtime = await runtimeOf(root, o.mode, deps);
    const r = await plan(root, changeId, {
      runtime,
      ...(deps.now ? { now: deps.now() } : {}),
      ...(o.force ? { force: true } : {}),
      ...(o.resume ? { resume: o.resume } : {}),
    });
    if (o.json) {
      io.out(
        JSON.stringify(
          {
            change: r.change,
            state: r.state,
            stories: r.skeleton.stories.map((s) => ({
              id: s.id,
              title: r.prose.get(s.id)?.title,
              source: s.source,
              systems: s.systems,
              repos: s.repos,
              tests: s.tests,
              dependsOn: s.dependsOn,
              openQuestions: s.openQuestions.map((q) => q.text),
            })),
            notPlanned: r.skeleton.notPlanned,
            tasks: r.skeleton.tasks,
            fallback: r.fallback,
            discarded: r.discarded,
            files: r.files,
            ...(r.waiting ? { waiting: r.waiting } : {}),
          },
          null,
          2,
        ),
      );
      return r.state === "written" ? 0 : 1;
    }
    if (r.state === "waiting") {
      io.out(
        `Handed the story prose to your assistant (run ${r.waiting!.runId}). When it is done, run: atticus plan stories ${changeId} --resume ${r.waiting!.runId}`,
      );
      return 1;
    }
    io.out(
      `Planned ${plural(r.skeleton.stories.length, "story")} and ${plural(r.skeleton.tasks.length, "task")} for ${r.change} in ${plural(r.skeleton.repos.length, "repo")}.`,
    );
    for (const line of table(
      ["STORY", "TITLE", "REPOS", "TESTS"],
      r.skeleton.stories.map((s) => [
        s.id,
        r.prose.get(s.id)?.title ?? "",
        s.repos.join(", "),
        s.tests.join(", "),
      ]),
    ))
      io.out(line);
    for (const n of r.skeleton.notPlanned) io.out(`Not planned: ${n.what}: ${n.why}.`);
    if (r.fallback.length)
      io.out(
        `No AI prose for ${r.fallback.join(", ")}: a person words ${r.fallback.length === 1 ? "it" : "them"}.`,
      );
    for (const d of r.discarded)
      io.out(`Discarded AI output${d.id ? ` for ${d.id}` : ""}: ${d.reason}.`);
    io.out(`Next: atticus plan snow ${changeId}, then atticus plan bar ${changeId}.`);
    return 0;
  } catch (e) {
    return fail(io, e);
  }
}

/** atticus plan snow <change> [--force] [--json] */
export async function snowDraft(
  root: string,
  changeId: string | undefined,
  o: { force?: boolean; json?: boolean },
  io: Output,
): Promise<number> {
  if (!changeId) {
    io.err("Usage: atticus plan snow <change> [--force] [--json]");
    return 2;
  }
  try {
    const r = await draftSnow(root, changeId, o.force ? { force: true } : {});
    if (o.json) {
      io.out(
        JSON.stringify(
          r.drafts.map((d) => ({
            template: d.need.template.id,
            record: d.need.record,
            why: d.need.why,
            fields: d.fields,
            assumed: d.assumed,
            missing: d.missing,
          })),
          null,
          2,
        ),
      );
      return r.drafts.some((d) => d.missing.length) ? 1 : 0;
    }
    if (r.drafts.length === 0) {
      io.out(`${changeId} needs no service-desk request.`);
      return 0;
    }
    io.out(
      `Wrote ${plural(r.drafts.length, "service-desk draft")} to ${changesRelOf(root)}/${changeId}/snow.md.`,
    );
    for (const d of r.drafts) {
      io.out(
        `  ${d.need.template.requestType} for ${d.need.record} (${d.need.template.leadTimeDays} days): ${d.need.why}`,
      );
      for (const m of d.missing) io.out(`    To fill: ${m}`);
      for (const a of d.assumed) io.out(`    Assumed: ${a}`);
    }
    return r.drafts.some((d) => d.missing.length) ? 1 : 0;
  } catch (e) {
    return fail(io, e);
  }
}

/** atticus plan bar <change> [--eval <file>] [--json] */
export async function storyBarCommand(
  root: string,
  changeId: string | undefined,
  o: { eval?: string; json?: boolean },
  io: Output,
): Promise<number> {
  if (!changeId) {
    io.err("Usage: atticus plan bar <change> [--eval <expected stories.yaml>] [--json]");
    return 2;
  }
  try {
    const ev = o.eval ? await readStoryEval(resolve(root, o.eval)) : undefined;
    const r = await storyBar(root, changeId, ev ? { eval: ev } : {});
    if (o.json) {
      io.out(JSON.stringify(r, null, 2));
      return r.met ? 0 : 1;
    }
    const pct = Math.round(r.ready.rate * 100);
    io.out(
      `${r.ready.passed} of ${r.ready.total} stories are ready (${pct}%, the bar is ${Math.round(r.ready.min * 100)}%); ${r.gaps.filter((g) => g.covered).length} of ${r.gaps.length} gaps covered; ${plural(r.invented.length, "invented name")}.`,
    );
    for (const s of r.stories.filter((x) => !x.ready))
      io.out(`  ${s.id}: ${s.problems.join("; ")}`);
    for (const s of r.stories.filter((x) => x.wording.length))
      io.out(`  ${s.id} (wording): ${s.wording.join("; ")}`);
    for (const g of r.gaps.filter((x) => !x.covered))
      io.out(`  Gap not covered: ${g.id}: ${g.what}`);
    for (const x of [...r.outline, ...r.regressions]) io.out(`  ${x}`);
    io.out(r.met ? "The story bar is met." : "The story bar is not met.");
    return r.met ? 0 : 1;
  } catch (e) {
    return fail(io, e);
  }
}

function printSync(r: SyncResult, what: string, io: Output): number {
  const todo = r.writes.filter((w) => w.action === "create" || w.action === "update");
  if (r.dryRun) {
    io.out(`Dry run: ${plural(todo.length, `${what} write`)} for ${r.change}. Nothing was sent.`);
    for (const line of table(
      ["ACTION", "KEY", "TITLE"],
      r.writes.filter((w) => w.action !== "unchanged").map((w) => [w.action, w.key, w.title]),
    ))
      io.out(line);
    if (todo.length)
      io.out("Approve every write listed with --approve (you approve as your Git user).");
    return 0;
  }
  io.out(`Sent ${plural(r.done.length, `${what} write`)} for ${r.change}.`);
  for (const d of r.done)
    io.out(
      d.id.startsWith("manual:")
        ? `  ${d.action} ${d.key}: a step for a person (${d.id.slice(7)}); see atticus todo.`
        : `  ${d.action} ${d.key}: ${d.id}`,
    );
  for (const s of r.skipped) io.out(`  Skipped ${s.key}: ${s.reason}.`);
  for (const f of r.failed) io.err(`  Failed ${f.key}: ${f.reason}.`);
  return r.failed.length ? 1 : 0;
}

const approver = (by: string | undefined, now: () => Date) =>
  by
    ? (w: PlannedWrite): Approval => ({ by: by.replace(/^@/, ""), at: iso(now()), ref: w.key })
    : undefined;

/** atticus ado sync <change> [--dry-run] [--approve <you>] [--epic <id>] [--json] */
export async function adoSync(
  root: string,
  changeId: string | undefined,
  o: { approve?: string; dryRun?: boolean; epic?: string; json?: boolean },
  io: Output,
  deps: PlanDeps = {},
): Promise<number> {
  if (!changeId) {
    io.err("Usage: atticus ado sync <change> [--dry-run] [--approve <you>] [--epic <id>] [--json]");
    return 2;
  }
  try {
    const now = deps.now ?? (() => new Date());
    const workTracker =
      deps.workTracker ??
      (
        await metarepoAdapters(root, {
          change: changeId,
          onFallback: (e) =>
            io.err(
              `The work tracker can't be reached (${e.code}); writing steps for a person instead.`,
            ),
        })
      ).workTracker;
    if (!workTracker) {
      io.err(
        "runtime.yaml configures no work tracker. Set adapters.workTracker (type manual works with no integration).",
      );
      return 1;
    }
    const approve = approver(o.approve, now);
    const r = await syncWorkItems(root, changeId, {
      workTracker,
      dryRun: o.dryRun || !approve,
      ...(approve ? { approve } : {}),
      ...(o.epic ? { epic: o.epic } : {}),
      now: iso(now()),
    });
    if (o.json) {
      io.out(JSON.stringify(r, null, 2));
      return r.failed.length ? 1 : 0;
    }
    return printSync(r, "work-item", io);
  } catch (e) {
    return fail(io, e);
  }
}

/** atticus plan submit <change> [--dry-run] [--approve <you>] [--json]: file snow.md's drafts. */
export async function snowSubmit(
  root: string,
  changeId: string | undefined,
  o: { approve?: string; dryRun?: boolean; json?: boolean },
  io: Output,
  deps: PlanDeps = {},
): Promise<number> {
  if (!changeId) {
    io.err("Usage: atticus plan submit <change> [--dry-run] [--approve <you>] [--json]");
    return 2;
  }
  try {
    const now = deps.now ?? (() => new Date());
    const serviceDesk =
      deps.serviceDesk ?? (await metarepoAdapters(root, { change: changeId })).serviceDesk;
    if (!serviceDesk) {
      io.err(
        "runtime.yaml configures no service desk. Set adapters.serviceDesk (type manual works with no integration).",
      );
      return 1;
    }
    const approve = approver(o.approve, now);
    const r = await submitRequests(root, changeId, {
      serviceDesk,
      dryRun: o.dryRun || !approve,
      ...(approve ? { approve } : {}),
      now: iso(now()),
    });
    if (o.json) {
      io.out(JSON.stringify(r, null, 2));
      return r.failed.length ? 1 : 0;
    }
    return printSync(r, "service-desk", io);
  } catch (e) {
    return fail(io, e);
  }
}

/** atticus templates draft [--mode <mode>] [--json] */
export async function templatesDraft(
  root: string,
  o: { mode?: string; json?: boolean; noAi?: boolean },
  io: Output,
  deps: PlanDeps = {},
): Promise<number> {
  try {
    const runtime = o.noAi ? undefined : await runtimeOf(root, o.mode, deps);
    const r = await draftTemplates(root, {
      ...(runtime ? { runtime } : {}),
      ...(deps.now ? { now: deps.now() } : {}),
    });
    return reportTemplates(root, r, o, io);
  } catch (e) {
    return fail(io, e);
  }
}

/**
 * The end of `templates draft` in hand-off mode: `atticus handoff done` validated the
 * template writer's answer, so the proposal is drafted again with that prose.
 */
export async function completeTemplatesDraft(
  root: string,
  run: Run,
  io: Output,
  deps: PlanDeps = {},
): Promise<number> {
  try {
    const r = await draftTemplates(root, {
      finished: run,
      ...(deps.now ? { now: deps.now() } : {}),
    });
    return reportTemplates(root, r, {}, io);
  } catch (e) {
    return fail(io, e);
  }
}

function reportTemplates(
  root: string,
  r: Awaited<ReturnType<typeof draftTemplates>>,
  o: { json?: boolean },
  io: Output,
): number {
  {
    if (o.json) {
      io.out(
        JSON.stringify(
          {
            templates: r.templates.map((t) => ({
              id: t.id,
              existing: t.existing,
              template: t.template,
              notes: t.notes,
              problems: t.problems,
            })),
            procedures: r.procedures.map((p) => p.id),
            workItems: r.workItems,
            triage: r.triage,
            files: r.files,
            problems: r.problems,
          },
          null,
          2,
        ),
      );
      return 0;
    }
    io.out(
      `Read ${plural(r.sources.howTos.length, "how-to source")}, ${plural(r.sources.tickets.length, "ticket export")} and ${plural(r.sources.workItems.length, "work-item export")}.`,
    );
    for (const t of r.templates)
      io.out(
        `  ${t.id}: ${t.existing === "matches" ? "the org pack's template agrees" : t.existing === "differs" ? "the org pack's template disagrees (see triage)" : "new draft"}`,
      );
    for (const t of r.triage) io.out(`  Needs a decision: ${t.summary}`);
    for (const p of r.problems) io.err(`  ${p}`);
    io.out(
      `Wrote the proposal to ${proposalsRelOf(root)}/templates/ (${plural(r.files.length, "file")}); read SUMMARY.md, then copy what you accept into org-pack/ in a pull request.`,
    );
    return 0;
  }
}
