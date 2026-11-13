import { Api, loadOrgPack, orgPackDirOf, copilotAcpOf } from "@maycombhq/core";
import {
  badRequest,
  conflict,
  HttpError,
  notFound,
  type Router,
  type ServerContext,
} from "@maycombhq/server";
import type { WriteResult } from "@maycombhq/assistant-files";
import type { Output } from "./commands.js";
import { copilotAcpAllowed } from "./copilot-acp-steps.js";
import { randomBytes } from "node:crypto";
import { CopilotRun, TAB_LINES, type NewLines } from "./copilot-run.js";
import type { MapAllDeps, MapAllEvent, MapAllOptions } from "./map-all.js";

/** beta.27: what `atticus assistant-files --check` would do here; tests pass their own. */
export type AssistantFilesCheck = (root: string) => Promise<{ results: WriteResult[] }>;

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

/**
 * beta.28: how long after Stop the run's view waits for its work to end. A session's own stop
 * takes up to about seven seconds (five for the agent to say so, two for the server to close);
 * past this the view ends the run as stopped whatever the work is still waiting on.
 */
const STOP_GRACE_MS = 15_000;

/** beta.28: said when the work didn't end within the grace after Stop. */
const CUT_OFF =
  "The run didn't end within a few seconds of Stop: it is ended here. Whatever it was still waiting on is cut off, and nothing more it does is shown.";

/** The lines of each tab a poll of the current run gets. */
const TAIL = 200;

const NOT_ALLOWED =
  "runtime.yaml doesn't allow copilot-acp here (schemaVersion 3, copilot-acp in modes.allowed and copilot in assistants.allowed), so the app can't start Copilot itself. Read through Copilot Chat instead: atticus map --all in a terminal gives each part to paste.";

interface Here {
  allowed: boolean;
  model?: string;
  limit?: NonNullable<Api.CopilotRunCurrentT["limit"]>;
  assistantFiles?: NonNullable<Api.CopilotRunCurrentT["assistantFiles"]>;
}

// Review of fix/b27-copilot: Copilot's files only, as the run checks them.
const defaultCheck: AssistantFilesCheck = async (root) =>
  (await import("@maycombhq/assistant-files")).generateAssistantFiles(root, {
    check: true,
    assistants: ["copilot"],
  });

/**
 * Whether the app may start Copilot here, and (beta.27) what its dialog needs: the model's limit
 * (known, or the value to fill the field with) and whether the assistant files are current.
 */
async function allowedHere(root: string, check: AssistantFilesCheck): Promise<Here> {
  try {
    const op = await loadOrgPack(orgPackDirOf(root));
    const c = copilotAcpOf(op.runtime);
    const allowed = copilotAcpAllowed(op);
    if (!allowed) return { allowed, ...(c.model ? { model: c.model } : {}) };
    const { assistantFilesState, limitFor, limitToOffer } = await import("./map-all.js");
    const known = await limitFor(root, op, undefined).catch(() => undefined);
    const offer = known ? undefined : await limitToOffer(root);
    const limit: Here["limit"] = known
      ? {
          known: true,
          tokens: known.limit,
          from: known.from === "probe" ? "probe" : "runtime.yaml",
        }
      : { known: false, ...(offer ? { tokens: offer.tokens, from: offer.from } : {}) };
    const files = await check(root)
      .then((r) => {
        const { shared, ...s } = assistantFilesState(r.results);
        // 3.12.0, additive: the files of a person's the run adds Atticus's section to, by name.
        return shared.length ? { ...s, shared } : s;
      })
      .catch(() => undefined);
    return {
      allowed,
      ...(c.model ? { model: c.model } : {}),
      limit,
      ...(files ? { assistantFiles: files } : {}),
    };
  } catch {
    return { allowed: false };
  }
}

const optionsOf = (b: Api.StartCopilotRunRequestT): MapAllOptions => ({
  mode: "copilot-acp",
  // beta.27: the limit the person gave in the dialog, as --max-tokens.
  ...(b.maxTokens !== undefined ? { maxTokens: b.maxTokens } : {}),
  ...(b.kind === "stale" ? { stale: true } : {}),
  ...(b.kind === "gaps" ? { gaps: true } : {}),
  ...(b.repos?.length ? { repos: b.repos } : {}),
  ...(b.force ? { force: true } : {}),
  resumeAs: "the next run (Map from the app, or atticus map --all)",
});

export function uiCopilotRunRoutes(
  r: Router,
  ctx: ServerContext,
  deps: {
    start?: MapAllStarter;
    now?: () => Date;
    flushMs?: number;
    assistantFiles?: AssistantFilesCheck;
    /** beta.28: the most Stop waits for the run's work to end before the run is ended. */
    stopGraceMs?: number;
  } = {},
): Router {
  const start = deps.start ?? defaultStarter(ctx.root);
  const check = deps.assistantFiles ?? defaultCheck;
  const now = deps.now ?? (() => new Date());
  const flushMs = deps.flushMs ?? 100;
  const stopGraceMs = deps.stopGraceMs ?? STOP_GRACE_MS;
  let run: CopilotRun | undefined;
  let allowed: { at: number; v: Here } | undefined;
  let seq = 0;
  // beta.28: the grace each stopped run has for its work to end.
  const stopTimers = new Map<CopilotRun, ReturnType<typeof setTimeout>>();
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
          allowed = { at: Date.now(), v: await allowedHere(ctx.root, check) };
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
            ...(a.limit ? { limit: a.limit } : {}),
            ...(a.assistantFiles ? { assistantFiles: a.assistantFiles } : {}),
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
        let a: Here;
        try {
          a = await allowedHere(ctx.root, check);
        } finally {
          starting = false;
        }
        // What the dialog was shown is read again: the next poll says it as it is now.
        allowed = { at: Date.now(), v: a };
        if (!a.allowed) throw conflict(NOT_ALLOWED);
        // beta.27: a Copilot-only metarepo names no model limit; the dialog asks for it.
        if (a.limit && !a.limit.known && b.data.maxTokens === undefined) {
          throw new HttpError(
            400,
            "The model's limit is needed",
            "Atticus doesn't know your model's limit, and a part planned too big overflows the reader: give it in the dialog (Your model's limit, in tokens), the context window of the model Copilot uses. It is kept on this machine for the next run.",
            { code: "limit-unknown" },
          );
        }
        // beta.27: sessions would each stop at the assistant files' check: refused up front.
        if (a.assistantFiles?.edited.length) {
          const { assistantFilesEditedWords } = await import("./map-all.js");
          throw new HttpError(
            409,
            "Assistant files edited by hand",
            assistantFilesEditedWords(a.assistantFiles.edited),
            { code: "assistant-files-edited", files: a.assistantFiles.edited },
          );
        }
        // Checked again: a step may have started while the runtime was being read.
        if (ctx.jobs.runningOf("step")?.state === "running")
          throw conflict("An AI step started on this server meanwhile: wait for it to finish.");
        // beta.27: the limit given is kept on this machine, to fill the dialog next time; only
        // for a run that starts (review of fix/b27-copilot: never before the last refusal).
        if (b.data.maxTokens !== undefined) {
          const { saveLastLimit } = await import("./map-all.js");
          await saveLastLimit(ctx.root, b.data.maxTokens, now().getTime());
          allowed = undefined;
        }
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
            // beta.28: once the run is ended (Stop's grace ran out), what its work still says
            // is no longer the run's.
            const live = () => me.view.state === "running";
            const io: Output = {
              out: (l) => {
                if (live()) queue(me.line(l));
              },
              err: (l) => {
                if (!live()) return;
                lastErr = l;
                queue(me.line(l));
              },
            };
            const onEvent = (e: MapAllEvent) => {
              if (!live()) return;
              for (const n of me.event(e)) queue(n);
              const p = me.view.progress;
              c.progress(p.repoIndex, p.repos, p.session ?? p.repo ?? "Planning");
              state();
            };
            // beta.28: the job's own signal, given to its work, rather than the one its async
            // context carries: Stop reaches the run however the work was started.
            const signal = c.signal;
            let code: number;
            try {
              code = await start(optionsOf(b.data), io, { signal, onEvent });
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              if (!live()) return { errors: [msg] };
              queue(me.finish(signal.aborted ? "stopped" : "failed", now().toISOString(), msg));
              flush();
              state();
              // Repos read before it failed were written: the pages read the facts again.
              ctx.events.publish({ type: "file.changed", path: "facts" });
              return { errors: [msg] };
            }
            if (!live()) return { result: { code, runId } };
            const stopped = signal.aborted;
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
        const r0 = run;
        ctx.jobs.cancel(r0.view.jobId);
        queue(r0.line("Stopping: the session under way is cancelled..."));
        // beta.28: field report: Stop, then "running" for 50 minutes. The person's Stop is the
        // run's end: if its work hasn't ended within the grace, the run is ended here, stopped.
        if (!stopTimers.has(r0)) {
          const t = setTimeout(() => {
            stopTimers.delete(r0);
            if (r0.view.state !== "running") return;
            queue(r0.line(CUT_OFF));
            queue(r0.finish("stopped", now().toISOString()));
            flush();
            if (run === r0) state();
            ctx.events.publish({ type: "file.changed", path: "facts" });
          }, stopGraceMs);
          t.unref?.();
          stopTimers.set(r0, t);
        }
        return { status: 200, body: structuredClone(r0.view) };
      })
  );
}
