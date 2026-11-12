import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import {
  Api,
  printToCurrent,
  readTerminalRunLines,
  readTerminalRuns,
  runLogsDirOf,
  runsDirOf,
  runsRelOf,
  RUN_LOG_READ_MAX,
  tailTerminalRunLines,
  type RunLogTail,
  type TerminalRunView,
} from "@maycombhq/core";
import {
  badRequest,
  HttpError,
  notFound,
  problem,
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
/** A command's log is read at most this many caps (RUN_LOG_READ_MAX lines) a tick. */
const TAIL_READS_PER_TICK = 4;
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

/**
 * Review of beta.23 (Windows, an editor panel): a write whose work outlasts one request (a task
 * run's Done builds, fixes and commits; a live work-tracker sync calls the tracker per item) runs
 * as a job when the page asks (`job: true`). The answer is 202 and the job's id at once; the
 * Console shows the work; the job's result is the answer the route would have given (`answer`)
 * or, refused, its problem (`problem`), with `lines` for whoever only reads those.
 */
export function answerAsJob(
  ctx: Pick<ServerContext, "jobs">,
  title: string,
  work: () => Promise<Record<string, unknown>>,
  o: { kind?: JobKind; meta?: Record<string, string> } = {},
): { status: 202; body: { jobId: string } } {
  const opts: JobStartOptions = { title, ...(o.meta ? { meta: o.meta } : {}) };
  const job = ctx.jobs.start(
    o.kind ?? "work",
    async () => {
      try {
        const answer = await work();
        const lines = Array.isArray(answer.lines) ? answer.lines.map(String) : [];
        return { result: { answer, lines } };
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        const p = problem(e);
        const lines = Array.isArray(p.lines) ? p.lines.map(String) : [];
        return {
          result: { problem: p, lines },
          errors: lines.length ? lines : [e.detail ?? e.title],
        };
      }
    },
    opts,
  );
  return { status: 202, body: { jobId: job.id } };
}

/**
 * Review of beta.23: work that writes the metarepo's own files (the step a Done resumes, a read's
 * `verify --write`), as a local job: the Console shows it and what it prints while it runs, and
 * it takes the one local step's slot, so Apply, Propose and Bring in are told it runs and never
 * run beside it. A local step already running is waited for (said once), never raced.
 */
export async function trackedLocal<T>(
  ctx: Pick<ServerContext, "jobs">,
  title: string,
  work: (c?: JobControl) => Promise<T>,
  o: { meta?: Record<string, string>; wait?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const jobs = ctx.jobs as { track?: unknown; runningOf?: unknown } | undefined;
  if (!jobs || typeof jobs.track !== "function" || typeof jobs.runningOf !== "function")
    return work();
  const wait = o.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let said = false; ; said = true) {
    const busy = ctx.jobs.runningOf("local");
    // Checked and started in one tick: nothing else takes the slot between.
    if (!busy) break;
    if (!said)
      printToCurrent(`${title}: waiting for ${busy.title ?? busy.progress.message} to finish.`);
    await wait(200);
  }
  return tracked(
    ctx,
    title,
    (c) => {
      c?.progress(0, 1, title);
      return work(c);
    },
    { kind: "local", ...(o.meta ? { meta: o.meta } : {}) },
  );
}

const jobState = (j: Job): Api.ActivityStateT =>
  j.state === "queued" ? "running" : (j.state as Api.ActivityStateT);

/** How far before a hand-off run the command that prepared it may have started. */
const PREPARED_MS = 15 * 60 * 1000;
/** Where a command ran, in words, for a hand-off's first line. */
const WHERE_WORDS: Record<string, string> = {
  terminal: "in a terminal",
  vscode: "in VS Code",
  intellij: "in IntelliJ",
  copilot: "in a Copilot session",
};

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

const APP_KINDS = new Set<string>(Api.ActivityKind.options);
/** The Console kind of a job an app started, kept in the run log; undefined for a command. */
const appKind = (t: TerminalRunView): Api.ActivityKindT | undefined =>
  t.startedBy === "app" && t.job && APP_KINDS.has(t.job.kind)
    ? (t.job.kind as Api.ActivityKindT)
    : t.startedBy === "app"
      ? "work"
      : undefined;

const newestFirst = (a: Entry, b: Entry) =>
  b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id);

/**
 * The entries the list gives, newest first: every one that runs (a long run started before a
 * hundred quick ones stays, and so does the strip), then the newest of the rest up to `max`.
 */
export function newestKeepingRunning(entries: Entry[], max: number): Entry[] {
  const running = entries.filter((e) => e.state === "running");
  const rest = entries
    .filter((e) => e.state !== "running")
    .sort(newestFirst)
    .slice(0, Math.max(max - running.length, 0));
  return [...running, ...rest].sort(newestFirst);
}

export function uiActivityRoutes(
  r: Router,
  ctx: ServerContext,
  deps: { alive?: (pid: number) => boolean; now?: () => Date; tickMs?: number } = {},
): Router {
  const root = ctx.root;
  const now = deps.now ?? (() => new Date());
  const readOpts = { ...(deps.alive ? { alive: deps.alive } : {}), now };
  /**
   * Beta.27 review: whether a run is listed from the run log: not one of this server's own jobs
   * (its JobManager lists it, with Stop and its lines live); a job an earlier run of the app
   * started is.
   */
  const fromLog = (t: TerminalRunView): boolean =>
    !(
      t.startedBy === "app" &&
      (ctx.jobs as { ownsRun?: (id: string) => boolean }).ownsRun?.(t.runId)
    );

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
      ...(j.state === "running" && j.stopping ? { stopping: true } : {}),
      ...(meta.handoffRun ? { runId: meta.handoffRun } : {}),
    };
  };

  // ---------------------------------------------------------------- commands run elsewhere
  /**
   * What this server has sent of each command's run: its lines, its state, the log's size and
   * file, where its tail read to, and whether lines past a read's cap wait for the next tick.
   */
  const tails = new Map<
    string,
    { total: number; state: string; size: number; ino: number; at?: RunLogTail; more: boolean }
  >();
  const terminalEntry = (t: TerminalRunView, total?: number): Entry => ({
    id: `${TERM}${t.runId}`,
    // Beta.27 review: a job an earlier run of the app started, kept in the run log, by its kind;
    // one still running when that app closed (or crashed) has `ended`.
    kind: appKind(t) ?? "command",
    title: t.title,
    where: t.startedBy,
    state: t.stale || t.appClosed ? "ended" : t.state,
    startedAt: t.startedAt,
    ...(t.finishedAt ? { finishedAt: t.finishedAt } : {}),
    ...(t.exitCode !== undefined ? { exitCode: t.exitCode } : {}),
    lines: total ?? tails.get(t.runId)?.total ?? t.lines,
    from: t.dropped,
    runId: t.runId,
  });
  const logStat = (runId: string) => {
    try {
      const s = statSync(join(runLogsDirOf(root), `${runId}.log`));
      return { size: s.size, ino: s.ino };
    } catch {
      return { size: 0, ino: 0 };
    }
  };
  let seeded = false;
  /**
   * New lines and ends of the commands' runs, sent live (the first look only learns them). A
   * log is read from where its tail read to, never whole again; a burst past a read's cap is
   * read on, a few caps a tick, and the rest next tick, so every line and the end reach the page.
   */
  const tick = () => {
    let runs: TerminalRunView[];
    try {
      runs = readTerminalRuns(root, readOpts).filter(fromLog);
    } catch {
      return;
    }
    for (const t of runs) {
      const was = tails.get(t.runId);
      const state = t.stale || t.appClosed ? "ended" : t.state;
      const { size, ino } = logStat(t.runId);
      if (was && !was.more && was.state === state && was.size === size && was.ino === ino) continue;
      let total = was?.total ?? 0;
      let at = was?.at;
      let more = false;
      if (!was || was.more || size !== was.size || ino !== was.ino) {
        for (let reads = 0; reads < TAIL_READS_PER_TICK; reads++) {
          const got = tailTerminalRunLines(root, t.runId, at);
          if (!got) break;
          if (was && seeded && got.lines.length)
            ctx.events.publish({
              type: "activity.lines",
              id: `${TERM}${t.runId}`,
              at: got.from,
              lines: got.lines,
            });
          total = got.at.line;
          at = got.at;
          more = got.more;
          // The first look only learns where the log is.
          if (!was || !more) break;
        }
      }
      tails.set(t.runId, { total, state, size, ino, ...(at ? { at } : {}), more });
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
  /**
   * The command run elsewhere that prepared a hand-off run: the newest that names its change and
   * started at most PREPARED_MS before it (a `handoff done` is a Done, not the start).
   */
  const preparedBy = (h: HandoffRun): TerminalRunView | undefined => {
    const at = Date.parse(h.startedAt);
    let best: TerminalRunView | undefined;
    for (const t of readTerminalRuns(root, readOpts)) {
      if (t.command[0] === "handoff" || !t.command.slice(1).includes(h.change)) continue;
      const s = Date.parse(t.startedAt);
      if (!(s <= at && at - s <= PREPARED_MS)) continue;
      if (!best || t.startedAt > best.startedAt) best = t;
    }
    return best;
  };
  /** A hand-off run's lines: what to do, then each Done's, from the app and from anywhere. */
  const handoffLines = (h: HandoffRun): { lines: string[]; shape: string[] } => {
    // The parts the lines are made of (the waiting words or the state, then each Done's), each
    // with its length but the last's: what the lines' version is made from (handoffEntry).
    const shape: string[] = [handoffState(h.state)];
    const prompt = `${runsRelOf(root)}/${h.change}/${h.runId}/prompt.md`;
    const out: string[] = [];
    // Beta.26 review: the command that prepared it, run elsewhere (its own entry has its lines).
    const by = preparedBy(h);
    if (by) {
      shape.push(`prepared ${by.runId}`);
      out.push(`Prepared by ${by.title}, ${WHERE_WORDS[by.startedBy] ?? `in ${by.startedBy}`}.`);
    }
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
    // Each Done, the app's (its job's lines) and anywhere else's (`atticus handoff done <run>`'s
    // own log), oldest first: the one still running is the last part, so what it prints is only
    // added to the lines (review of beta.23).
    const parts: { at: string; key: string; head: string; lines: string[] }[] = [];
    for (const j of ctx.jobs.list()) {
      if (ctx.jobs.metaOf(j.id)?.handoffRun !== h.runId) continue;
      parts.push({
        at: j.startedAt,
        key: `job ${j.id}`,
        head: `Done, from the app (${j.state}):`,
        lines: ctx.jobs.linesOf(j.id)?.lines ?? [],
      });
    }
    for (const t of readTerminalRuns(root, readOpts)) {
      const [g, c, id] = t.command;
      if (g !== "handoff" || c !== "done" || id !== h.runId) continue;
      parts.push({
        at: t.startedAt,
        key: `run ${t.runId}`,
        head: `${t.title} (${t.startedBy}, ${t.stale ? "ended" : t.state}):`,
        lines: readTerminalRunLines(root, t.runId)?.lines ?? [],
      });
    }
    parts.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.key < b.key ? -1 : 1));
    for (const p of parts) {
      // A part's head line (its state) changes as it ends, so it is part of the version too.
      shape.push(`${p.key} ${out.length} ${p.head}`);
      out.push("", p.head, ...p.lines);
    }
    return { lines: out, shape };
  };
  const handoffEntry = (h: HandoffRun): Entry => {
    const { lines, shape } = handoffLines(h);
    // Review of beta.23: these lines are made again each time (the "waiting" words go once Done
    // ran, and an app's Done comes before a terminal's), so they aren't only added to: their
    // version tells the page to read them again rather than add past what it holds.
    // Only the parts and where each starts: lines added to the last part (a Done printing as it
    // runs) are added to what the page holds, not a reason to read them all again.
    const rev = createHash("sha256").update(shape.join("\n")).digest("hex").slice(0, 16);
    return {
      rev,
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
      ...readTerminalRuns(root, readOpts)
        .filter(fromLog)
        .map((t) => terminalEntry(t)),
      ...handoffEntries(),
    ];
    const kept = newestKeepingRunning(entries, MAX_ENTRIES);
    return { entries: kept, running: kept.filter((e) => e.state === "running").length };
  };

  const linesOf = (id: string, from: number | undefined): Api.ActivityLinesT => {
    if (id.startsWith(TERM)) {
      const runId = id.slice(TERM.length);
      const t = readTerminalRuns(root, readOpts).find((x) => x.runId === runId);
      const l = t ? readTerminalRunLines(root, runId, from) : undefined;
      if (!t || !l) throw notFound(`There is no activity ${id}.`);
      return { id, ...l, state: t.stale || t.appClosed ? "ended" : t.state };
    }
    if (RUN_DIR.test(id)) {
      handoffCache = undefined;
      const h = handoffRuns().find((x) => x.runId === id);
      if (!h) throw notFound(`There is no activity ${id}.`);
      const all = handoffLines(h).lines;
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
