import {
  maskSecretShapes,
  printToCurrent,
  withCommit,
  withPrinter,
  withSignal,
  type PrintOptions,
} from "@maycombhq/core";

/**
 * Long work (scans, syncs, reconciles, intake) runs as a job (ADR 0015): the call returns 202 with
 * a job id, progress goes out as live events, and the job can be read or cancelled. Cancelling
 * is cooperative: the work runs inside the job's abort signal (ADR 0119), which a model call
 * stops on at once and a scan checks between repos, and `cancelled` says so between steps.
 *
 * ADR 0187: a job keeps what it prints (its last JOB_LINES lines), for the Console. Work prints
 * with `c.line(...)`, or with `jobLine(...)` from anywhere inside it (the routes' `run` helpers
 * pass every line the command prints); a job that printed nothing as it ran gets its result's
 * lines and its errors when it ends. Whoever listens (`subscribe`) hears each new line and each
 * change of state.
 */

/**
 * `local`: a person's local step (Apply, Propose, Bring in, round 37): never an AI step's slot.
 * `work` (ADR 0187): a request the page waits on, run as a job so the Console shows it (the
 * critic, a wiki's sync, a step run, Done); no route counts it as busy.
 */
export type JobKind =
  "scan" | "sync" | "reconcile" | "index" | "intake" | "step" | "local" | "work";
export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";

export interface Job {
  id: string;
  kind: JobKind;
  state: JobState;
  progress: { done: number; total: number; message: string };
  /** What it is, in words (ADR 0187): "Scan", "Applying to forge-ledger". */
  title?: string;
  startedAt: string;
  finishedAt?: string;
  errors: string[];
  result?: Record<string, unknown>;
  /** Beta.27 review: Stop was asked and it is ending (until it ends). */
  stopping?: boolean;
}

export interface JobControl {
  progress(done: number, total: number, message: string): void;
  /**
   * Print a line to the job's Console entry (ADR 0187). `now` (beta.28.1): a progress line, sent
   * at once rather than in the next batch.
   */
  line(text: string, o?: PrintOptions): void;
  /**
   * Beta.28.1: the work has started writing. A Stop after this is too late: the job ends done,
   * saying the Stop came after the write; a Stop asked before it that the work didn't hear is
   * said the same way.
   */
  commit(): void;
  readonly cancelled: boolean;
  /**
   * Beta.27 review: the job's signal, aborted on Stop. Work that starts a process (git, a
   * model's CLI) passes it on, so Stop ends that process too, not only the next step.
   */
  readonly signal: AbortSignal;
}

/**
 * Beta.27 review: where a job is kept beyond this process (the run log, ADR 0187), so the app's
 * Console still has it after a restart: told of its start, each line it prints and its end.
 */
export interface JobRecorder {
  /** The run log's id for it, so the Console lists it once (as this job, not from the log). */
  readonly runId?: string;
  line(text: string): void;
  /** `app-closed`: it was still running when the server closed. */
  end(state: JobState, how?: "app-closed"): void;
}
export interface JobManagerOptions {
  record?: (
    job: Job,
    meta: Record<string, string> | undefined,
    log: JobLogTitle,
  ) => JobRecorder | undefined;
}

/**
 * Beta.27 re-review: what a job's run-log title is made of, by the rules a command's title
 * follows (core's appRunTitle and runTitle): the ids it names (a repo, a change, a run: each kept
 * when it has an id's strict shape, else `…`), or the command it runs, its words as the command
 * line's title rules give them (titleInputsOf). Never `title`, the app's own words.
 */
export interface JobLogTitle {
  ids?: string[];
  command?: {
    positionals: string[];
    flags: string[];
    values?: Record<string, string>;
  };
}

/** What a job prints when Stop is asked, and when it has stopped. */
export const STOPPING = "Stopping…";
export const STOPPED = "Stopped.";
/** What a job's record says when the app closed while it ran. */
export const CLOSED = "Stopped when the app closed.";
/** Beta.28.1: Stop asked once the work had started writing. */
export const TOO_LATE =
  "Stop came after the write had started: it finishes, so what it writes stays whole.";

export type JobWork = (
  c: JobControl,
) => Promise<{ result?: Record<string, unknown>; errors?: string[] } | void>;

type Publish = (e: { type: string } & Record<string, unknown>) => void;

/** The lines a job keeps (its last ones), as a Copilot run's tab does. */
export const JOB_LINES = 5000;
/** The finished jobs kept for the Console (the oldest go first). */
export const JOBS_KEPT = 100;

export interface JobStartOptions {
  /** Shown in this app (its Console, its jobs); never kept in the run log (`log` is). */
  title?: string;
  /** Beta.27 re-review: what its run-log title is made of; its kind alone without. */
  log?: JobLogTitle;
  /** What the job belongs to (ADR 0187): `copilotRunId`, `handoffRun`. */
  meta?: Record<string, string>;
}

export type JobChange =
  | { type: "state"; job: Job }
  /** `now` (beta.28.1): a progress line, for the Console at once. */
  | { type: "lines"; job: Job; at: number; lines: string[]; now?: boolean };

/** Print a line to the job this code runs in, if it runs in one (ADR 0187). */
export const jobLine = (line: string): void => printToCurrent(line);

export class JobManager {
  private jobs = new Map<string, Job>();
  private cancelledIds = new Set<string>();
  private aborts = new Map<string, AbortController>();
  private seq = 0;
  /** Round 41: every running job of a kind, in start order (a later one never hides an earlier). */
  private running = new Map<JobKind, Set<string>>();
  private printed = new Map<string, { from: number; lines: string[] }>();
  private metas = new Map<string, Record<string, string>>();
  private listeners = new Set<(c: JobChange) => void>();
  private ends = new Map<string, () => void>();
  /** Jobs past their commit point (beta.28.1): a Stop now is too late. */
  private committedIds = new Set<string>();
  /** The message a job said before a Stop not yet heard (the hunt of beta.28.1, S3). */
  private beforeStop = new Map<string, string>();
  private recorders = new Map<string, JobRecorder>();
  /** Each run log record this manager made, and its job. */
  private runIds = new Map<string, string>();

  /** Whether a run in the run log is one of this manager's jobs (its recorder made it). */
  ownsRun(runId: string): boolean {
    return this.runIds.has(runId);
  }

  constructor(
    private readonly publish: Publish,
    private readonly now: () => Date = () => new Date(),
    private readonly o: JobManagerOptions = {},
  ) {}

  /**
   * A running job of a kind, if any: the earliest still running (one scan at a time: a second
   * ask gets 409).
   */
  runningOf(kind: JobKind): Job | undefined {
    for (const id of this.running.get(kind) ?? []) {
      const j = this.jobs.get(id);
      if (j?.state === "running") return j;
    }
    return undefined;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** Every job kept, newest first (ADR 0187). */
  list(): Job[] {
    return [...this.jobs.values()].reverse();
  }

  /** What a job belongs to, as it was started. */
  metaOf(id: string): Record<string, string> | undefined {
    return this.metas.get(id);
  }

  /** A job's printed lines from a line on (or its last `max`), and how many it printed. */
  linesOf(
    id: string,
    from?: number,
    max = JOB_LINES,
  ): { from: number; lines: string[]; total: number } | undefined {
    const p = this.printed.get(id);
    if (!p) return undefined;
    const total = p.from + p.lines.length;
    const start =
      from === undefined ? Math.max(total - max, p.from) : Math.max(Math.min(from, total), p.from);
    return { from: start, lines: p.lines.slice(start - p.from, start - p.from + max), total };
  }

  /** Hear each job's new lines and changes of state. */
  subscribe(f: (c: JobChange) => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  private tell(c: JobChange) {
    for (const f of this.listeners) {
      try {
        f(c);
      } catch {
        // a listener's failure never stops the job
      }
    }
  }

  private print(job: Job, text: string, o?: PrintOptions) {
    const p = this.printed.get(job.id);
    if (!p) return;
    this.recorded(job.id, (r) => r.line(String(text)));
    // Beta.27 re-review (round 2): masked as the run log's record is (a token by its shape), so
    // the Console shows live what the record keeps.
    const lines = String(text)
      .split(/\r?\n/)
      .map((l) => maskSecretShapes(l));
    const at = p.from + p.lines.length;
    p.lines.push(...lines);
    if (p.lines.length > JOB_LINES) {
      const drop = p.lines.length - JOB_LINES;
      p.lines.splice(0, drop);
      p.from += drop;
    }
    this.tell({ type: "lines", job, at, lines, ...(o?.now ? { now: true } : {}) });
    // The hunt of beta.28.1: a progress line (`now`: a step as it starts, a heartbeat) is what
    // the job is doing now, so its progress message follows it (Apply's write, step by step);
    // a job stopping keeps saying "Stopping…".
    const last = lines.at(-1);
    if (o?.now && last && job.state === "running" && !job.stopping) {
      job.progress = { ...job.progress, message: last };
      this.publish({ type: "job.progress", jobId: job.id, ...job.progress });
      this.tell({ type: "state", job });
    }
  }

  /** Tell a job's recorder, never failing the job (a recorder that throws is dropped). */
  private recorded(id: string, f: (r: JobRecorder) => void) {
    const r = this.recorders.get(id);
    if (!r) return;
    try {
      f(r);
    } catch {
      this.recorders.delete(id);
    }
  }

  /** Finished jobs past JOBS_KEPT go, oldest first; running ones stay. */
  private forget() {
    let over = this.jobs.size - JOBS_KEPT;
    if (over <= 0) return;
    for (const [id, j] of this.jobs) {
      if (over <= 0) break;
      if (j.state === "running" || j.state === "queued") continue;
      this.jobs.delete(id);
      this.printed.delete(id);
      this.metas.delete(id);
      this.cancelledIds.delete(id);
      // Forgotten here, it is listed from the run log again.
      for (const [run, job] of this.runIds) if (job === id) this.runIds.delete(run);
      over--;
    }
  }

  start(kind: JobKind, work: JobWork, o: JobStartOptions = {}): Job {
    const id = `job-${++this.seq}`;
    const job: Job = {
      id,
      kind,
      state: "running",
      progress: { done: 0, total: 0, message: "Starting" },
      ...(o.title ? { title: o.title } : {}),
      startedAt: this.now().toISOString(),
      errors: [],
    };
    this.jobs.set(id, job);
    this.printed.set(id, { from: 0, lines: [] });
    if (o.meta) this.metas.set(id, { ...o.meta });
    try {
      // Without a `log`, the ids it belongs to (its meta: a run's id) are what it names.
      const r = this.o.record?.(
        job,
        o.meta,
        o.log ?? (o.meta ? { ids: Object.values(o.meta) } : {}),
      );
      if (r) this.recorders.set(id, r);
      if (r?.runId) this.runIds.set(r.runId, id);
    } catch {
      // kept in memory only
    }
    this.forget();
    const ofKind = this.running.get(kind) ?? new Set<string>();
    ofKind.add(id);
    this.running.set(kind, ofKind);
    const abort = new AbortController();
    this.aborts.set(id, abort);
    const cancelled = this.cancelledIds;
    const line = (text: string, lo?: PrintOptions) => this.print(job, text, lo);
    const commit = () => {
      if (this.committedIds.has(id)) return;
      this.committedIds.add(id);
      // A Stop asked before the work heard it: too late now, said as such.
      if (cancelled.delete(id)) {
        delete job.stopping;
        // The hunt of beta.28.1 (S3): the Stop is taken back, so is its "Stopping…".
        const was = this.beforeStop.get(id);
        this.beforeStop.delete(id);
        if (was !== undefined && job.progress.message === STOPPING) {
          job.progress = { ...job.progress, message: was };
          this.publish({ type: "job.progress", jobId: id, ...job.progress });
        }
        line(TOO_LATE);
        this.tell({ type: "state", job });
      }
    };
    const control: JobControl = {
      progress: (done, total, given) => {
        // Stopping, it says so until it ends, whatever step it reaches meanwhile.
        const message = job.stopping ? STOPPING : given;
        job.progress = { done, total, message };
        this.publish({ type: "job.progress", jobId: id, done, total, message });
        this.tell({ type: "state", job });
      },
      line,
      commit,
      get cancelled() {
        return cancelled.has(id);
      },
      signal: abort.signal,
    };
    this.tell({ type: "state", job });
    void (async () => {
      try {
        const out = await withPrinter(line, () =>
          withSignal(abort.signal, () => withCommit(commit, () => work(control))),
        );
        if (out?.result) job.result = out.result;
        if (out?.errors?.length) job.errors.push(...out.errors);
        job.state = this.cancelledIds.has(id) ? "cancelled" : job.errors.length ? "failed" : "done";
      } catch (e) {
        if (this.cancelledIds.has(id)) job.state = "cancelled";
        else {
          job.errors.push(e instanceof Error ? e.message : String(e));
          job.state = "failed";
        }
      }
      this.aborts.delete(id);
      this.committedIds.delete(id);
      this.beforeStop.delete(id);
      // Printed nothing as it ran: what it ended with is its lines.
      const p = this.printed.get(id);
      if (p && p.from + p.lines.length === 0) {
        const said = job.result?.lines;
        const end = [
          ...(Array.isArray(said) ? said.filter((l): l is string => typeof l === "string") : []),
          ...job.errors.filter((e) => !(Array.isArray(said) && said.includes(e))),
        ];
        if (end.length) line(end.join("\n"));
      }
      if (job.state === "cancelled") line(STOPPED);
      // The hunt of beta.28.1: its last word is how it ended: "Stopped." for a stop (never the
      // "Stopping…" it said while stopping), and a job done is done of every step it counted.
      if (job.state === "cancelled") job.progress = { ...job.progress, message: STOPPED };
      else if (job.state === "done" && job.progress.done < job.progress.total)
        job.progress = { ...job.progress, done: job.progress.total };
      delete job.stopping;
      job.finishedAt = this.now().toISOString();
      ofKind.delete(id);
      if (!ofKind.size && this.running.get(kind) === ofKind) this.running.delete(kind);
      this.publish({ type: "job.done", jobId: id, state: job.state });
      this.tell({ type: "state", job });
      this.recorded(id, (r) => r.end(job.state));
      this.recorders.delete(id);
      this.ends.get(id)?.();
      this.ends.delete(id);
    })();
    return job;
  }

  /**
   * Run work the caller waits for as a job (ADR 0187): the route keeps its answer, and the
   * Console shows what it printed. Resolves with the work's value, or throws its error.
   */
  track<T>(
    kind: JobKind,
    work: (c: JobControl) => Promise<T>,
    o: JobStartOptions = {},
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let value: T;
      let failed: { e: unknown } | undefined;
      const job = this.start(
        kind,
        async (c) => {
          try {
            value = await work(c);
          } catch (e) {
            failed = { e };
            throw e;
          }
        },
        o,
      );
      this.ends.set(job.id, () => (failed ? reject(failed.e) : resolve(value)));
    });
  }

  /**
   * Ask a running job to stop; false when it already finished. Beta.27 review: it says
   * "Stopping…" (its progress, a line, `stopping`) until it ends, so the Console and the strip
   * show the stop was heard; a second ask while it stops is the same stop.
   */
  cancel(id: string): boolean {
    const j = this.jobs.get(id);
    if (!j || j.state !== "running") return false;
    if (j.stopping) return true;
    // Beta.28.1: past the work's commit point, Stop is too late: said, and the work goes on.
    if (this.committedIds.has(id)) {
      this.print(j, TOO_LATE);
      return true;
    }
    this.cancelledIds.add(id);
    this.beforeStop.set(id, j.progress.message);
    j.stopping = true;
    j.progress = { ...j.progress, message: STOPPING };
    this.print(j, STOPPING);
    this.publish({ type: "job.progress", jobId: id, ...j.progress });
    this.tell({ type: "state", job: j });
    this.aborts.get(id)?.abort();
    return true;
  }

  /**
   * Beta.27 review: the server is closing. Each job still running is stopped, and its record in
   * the run log ends there, so a later run of the app shows it stopped when the app closed.
   */
  closeAll(): void {
    for (const j of this.jobs.values()) {
      if (j.state !== "running") continue;
      // Written now: the process may end before the job's own end is.
      this.recorded(j.id, (r) => {
        r.line(CLOSED);
        r.end("cancelled", "app-closed");
      });
      this.recorders.delete(j.id);
      // Beta.28.1 (the re-review): past its commit point a Stop is too late and would only say
      // so after its record ended; the work finishes, or ends with the process.
      if (!this.committedIds.has(j.id)) this.cancel(j.id);
    }
  }

  /** Wait for a job to finish (tests and the CLI). */
  async settle(id: string, timeoutMs = 60_000): Promise<Job> {
    const start = Date.now();
    for (;;) {
      const j = this.jobs.get(id);
      if (!j) throw new Error(`No job ${id}`);
      if (j.state !== "running" && j.state !== "queued") return j;
      if (Date.now() - start > timeoutMs) throw new Error(`Job ${id} did not finish`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}
