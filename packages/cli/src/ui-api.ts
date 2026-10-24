import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
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
import { taskRun } from "./run-commands.js";
import { scanCommand } from "./scan-commands.js";
import { handoffDone, workspaceOpen, workspaceSync } from "./workspace-commands.js";

/**
 * The write side of the local API (ADR 0015). Every call runs the same command function the
 * terminal does, so the screen and `atticus …` can never disagree: exit 0 is success, 1 is a
 * refusal (422 with the command's own words), 2 a bad request (400).
 */

export interface UiDeps {
  /** Tests inject a mock Git host; otherwise runtime.yaml decides. */
  gitHost?: GitHost;
  now?: string;
}

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
  for (const a of report.type.artifacts as z.infer<typeof ChangeArtifact>[]) {
    const files = await artifactFiles(dir, a);
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
  };
  const manifest = await readFile(join(dir, "context-manifest.json"), "utf8").catch(() => "");
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
    promptPath: `${runsRelOf(root)}/${change}/${runId}/prompt.md`,
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
async function artifactPath(root: string, id: string, artifact: string): Promise<string> {
  const a = ChangeArtifact.safeParse(artifact);
  if (!a.success)
    throw badRequest(
      `${artifact} is not an artifact. Use one of ${ChangeArtifact.options.join(", ")}.`,
    );
  const dir = join(changesDirOf(root), id);
  const files = await artifactFiles(dir, a.data);
  if (files.length === 0) throw notFound(`Change ${id} has no ${artifact} yet.`);
  return files[0]!;
}

export function uiRoutes(r: Router, ctx: ServerContext, deps: UiDeps = {}): Router {
  const { root, user, jobs } = ctx;
  const changeDeps = {
    ...(deps.gitHost ? { gitHost: deps.gitHost } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  };
  return (
    r
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
        const rel = await artifactPath(root, params.changeId!, params.artifact!);
        const content = await readFile(join(changesDirOf(root), params.changeId!, rel), "utf8");
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
        const rel = await artifactPath(root, params.changeId!, params.artifact!);
        const file = join(changesDirOf(root), params.changeId!, rel);
        const now = await readFile(file, "utf8");
        if (sha(now) !== b.baseSha256)
          throw conflict(
            `${rel} changed since you opened it. Reload it, then make your edit again.`,
          );
        await writeFile(file, b.content, "utf8");
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
        return { status: 201, body: await changeDetail(root, params.changeId!) };
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
        if (b.task)
          res = await run((io) =>
            taskRun(
              root,
              params.changeId!,
              b.task!,
              {
                mode: b.runtime,
                by: user,
                ...(b.autonomy
                  ? {
                      level:
                        b.autonomy === "draft-and-pr"
                          ? "pr"
                          : b.autonomy === "plan-only"
                            ? "plan"
                            : "draft",
                    }
                  : {}),
              },
              io,
            ),
          );
        else if (b.agent === "story-writer")
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
        const res = await run((io) => handoffDone(root, params.runId!, io));
        const after = await findRun(root, params.runId!);
        ctx.events.publish({ type: "run.changed", runId: after.runId, state: after.state });
        return { status: 200, body: { ...after, lines: [...res.out, ...res.err] } };
      })
      .add("POST", "/api/runs/{runId}/retry", async ({ params }) => {
        const v = await findRun(root, params.runId!);
        if (v.state !== "failed")
          throw conflict(`Only a failed run can be retried; ${v.runId} is ${v.state}.`);
        const file = join(runsDirOf(root), v.change, v.runId, "run.json");
        const rec = JSON.parse(await readFile(file, "utf8"));
        rec.state = "prepared";
        rec.attempt = (rec.attempt ?? 1) + 1;
        rec.errors = [];
        await writeFile(file, JSON.stringify(rec, null, 2) + "\n");
        const after = await findRun(root, params.runId!);
        ctx.events.publish({ type: "run.changed", runId: after.runId, state: after.state });
        return { status: 200, body: after };
      })
      .add("POST", "/api/runs/{runId}/cancel", async ({ params }) => {
        const v = await findRun(root, params.runId!);
        if (["validated", "cancelled"].includes(v.state))
          throw conflict(`Run ${v.runId} is already ${v.state}.`);
        const file = join(runsDirOf(root), v.change, v.runId, "run.json");
        const rec = JSON.parse(await readFile(file, "utf8"));
        rec.state = "cancelled";
        rec.finishedAt = new Date().toISOString();
        await writeFile(file, JSON.stringify(rec, null, 2) + "\n");
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
