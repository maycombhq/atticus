import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { baseClonePath } from "@maycombhq/workspace";
import {
  Api,
  ChangeArtifact,
  changesDirOf,
  changesRelOf,
  loadOrgPack,
  orgPackDirOf,
  runsDirOf,
  runsRelOf,
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
  liveHandoff,
  requiredArtifacts,
  loadChangeContext,
  type ChangeReport,
} from "@maycombhq/changes";
import type { GitHost } from "@maycombhq/adapters";
import { readChangeFiles, readRound, reviewedGates, roundsOf } from "@maycombhq/naysayer";
import { readChangeTasks } from "@maycombhq/speckit";
import {
  badRequest,
  conflict,
  HttpError,
  notFound,
  type Router,
  type ServerContext,
} from "@maycombhq/server";
import type { Output } from "./commands.js";
import { changeHandoff, changeNew, changeSync } from "./change-commands.js";
import { critic, findingAction } from "./critic-commands.js";
import { planStories } from "./plan-commands.js";
import { reconcileCommand } from "./reconcile-commands.js";
import {
  cancelTaskRunWait,
  findTaskRunOfRun,
  previewTaskRun,
  taskRunOfRun,
} from "@maycombhq/taskrun";
import { runDone, taskRun, taskRunNotWaiting } from "./run-commands.js";
import { scanCommand } from "./scan-commands.js";
import { workspaceOpen, workspaceSync } from "./workspace-commands.js";

/**
 * The write side of the local API (ADR 0015). Every call runs the same command function the
 * terminal does, so the screen and `atticus …` can never disagree: exit 0 is success, 1 is a
 * refusal (422 with the command's own words), 2 a bad request (400).
 */

/** Opens the task's repo's worktree when the change has none for it; undefined when it has. */
async function openTaskWorktree(
  root: string,
  change: string,
  task: string,
): Promise<Ran | undefined> {
  const p = await previewTaskRun(root, change, task, { skipGitHost: true }).catch(() => undefined);
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
  // No base clone yet either (a repo the person never cloned): clone it first.
  if (!existsSync(baseClonePath(root, p.repo))) {
    const synced = await run((io) => workspaceSync(root, [p.repo], io));
    if (synced.code !== 0) return synced;
    const opened = await run((io) => workspaceOpen(root, change, [p.repo], io));
    return { ...opened, out: [...synced.out, ...opened.out] };
  }
  return run((io) => workspaceOpen(root, change, [p.repo], io));
}

export interface UiDeps {
  /** Tests inject a mock Git host; otherwise runtime.yaml decides. */
  gitHost?: GitHost;
  now?: string;
  /** Tests: a task run's build and Git, for Done (otherwise the repo's build and real Git). */
  taskRun?: Pick<import("./run-commands.js").RunDeps, "commands" | "git">;
  /** Tests: the in-process atticus a step's resume runs with (fourth UX walk). */
  runStep?: import("./handoff-resume.js").StepRunner;
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
  const code = await f({ out: (l) => out.push(l), err: (l) => err.push(l) });
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
      openFindings: findings.filter((f) => f.state === "open" && f.artifact.startsWith(a)).length,
    });
  }
  const h = liveHandoff(c) ?? c.handoffs.at(-1);
  // ADR 0113: whether it takes the fast path.
  const fast = (await changeSize(cctx, c)).fast;
  return {
    id: c.id,
    title: c.title,
    type: c.type,
    state: c.state,
    repos: c.touches.repos,
    openFindings: open,
    updatedAt: c.history.at(-1)?.at ?? c.createdAt,
    ...(fast ? { fastPath: true } : {}),
    artifacts,
    ...(h
      ? {
          handoff: {
            phase: h.phase,
            ...(h.pr?.url ? { pr: h.pr.url } : {}),
            state: h.state === "merged" ? "merged" : h.state === "closed" ? "closed" : "open",
          },
        }
      : {}),
  };
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
  o: { orNew?: boolean } = {},
): Promise<string> {
  const a = ChangeArtifact.safeParse(artifact);
  if (!a.success)
    throw badRequest(
      `${artifact} is not an artifact. Use one of ${ChangeArtifact.options.join(", ")}.`,
    );
  const dir = join(changesDirOf(root), id);
  const files = await artifactFiles(dir, a.data);
  // Third UX walk: a one-file artifact not written yet opens empty, and Save creates it (a new
  // change's proposal, written by hand). Specs are one file per capability: drafted, not here.
  if (files.length === 0 && o.orNew && a.data !== "specs")
    return a.data === "stories" ? "stories.md" : `${a.data}.md`;
  if (files.length === 0) throw notFound(`Change ${id} has no ${artifact} yet.`);
  return files[0]!;
}

export function uiRoutes(r: Router, ctx: ServerContext, deps: UiDeps = {}): Router {
  const { root, user, jobs } = ctx;
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
  const asJob = (what: string, work: () => Promise<Ran>) => {
    // Round 37: its own kind, so a slow Apply never reads as "an AI step is running".
    const job = ctx.jobs.start("local", async (c) => {
      c.progress(0, 1, what);
      const res = await work();
      c.progress(1, 1, res.code === 0 ? "Done" : "Stopped");
      ctx.events.publish({ type: "file.changed", path: "." });
      const lines = [...res.out, ...res.err];
      return { result: { code: res.code, lines }, errors: res.code === 0 ? [] : lines };
    });
    return { status: 202, body: { jobId: job.id } };
  };
  return (
    r
      // ADR 0183: the app runs the local steps and proposes them for review on the person's yes.
      .add("POST", "/api/facts/{repo}/apply", async ({ params }) => {
        const { verifyCommand } = await import("./verify-commands.js");
        return asJob(`Applying to ${params.repo}`, () =>
          run((io) =>
            verifyCommand(root, params.repo!, { write: true, verbose: false, json: false }, io),
          ),
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
        return { status: 200, body: plan };
      })
      .add("POST", "/api/propose", async ({ body }) => {
        const b = parseBody(Api.ProposeRequest, body);
        const { proposeForReview } = await import("./propose.js");
        // The person's click is the approval to push the branch and open the PR (ADR 0183).
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
      .add("GET", "/api/changes/{changeId}/artifacts/{artifact}", async ({ params }) => {
        await readChange(root, params.changeId!);
        const rel = await artifactPath(root, params.changeId!, params.artifact!, { orNew: true });
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
      .add("PUT", "/api/changes/{changeId}/artifacts/{artifact}", async ({ params, body }) => {
        await readChange(root, params.changeId!);
        const b = parseBody(Api.SaveArtifactRequest, body);
        const rel = await artifactPath(root, params.changeId!, params.artifact!, { orNew: true });
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
      })
      .add("GET", "/api/changes/{changeId}/tasks", async ({ params }) => {
        await readChange(root, params.changeId!);
        const files = await readChangeFiles(join(changesDirOf(root), params.changeId!));
        return {
          status: 200,
          body: readChangeTasks(files).map((t) => ({
            id: t.id,
            repo: t.repo,
            description: t.title,
            done: t.done,
            ...(t.stories[0] ? { story: t.stories[0] } : {}),
            branch: `task/${params.changeId}/${t.id}`,
          })),
        };
      })
      .add("POST", "/api/changes/{changeId}/workspace", async ({ params, body }) => {
        await readChange(root, params.changeId!);
        const b = parseBody(Api.OpenWorkspaceRequest, body);
        const res = await run((io) => workspaceOpen(root, params.changeId!, b.repos, io));
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
        // The person's click is the approval to open the PR (ADR 0073).
        const b = parseBody(Api.HandoffRequest, body);
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
      .add("POST", "/api/changes/{changeId}/sync", async ({ params, body }) => {
        await readChange(root, params.changeId!);
        const b = parseBody(Api.SyncRequest, body);
        // Sync and merge: the person's click is the approval to merge a PR that is ready.
        const res = await run((io) =>
          changeSync(
            root,
            params.changeId!,
            { by: user, approve: true, ...(b.repo ? { repo: b.repo } : {}) },
            io,
            changeDeps,
          ),
        );
        if (res.code === 2) throw refused(res);
        return {
          status: 200,
          body: {
            ...(await changeDetail(root, params.changeId!)),
            lines: [...res.out, ...res.err],
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
              // Only the level is wanted here: the app never pushes, so no Git host is made.
              const p = await previewTaskRun(root, params.changeId!, b.task, { skipGitHost: true });
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
          const opened = await openTaskWorktree(root, params.changeId!, b.task!);
          if (opened && opened.code !== 0) throw refused(opened);
          res = await run((io) =>
            taskRun(root, params.changeId!, b.task!, { mode: b.runtime, by: user, level: lv }, io),
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
        let res = await once(b.gate);
        // A change in a state with no gate of its own (define) is checked at the gate it goes to.
        if (!b.gate && res.code === 2 && res.err.some((l) => /has no gate/.test(l))) {
          const next = (await changeReport(root, params.changeId!)).next;
          if (next) res = await once(next);
        }
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
      .add("POST", "/api/runs/{runId}/done", async ({ params }) => {
        const before = await findRun(root, params.runId!);
        if (before.state === "validated" || before.state === "cancelled")
          throw conflict(`Run ${params.runId} is already ${before.state}.`);
        // One Done at a time per run: a second click while the first builds is told so (two
        // builds in one worktree collide, on Windows over locked files).
        if (doneBusy.has(params.runId!))
          throw conflict(`Done for ${params.runId} is already running; wait for it to finish.`);
        doneBusy.add(params.runId!);
        let res: Ran;
        try {
          // A task run's Done builds, fixes and commits as atticus handoff done does (round 22).
          res = await run((io) => runDone(root, params.runId!, { by: user }, io, deps.taskRun));
        } finally {
          doneBusy.delete(params.runId!);
        }
        const after = await findRun(root, params.runId!);
        ctx.events.publish({ type: "run.changed", runId: after.runId, state: after.state });
        // The answer had problems, the build failed, or the task needs a person: said as such,
        // with what the command printed, never as a success.
        if (res.code !== 0) throw refused(res);
        // Fourth UX walk: a step the app prepared is finished here too: its resume writes what
        // the answer said (a draft's proposal and specs), or offers its next prompt (`next`).
        const { resumeAfterDone } = await import("./handoff-resume.js");
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
          status: 200,
          body: {
            ...after,
            // When the app resumed the step, runDone's "run the step again with --resume" is done.
            lines: [
              ...[...res.out, ...res.err].filter((l) => !(resumed && /--resume run-/.test(l))),
              ...(resumed?.lines ?? []),
            ],
            ...(resumed?.next ? { next: resumed.next } : {}),
          },
        };
      })
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
        const job = jobs.start("scan", async (c) => {
          c.progress(0, 1, "Scanning");
          const res = await run((io) =>
            scanCommand(
              root,
              {
                ...(b.repos ? { repos: b.repos } : {}),
                full: b.full,
                json: true,
                // ADR 0123: another branch, scanned beside the baseline.
                ...(b.ref ? { ref: b.ref } : {}),
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
          return {
            result: { stats: parsed.stats, problems },
            errors: res.code === 2 ? res.err : [],
          };
        });
        return { status: 202, body: { jobId: job.id } };
      })
      .add("POST", "/api/workspace/sync", ({ body }) => {
        const b = parseBody(Api.ScanRequest.pick({ repos: true }), body);
        const job = jobs.start("sync", async (c) => {
          c.progress(0, 1, "Syncing base clones");
          const res = await run((io) => workspaceSync(root, b.repos, io));
          c.progress(1, 1, "Synced");
          return { result: { lines: res.out }, errors: res.code === 0 ? [] : res.err };
        });
        return { status: 202, body: { jobId: job.id } };
      })
      .add("POST", "/api/reconcile", ({ body }) => {
        const b = parseBody(Api.ReconcileRequest, body);
        const job = jobs.start("reconcile", async (c) => {
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
        });
        return { status: 202, body: { jobId: job.id } };
      })
  );
}
