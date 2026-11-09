import { Api, currentSignal, loadOrgPack, orgPackDirOf, copilotAcpOf } from "@maycombhq/core";
import { badRequest, conflict, notFound, type Router, type ServerContext } from "@maycombhq/server";
import type { Output } from "./commands.js";
import { copilotAcpAllowed } from "./copilot-acp-steps.js";
import { randomBytes } from "node:crypto";
import { CopilotRun, TAB_LINES, type NewLines } from "./copilot-run.js";
import type { MapAllDeps, MapAllEvent, MapAllOptions } from "./map-all.js";

/**
 * ADR 0173: an unattended Copilot run started from the app, after the person's yes. The run is
 * `atticus map --all`'s own code (copilot-acp), in this process, as a job; its progress and its
 * lines (split into Console tabs by session) are kept here for the page and sent as live events.
 * One run at a time; Stop cancels the session under way, as Ctrl+C does.
 */

/** Starts `map --all` with the app's io and listeners; tests pass their own. */
export type MapAllStarter = (
  o: MapAllOptions,
  io: Output,
  deps: Pick<MapAllDeps, "signal" | "onEvent">,
) => Promise<number>;

const defaultStarter =
  (root: string): MapAllStarter =>
  async (o, io, deps) => {
    const { mapAllCommand } = await import("./map-all.js");
    return mapAllCommand(root, o, io, {
      ...deps,
      makeAcp: async () => (await import("./copilot-acp-steps.js")).acpStepRunner(root),
    });
  };

/** The lines of each tab a poll of the current run gets. */
const TAIL = 200;

const NOT_ALLOWED =
  "runtime.yaml doesn't allow copilot-acp here (schemaVersion 3, copilot-acp in modes.allowed and copilot in assistants.allowed), so the app can't start Copilot itself. Read through Copilot Chat instead: atticus map --all in a terminal gives each part to paste.";

async function allowedHere(root: string): Promise<{ allowed: boolean; model?: string }> {
  try {
    const op = await loadOrgPack(orgPackDirOf(root));
    const c = copilotAcpOf(op.runtime);
    return { allowed: copilotAcpAllowed(op), ...(c.model ? { model: c.model } : {}) };
  } catch {
    return { allowed: false };
  }
}

const optionsOf = (b: Api.StartCopilotRunRequestT): MapAllOptions => ({
  mode: "copilot-acp",
  ...(b.kind === "stale" ? { stale: true } : {}),
  ...(b.kind === "gaps" ? { gaps: true } : {}),
  ...(b.repos?.length ? { repos: b.repos } : {}),
  ...(b.force ? { force: true } : {}),
  resumeAs: "the next run (Map from the app, or atticus map --all)",
});

export function uiCopilotRunRoutes(
  r: Router,
  ctx: ServerContext,
  deps: { start?: MapAllStarter; now?: () => Date; flushMs?: number } = {},
): Router {
  const start = deps.start ?? defaultStarter(ctx.root);
  const now = deps.now ?? (() => new Date());
  const flushMs = deps.flushMs ?? 100;
  let run: CopilotRun | undefined;
  let allowed: { at: number; v: Awaited<ReturnType<typeof allowedHere>> } | undefined;
  let seq = 0;
  // A start under way (between its checks and the run being set): a second waits its turn.
  let starting = false;

  // Lines go out in small batches per tab, so a chatty session doesn't flood the socket.
  const pending = new Map<string, NewLines>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    const r0 = run;
    if (!r0) return;
    for (const n of pending.values())
      ctx.events.publish({ type: "copilot-run.lines", runId: r0.view.runId, ...n });
    pending.clear();
  };
  const queue = (n: NewLines) => {
    const p = pending.get(n.tab);
    if (p) p.lines.push(...n.lines);
    else pending.set(n.tab, { ...n, lines: [...n.lines] });
    timer ??= setTimeout(flush, flushMs);
  };
  const state = () => {
    if (run) ctx.events.publish({ type: "copilot-run.state", run: run.summary() });
  };

  return (
    r
      .add("GET", "/api/copilot-runs/current", async ({ query }) => {
        // Read once a few seconds, not on every poll: runtime.yaml changes rarely.
        if (!allowed || Date.now() - allowed.at > 10_000)
          allowed = { at: Date.now(), v: await allowedHere(ctx.root) };
        const a = allowed.v;
        // A page that polls gets each tab's last lines only (it has the rest, or asks for them).
        const tail = Math.min(Math.max(Number(query.get("tail") ?? TAIL) || TAIL, 0), TAB_LINES);
        const view = run
          ? {
              ...run.summary(),
              tabs: run.view.tabs.map((t) => {
                const keep = tail ? t.lines.slice(-tail) : t.lines;
                return { ...t, from: t.from + t.lines.length - keep.length, lines: [...keep] };
              }),
            }
          : null;
        return {
          status: 200,
          body: {
            run: view,
            allowed: a.allowed,
            ...(a.allowed ? {} : { why: NOT_ALLOWED }),
            ...(a.model ? { model: a.model } : {}),
          } satisfies Api.CopilotRunCurrentT,
        };
      })
      .add("POST", "/api/copilot-runs", async ({ body }) => {
        const b = Api.StartCopilotRunRequest.safeParse(body ?? {});
        if (!b.success)
          throw badRequest("Some fields aren't right.", {
            errors: b.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
          });
        if (b.data.kind === "repos" && !b.data.repos?.length)
          throw badRequest("Name the repos to read (repos), or pick stale, gaps or all.");
        if (run?.view.state === "running")
          throw conflict(
            `A Copilot run is under way (${run.view.runId}, started ${run.view.startedAt}): stop it, or wait for it to finish.`,
          );
        if (starting)
          throw conflict("A Copilot run is starting: wait for it, then stop it if need be.");
        const busy = ctx.jobs.runningOf("step");
        if (busy?.state === "running")
          throw conflict(
            `An AI step is running on this server (${busy.id}): wait for it to finish.`,
          );
        starting = true;
        let a: Awaited<ReturnType<typeof allowedHere>>;
        try {
          a = await allowedHere(ctx.root);
        } finally {
          starting = false;
        }
        if (!a.allowed) throw conflict(NOT_ALLOWED);
        // Checked again: a step may have started while the runtime was being read.
        if (ctx.jobs.runningOf("step")?.state === "running")
          throw conflict("An AI step started on this server meanwhile: wait for it to finish.");
        // Unique across restarts of the app's server, so a page kept open never mixes two runs.
        const runId = `copilot-run-${now().getTime().toString(36)}-${randomBytes(3).toString("hex")}-${++seq}`;
        const me = new CopilotRun({
          runId,
          jobId: "",
          kind: b.data.kind,
          ...(b.data.repos ? { repos: b.data.repos } : {}),
          ...(b.data.force ? { force: true } : {}),
          ...(ctx.user ? { by: ctx.user } : {}),
          ...(a.model ? { model: a.model } : {}),
          startedAt: now().toISOString(),
        });
        run = me;
        let lastErr: string | undefined;
        const job = ctx.jobs.start(
          "step",
          async (c) => {
            const io: Output = {
              out: (l) => queue(me.line(l)),
              err: (l) => {
                lastErr = l;
                queue(me.line(l));
              },
            };
            const onEvent = (e: MapAllEvent) => {
              for (const n of me.event(e)) queue(n);
              const p = me.view.progress;
              c.progress(p.repoIndex, p.repos, p.session ?? p.repo ?? "Planning");
              state();
            };
            const signal = currentSignal();
            let code: number;
            try {
              code = await start(optionsOf(b.data), io, {
                ...(signal ? { signal } : {}),
                onEvent,
              });
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              queue(me.finish(signal?.aborted ? "stopped" : "failed", now().toISOString(), msg));
              flush();
              state();
              // Repos read before it failed were written: the pages read the facts again.
              ctx.events.publish({ type: "file.changed", path: "facts" });
              return { errors: [msg] };
            }
            const stopped = signal?.aborted === true;
            queue(
              me.finish(
                stopped ? "stopped" : code === 0 ? "done" : "failed",
                now().toISOString(),
                stopped || code === 0
                  ? undefined
                  : (lastErr ?? `atticus map --all ended with ${code}`),
              ),
            );
            flush();
            state();
            ctx.events.publish({ type: "file.changed", path: "facts" });
            return { result: { code, runId } };
          },
          { meta: { copilotRunId: runId } },
        );
        me.view.jobId = job.id;
        state();
        return { status: 202, body: structuredClone(me.view) };
      })
      // A tab's lines from a line on, for a page catching up or showing earlier lines.
      .add("GET", "/api/copilot-runs/{runId}/tabs/{tab}", async ({ params, query }) => {
        if (!run || run.view.runId !== params.runId)
          throw notFound(`There is no run ${params.runId}.`);
        const t = run.view.tabs.find((x) => x.id === params.tab);
        if (!t) throw notFound(`${params.runId} has no tab ${params.tab}.`);
        const from = Math.max(Number(query.get("from") ?? 0) || 0, t.from);
        return {
          status: 200,
          body: { id: t.id, title: t.title, from, lines: t.lines.slice(from - t.from) },
        };
      })
      .add("POST", "/api/copilot-runs/{runId}/stop", async ({ params }) => {
        if (!run || run.view.runId !== params.runId)
          throw notFound(`There is no run ${params.runId}.`);
        if (run.view.state !== "running")
          throw conflict(
            `${params.runId} has already ${run.view.state === "done" ? "finished" : run.view.state}.`,
          );
        ctx.jobs.cancel(run.view.jobId);
        queue(run.line("Stopping: the session under way is cancelled..."));
        return { status: 200, body: structuredClone(run.view) };
      })
  );
}
