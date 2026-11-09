import { tracked } from "./ui-api-activity.js";
import { printToCurrent } from "@maycombhq/core";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { baseClonePath, loadRepos } from "@maycombhq/workspace";
import {
  Api,
  ChangeArtifact,
  changesDirOf,
  changesRelOf,
  factsDirOf,
  factsFileOf,
  loadOrgPack,
  orgPackDirOf,
  runsDirOf,
  runsRelOf,
  SPEC_HEADER_FILE,
  specDirOf,
  RUN_SCHEMA_VERSION,
  writeFileIfUnchanged,
  type ChangeLifecycle,
  type Finding,
} from "@maycombhq/core";
import {
  artifactFiles,
  artifactPhase,
  changeReport,
  changeSize,
  changeStore,
  ChangeOwnersError,
  liveHandoff,
  requiredArtifacts,
  loadChangeContext,
  handoffBranchPushed,
  pushHandoffBranch,
  readTaskDecision,
  recordTaskDecision,
  setChangeOwners,
  unmergedTaskBranches,
  unmergedTaskWords,
  type ChangeReport,
} from "@maycombhq/changes";
import type { GitHost } from "@maycombhq/adapters";
import { readChangeFiles, readRound, reviewedGates, roundsOf } from "@maycombhq/naysayer";
import { readChangeTasks, setTaskDone } from "@maycombhq/speckit";
import {
  badRequest,
  conflict,
  HttpError,
  notFound,
  requireConfirmation,
  type Router,
  type ServerContext,
} from "@maycombhq/server";
import type { Output } from "./commands.js";
import { changeHandoff, changeNew, changeReleasePrs, changeSync } from "./change-commands.js";
import { critic, findingAction } from "./critic-commands.js";
import { planStories } from "./plan-commands.js";
import { reconcileCommand } from "./reconcile-commands.js";
import {
  buildTask,
  cancelTaskRunWait,
  findTaskRunOfRun,
  previewTaskRun,
  raiseTaskPr,
  readTaskRun,
  saveTaskRun,
  readyTasksOf,
  runReadyTasks,
  settleTaskPr,
  taskRunOfRun,
} from "@maycombhq/taskrun";
import { runDone, taskRun, taskRunNotWaiting } from "./run-commands.js";
import { partStates } from "./runs-view.js";
import { scanCommand } from "./scan-commands.js";
import { workspaceOpen, workspaceSync } from "./workspace-commands.js";
import { requireConfirmedModel } from "./model-address.js";
import { keptAnswer } from "./watched-memo.js";
import { markCheckedByApp, startAutoDone, type AutoDoneOptions } from "./handoff-autodone.js";

/**
 * The write side of the local API (ADR 0015). Every call runs the same command function the
 * terminal does, so the screen and `atticus …` can never disagree: exit 0 is success, 1 is a
 * refusal (422 with the command's own words), 2 a bad request (400).
 */

/** A repo name, as the other /api/facts/{repo} routes take it (ui-api-facts.ts). */
const FACTS_REPO = /^[a-z0-9][a-z0-9._-]{0,99}$/i;

/** Opens the task's repo's worktree when the change has none for it; undefined when it has. */
async function openTaskWorktree(
  root: string,
  change: string,
  task: string,
  gitHost?: GitHost,
): Promise<Ran | undefined> {
  const p = await previewTaskRun(root, change, task, {
    skipGitHost: true,
    ...(gitHost ? { gitHost } : {}),
  }).catch(() => undefined);
  if (!p) return undefined; // the run itself says what is wrong, as before
  const text = await readFile(join(changesDirOf(root), change, "repos.yaml"), "utf8").catch(
    () => "",
  );
  let has = false;
  try {
    const d = parseYaml(text) as { repos?: { id?: string; worktree?: string }[] } | null;
    has = !!d?.repos?.some((r) => r.id === p.repo && r.worktree);
  } catch {
    // A repos.yaml that doesn't read: opening the workspace writes it again.
  }
  if (has) return undefined;
  const wait = { lockWaitMs: INLINE_LOCK_WAIT_MS };
  return inlineGit(async () => {
    // No base clone yet either (a repo the person never cloned): clone it first.
    if (!existsSync(baseClonePath(root, p.repo))) {
      const synced = await run((io) => workspaceSync(root, [p.repo], io, wait));
      if (synced.code !== 0) return synced;
      const opened = await run((io) => workspaceOpen(root, change, [p.repo], io, wait));
      return { ...opened, out: [...synced.out, ...opened.out] };
    }
    return run((io) => workspaceOpen(root, change, [p.repo], io, wait));
  });
}

/**
 * Review round 50: a route the app waits on (Run with AI, Open the workspace) waits for a base
 * clone another sync holds only this long (a terminal waits up to 30 minutes), then answers 409.
 */
const INLINE_LOCK_WAIT_MS = 2_000;

/** Git work on a base clone for a route that answers at once: a sync running elsewhere is 409. */
async function inlineGit<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (!(e instanceof Error) || e.name !== "LockHeldError") throw e;
    const what = (e as Error & { held?: { what?: string } }).held?.what ?? e.message;
    const repo = /base clone of (\S+)/.exec(what)?.[1];
    throw conflict(
      repo
        ? `A sync of ${repo} is running; try again when it finishes.`
        : `${e.message} Try again when it finishes.`,
    );
  }
}

export interface UiDeps {
  /** Tests inject a mock Git host; otherwise runtime.yaml decides. */
  gitHost?: GitHost;
  now?: string;
  /** Tests: a task run's build and Git, for Done (otherwise the repo's build and real Git). */
  taskRun?: Pick<import("./run-commands.js").RunDeps, "commands" | "git">;
  /** Tests: the in-process atticus a step's resume runs with (fourth UX walk). */
  runStep?: import("./handoff-resume.js").StepRunner;
  /** Tests: the machine's checks (otherwise atticus doctor's). */
  doctor?: (root: string) => Promise<import("./doctor.js").DoctorCheck[]>;
  /** ADR 0188: how the app checks an answer once its file is complete (tests: quick, or off). */
  autoDone?: AutoDoneOptions;
}

/** The errors a task run's checks raise, said to the person as the CLI says them. */
const TASK_ERRORS = new Set([
  "SpecKitError",
  "ChangeError",
  "ChangeFileError",
  "AdapterError",
  "RuntimeConfigError",
  "GitError",
  "RuntimeError",
]);

interface Ran {
  code: number;
  out: string[];
  err: string[];
}

async function run(f: (io: Output) => Promise<number>): Promise<Ran> {
  const out: string[] = [];
  const err: string[] = [];
  // ADR 0187: inside a job, each line also goes to its Console entry as it is printed.
  const code = await f({
    out: (l) => {
      out.push(l);
      printToCurrent(l);
    },
    err: (l) => {
      err.push(l);
      printToCurrent(l);
    },
  });
  return { code, out, err };
}

/** A command's refusal or usage error as problem details, its own words as the detail. */
function refused(r: Ran): HttpError {
  const detail = (r.err.length ? r.err : r.out).join("\n") || "The command refused.";
  return r.code === 2
    ? new HttpError(400, "The request isn't valid", detail)
    : new HttpError(422, "Atticus can't do that yet", detail, { lines: [...r.out, ...r.err] });
}

function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body ?? {});
  if (!r.success)
    throw badRequest("Some fields aren't right.", {
      errors: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  return r.data;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** ADR 0113: the largest file the app may attach to a change. */
const MAX_ATTACH = 15 * 1024 * 1024;

/** Contract C4 NewChangeRequest plus the owners, systems and template the form also asks (ADR 0043). */
const NewChange = Api.NewChangeRequest;

async function latestFindings(root: string, change: string): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const gate of await reviewedGates(root, change)) {
    const rounds = await roundsOf(root, change, gate);
    if (rounds.length)
      out.push(
        ...(await readRound(root, change, gate, rounds.at(-1)!)).findings.map((f) => f.finding),
      );
  }
  return out;
}

async function readChange(root: string, id: string): Promise<ChangeLifecycle> {
  try {
    return await changeStore(root).read(id);
  } catch {
    throw notFound(`There is no change ${id}.`);
  }
}

/** ChangeDetail (C4) from the same report `atticus change status` prints. */
async function changeDetail(root: string, id: string) {
  const c = await readChange(root, id);
  const report: ChangeReport = await changeReport(root, id);
  const findings = await latestFindings(root, id);
  const open = { blocking: 0, gap: 0, risk: 0, idea: 0 };
  for (const f of findings) if (f.state === "open") open[f.severity] += 1;
  const dir = join(changesDirOf(root), id);
  const phases = report.type.phases;
  const current = report.phase ? phases.indexOf(report.phase) : phases.length;
  const artifacts = [];
  const blockedArtifacts = new Set(report.blockers.map((b) => b.artifact).filter(Boolean));
  // A file that still holds only the template isn't written yet (seventh UX walk).
  const templateOnly = new Set(
    report.blockers.filter((b) => b.code === "unfilled-artifact").map((b) => b.artifact),
  );
  const cctx = await loadChangeContext(root);
  type Artifact = z.infer<typeof ChangeArtifact>;
  // On the stage path (ADR 0087: a stage's loop has run), the stages' artifacts come first, in
  // stage order, and the change-draft ones (proposal, specs, ...) only when they are there (a
  // real change, 2026-10-25, listed every OpenSpec-era artifact as ready or blocked).
  const onStages = (
    await Promise.all(
      cctx.policy.stages.map((s) =>
        readFile(join(dir, ...s.loop.split("/"))).then(
          () => true,
          () => false,
        ),
      ),
    )
  ).some(Boolean);
  const type = report.type.artifacts as Artifact[];
  const ofStages = cctx.policy.stages
    .flatMap((s) => s.artifacts)
    .filter((a, i, all) => type.includes(a) && all.indexOf(a) === i);
  const due = new Set<Artifact>();
  for (const p of phases)
    for (const a of requiredArtifacts(cctx, report.type, p, report.footprint)) due.add(a);
  const order = onStages ? [...ofStages, ...type.filter((a) => !ofStages.includes(a))] : type;
  for (const a of order) {
    const files = await artifactFiles(dir, a);
    // A stage's artifact is listed when it is due (data.md only when the change touches data).
    if (onStages && !files.length && !(ofStages.includes(a) && due.has(a))) continue;
    const at = phases.indexOf(artifactPhase(cctx, report.type, a));
    const done = files.length > 0 && !blockedArtifacts.has(a);
    artifacts.push({
      artifact: a,
      path: `${changesRelOf(root)}/${id}/${files[0] ?? `${a}.md`}`,
      status: done ? "done" : at <= current ? "ready" : "blocked",
      // Seventh UX walk (2.70.0): ready or blocked says what the phase allows, not that it is there.
      written: files.length > 0 && !templateOnly.has(a),
      openFindings: findings.filter((f) => f.state === "open" && f.artifact.startsWith(a)).length,
    });
  }
  const h = liveHandoff(c) ?? c.handoffs.at(-1);
  // ADR 0113: whether it takes the fast path.
  const fast = (await changeSize(cctx, c)).fast;
  // App-only audit (3.3.0): the open hand-off's branch is here but not on the remote as it is
  // here (its push failed): the change page offers Push again. Local refs only.
  const live = liveHandoff(c);
  const unpushed = !!live && !(await handoffBranchPushed(root, live.branch).catch(() => true));
  return {
    id: c.id,
    title: c.title,
    type: c.type,
    state: c.state,
    repos: c.touches.repos,
    openFindings: open,
    updatedAt: c.history.at(-1)?.at ?? c.createdAt,
    ...(fast ? { fastPath: true } : {}),
    // Ninth UX walk (2.83.0): who owns each role, so the change page can name them.
    owners: c.owners,
    artifacts,
    ...(h
      ? {
          handoff: {
            phase: h.phase,
            ...(h.pr?.url ? { pr: h.pr.url } : {}),
            state: h.state === "merged" ? "merged" : h.state === "closed" ? "closed" : "open",
            ...(unpushed && h === live ? { unpushed: true, branch: live.branch } : {}),
          },
        }
      : {}),
  };
}

/**
 * Sixth UX walk (2.69.0): the repos of a proposal's corrections files whose corrections are newer
 * than the repo's last Apply. Apply (verify --write) rewrites the repo's spec header every time
 * it writes the map; a repo with no header yet (a prototype's) goes by its verify.yaml.
 */
async function applyFirstOf(root: string, files: readonly { path: string }[]): Promise<string[]> {
  const mtime = (p: string) =>
    stat(p).then(
      (s) => s.mtimeMs,
      () => undefined,
    );
  const out: string[] = [];
  for (const f of files) {
    const repo =
      /(?:^|\/)facts\/([^/]+)\.corrections\.jsonl$/.exec(f.path)?.[1] ??
      (await answeredMapQuestionRepo(root, f.path));
    if (!repo || out.includes(repo)) continue;
    const saved = await mtime(join(root, ...f.path.split("/")));
    if (saved === undefined) continue;
    const applied =
      (await mtime(join(specDirOf(root, repo), SPEC_HEADER_FILE))) ??
      (await mtime(join(factsDirOf(root), `${repo}.verify.yaml`)));
    if (applied === undefined || saved > applied) out.push(repo);
  }
  return out;
}

/**
 * Seventh UX walk: the repo of a proposal's question file when it is an answered question that
 * Apply reads, one asked by `atticus verify <repo> --write` (its rerun says so) about that repo.
 * A change's own question, filed under the change id, goes with the change's hand-off instead.
 */
async function answeredMapQuestionRepo(root: string, path: string): Promise<string | undefined> {
  if (!/(?:^|\/)questions\/q-[^/]+\.yaml$/.test(path)) return undefined;
  const q = await readFile(join(root, ...path.split("/")), "utf8").then(
    (t) => parseYaml(t) as { state?: unknown; repo?: unknown; rerun?: unknown } | null,
    () => undefined,
  );
  if (!q || q.state !== "answered" || typeof q.repo !== "string") return undefined;
  const of = /^atticus verify ([a-z0-9][a-z0-9._-]*) --write$/.exec(String(q.rerun ?? "").trim());
  return of?.[1] === q.repo ? q.repo : undefined;
}

/**
 * A change's tasks as the Task board shows them (C4 Task): tasks.md's order and ticks, each with
 * where its Run with AI stands (2.69.0, sixth UX walk), read from its task-run.yaml. A record that
 * doesn't read leaves the task as tasks.md says, never the list unread. Review round 43 (2.70.0):
 * with `prs`, a raised PR's state is asked of the Git host (read-only, a short timeout, all at
 * once), so a PR merged or closed there is said and its task can run with AI again; a host that
 * can't say leaves the record's state.
 *
 * Seventh UX walk (2.72.0): asking also keeps each record in step with the host (settleTaskPr):
 * the PR's number and link as the host has them now (a manual host's, as the person recorded
 * them), and a task whose PR merged ticked in tasks.md, once; the list is read after that, so it
 * says the tick (`taskRun.ticked`). `onTick` hears of a task ticked just now.
 */
async function taskViews(
  root: string,
  change: string,
  prs?: { gitHost?: GitHost; now?: string; onTick?: () => void },
): Promise<Api.TaskT[]> {
  const dir = join(changesDirOf(root), change);
  let tasks = readChangeTasks(await readChangeFiles(dir));
  const states = prs
    ? await Promise.all(
        tasks.map((t) =>
          settleTaskPr(root, change, t.id, {
            ...(prs.gitHost ? { gitHost: prs.gitHost } : {}),
            ...(prs.now ? { now: () => new Date(prs.now!) } : {}),
          }).catch(() => ({}) as Awaited<ReturnType<typeof settleTaskPr>>),
        ),
      )
    : [];
  if (states.some((s) => s.ticked)) {
    tasks = readChangeTasks(await readChangeFiles(dir));
    prs?.onTick?.();
  }
  // Ninth UX walk: what each task waits for, as the ready list reads it (same repo included).
  const waits = new Map(
    (await readyTasksOf(root, change).catch(() => ({ tasks: [] }))).tasks.map((x) => [x.id, x]),
  );
  // App-only audit (3.3.0): each task branch's commits not in the change branch here (local refs
  // only, so the board stays quick), whether a person let one go, and whether its repo builds now.
  const unmerged = new Map(
    (await unmergedTaskBranches(root, change, { offline: true }).catch(() => [])).map((u) => [
      u.task,
      u,
    ]),
  );
  const builds = new Map(
    (await loadRepos(root).catch(() => [])).map((r) => [r.id, !!r.build?.trim()]),
  );
  const out: Api.TaskT[] = [];
  for (const [i, t] of tasks.entries()) {
    const w = t.done ? undefined : waits.get(t.id);
    const u = unmerged.get(t.id);
    const decision = await readTaskDecision(root, change, t.id).catch(() => undefined);
    const tr = await readTaskRun(root, change, t.id).catch(() => undefined);
    const run = tr ? (tr.waiting ?? tr.runs[0]) : undefined;
    const prState = tr?.state === "pr-open" ? states[i]?.state : undefined;
    out.push({
      id: t.id,
      repo: t.repo,
      description: t.title,
      done: t.done,
      ...(t.stories[0] ? { story: t.stories[0] } : {}),
      branch: `task/${change}/${t.id}`,
      ...(run ? { run } : {}),
      ...(tr
        ? {
            taskRun: {
              state: tr.state,
              level: tr.level,
              branch: tr.branch,
              ...(tr.commit ? { commit: tr.commit } : {}),
              ...(tr.pr ? { pr: { ...tr.pr, ...(prState ? { state: prState } : {}) } } : {}),
              ...(tr.ticked ? { ticked: tr.ticked } : {}),
              ...(tr.marked ? { marked: tr.marked } : {}),
              notes: tr.notes,
            },
          }
        : {}),
      ...(w?.waitsFor.length ? { waits: { tasks: w.waitsFor, sameRepo: w.sameRepo ?? [] } } : {}),
      ...(u ? { unmerged: { commits: u.commits, branch: u.branch } } : {}),
      ...(decision
        ? { decision: { by: decision.by, at: decision.at, reason: decision.reason } }
        : {}),
      // Only beside a run: the card reads it to offer Build and raise PR.
      ...(tr ? { repoBuilds: builds.get(t.repo) ?? false } : {}),
    });
  }
  return out;
}

/** A run record as RunView (C4). */
async function runView(root: string, change: string, runId: string) {
  const dir = join(runsDirOf(root), change, runId);
  const text = await readFile(join(dir, "run.json"), "utf8").catch(() => undefined);
  if (!text) return undefined;
  const r = JSON.parse(text) as {
    runId: string;
    runtime: string;
    state: string;
    attempt: number;
    startedAt: string;
    finishedAt?: string;
    errors: string[];
    request: { agent: string | { id: string }; change: string; outputPath?: string };
    /** ADR 0121 addendum: the kind of step and the model that ran it. */
    stepClass?: Api.RunListItem["stepClass"];
    model?: string;
    /** ADR 0185: the batch a lens was asked in, or a batch's lenses. */
    batch?: string;
    parts?: { name: string; runId: string }[];
  };
  const manifest = await readFile(join(dir, "context-manifest.json"), "utf8").catch(() => "");
  const tr = await taskRunOfRun(root, change, runId).catch(() => undefined);
  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    runId: r.runId,
    change: r.request.change,
    // A run records the whole agent definition; the view names it.
    agent: typeof r.request.agent === "string" ? r.request.agent : r.request.agent.id,
    runtime: r.runtime,
    state: r.state,
    startedAt: r.startedAt,
    ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}),
    ...(r.request.outputPath ? { output: r.request.outputPath } : {}),
    contextManifestSha256: sha(manifest),
    errors: r.errors ?? [],
    attempt: r.attempt ?? 1,
    ...(r.stepClass ? { stepClass: r.stepClass } : {}),
    ...(r.model ? { model: r.model } : {}),
    ...(r.batch ? { batch: r.batch } : {}),
    ...(r.parts?.length ? { parts: await partStates(root, change, r.parts) } : {}),
    promptPath: `${runsRelOf(root)}/${change}/${runId}/prompt.md`,
    ...(tr
      ? {
          taskRun: {
            task: tr.task,
            repo: tr.repo,
            level: tr.level,
            state: tr.state,
            branch: tr.branch,
            worktree: tr.worktree,
            notes: tr.notes,
            ...(tr.commit ? { commit: tr.commit } : {}),
            ...(tr.attempts.at(-1) ? { log: tr.attempts.at(-1)!.log } : {}),
          },
        }
      : {}),
  };
}

async function findRun(root: string, runId: string) {
  if (!/^run-[0-9a-z-]+$/.test(runId)) throw notFound(`There is no run ${runId}.`);
  for (const change of await readdir(runsDirOf(root)).catch(() => [] as string[])) {
    const v = await runView(root, change, runId);
    if (v) return v;
  }
  throw notFound(`There is no run ${runId}.`);
}

/** The file behind a single-file view of an artifact (specs and stories show their first file). */
async function artifactPath(
  root: string,
  id: string,
  artifact: string,
  o: { orNew?: boolean; file?: string | null } = {},
): Promise<string> {
  const a = ChangeArtifact.safeParse(artifact);
  if (!a.success)
    throw badRequest(
      `${artifact} is not an artifact. Use one of ${ChangeArtifact.options.join(", ")}.`,
    );
  const dir = join(changesDirOf(root), id);
  const files = await artifactFiles(dir, a.data);
  // 2.72.0 (seventh UX walk): one file of a many-file artifact, such as a story, by its path in
  // the change folder; only a file the artifact has, never a path elsewhere.
  if (o.file) {
    if (!files.includes(o.file))
      throw notFound(`${o.file} isn't one of change ${id}'s ${artifact} files.`);
    return o.file;
  }
  // Third UX walk: a one-file artifact not written yet opens empty, and Save creates it (a new
  // change's proposal, written by hand). Specs are one file per capability: drafted, not here.
  if (files.length === 0 && o.orNew && a.data !== "specs")
    return a.data === "stories" ? "stories.md" : `${a.data}.md`;
  if (files.length === 0) throw notFound(`Change ${id} has no ${artifact} yet.`);
  return files[0]!;
}

export function uiRoutes(r: Router, ctx: ServerContext, deps: UiDeps = {}): Router {
  const { root, user, jobs } = ctx;
  /**
   * Review round 48 (ADR 0186): the person's confirmation of a write to a shared system, from the
   * app's page; the session token alone is 403. Spent whether the write then works or not.
   */
  const confirmed = (write: Api.ConfirmedWriteT, target: string, given: unknown) =>
    requireConfirmation(ctx.confirmations, write, target, given);
  /** ADR 0181 part 4: the ready list, in the deployment plan's order, each open PR as the host says. */
  const readyView = async (change: string): Promise<Api.ReadyTasksT> => {
    const { deployOrderOf } = await import("./run-ready-commands.js");
    const repoOrder = await deployOrderOf(root, change);
    const prStates = new Map<string, "open" | "merged" | "closed">();
    for (const t of await taskViews(root, change, {
      ...(deps.gitHost ? { gitHost: deps.gitHost } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    }))
      if (t.taskRun?.pr?.state) prStates.set(t.id, t.taskRun.pr.state);
    const plan = await readyTasksOf(root, change, {
      ...(repoOrder ? { repoOrder } : {}),
      prStates,
    });
    return Api.ReadyTasks.parse({ change, ...plan, ...(repoOrder ? { repoOrder } : {}) });
  };
  /** The runs whose Done is being checked now. */
  const doneBusy = new Set<string>();
  const changeDeps = {
    ...(deps.gitHost ? { gitHost: deps.gitHost } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  };
  /**
   * Windows review: Apply, Propose and Bring in run git, verify and the Git host, which on a bank
   * laptop can take longer than an editor panel waits for one answer (30 s). They run as jobs
   * (202 and the job's id; the page follows /api/jobs/{id}), whose result is the code and lines.
   */
  /** What each local job does, in words, for the refusal of a second one (round 41). */
  const localWhat = new Map<string, string>();
  const asJob = (what: string, work: () => Promise<Ran>) => {
    // Round 41: one local step at a time: Bring in moves the working tree, so it never runs
    // while Apply writes facts or Propose commits them. The refusal names the one that runs.
    const busy = ctx.jobs.runningOf("local");
    if (busy)
      throw conflict(
        `${localWhat.get(busy.id) ?? busy.progress.message} is running on this server (${busy.id}): wait for it to finish, then try again.`,
      );
    // Round 37: its own kind, so a slow Apply never reads as "an AI step is running".
    const job = ctx.jobs.start(
      "local",
      async (c) => {
        c.progress(0, 1, what);
        const res = await work();
        c.progress(1, 1, res.code === 0 ? "Done" : "Stopped");
        ctx.events.publish({ type: "file.changed", path: "." });
        const lines = [...res.out, ...res.err];
        return { result: { code: res.code, lines }, errors: res.code === 0 ? [] : lines };
      },
      { title: what },
    );
    localWhat.set(job.id, what);
    return { status: 202, body: { jobId: job.id } };
  };
  /**
   * Done: a hand-off's answer checked, and the step it finishes resumed (fourth UX walk). ADR
   * 0188: the same for the app's own check once the answer file is complete (`by: "app"`, from
   * handoff-autodone.ts), so the two never differ. A run the command line already checked (the
   * assistant ran atticus handoff done) is only resumed. One at a time per run, never twice.
   */
  const doneRun = async (runId: string, by: "person" | "app") => {
    const before = await findRun(root, runId);
    const { hasKeptResume } = await import("./handoff-resume.js");
    const onlyResume = before.state === "validated" && (await hasKeptResume(root, runId));
    if ((before.state === "validated" && !onlyResume) || before.state === "cancelled")
      throw conflict(`Run ${runId} is already ${before.state}.`);
    // One Done at a time per run: a second click while the first builds is told so (two
    // builds in one worktree collide, on Windows over locked files).
    if (doneBusy.has(runId))
      throw conflict(`Done for ${runId} is already running; wait for it to finish.`);
    doneBusy.add(runId);
    let res: Ran;
    try {
      // A task run's Done builds, fixes and commits as atticus handoff done does (round 22).
      // ADR 0187: as a job, whose lines the hand-off run's Console entry shows.
      res = onlyResume
        ? { code: 0, out: [], err: [] }
        : await tracked(
            ctx,
            by === "app" ? `Checked the answer: ${runId}` : `Done: ${runId}`,
            () => run((io) => runDone(root, runId, { by: user }, io, deps.taskRun)),
            { meta: { handoffRun: runId } },
          );
      if (by === "app") await markCheckedByApp(root, before.change, runId).catch(() => undefined);
    } finally {
      doneBusy.delete(runId);
    }
    const after = await findRun(root, runId);
    ctx.events.publish({ type: "run.changed", runId: after.runId, state: after.state });
    // The answer had problems, the build failed, or the task needs a person: said as such,
    // with what the command printed, never as a success. Ninth UX walk: in the app's words
    // (fix the answer, then press Done again; not atticus handoff done <run> again).
    const { resumeAfterDone, appLines } = await import("./handoff-resume.js");
    if (res.code !== 0) throw refused({ ...res, out: appLines(res.out), err: appLines(res.err) });
    // Fourth UX walk: a step the app prepared is finished here too: its resume writes what
    // the answer said (a draft's proposal and specs), or offers its next prompt (`next`).
    const stepRunner =
      deps.runStep ??
      (async (args: string[]) => {
        const { main } = await import("./main.js");
        const out: string[] = [];
        const err: string[] = [];
        const code = await main(
          [...args, "--root", root],
          { out: (l) => out.push(l), err: (l) => err.push(l) },
          { quiet: true },
        );
        return { code, out, err };
      });
    const resumed = await resumeAfterDone(root, stepRunner, after.change, after.runId).catch(
      (e: Error) => ({ lines: [e.message] }) as { next?: string; lines: string[] },
    );
    if (resumed) ctx.events.publish({ type: "file.changed", path: changesRelOf(root) });
    return {
      ...after,
      // When the app resumed the step, runDone's "run the step again with --resume" is done;
      // sixth UX walk: what is left to do is said in the app's words.
      lines: [
        ...(resumed
          ? appLines([...res.out, ...res.err].filter((l) => !/--resume run-/.test(l)))
          : appLines([...res.out, ...res.err])),
        ...(resumed?.lines ?? []),
      ],
      ...(resumed?.next ? { next: resumed.next } : {}),
    };
  };
  // ADR 0188: the answer arrives by itself: a waiting hand-off is checked once its file is complete.
  startAutoDone(ctx, (runId) => doneRun(runId, "app"), deps.autoDone ?? {});
  return (
    r
      // ADR 0183: the app runs the local steps and proposes them for review on the person's yes.
      .add("POST", "/api/facts/{repo}/apply", async ({ params }) => {
        const { verifyCommand } = await import("./verify-commands.js");
        // Final review: the router decodes %2F and %5C, so the repo is checked as every other
        // /api/facts/{repo} route checks it, and must be one the workspace lists, before any
        // file is read under its name.
        const repo = params.repo!;
        if (!FACTS_REPO.test(repo)) throw badRequest(`${JSON.stringify(repo)} isn't a repo name.`);
        if (!(await loadRepos(root)).some((x) => x.id === repo))
          throw notFound(`There is no repo ${repo} in this workspace.`);
        return asJob(`Applying to ${repo}`, () =>
          run((io) => verifyCommand(root, repo, { write: true, verbose: false, json: false }, io)),
        );
      })
      // Ninth UX walk: the upgrade steps this metarepo waits on (runtime.yaml at an older schema,
      // say), and atticus upgrade run here as a local job on the person's click. It backs up what
      // it changes; the changes are files to propose for review like any other.
      // beta.23: every migration's dry run reads every record and question; Home asks this on
      // each load, so the answer is kept until a change is heard (watched-memo.ts).
      .add("GET", "/api/upgrade", async () =>
        keptAnswer(root, "upgrade", async () => {
          const { newerAtticusOf, upgradeCheck } = await import("./upgrade.js");
          const c = await upgradeCheck(root);
          // Round 49: a stamp this Atticus can't read still names the newer Atticus, when it does.
          const stamp = c.stamp?.atticus ?? newerAtticusOf(c);
          const body: Api.UpgradeViewT = {
            atticus: c.atticus,
            newer: c.newer,
            ...(stamp ? { stamp } : {}),
            pending: c.pending,
          };
          return { status: 200, body };
        }),
      )
      .add("POST", "/api/upgrade", async () => {
        const { newerThan, newerWords, upgradeCheck, upgradeCommand } =
          await import("./upgrade.js");
        const c = await upgradeCheck(root);
        if (c.newer) throw conflict(newerWords(c));
        // Round 49: as atticus upgrade does, it runs to record this Atticus when no step waits
        // but the stamp is older than this build, or missing.
        if (!c.pending.length && c.stamp && !newerThan(c.atticus, c.stamp.atticus))
          throw conflict(`Nothing to upgrade: up to date for Atticus ${c.atticus}.`);
        return asJob("Upgrading the metarepo", () =>
          run((io) => upgradeCommand(root, { by: user }, io)),
        );
      })
      .add("GET", "/api/propose", async ({ query }) => {
        const { proposePlan, PROPOSE_SCOPES } = await import("./propose.js");
        const scope = query.get("scope") ?? "";
        if (!(PROPOSE_SCOPES as readonly string[]).includes(scope))
          throw refused({
            code: 2,
            out: [],
            err: [`scope is one of ${PROPOSE_SCOPES.join(", ")}.`],
          });
        // Initiatives review: a metarepo that isn't a Git repository (the practice sandbox) is
        // said, never a 500.
        const plan = await proposePlan(root, scope as (typeof PROPOSE_SCOPES)[number], {
          by: user,
        }).catch((e: Error) => {
          throw refused({
            code: 1,
            out: [],
            err: [
              `Atticus can't list what changed here: ${e.message.split("\n")[0]}. Propose for review needs the metarepo to be a Git repository with a remote.`,
            ],
          });
        });
        return { status: 200, body: { ...plan, applyFirst: await applyFirstOf(root, plan.files) } };
      })
      .add("POST", "/api/propose", async ({ body }) => {
        const b = parseBody(Api.ProposeRequest, body);
        // The person's confirmation from the app is the approval to push the branch and open the
        // PR (ADR 0183, 0186); the session token alone is 403.
        confirmed("propose", b.scope, b.confirmation);
        const { proposeForReview } = await import("./propose.js");
        return asJob("Proposing for review", () =>
          run((io) =>
            proposeForReview(
              root,
              {
                scope: b.scope,
                by: user,
                files: b.files,
                ...(b.title ? { title: b.title } : {}),
                ...(b.branch ? { branch: b.branch } : {}),
              },
              io,
            ),
          ),
        );
      })
      .add("POST", "/api/propose/bring-in", async () => {
        const { bringInMerged } = await import("./propose.js");
        return asJob("Bringing in what merged", () => run((io) => bringInMerged(root, io)));
      })
      // App-only audit (3.3.0): Set the upstream, when Bring in found the branch follows none and
      // the remote has the same branch: a local setting of this copy (nothing is sent).
      .add("POST", "/api/propose/upstream", async ({ body }) => {
        const b = parseBody(Api.UpstreamRequest, body);
        const { setUpstream } = await import("./propose.js");
        return asJob(`Setting the upstream to ${b.upstream}`, () =>
          run((io) => setUpstream(root, b.upstream, io)),
        );
      })
      // 2.76.0 (eighth UX walk): Check the code again, on the person's click (ADR 0114). It
      // scans each repo's branch from its base clone, a local step like Apply.
      .add("POST", "/api/changes/{changeId}/conformance", async ({ params }) => {
        await readChange(root, params.changeId!);
        const { changeConformCommand } = await import("./change-conform.js");
        return asJob(`Checking ${params.changeId!}'s code against its design`, () =>
          run((io) => changeConformCommand(root, params.changeId!, { findingsAnswer: true }, io)),
        );
      })
      .add("GET", "/api/change-types", async () => {
        const op = await loadOrgPack(orgPackDirOf(root));
        return {
          status: 200,
          body: op.changeTypes.types.map((t) => ({
            id: t.id,
            name: t.name,
            ...(t.description ? { description: t.description } : {}),
          })),
        };
      })
      .add("POST", "/api/changes", async ({ body }) => {
        const b = parseBody(NewChange, body);
        const owners = Object.entries(b.owners ?? {}).map(
          ([role, who]) => `${role}=${who.join(",")}`,
        );
        const res = await run((io) =>
          changeNew(
            root,
            {
              id: b.id,
              title: b.title,
              type: b.type,
              by: user,
              owners,
              ...(b.systems ? { systems: b.systems } : {}),
              ...(b.template ? { template: b.template } : {}),
              ...(b.like ? { like: b.like } : {}),
            },
            io,
            changeDeps,
          ),
        );
        if (res.code !== 0) {
          if (res.err.some((l) => /already exists/i.test(l))) throw conflict(res.err.join("\n"));
          throw refused(res);
        }
        return { status: 201, body: await changeDetail(root, b.id) };
      })
      .add("GET", "/api/changes/{changeId}", async ({ params }) => ({
        status: 200,
        body: await changeDetail(root, params.changeId!),
      }))
      // Ninth UX walk (2.83.0): a person names the change's owners per role from its page, so
      // Home and Questions know whose questions are whose: change.yaml through the change store.
      .add("PUT", "/api/changes/{changeId}/owners", async ({ params, body }) => {
        await readChange(root, params.changeId!);
        const b = parseBody(Api.ChangeOwnersRequest, body);
        try {
          await setChangeOwners(root, params.changeId!, b.owners);
        } catch (e) {
          if (e instanceof ChangeOwnersError) throw badRequest(e.message);
          throw e;
        }
        ctx.events.publish({
          type: "file.changed",
          path: `${changesRelOf(root)}/${params.changeId!}/change.yaml`,
        });
        return { status: 200, body: await changeDetail(root, params.changeId!) };
      })
      .add("GET", "/api/changes/{changeId}/status", async ({ params }) => {
        await readChange(root, params.changeId!);
        const rep = await changeReport(root, params.changeId!);
        return {
          status: 200,
          body: {
            state: rep.state,
            ...(rep.phase ? { phase: rep.phase } : {}),
            ...(rep.next ? { next: rep.next } : {}),
            ...(rep.progress ? { progress: rep.progress } : {}),
            nextStep: rep.nextStep,
            risk: rep.risk,
            tests: rep.tests,
            ...(rep.handoff
              ? {
                  handoff: {
                    pr: rep.handoff.pr,
                    state: rep.handoff.state,
                    phase: rep.handoff.phase,
                  },
                }
              : {}),
            blockers: rep.blockers,
            reasons: rep.reasons,
          },
        };
      })
      .add("GET", "/api/changes/{changeId}/artifacts/{artifact}", async ({ params, query }) => {
        await readChange(root, params.changeId!);
        const rel = await artifactPath(root, params.changeId!, params.artifact!, {
          orNew: true,
          file: query.get("file"),
        });
        const content = await readFile(
          join(changesDirOf(root), params.changeId!, rel),
          "utf8",
        ).catch(() => "");
        return {
          status: 200,
          body: {
            artifact: params.artifact,
            path: `${changesRelOf(root)}/${params.changeId}/${rel}`,
            content,
            sha256: sha(content),
          },
        };
      })
      .add(
        "PUT",
        "/api/changes/{changeId}/artifacts/{artifact}",
        async ({ params, body, query }) => {
          await readChange(root, params.changeId!);
          const b = parseBody(Api.SaveArtifactRequest, body);
          const rel = await artifactPath(root, params.changeId!, params.artifact!, {
            orNew: true,
            file: query.get("file"),
          });
          const file = join(changesDirOf(root), params.changeId!, rel);
          const was = await readFile(file, "utf8").catch(() => undefined);
          const now = was ?? "";
          if (sha(now) !== b.baseSha256)
            throw conflict(
              `${rel} changed since you opened it. Reload it, then make your edit again.`,
            );
          // Atomic, and refused (409) if another save landed between the read and the write.
          await mkdir(dirname(file), { recursive: true });
          await writeFileIfUnchanged(file, was, b.content);
          // ADR 0181 (2.79.0): a person's save of a stage draft says who saved it and when, so
          // its "Drafted by AI" chip becomes "Edited by <who>".
          const { recordPersonSave } = await import("@maycombhq/planner");
          await recordPersonSave(join(changesDirOf(root), params.changeId!), params.changeId!, {
            file: rel,
            who: user,
            at: (deps.now ? new Date(deps.now) : new Date()).toISOString(),
            content: b.content,
          }).catch(() => undefined);
          ctx.events.publish({
            type: "file.changed",
            path: `${changesRelOf(root)}/${params.changeId}/${rel}`,
          });
          return {
            status: 200,
            body: {
              artifact: params.artifact,
              path: `${changesRelOf(root)}/${params.changeId}/${rel}`,
              content: b.content,
              sha256: sha(b.content),
            },
          };
        },
      )
      .add("GET", "/api/changes/{changeId}/tasks", async ({ params }) => {
        await readChange(root, params.changeId!);
        const change = params.changeId!;
        return {
          status: 200,
          body: await taskViews(root, change, {
            ...(deps.gitHost ? { gitHost: deps.gitHost } : {}),
            ...(deps.now ? { now: deps.now } : {}),
            // Seventh UX walk: a task ticked because its PR merged changed tasks.md.
            onTick: () =>
              ctx.events.publish({
                type: "file.changed",
                path: `${changesRelOf(root)}/${change}/tasks.md`,
              }),
          }),
        };
      })
      // Seventh UX walk (2.72.0): a person ticks or unticks a task in tasks.md from the Task board,
      // a local edit to the change's files that rides its build hand-off (only the box changes).
      .add("POST", "/api/changes/{changeId}/tasks/{taskId}/done", async ({ params, body }) => {
        await readChange(root, params.changeId!);
        const change = params.changeId!;
        const task = params.taskId!;
        const b = parseBody(Api.TaskDoneRequest, body);
        if (!(await taskViews(root, change)).some((t) => t.id === task))
          throw notFound(`Change ${change} has no task ${task}.`);
        // App-only audit (3.3.0): a task whose branch has commits the change branch hasn't (here
        // or on the Git host) isn't done until its PR merges, unless a person says why its work
        // isn't needed: that decision is recorded with their reason, and lets Build ready pass.
        if (b.done) {
          const held = await unmergedTaskBranches(root, change, { task });
          if (held.length && !b.reason?.trim())
            throw conflict(
              `${held.map((h) => unmergedTaskWords(change, h)).join(" ")} To mark it done anyway, say why its work isn't needed.`,
            );
          if (held.length)
            await recordTaskDecision(root, change, task, {
              by: user,
              at: (deps.now ? new Date(deps.now) : new Date())
                .toISOString()
                .replace(/\.\d{3}Z$/, "Z"),
              reason: b.reason!,
            });
        }
        if (await setTaskDone(root, change, task, b.done))
          ctx.events.publish({
            type: "file.changed",
            path: `${changesRelOf(root)}/${change}/tasks.md`,
          });
        // Eighth UX walk (2.76.0): a task that has run keeps who ticked or unticked it by hand,
        // so one Atticus ticked at its merge and a person ticked again says who did.
        const tr = await readTaskRun(root, change, task).catch(() => undefined);
        if (tr) {
          tr.marked = {
            done: b.done,
            by: user,
            at: (deps.now ? new Date(deps.now) : new Date()).toISOString().replace(/\.000Z$/, "Z"),
          };
          await saveTaskRun(root, tr);
        }
        return {
          status: 200,
          body: (await taskViews(root, change)).find((t) => t.id === task)!,
        };
      })
      // ADR 0181 part 4 (2.76.0): the change's tasks not done yet, in cross-repo order, each ready
      // to run or why not, for the Task board's Run all ready tasks.
      .add("GET", "/api/changes/{changeId}/tasks/ready", async ({ params }) => {
        await readChange(root, params.changeId!);
        return { status: 200, body: await readyView(params.changeId!) };
      })
      // ADR 0181 part 4 (2.76.0): Run all ready tasks. One task run per ready task (ADR 0036, with
      // its lock), in order, as one job, since the server runs one AI step at a time; it stops on
      // the first that needs a person. The app never asks for the pr level, so the click is the
      // person's approval for the drafts; each PR is raised on its own Raise click, or with
      // --approve in an editor or on the command line. Nothing is merged.
      .add("POST", "/api/changes/{changeId}/tasks/run-ready", async ({ params, body }) => {
        const change = params.changeId!;
        await readChange(root, change);
        const b = parseBody(Api.RunReadyRequest, body);
        // Review round 50: as a single task run, its model only where the person confirmed it.
        await requireConfirmedModel(root, b.runtime);
        const view = await readyView(change);
        const tasks = b.tasks ? view.ready.filter((t) => b.tasks!.includes(t)) : view.ready;
        if (!tasks.length)
          throw refused({
            code: 1,
            out: [],
            err: [
              b.tasks
                ? `None of ${b.tasks.join(", ")} is ready to run now: the Task board says why.`
                : `No task of ${change} is ready to run: each waits for the tasks before it, its PR, the assistant or a person.`,
            ],
          });
        const repoOf = new Map(view.tasks.map((t) => [t.id, t.repo]));
        // Round 45: checked and started in one tick, with nothing awaited in between, so two
        // clicks never start two jobs.
        const busy = ctx.jobs.runningOf("step");
        if (busy)
          throw conflict(
            `An AI step is running on this server (${busy.id}): wait for it to finish, or cancel it.`,
          );
        const job = ctx.jobs.start(
          "step",
          async (c) => {
            const r = await runReadyTasks(root, change, {
              by: user,
              only: tasks,
              ...(view.repoOrder ? { repoOrder: view.repoOrder } : {}),
              ...(b.level ? { level: b.level } : {}),
              ...(b.runtime ? { mode: b.runtime } : {}),
              // As Run with AI: runtime.yaml's level, lowered to the repo's cap, and at most draft.
              levelFor: async (task) => {
                const p = await previewTaskRun(root, change, task, {
                  skipGitHost: true,
                  ...(deps.gitHost ? { gitHost: deps.gitHost } : {}),
                });
                return p.level === "pr" ? "draft" : p.level;
              },
              // The task's repo gets its worktree when it has none yet, as Run with AI does.
              before: async (task) => {
                // Round 50: a sync of its repo running elsewhere is said, and the task waits.
                const opened = await openTaskWorktree(root, change, task, deps.gitHost).catch(
                  (e: unknown) => {
                    if (e instanceof HttpError) return { code: 1, out: [], err: [e.detail ?? ""] };
                    throw e;
                  },
                );
                return opened && opened.code !== 0
                  ? opened.err.join(" ") ||
                      opened.out.join(" ") ||
                      "Its worktree couldn't be opened."
                  : undefined;
              },
              progress: (done, total, message) => {
                c.progress(done, total, message);
                c.line(message);
              },
              cancelled: () => c.cancelled,
              ...(deps.gitHost ? { gitHost: deps.gitHost } : {}),
              ...(deps.taskRun?.git ? { git: deps.taskRun.git } : {}),
              ...(deps.taskRun?.commands ? { commands: deps.taskRun.commands } : {}),
            });
            for (const x of r.ran)
              ctx.events.publish({
                type: "file.changed",
                path: `${changesRelOf(root)}/${change}/tasks/${x.task}/task-run.yaml`,
              });
            const ran = r.ran.map((x) =>
              "record" in x
                ? { task: x.task, repo: x.repo, state: x.record.state, branch: x.record.branch }
                : { task: x.task, repo: x.repo || (repoOf.get(x.task) ?? ""), refused: x.refused },
            );
            const left = r.stopped ? r.planned.slice(r.planned.indexOf(r.stopped.task) + 1) : [];
            return {
              result: Api.RunReadyResult.parse({
                ran,
                ...(r.stopped ? { stopped: r.stopped } : {}),
                left,
              }),
            };
          },
          { title: `Run the ready tasks of ${change}` },
        );
        return { status: 202, body: Api.RunReadyAccepted.parse({ jobId: job.id, tasks }) };
      })
      // Sixth UX walk (2.69.0): a drafted task's PR from the Task board. The person's
      // confirmation from the app is the approval to push its branch and open the PR into the
      // change branch (ADR 0073, 0186), as Raise hand-off's is; the AI step isn't run again.
      .add("POST", "/api/changes/{changeId}/tasks/{taskId}/pr", async ({ params, body }) => {
        await readChange(root, params.changeId!);
        const change = params.changeId!;
        const task = params.taskId!;
        const b = parseBody(Api.ConfirmedRequest, body ?? {});
        if (!(await taskViews(root, change)).some((t) => t.id === task))
          throw notFound(`Change ${change} has no task ${task}.`);
        confirmed("task-pr", `${change}/${task}`, b.confirmation);
        let raised: Awaited<ReturnType<typeof raiseTaskPr>>;
        try {
          raised = await raiseTaskPr(root, change, task, {
            approval: {
              by: user,
              at: (deps.now ? new Date(deps.now) : new Date()).toISOString(),
              ref: `task ${task} of ${change}: push and PR (the app's Raise the task's PR)`,
            },
            ...(deps.taskRun?.git ? { git: deps.taskRun.git } : {}),
            ...(deps.gitHost ? { gitHost: deps.gitHost } : {}),
          });
        } catch (e) {
          if (e instanceof Error && (e.name === "TaskRunError" || TASK_ERRORS.has(e.name)))
            throw refused({ code: 1, out: [], err: [e.message] });
          throw e;
        }
        ctx.events.publish({
          type: "file.changed",
          path: `${changesRelOf(root)}/${change}/tasks/${task}/task-run.yaml`,
        });
        // Review round 42: a push or PR that failed leaves the task built with a note of why, so
        // it can be raised again; 201 says the PR is raised, so this one is the refusal (422).
        if (raised.state !== "pr-open")
          throw refused({
            code: 1,
            out: [],
            err: [raised.notes.at(-1) ?? "The PR wasn't raised."],
          });
        return {
          status: 201,
          body: (
            await taskViews(root, change, { ...(deps.gitHost ? { gitHost: deps.gitHost } : {}) })
          ).find((t) => t.id === task)!,
        };
      })
      // App-only audit (3.3.0): Build and raise PR on a task drafted but not built (UNVERIFIED) or
      // one a person took over: built where it is with its repo's build command as it is now, and
      // with `raise`, the person's confirmation (ADR 0186, `task-pr`) pushes its branch and opens
      // its PR into the change branch. The AI step isn't run again.
      .add("POST", "/api/changes/{changeId}/tasks/{taskId}/build", async ({ params, body }) => {
        await readChange(root, params.changeId!);
        const change = params.changeId!;
        const task = params.taskId!;
        const b = parseBody(Api.TaskBuildRequest, body ?? {});
        if (!(await taskViews(root, change)).some((t) => t.id === task))
          throw notFound(`Change ${change} has no task ${task}.`);
        if (b.raise) confirmed("task-pr", `${change}/${task}`, b.confirmation);
        let built: Awaited<ReturnType<typeof buildTask>>;
        try {
          built = await buildTask(root, change, task, {
            ...(b.raise
              ? {
                  approval: {
                    by: user,
                    at: (deps.now ? new Date(deps.now) : new Date()).toISOString(),
                    ref: `task ${task} of ${change}: build, push and PR (the app's Build and raise PR)`,
                  },
                }
              : {}),
            ...(deps.taskRun?.git ? { git: deps.taskRun.git } : {}),
            ...(deps.taskRun?.commands ? { commands: deps.taskRun.commands } : {}),
            ...(deps.gitHost ? { gitHost: deps.gitHost } : {}),
          });
        } catch (e) {
          if (e instanceof Error && (e.name === "TaskRunError" || TASK_ERRORS.has(e.name)))
            throw refused({ code: 1, out: [], err: [e.message] });
          throw e;
        }
        ctx.events.publish({
          type: "file.changed",
          path: `${changesRelOf(root)}/${change}/tasks/${task}/task-run.yaml`,
        });
        // The build failed: said as the refusal (422), with its log; the card offers it again.
        if (built.state !== "built" && built.state !== "pr-open")
          throw refused({ code: 1, out: [], err: [built.notes.at(-1) ?? "The build fails."] });
        return {
          status: built.state === "pr-open" ? 201 : 200,
          body: (
            await taskViews(root, change, { ...(deps.gitHost ? { gitHost: deps.gitHost } : {}) })
          ).find((t) => t.id === task)!,
        };
      })
      .add("POST", "/api/changes/{changeId}/workspace", async ({ params, body }) => {
        await readChange(root, params.changeId!);
        const b = parseBody(Api.OpenWorkspaceRequest, body);
        const res = await inlineGit(() =>
          run((io) =>
            workspaceOpen(root, params.changeId!, b.repos, io, {
              lockWaitMs: INLINE_LOCK_WAIT_MS,
            }),
          ),
        );
        if (res.code !== 0) throw refused(res);
        const repos = await readFile(
          join(changesDirOf(root), params.changeId!, "repos.yaml"),
          "utf8",
        ).catch(() => "");
        return { status: 200, body: { lines: res.out, reposYaml: repos } };
      })
      .add("POST", "/api/changes/{changeId}/handoff", async ({ params, body }) => {
        await readChange(root, params.changeId!);
        // The phase defaults to the change's current one; repo names the metarepo (ADR 0043).
        // The person's confirmation from the app is the approval to open the PR (ADR 0073,
        // 0186); the session token alone is 403.
        const b = parseBody(Api.HandoffRequest, body);
        confirmed("handoff", params.changeId!, b.confirmation);
        const res = await run((io) =>
          changeHandoff(
            root,
            params.changeId!,
            { by: user, approve: true, ...(b.repo ? { repo: b.repo } : {}) },
            io,
            changeDeps,
          ),
        );
        if (res.code !== 0) throw refused(res);
        // Review round 35: what the hand-off said (a branch it couldn't push) reaches the page.
        return {
          status: 201,
          body: { ...(await changeDetail(root, params.changeId!)), notes: res.out },
        };
      })
      // App-only audit (3.3.0): Push again. The open hand-off's branch, kept here when its push
      // failed, goes to the remote by name, never forced, on the person's confirmation (ADR 0186,
      // `handoff`): a push to a shared system. What git said is the refusal (422).
      .add("POST", "/api/changes/{changeId}/handoff/push", async ({ params, body }) => {
        const c = await readChange(root, params.changeId!);
        const b = parseBody(Api.ConfirmedRequest, body ?? {});
        confirmed("handoff", params.changeId!, b.confirmation);
        const live = liveHandoff(c);
        if (!live)
          throw refused({
            code: 1,
            out: [],
            err: [`${c.id} has no open hand-off, so there is no branch to push.`],
          });
        try {
          const r = await pushHandoffBranch(root, live.branch, {
            approval: {
              by: user,
              at: (deps.now ? new Date(deps.now) : new Date()).toISOString(),
              ref: `${c.id}: push ${live.branch} (the app's Push again)`,
            },
          });
          ctx.events.publish({
            type: "file.changed",
            path: `${changesRelOf(root)}/${c.id}/change.yaml`,
          });
          return {
            status: 200,
            body: {
              ...(await changeDetail(root, c.id)),
              notes: [`Pushed ${r.branch} (${r.commit.slice(0, 12)}).`],
            },
          };
        } catch (e) {
          const words = (e instanceof Error ? e.message : String(e)).split("\n")[0]!;
          throw refused({
            code: 1,
            out: [],
            err: [
              `${live.branch} wasn't pushed (${words}): fix that and Push again, or push it yourself (git push origin ${live.branch}).`,
            ],
          });
        }
      })
      .add("POST", "/api/changes/{changeId}/release-prs", async ({ params, body }) => {
        const id = params.changeId!;
        await readChange(root, id);
        const b = parseBody(Api.ReleasePrsRequest, body);
        // ADR 0184: the person's confirmation from the app (ADR 0186) is the approval to push the
        // change branch where the host lacks it (never forced, never the default branch) and to
        // open the release PRs.
        confirmed("release-prs", id, b.confirmation);
        const res = await run((io) =>
          changeReleasePrs(root, id, { by: user, approve: true }, io, changeDeps),
        );
        ctx.events.publish({ type: "file.changed", path: `${id}/repos.yaml` });
        if (res.code !== 0) throw refused(res);
        return { status: 201, body: Api.LinesView.parse({ lines: res.out }) };
      })
      .add("POST", "/api/changes/{changeId}/sync", async ({ params, body }) => {
        await readChange(root, params.changeId!);
        const b = parseBody(Api.SyncRequest, body);
        // Sync and merge: the person's confirmation from the app is the approval to merge a PR
        // that is ready (ADR 0186). Without one, sync only reads the PRs and says what is ready.
        const approve = b.confirmation !== undefined;
        if (approve) confirmed("merge", params.changeId!, b.confirmation);
        const res = await run((io) =>
          changeSync(
            root,
            params.changeId!,
            { by: user, approve, ...(b.repo ? { repo: b.repo } : {}) },
            io,
            changeDeps,
          ),
        );
        if (res.code === 2) throw refused(res);
        // Ninth UX walk: a merge not pulled yet is brought in on Home, not with git pull.
        const { appLines } = await import("./handoff-resume.js");
        return {
          status: 200,
          body: {
            ...(await changeDetail(root, params.changeId!)),
            lines: appLines([...res.out, ...res.err]),
          },
        };
      })
      // ADR 0113: files attached to a change. The upload is a write to the metarepo's own files,
      // guarded like every other write (the session token, this host only, JSON only); the
      // person's choice of the file in the app is the approval. It may be larger than other calls.
      .add("GET", "/api/changes/{changeId}/inputs", async ({ params }) => {
        const c = await readChange(root, params.changeId!);
        const { readChangeInputs } = await import("@maycombhq/intake");
        return {
          status: 200,
          body: Api.ChangeInputList.parse(await readChangeInputs(join(changesDirOf(root), c.id))),
        };
      })
      // ADR 0133: each prototype attached to the change, compared again from today's facts.
      .add("GET", "/api/changes/{changeId}/prototypes", async ({ params }) => {
        const c = await readChange(root, params.changeId!);
        const { changePrototypes } = await import("./prototype-commands.js");
        return {
          status: 200,
          body: Api.ChangePrototypeList.parse(await changePrototypes(root, c.id)),
        };
      })
      // Round 36 (UX review): Compare from the app, the command line's own attach. A write to the
      // change's own files in the metarepo (ADR 0183's local steps), on the person's click.
      .add("POST", "/api/changes/{changeId}/prototypes", async ({ params, body }) => {
        const c = await readChange(root, params.changeId!);
        const b = parseBody(Api.ComparePrototypeRequest, body);
        const { attachPrototype, changePrototypes } = await import("./prototype-commands.js");
        const res = await run((io) =>
          attachPrototype(
            root,
            c.id,
            b.repo,
            { by: user, ...(deps.now ? { now: new Date(deps.now) } : {}) },
            io,
          ),
        );
        if (res.code !== 0) throw refused(res);
        ctx.events.publish({ type: "file.changed", path: `${changesRelOf(root)}/${c.id}/inputs` });
        return {
          status: 201,
          body: Api.ComparePrototypeView.parse({
            ...(await changePrototypes(root, c.id)),
            lines: res.out,
          }),
        };
      })
      .add(
        "POST",
        "/api/changes/{changeId}/inputs",
        async ({ params, body }) => {
          const c = await readChange(root, params.changeId!);
          const b = parseBody(Api.AttachFileRequest, body);
          const bytes = new Uint8Array(Buffer.from(b.content, "base64"));
          if (bytes.length > MAX_ATTACH)
            throw new HttpError(413, "The file is too large", "Attach a file of 15 MB or less.");
          const { attachFiles } = await import("./attach-commands.js");
          const r = await attachFiles(root, c.id, [{ name: b.name, bytes }], user);
          if (!r.added.length)
            throw new HttpError(422, "Atticus can't attach that", r.refused[0]?.why ?? "", {
              lines: r.refused.map((x) => `${x.name}: ${x.why}`),
            });
          return { status: 201, body: Api.AttachResult.parse(r) };
        },
        { maxBody: Math.ceil((MAX_ATTACH * 4) / 3) + 64 * 1024 },
      )
      .add("GET", "/api/changes/{changeId}/runs", async ({ params }) => {
        await readChange(root, params.changeId!);
        const dir = join(runsDirOf(root), params.changeId!);
        const out = [];
        for (const id of (await readdir(dir).catch(() => [] as string[])).sort()) {
          const v = await runView(root, params.changeId!, id);
          if (v) out.push(v);
        }
        return { status: 200, body: out };
      })
      .add("POST", "/api/changes/{changeId}/runs", async ({ params, body }) => {
        await readChange(root, params.changeId!);
        const b = parseBody(Api.StartRunRequest, body);
        // Review round 50 (ADR 0186 addendum): in model mode the key goes only where the person
        // confirmed it.
        await requireConfirmedModel(root, b.runtime);
        const before = new Set(
          await readdir(join(runsDirOf(root), params.changeId!)).catch(() => [] as string[]),
        );
        let res: Ran;
        if (b.task) {
          // The app never pushes or opens a PR (that is the person's --approve, in the editor or
          // on the command line): asked for nothing, a task runs at runtime.yaml's level,
          // lowered to the repo's cap, and at most draft; draft-and-pr asked for is refused.
          let level: "plan" | "draft" | "pr" | undefined = b.autonomy
            ? b.autonomy === "draft-and-pr"
              ? "pr"
              : b.autonomy === "plan-only"
                ? "plan"
                : "draft"
            : undefined;
          if (level === "pr")
            throw refused({
              code: 1,
              out: [],
              err: [
                "The pr level pushes the task branch and opens a PR, which needs the person's yes: start it from VS Code, IntelliJ or the command line (atticus task run <change> <task> --level pr --approve).",
              ],
            });
          if (!level) {
            try {
              // The level is wanted here: the app never pushes, so whether a Git host is there to
              // push to isn't asked. Review round 43: a task whose PR is open asks the route's Git
              // host (read-only) whether it still is, so one merged or closed runs again.
              const p = await previewTaskRun(root, params.changeId!, b.task, {
                skipGitHost: true,
                ...(deps.gitHost ? { gitHost: deps.gitHost } : {}),
              });
              level = p.level === "pr" ? "draft" : p.level;
            } catch (e) {
              // A task that waits is 409; a task, repo or setting that isn't right is said (422),
              // as the CLI says it, never "Something went wrong".
              if (e instanceof Error && e.name === "TaskRunError") throw conflict(e.message);
              if (e instanceof Error && TASK_ERRORS.has(e.name))
                throw refused({ code: 1, out: [], err: [e.message] });
              throw e;
            }
          }
          const lv = level;
          // UX review: the task's repo gets its worktree here when it has none yet (a local
          // folder, nothing shared), so Run with AI never sends the person to a terminal first.
          const opened = await openTaskWorktree(root, params.changeId!, b.task!, deps.gitHost);
          if (opened && opened.code !== 0) throw refused(opened);
          res = await run((io) =>
            taskRun(root, params.changeId!, b.task!, { mode: b.runtime, by: user, level: lv }, io, {
              ...(deps.gitHost ? { gitHost: deps.gitHost } : {}),
              ...(deps.taskRun?.git ? { git: deps.taskRun.git } : {}),
            }),
          );
          if (opened) res = { ...res, out: [...opened.out, ...res.out] };
        } else if (b.agent === "story-writer")
          res = await run((io) => planStories(root, params.changeId!, { mode: b.runtime }, io));
        else if (b.agent.endsWith("-critic"))
          res = await run((io) => critic(root, params.changeId!, { mode: b.runtime }, io));
        else
          throw badRequest(
            `Start ${b.agent} from its screen; this call starts task runs, the story writer and the critic.`,
          );
        if (res.code === 2) throw refused(res);
        const after = (
          await readdir(join(runsDirOf(root), params.changeId!)).catch(() => [] as string[])
        )
          .filter((x) => !before.has(x))
          .sort();
        if (after.length === 0) throw refused(res);
        const v = await runView(root, params.changeId!, after.at(-1)!);
        for (const id of after)
          ctx.events.publish({
            type: "run.changed",
            runId: id,
            state: (await runView(root, params.changeId!, id))?.state ?? "prepared",
          });
        return { status: 201, body: v };
      })
      .add("POST", "/api/changes/{changeId}/critic", async ({ params, body }) => {
        await readChange(root, params.changeId!);
        const b = parseBody(Api.RunCriticRequest, body);
        // AI lenses go to the person's assistant (hand-off) unless AI is off here (ADR 0046):
        // then the rule checks run alone and the lenses are recorded as not run.
        const op = await loadOrgPack(orgPackDirOf(root));
        const mode = op.runtime.ai === "off" ? undefined : "hand-off";
        const once = (gate?: string) =>
          run((io) =>
            critic(
              root,
              params.changeId!,
              { ...(gate ? { gate } : {}), ...(mode ? { mode } : {}), json: true },
              io,
            ),
          );
        // ADR 0187: as a job, so the Console shows it while the page waits.
        const res = await tracked(ctx, `Critic on ${params.changeId!}`, async () => {
          let got = await once(b.gate);
          // A change in a state with no gate of its own (define) is checked at the gate it goes to.
          if (!b.gate && got.code === 2 && got.err.some((l) => /has no gate/.test(l))) {
            const next = (await changeReport(root, params.changeId!)).next;
            if (next) got = await once(next);
          }
          return got;
        });
        if (res.code === 2) throw refused(res);
        ctx.events.publish({
          type: "file.changed",
          path: `${changesRelOf(root)}/${params.changeId!}/review`,
        });
        let round: unknown;
        try {
          round = JSON.parse(res.out.join("\n"));
        } catch {
          throw refused(res);
        }
        return { status: 200, body: { ai: op.runtime.ai, round } };
      })
      .add("GET", "/api/runs/{runId}", async ({ params }) => ({
        status: 200,
        body: await findRun(root, params.runId!),
      }))
      .add("POST", "/api/runs/{runId}/done", async ({ params }) => ({
        status: 200,
        body: await doneRun(params.runId!, "person"),
      }))
      .add("POST", "/api/runs/{runId}/retry", async ({ params }) => {
        const v = await findRun(root, params.runId!);
        if (v.state !== "failed")
          throw conflict(`Only a failed run can be retried; ${v.runId} is ${v.state}.`);
        // A task run's own run is retried by its task run (Done, or the task run again), never
        // on its own: it would then be marked done with nothing built.
        const owner = await findTaskRunOfRun(root, v.runId);
        if (owner && owner.waiting !== v.runId) throw conflict(taskRunNotWaiting(v.runId, owner));
        const file = join(runsDirOf(root), v.change, v.runId, "run.json");
        const was = await readFile(file, "utf8");
        const rec = JSON.parse(was);
        rec.state = "prepared";
        rec.attempt = (rec.attempt ?? 1) + 1;
        rec.errors = [];
        // Atomic (a step reading run.json never sees half a file), 409 if a runner wrote meanwhile.
        await writeFileIfUnchanged(file, was, JSON.stringify(rec, null, 2) + "\n");
        const after = await findRun(root, params.runId!);
        ctx.events.publish({ type: "run.changed", runId: after.runId, state: after.state });
        return { status: 200, body: after };
      })
      .add("POST", "/api/runs/{runId}/cancel", async ({ params }) => {
        // A task run waiting on a run that isn't on this machine (.runs is per machine): the
        // wait is ended, so the task can run again here.
        const here = await findRun(root, params.runId!).catch(() => undefined);
        if (!here) {
          let ended;
          try {
            ended = await cancelTaskRunWait(root, params.runId!, { by: user });
          } catch (e) {
            // A Done running elsewhere holds the task: said as such, never "no run".
            if (e instanceof Error && e.name === "TaskRunError") throw conflict(e.message);
            throw e;
          }
          if (!ended) throw notFound(`There is no run ${params.runId}.`);
          // The run's own view, as the task run knows it (its run.json isn't here to read).
          const at = new Date().toISOString();
          const body: z.infer<typeof Api.RunView> = {
            schemaVersion: RUN_SCHEMA_VERSION,
            runId: params.runId!,
            change: ended.change,
            agent: "task-runner",
            runtime: "hand-off",
            state: "cancelled",
            startedAt: ended.startedAt,
            finishedAt: at,
            contextManifestSha256: sha(""),
            errors: [],
            attempt: 1,
          };
          ctx.events.publish({ type: "run.changed", runId: params.runId!, state: "cancelled" });
          return { status: 200, body };
        }
        const v = await findRun(root, params.runId!);
        if (["validated", "cancelled"].includes(v.state))
          throw conflict(`Run ${v.runId} is already ${v.state}.`);
        if (doneBusy.has(v.runId))
          throw conflict(`Done for ${v.runId} is running; wait for it to finish.`);
        const file = join(runsDirOf(root), v.change, v.runId, "run.json");
        const cancelRun = async () => {
          const was = await readFile(file, "utf8");
          const rec = JSON.parse(was);
          rec.state = "cancelled";
          rec.finishedAt = new Date().toISOString();
          await writeFileIfUnchanged(file, was, JSON.stringify(rec, null, 2) + "\n");
        };
        // A task run waiting on it ends too, so the task can run again; both under the task's
        // lock, so a Done running elsewhere (the assistant's, in a terminal) is waited for: 409.
        try {
          await cancelTaskRunWait(root, v.runId, { by: user, cancelRun });
        } catch (e) {
          if (e instanceof Error && e.name === "TaskRunError") throw conflict(e.message);
          throw e;
        }
        const after = await findRun(root, params.runId!);
        ctx.events.publish({ type: "run.changed", runId: after.runId, state: after.state });
        return { status: 200, body: after };
      })
      .add("POST", "/api/findings/{changeId}/{findingId}/action", async ({ params, body }) => {
        await readChange(root, params.changeId!);
        const b = parseBody(Api.FindingActionRequest, body);
        const res = await run((io) =>
          findingAction(
            root,
            params.changeId!,
            params.findingId!,
            b.action,
            {
              by: user,
              ...(b.reason ? { reason: b.reason } : {}),
              ...(b.askedOf ? { askedOf: b.askedOf } : {}),
              ...(b.patch ? { edit: b.patch } : {}),
              ...(b.gate ? { gate: b.gate } : {}),
            },
            io,
          ),
        );
        if (res.code !== 0) {
          if (res.err.some((l) => /no finding|not found/i.test(l)))
            throw notFound(res.err.join("\n"));
          if (res.err.some((l) => /can't be waived|not allowed|needs/i.test(l)))
            throw new HttpError(403, "Not allowed", res.err.join("\n"));
          throw refused(res);
        }
        const f = (await latestFindings(root, params.changeId!)).find(
          (x) => x.id === params.findingId,
        );
        return { status: 200, body: f };
      })
      .add("POST", "/api/scan", ({ body }) => {
        const b = parseBody(Api.ScanRequest, body);
        if (jobs.runningOf("scan")) throw conflict("A scan is already running.");
        const scanTitle = b.repos?.length ? `Scan ${b.repos.join(", ")}` : "Scan";
        const job = jobs.start(
          "scan",
          async (c) => {
            c.progress(0, 1, "Checking with the built-in readers");
            // App-only audit: host questions only for the repos the assistant has read (facts
            // on file), unless the person asks for every repo.
            const askFrom = b.askAll
              ? undefined
              : new Set(
                  (await readdir(factsDirOf(root)).catch(() => [] as string[]))
                    .map((f) => factsFileOf(f))
                    .filter((f) => f?.facts)
                    .map((f) => f!.repo),
                );
            const res = await run((io) =>
              scanCommand(
                root,
                {
                  ...(b.repos ? { repos: b.repos } : {}),
                  full: b.full,
                  json: true,
                  // ADR 0123: another branch, scanned beside the baseline.
                  ...(b.ref ? { ref: b.ref } : {}),
                  ...(askFrom ? { askFrom } : {}),
                },
                io,
              ),
            );
            c.progress(1, 1, "Scanned");
            const parsed = (() => {
              try {
                return JSON.parse(res.out.join("\n")) as Record<string, unknown>;
              } catch {
                return {};
              }
            })();
            const problems = (parsed.problems as unknown[] | undefined)?.length ?? 0;
            ctx.events.publish({
              type: "index.rebuilt",
              records: Number((parsed.stats as { records?: number } | undefined)?.records ?? 0),
            });
            // App-only audit: what the readers added, changed and removed, and the questions
            // it asked, said in the job's result and its Console lines.
            const diff = (parsed.diff ?? {}) as Record<string, unknown[] | undefined>;
            const added = diff.added?.length ?? 0;
            const changed = diff.changed?.length ?? 0;
            const removed = diff.removed?.length ?? 0;
            const questions = (parsed.questions as unknown[] | undefined)?.length ?? 0;
            printToCurrent(
              `The built-in readers added ${added} record${added === 1 ? "" : "s"}, changed ${changed} and removed ${removed}; ${questions} host question${questions === 1 ? " is" : "s are"} open.`,
            );
            return {
              result: { stats: parsed.stats, problems, added, changed, removed, questions },
              errors: res.code === 2 ? res.err : [],
            };
          },
          { title: scanTitle },
        );
        return { status: 202, body: { jobId: job.id } };
      })
      .add("POST", "/api/workspace/sync", ({ body }) => {
        const b = parseBody(Api.ScanRequest.pick({ repos: true }), body);
        // Review round 48: one sync at a time here (as a scan); the base clones' own lock keeps
        // a terminal's sync from running git with this one.
        const busy = jobs.runningOf("sync");
        if (busy) throw conflict(`A sync is already running (${busy.id}): wait for it to finish.`);
        const job = jobs.start(
          "sync",
          async (c) => {
            c.progress(0, 1, "Syncing base clones");
            const res = await run((io) => workspaceSync(root, b.repos, io));
            c.progress(1, 1, "Synced");
            return { result: { lines: res.out }, errors: res.code === 0 ? [] : res.err };
          },
          { title: b.repos?.length ? `Sync ${b.repos.join(", ")}` : "Sync the base clones" },
        );
        return { status: 202, body: { jobId: job.id } };
      })
      .add("POST", "/api/reconcile", ({ body }) => {
        const b = parseBody(Api.ReconcileRequest, body);
        const busy = jobs.runningOf("reconcile");
        if (busy)
          throw conflict(`A reconcile is already running (${busy.id}): wait for it to finish.`);
        const job = jobs.start(
          "reconcile",
          async (c) => {
            c.progress(0, 1, `Reconciling ${b.diagram}`);
            const res = await run((io) => reconcileCommand(root, [b.diagram], { json: true }, io));
            c.progress(1, 1, "Reconciled");
            let result: Record<string, unknown>;
            try {
              result = JSON.parse(res.out.join("\n")) as Record<string, unknown>;
            } catch {
              result = { lines: res.out };
            }
            return { result, errors: res.code === 2 ? res.err : [] };
          },
          { title: `Reconcile ${b.diagram}` },
        );
        return { status: 202, body: { jobId: job.id } };
      })
  );
}
