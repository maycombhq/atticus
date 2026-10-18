import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createAdapters, type GitHost } from "@maycombhq/adapters";
import {
  runtimeForCli,
  RUNTIME_MODES,
  type AiRuntime,
  type CreateRuntimeOptions,
  type RuntimeMode,
} from "@maycombhq/ai";
import { generateAssistantFiles, smokeCheck } from "@maycombhq/assistant-files";
import { changesRelOf, loadOrgPack, orgPackDirOf } from "@maycombhq/core";
import { driftCheck, handDown, handUp } from "@maycombhq/speckit";
import {
  completeTaskHandoff,
  isTaskRun,
  RunLevel,
  runTask,
  type CommandRunner,
  type TaskRunRecord,
} from "@maycombhq/taskrun";
import type { GitRunner } from "@maycombhq/workspace";
import type { Output } from "./commands.js";

/**
 * atticus task run / spec hand-down / spec hand-up / drift / assistant-files, and the AI
 * runtime every AI command uses. Exit codes: 0 ok, 1 problems (or something for a person to
 * do), 2 usage.
 */

export { isTaskRun, runtimeForCli };

/** Things tests inject: no network, no real build, no live model. */
export interface RunDeps {
  runtime?: AiRuntime;
  runtimeOptions?: Omit<CreateRuntimeOptions, "root" | "mode">;
  commands?: CommandRunner;
  git?: GitRunner;
  gitHost?: GitHost;
  now?: () => Date;
  env?: Record<string, string | undefined>;
}

const KNOWN = new Set([
  "SpecKitError",
  "TaskRunError",
  "RuntimeConfigError",
  "AssistantFilesError",
  "ChangeError",
  "ChangeFileError",
  "AdapterError",
  "WorkspaceFileError",
]);

function fail(io: Output, e: unknown): number {
  if (e instanceof Error && KNOWN.has(e.name)) {
    io.err(e.message);
    return (e as { code?: string }).code === "invalid" ? 2 : 1;
  }
  throw e;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function describeRun(root: string, r: TaskRunRecord, io: Output): number {
  const what: Record<TaskRunRecord["state"], string> = {
    planned: `Wrote the plan for task ${r.task}: ${changesRelOf(root)}/${r.change}/tasks/${r.task}/plan.md.`,
    waiting: `Handed task ${r.task} to your assistant. The prompt is in .runs/${r.change}/${r.waiting}/prompt.md; it ends with: atticus handoff done ${r.waiting}`,
    built: `Task ${r.task} is drafted on ${r.branch} and the build passes (${plural(r.attempts.length, "attempt")}); committed ${r.commit?.slice(0, 12) ?? ""}.`,
    unverified: `Task ${r.task} is drafted on ${r.branch} but wasn't built: ${r.repo} has no build command.`,
    "pr-open": `Opened PR ${r.pr?.url ?? ""} from ${r.branch} for review.`,
    "needs-person": `Task ${r.task} needs a person in ${r.worktree}.`,
    failed: `The run for task ${r.task} failed.`,
  };
  io.out(what[r.state]);
  for (const n of r.notes) io.out(`  ${n}`);
  return r.state === "failed" || r.state === "needs-person" ? 1 : 0;
}

/** atticus task run <change> <task> [--level plan|draft|pr] [--mode <mode>] --by <you> [--approve] [--json] */
export async function taskRun(
  root: string,
  changeId: string | undefined,
  taskId: string | undefined,
  o: { level?: string; mode?: string; by?: string; approve?: boolean; json?: boolean },
  io: Output,
  deps: RunDeps = {},
): Promise<number> {
  if (!changeId || !taskId) {
    io.err(
      "Usage: atticus task run <change> <task> --by <you> [--level plan|draft|pr] [--mode hand-off|model|headless-claude-code] [--approve]",
    );
    return 2;
  }
  if (!o.by) {
    io.err("Say who is running the task: --by <you>");
    return 2;
  }
  if (o.level !== undefined && !RunLevel.safeParse(o.level).success) {
    io.err(`Unknown level ${o.level}. Use one of: plan, draft, pr.`);
    return 2;
  }
  if (
    o.mode !== undefined &&
    (!(RUNTIME_MODES as readonly string[]).includes(o.mode) || o.mode === "mock")
  ) {
    io.err(`Unknown mode ${o.mode}. Use one of: hand-off, model, headless-claude-code, replay.`);
    return 2;
  }
  const now = deps.now ?? (() => new Date());
  try {
    const r = await runTask(root, changeId, taskId, {
      by: o.by,
      ...(o.level ? { level: o.level as RunLevel } : {}),
      ...(o.mode ? { mode: o.mode as RuntimeMode } : {}),
      ...(o.approve
        ? {
            approval: {
              by: o.by,
              at: now().toISOString(),
              ref: `task ${taskId} of ${changeId}: push and PR`,
            },
          }
        : {}),
      ...(deps.runtime ? { runtime: deps.runtime } : {}),
      ...(deps.runtimeOptions ? { runtimeOptions: deps.runtimeOptions } : {}),
      ...(deps.commands ? { commands: deps.commands } : {}),
      ...(deps.git ? { git: deps.git } : {}),
      ...(deps.gitHost ? { gitHost: deps.gitHost } : {}),
      now,
    });
    if (o.json) {
      io.out(JSON.stringify(r, null, 2));
      return r.state === "failed" || r.state === "needs-person" ? 1 : 0;
    }
    return describeRun(root, r, io);
  } catch (e) {
    return fail(io, e);
  }
}

/** `atticus handoff done <run>` for a task run (the lead routes there when isTaskRun says so). */
export async function taskHandoff(
  root: string,
  runId: string | undefined,
  o: { by?: string; approve?: boolean; json?: boolean },
  io: Output,
  deps: RunDeps = {},
): Promise<number> {
  if (!runId) {
    io.err("Usage: atticus handoff done <run-id>");
    return 2;
  }
  const now = deps.now ?? (() => new Date());
  try {
    const r = await completeTaskHandoff(root, runId, {
      ...(o.approve && o.by
        ? { approval: { by: o.by, at: now().toISOString(), ref: `${runId}: push and PR` } }
        : {}),
      ...(deps.commands ? { commands: deps.commands } : {}),
      ...(deps.git ? { git: deps.git } : {}),
      ...(deps.gitHost ? { gitHost: deps.gitHost } : {}),
      now,
    });
    if (o.json) io.out(JSON.stringify(r, null, 2));
    else if (r.state === "waiting")
      io.out(
        `The build still fails; fix it in ${r.worktree} and run atticus handoff done ${runId} again.`,
      );
    else return describeRun(root, r, io);
    return r.state === "waiting" ? 1 : 0;
  } catch (e) {
    return fail(io, e);
  }
}

/** atticus spec hand-down <change> <task> [--force] [--json] */
export async function specHandDown(
  root: string,
  changeId: string | undefined,
  taskId: string | undefined,
  o: { force?: boolean; json?: boolean },
  io: Output,
  deps: RunDeps = {},
): Promise<number> {
  if (!changeId || !taskId) {
    io.err("Usage: atticus spec hand-down <change> <task> [--force]");
    return 2;
  }
  try {
    const r = await handDown(root, changeId, taskId, {
      ...(o.force ? { force: true } : {}),
      ...(deps.git ? { git: deps.git } : {}),
    });
    if (o.json) {
      io.out(JSON.stringify(r, null, 2));
      return 0;
    }
    io.out(
      r.engine === "speckit"
        ? `Handed task ${r.task} down to ${r.repo} as the Spec Kit feature ${r.feature}, in ${r.worktree}.`
        : `Handed task ${r.task} down to ${r.repo} as ${r.feature}/${r.task}.md, in ${r.worktree}.`,
    );
    for (const f of r.written) io.out(`  wrote ${f}`);
    for (const f of r.kept)
      io.out(`  kept ${f} (changed since the last hand-down; --force replaces it)`);
    const af = r.assistantFiles.results.filter((x) => x.written).length;
    if (af) io.out(`  ${plural(af, "assistant file")} written or updated`);
    for (const p of r.problems) io.err(p);
    io.out(
      r.commit
        ? `Committed ${r.commit.slice(0, 12)} on change/${r.change}; nothing was pushed.`
        : "Nothing new to commit.",
    );
    return 0;
  } catch (e) {
    return fail(io, e);
  }
}

/** atticus spec hand-up <change> <task> --by <you> [--pr <n> --pr-url <url>] [--json] */
export async function specHandUp(
  root: string,
  changeId: string | undefined,
  taskId: string | undefined,
  o: { by?: string; pr?: number; prUrl?: string; json?: boolean },
  io: Output,
  deps: RunDeps = {},
): Promise<number> {
  if (!changeId || !taskId) {
    io.err("Usage: atticus spec hand-up <change> <task> --by <you> [--pr <number> --pr-url <url>]");
    return 2;
  }
  if (!o.by) {
    io.err("Say who is handing the task up: --by <you>");
    return 2;
  }
  if ((o.pr === undefined) !== (o.prUrl === undefined)) {
    io.err("Give both --pr <number> and --pr-url <url>, or neither.");
    return 2;
  }
  try {
    const runtime =
      deps.runtime ??
      (await runtimeForCli(root, { ...(deps.env ? { env: deps.env } : {}) })).runtime;
    let gitHost = deps.gitHost;
    if (!gitHost && o.pr === undefined) {
      const op = await loadOrgPack(join(orgPackDirOf(root)));
      gitHost = createAdapters(op.runtime).gitHost;
    }
    const r = await handUp(root, changeId, taskId, {
      by: o.by,
      runtime,
      ...(gitHost ? { gitHost } : {}),
      ...(o.pr !== undefined ? { pr: { number: o.pr, url: o.prUrl! } } : {}),
      ...(deps.git ? { git: deps.git } : {}),
      ...(deps.now
        ? {
            now: deps
              .now()
              .toISOString()
              .replace(/\.\d{3}Z$/, "Z"),
          }
        : {}),
    });
    if (o.json) {
      io.out(JSON.stringify(r, null, 2));
      return 0;
    }
    io.out(
      `Task ${r.task} is handed up from PR ${r.pr.url}${r.markedDone ? " and marked done in tasks.md" : ""}.`,
    );
    for (const e of r.evidence) io.out(`  evidence: ${changesRelOf(root)}/${r.change}/${e}`);
    const lens =
      r.lens.state === "ran"
        ? `the code-and-test lens raised ${plural(r.review?.findings.filter((f) => f.finding.artifact.startsWith(`tasks/${r.task}/`)).length ?? 0, "finding")}`
        : `the code-and-test lens ${r.lens.state === "waiting" ? "is waiting" : `was ${r.lens.state}`}${r.lens.reason ? `: ${r.lens.reason}` : ""}`;
    io.out(`  ${lens[0]!.toUpperCase()}${lens.slice(1)}.`);
    io.out(`  Drift: ${r.drift.found.length ? plural(r.drift.found.length, "finding") : "none"}.`);
    return r.drift.found.some((f) => f.severity === "blocking") ? 1 : 0;
  } catch (e) {
    return fail(io, e);
  }
}

/** atticus drift <change> [--json]: design vs repo plans vs code. Exit 1 when anything drifted. */
export async function driftCommand(
  root: string,
  changeId: string | undefined,
  o: { json?: boolean },
  io: Output,
  deps: RunDeps = {},
): Promise<number> {
  if (!changeId) {
    io.err("Usage: atticus drift <change> [--json]");
    return 2;
  }
  try {
    const r = await driftCheck(
      root,
      changeId,
      deps.now
        ? {
            now: deps
              .now()
              .toISOString()
              .replace(/\.\d{3}Z$/, "Z"),
          }
        : {},
    );
    const open = r.findings.filter((f) => f.finding.state === "open");
    if (o.json) {
      io.out(
        JSON.stringify(
          {
            change: r.change,
            round: r.round,
            unchanged: r.unchanged,
            plans: r.plans.map((p) => ({ repo: p.repo, feature: p.feature.feature, from: p.from })),
            findings: r.findings.map((f) => ({ ...f.finding, path: f.path })),
          },
          null,
          2,
        ),
      );
      return open.length ? 1 : 0;
    }
    if (r.plans.length === 0)
      io.out(`No repo plans for ${r.change} yet; the design was compared with the code only.`);
    else
      io.out(
        `Compared the design of ${r.change} with ${plural(r.plans.length, "repo plan")} and the code.`,
      );
    if (!r.findings.length) {
      io.out("No drift.");
      return 0;
    }
    for (const f of r.findings)
      io.out(
        `  [${f.finding.severity}${f.finding.state === "open" ? "" : `, ${f.finding.state}`}] ${f.finding.summary} (${f.path})`,
      );
    io.out(
      `${plural(open.length, "open finding")} on the drift gate, round ${r.round}${r.unchanged ? " (unchanged)" : ""}. A blocking one stops the PR until the design is amended or the plan is fixed.`,
    );
    return open.length ? 1 : 0;
  } catch (e) {
    return fail(io, e);
  }
}

/** atticus assistant-files [--repo <id> [--change <id>]] [--force] [--check] [--json] */
export async function assistantFiles(
  root: string,
  o: { repo?: string; change?: string; force?: boolean; check?: boolean; json?: boolean },
  io: Output,
): Promise<number> {
  if (o.change && !o.repo) {
    io.err("--change goes with --repo: atticus assistant-files --repo <id> --change <id>");
    return 2;
  }
  try {
    const r = await generateAssistantFiles(root, {
      ...(o.repo ? { repo: o.repo } : {}),
      ...(o.change ? { change: o.change } : {}),
      ...(o.force ? { force: true } : {}),
      ...(o.check ? { check: true } : {}),
    });
    const files = o.check
      ? []
      : await Promise.all(
          r.results
            .filter((x) => x.action !== "kept-not-generated")
            .map(async (x) => ({
              path: x.path,
              content: await readFile(join(r.dir, x.path), "utf8"),
            })),
        );
    const smoke = smokeCheck(files);
    if (o.json) {
      io.out(
        JSON.stringify(
          { dir: r.dir, profile: r.profile, results: r.results, problems: r.problems, smoke },
          null,
          2,
        ),
      );
    } else {
      for (const x of r.results.filter((y) => y.action !== "unchanged"))
        io.out(
          `  ${o.check ? `would be ${x.action}` : x.action === "kept-edited" ? "kept (edited by hand; --force replaces it)" : x.action === "kept-not-generated" ? "kept (not written by Atticus)" : x.action}: ${x.path}`,
        );
      for (const p of r.problems) io.err(p);
      for (const p of smoke) io.err(`${p.path}: ${p.message}`);
      const where =
        r.profile.kind === "metarepo" ? "the metarepo" : `${r.profile.repo} (${r.profile.engine})`;
      io.out(
        r.upToDate
          ? `Assistant files for ${where} are up to date.`
          : o.check
            ? `Assistant files for ${where} are out of date; run atticus assistant-files${o.repo ? ` --repo ${o.repo}` : ""}.`
            : `Wrote assistant files for ${where} from the org pack.`,
      );
    }
    if (smoke.length || r.problems.length) return 1;
    return o.check && !r.upToDate ? 1 : 0;
  } catch (e) {
    return fail(io, e);
  }
}
