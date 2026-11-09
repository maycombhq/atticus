import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import {
  Api,
  readTerminalRunLines,
  readTerminalRuns,
  runLogsDirOf,
  runsDirOf,
  runsRelOf,
  RUN_LOG_READ_MAX,
  type TerminalRunView,
} from "@maycombhq/core";
import {
  badRequest,
  notFound,
  type Job,
  type JobControl,
  type JobKind,
  type JobStartOptions,
  type Router,
  type ServerContext,
} from "@maycombhq/server";

/**
 * ADR 0187: the Console. Everything Atticus is doing or did lately on this metarepo, wherever it
 * was started, as one list, newest first:
 *
 * - the app's own jobs (scans, syncs, Apply, Propose, AI steps, the critic, Done...), with what
 *   each printed (the JobManager keeps each job's last lines);
 * - an unattended Copilot run the app started (ADR 0173), whose lines are its own tabs;
 * - the long commands run in a terminal, an editor or a Copilot session, from their run files
 *   under .atticus/logs/ (core's run-log), tailed here and sent live;
 * - the hand-off runs that wait for the person's assistant (.runs/), saying where the prompt is
 *   and what to do, and what Done printed (from the app, or `atticus handoff done` anywhere).
 *
 * Read-only: nothing here writes, and Stop goes through the jobs' and the Copilot run's routes.
 * New lines and changes go out as `activity.lines` and `activity.changed`.
 */

/** The entries the list gives at most. */
const MAX_ENTRIES = 100;
/** A finished hand-off run stays in the list this long. */
const HANDOFF_RECENT_MS = 24 * 60 * 60 * 1000;
const HANDOFF_MAX = 20;
const ID = /^[A-Za-z0-9._-]{1,160}$/;
const RUN_DIR = /^run-[0-9a-z-]+$/;

const TERM = "term-";

type Entry = Api.ActivityEntryT;

/**
 * Work a request waits on, as a job (ADR 0187), so the Console shows it and what it prints; the
 * route keeps its answer. A test's context without a JobManager runs the work as it is.
 */
export function tracked<T>(
  ctx: Pick<ServerContext, "jobs">,
  title: string,
  work: (c?: JobControl) => Promise<T>,
  o: { kind?: JobKind; meta?: Record<string, string> } = {},
): Promise<T> {
  const jobs = ctx.jobs as { track?: unknown } | undefined;
  if (!jobs || typeof jobs.track !== "function") return work();
  const opts: JobStartOptions = { title, ...(o.meta ? { meta: o.meta } : {}) };
  return ctx.jobs.track(o.kind ?? "work", (c) => work(c), opts);
}

const jobState = (j: Job): Api.ActivityStateT =>
  j.state === "queued" ? "running" : (j.state as Api.ActivityStateT);

interface HandoffRun {
  runId: string;
  change: string;
  agent?: string;
  state: string;
  startedAt: string;
  finishedAt?: string;
  output?: string;
  errors: string[];
}

/** The hand-off runs to show: waiting, or finished lately; read from run.json only. */
function readHandoffRuns(root: string, now: number): HandoffRun[] {
  const out: HandoffRun[] = [];
  let changes: string[];
  try {
    changes = readdirSync(runsDirOf(root));
  } catch {
    return [];
  }
  for (const c of changes) {
    if (c.includes("..") || c.includes(sep) || c.includes("/") || c.includes("\\")) continue;
    let ids: string[];
    try {
      ids = readdirSync(join(runsDirOf(root), c)).filter((n) => RUN_DIR.test(n));
    } catch {
      continue;
    }
    for (const id of ids) {
      let r: {
        runId?: string;
        runtime?: string;
        state?: string;
        startedAt?: string;
        finishedAt?: string;
        errors?: unknown;
        request?: { change?: string; agent?: unknown; outputPath?: string };
      };
      try {
        r = JSON.parse(readFileSync(join(runsDirOf(root), c, id, "run.json"), "utf8")) as typeof r;
      } catch {
        continue;
      }
      if (r.runtime !== "hand-off" || typeof r.startedAt !== "string" || !r.state) continue;
      const open = ["prepared", "waiting", "produced"].includes(r.state);
      const at = Date.parse(r.finishedAt ?? r.startedAt);
      if (!open && !(now - at < HANDOFF_RECENT_MS)) continue;
      const agent = r.request?.agent;
      out.push({
        runId: r.runId ?? id,
        change: r.request?.change ?? c,
        ...(typeof agent === "string"
          ? { agent }
          : agent && typeof agent === "object" && "id" in agent
            ? { agent: String((agent as { id: unknown }).id) }
            : {}),
        state: r.state,
        startedAt: r.startedAt,
        ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}),
        ...(r.request?.outputPath ? { output: r.request.outputPath } : {}),
        errors: Array.isArray(r.errors) ? r.errors.map(String) : [],
      });
    }
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, HANDOFF_MAX);
}

const handoffState = (s: string): Api.ActivityStateT =>
  s === "validated"
    ? "done"
    : s === "failed"
      ? "failed"
      : s === "cancelled"
        ? "cancelled"
        : "waiting";

export function uiActivityRoutes(
  r: Router,
  ctx: ServerContext,
  deps: { alive?: (pid: number) => boolean; now?: () => Date; tickMs?: number } = {},
): Router {
  const root = ctx.root;
  const now = deps.now ?? (() => new Date());
  const readOpts = { ...(deps.alive ? { alive: deps.alive } : {}), now };

  // ---------------------------------------------------------------- the app's jobs
  const jobEntry = (j: Job): Entry => {
    const meta = ctx.jobs.metaOf(j.id) ?? {};
    const lines = ctx.jobs.linesOf(j.id);
    const base = {
      where: "app" as const,
      state: jobState(j),
      startedAt: j.startedAt,
      ...(j.finishedAt ? { finishedAt: j.finishedAt } : {}),
      ...(j.state === "running" ? { progress: { ...j.progress } } : {}),
    };
    if (meta.copilotRunId)
      return {
        ...base,
        id: meta.copilotRunId,
        kind: "copilot",
        copilotRunId: meta.copilotRunId,
        jobId: j.id,
        lines: 0,
        from: 0,
        ...(j.state === "running"
          ? { stop: `/api/copilot-runs/${encodeURIComponent(meta.copilotRunId)}/stop` }
          : {}),
      };
    return {
      ...base,
      id: j.id,
      kind: j.kind,
      ...(j.title ? { title: j.title } : {}),
      jobId: j.id,
      lines: lines?.total ?? 0,
      from: lines?.from ?? 0,
      ...(j.state === "running" ? { stop: `/api/jobs/${encodeURIComponent(j.id)}/cancel` } : {}),
      ...(meta.handoffRun ? { runId: meta.handoffRun } : {}),
    };
  };

  // ---------------------------------------------------------------- commands run elsewhere
  /** What this server has sent of each command's run: its lines, its state, the log's size. */
  const tails = new Map<string, { total: number; state: string; size: number }>();
  const terminalEntry = (t: TerminalRunView, total?: number): Entry => ({
    id: `${TERM}${t.runId}`,
    kind: "command",
    title: t.title,
    where: t.startedBy,
    state: t.stale ? "ended" : t.state,
    startedAt: t.startedAt,
    ...(t.finishedAt ? { finishedAt: t.finishedAt } : {}),
    ...(t.exitCode !== undefined ? { exitCode: t.exitCode } : {}),
    lines: total ?? tails.get(t.runId)?.total ?? t.lines,
    from: t.dropped,
    runId: t.runId,
  });
  const logSize = (runId: string) => {
    try {
      return statSync(join(runLogsDirOf(root), `${runId}.log`)).size;
    } catch {
      return 0;
    }
  };
  let seeded = false;
  /** New lines and ends of the commands' runs, sent live (the first look only learns them). */
  const tick = () => {
    let runs: TerminalRunView[];
    try {
      runs = readTerminalRuns(root, readOpts);
    } catch {
      return;
    }
    for (const t of runs) {
      const was = tails.get(t.runId);
      const state = t.stale ? "ended" : t.state;
      const size = logSize(t.runId);
      if (was && was.state === state && was.size === size) continue;
      let total = was?.total ?? 0;
      if (!was || size !== was.size) {
        const got = readTerminalRunLines(root, t.runId, was ? was.total : undefined);
        if (got) {
          if (was && seeded && got.lines.length)
            ctx.events.publish({
              type: "activity.lines",
              id: `${TERM}${t.runId}`,
              at: got.from,
              lines: got.lines,
            });
          total = got.from + got.lines.length;
        }
      }
      tails.set(t.runId, { total, state, size });
      if (seeded && (!was || was.state !== state || was.total !== total))
        ctx.events.publish({ type: "activity.changed", entry: terminalEntry(t, total) });
    }
    seeded = true;
  };
  tick();
  const timer = setInterval(tick, deps.tickMs ?? 1000);
  timer.unref?.();
  const unsub = ctx.runLogs?.subscribe(tick);
  ctx.onClose?.add(() => {
    clearInterval(timer);
    unsub?.();
  });

  // ---------------------------------------------------------------- live: the jobs
  // Lines go out in small batches per job, so a chatty scan doesn't flood the socket.
  const pending = new Map<string, { at: number; lines: string[] }>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    flushTimer = undefined;
    for (const [id, p] of pending) ctx.events.publish({ type: "activity.lines", id, ...p });
    pending.clear();
  };
  const unsubJobs = ctx.jobs.subscribe((c) => {
    const e = jobEntry(c.job);
    if (c.type === "lines") {
      if (e.kind === "copilot") return;
      const p = pending.get(e.id);
      if (p) p.lines.push(...c.lines);
      else pending.set(e.id, { at: c.at, lines: [...c.lines] });
      flushTimer ??= setTimeout(flush, 100);
      return;
    }
    if (pending.has(e.id)) flush();
    ctx.events.publish({ type: "activity.changed", entry: e });
    // Done of a hand-off run: its own entry has the lines too.
    const run = ctx.jobs.metaOf(c.job.id)?.handoffRun;
    if (run && c.job.state !== "running") {
      const h = handoffEntries().find((x) => x.id === run);
      if (h) ctx.events.publish({ type: "activity.changed", entry: h });
    }
  });
  ctx.onClose?.add(() => {
    unsubJobs();
    if (flushTimer) clearTimeout(flushTimer);
  });

  // ---------------------------------------------------------------- hand-off runs
  let handoffCache: { at: number; runs: HandoffRun[] } | undefined;
  const handoffRuns = () => {
    const t = Date.now();
    if (!handoffCache || t - handoffCache.at > 1000)
      handoffCache = { at: t, runs: readHandoffRuns(root, now().getTime()) };
    return handoffCache.runs;
  };
  /** A hand-off run's lines: what to do, then each Done's, from the app and from anywhere. */
  const handoffLines = (h: HandoffRun): string[] => {
    const prompt = `${runsRelOf(root)}/${h.change}/${h.runId}/prompt.md`;
    const out: string[] = [];
    if (handoffState(h.state) === "waiting") {
      out.push(
        `Waiting for your assistant${h.agent ? ` (${h.agent})` : ""} on ${h.change}.`,
        `The prompt: ${prompt}`,
        "Give it to your assistant (Copilot Chat, Claude Code): copy it from Set up › Model runs, or open the file.",
        h.output
          ? `When the answer is in ${h.output}, press Done on its run, or run: atticus handoff done ${h.runId}`
          : `When the answer is written, press Done on its run, or run: atticus handoff done ${h.runId}`,
      );
    } else {
      out.push(`${h.change}: ${h.runId} ${h.state}.`, `The prompt: ${prompt}`);
      for (const e of h.errors) out.push(`  ${e}`);
    }
    // Done in the app: its job's lines.
    for (const j of [...ctx.jobs.list()].reverse()) {
      if (ctx.jobs.metaOf(j.id)?.handoffRun !== h.runId) continue;
      const l = ctx.jobs.linesOf(j.id);
      out.push("", `Done, from the app (${j.state}):`, ...(l?.lines ?? []));
    }
    // Done anywhere else: `atticus handoff done <run>`'s own log.
    for (const t of readTerminalRuns(root, readOpts).reverse()) {
      const [g, c, id] = t.command;
      if (g !== "handoff" || c !== "done" || id !== h.runId) continue;
      const l = readTerminalRunLines(root, t.runId);
      out.push(
        "",
        `${t.title} (${t.startedBy}, ${t.stale ? "ended" : t.state}):`,
        ...(l?.lines ?? []),
      );
    }
    return out;
  };
  const handoffEntry = (h: HandoffRun): Entry => {
    const lines = handoffLines(h);
    return {
      id: h.runId,
      kind: "handoff",
      title: h.agent ? `${h.change}: ${h.agent}` : h.change,
      where: "assistant",
      state: handoffState(h.state),
      startedAt: h.startedAt,
      ...(h.finishedAt ? { finishedAt: h.finishedAt } : {}),
      lines: lines.length,
      from: 0,
      runId: h.runId,
      handoff: {
        runId: h.runId,
        change: h.change,
        ...(h.agent ? { agent: h.agent } : {}),
        promptPath: `${runsRelOf(root)}/${h.change}/${h.runId}/prompt.md`,
        ...(h.output ? { output: h.output } : {}),
      },
    };
  };
  const handoffEntries = () => handoffRuns().map(handoffEntry);
  // A run written meanwhile (the watcher says so) is read at once.
  const runsRel = runsRelOf(root);
  const unlisten = ctx.events.listen((e) => {
    if (e.type === "file.changed" && String(e.path).startsWith(runsRel)) handoffCache = undefined;
  });
  ctx.onClose?.add(() => unlisten());

  // ---------------------------------------------------------------- the list
  const list = (): Api.ActivityListT => {
    tick();
    const entries: Entry[] = [
      ...ctx.jobs.list().map(jobEntry),
      ...readTerminalRuns(root, readOpts).map((t) => terminalEntry(t)),
      ...handoffEntries(),
    ]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id))
      .slice(0, MAX_ENTRIES);
    return { entries, running: entries.filter((e) => e.state === "running").length };
  };

  const linesOf = (id: string, from: number | undefined): Api.ActivityLinesT => {
    if (id.startsWith(TERM)) {
      const runId = id.slice(TERM.length);
      const t = readTerminalRuns(root, readOpts).find((x) => x.runId === runId);
      const l = t ? readTerminalRunLines(root, runId, from) : undefined;
      if (!t || !l) throw notFound(`There is no activity ${id}.`);
      return { id, ...l, state: t.stale ? "ended" : t.state };
    }
    if (RUN_DIR.test(id)) {
      handoffCache = undefined;
      const h = handoffRuns().find((x) => x.runId === id);
      if (!h) throw notFound(`There is no activity ${id}.`);
      const all = handoffLines(h);
      const start = Math.min(from ?? Math.max(all.length - RUN_LOG_READ_MAX, 0), all.length);
      return {
        id,
        from: start,
        lines: all.slice(start, start + RUN_LOG_READ_MAX),
        total: all.length,
        state: handoffState(h.state),
      };
    }
    const job = ctx.jobs
      .list()
      .find((j) => j.id === id || ctx.jobs.metaOf(j.id)?.copilotRunId === id);
    if (!job) throw notFound(`There is no activity ${id}.`);
    const e = jobEntry(job);
    // A Copilot run's lines are its tabs: GET /api/copilot-runs/{runId}/tabs/{tab}.
    if (e.kind === "copilot") return { id, from: 0, lines: [], total: 0, state: e.state };
    const l = ctx.jobs.linesOf(job.id, from) ?? { from: 0, lines: [], total: 0 };
    return { id, ...l, state: e.state };
  };

  return r
    .add("GET", "/api/activity", async () => ({ status: 200, body: list() }))
    .add("GET", "/api/activity/{id}/lines", async ({ params, query }) => {
      const id = params.id!;
      if (!ID.test(id)) throw badRequest(`${JSON.stringify(id)} isn't an activity's id.`);
      const raw = query.get("from");
      const from = raw === null ? undefined : Number(raw);
      if (from !== undefined && (!Number.isInteger(from) || from < 0))
        throw badRequest("from is a whole number of 0 or more.");
      return { status: 200, body: linesOf(id, from) };
    });
}
