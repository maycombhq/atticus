import { printToCurrent, withPrinter, withSignal } from "@maycombhq/core";

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
}

export interface JobControl {
  progress(done: number, total: number, message: string): void;
  /** Print a line to the job's Console entry (ADR 0187). */
  line(text: string): void;
  readonly cancelled: boolean;
}

export type JobWork = (
  c: JobControl,
) => Promise<{ result?: Record<string, unknown>; errors?: string[] } | void>;

type Publish = (e: { type: string } & Record<string, unknown>) => void;

/** The lines a job keeps (its last ones), as a Copilot run's tab does. */
export const JOB_LINES = 5000;
/** The finished jobs kept for the Console (the oldest go first). */
export const JOBS_KEPT = 100;

export interface JobStartOptions {
  title?: string;
  /** What the job belongs to (ADR 0187): `copilotRunId`, `handoffRun`. */
  meta?: Record<string, string>;
}

export type JobChange =
  { type: "state"; job: Job } | { type: "lines"; job: Job; at: number; lines: string[] };

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

  constructor(
    private readonly publish: Publish,
    private readonly now: () => Date = () => new Date(),
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

  private print(job: Job, text: string) {
    const p = this.printed.get(job.id);
    if (!p) return;
    const lines = String(text).split(/\r?\n/);
    const at = p.from + p.lines.length;
    p.lines.push(...lines);
    if (p.lines.length > JOB_LINES) {
      const drop = p.lines.length - JOB_LINES;
      p.lines.splice(0, drop);
      p.from += drop;
    }
    this.tell({ type: "lines", job, at, lines });
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
    this.forget();
    const ofKind = this.running.get(kind) ?? new Set<string>();
    ofKind.add(id);
    this.running.set(kind, ofKind);
    const abort = new AbortController();
    this.aborts.set(id, abort);
    const cancelled = this.cancelledIds;
    const line = (text: string) => this.print(job, text);
    const control: JobControl = {
      progress: (done, total, message) => {
        job.progress = { done, total, message };
        this.publish({ type: "job.progress", jobId: id, done, total, message });
        this.tell({ type: "state", job });
      },
      line,
      get cancelled() {
        return cancelled.has(id);
      },
    };
    this.tell({ type: "state", job });
    void (async () => {
      try {
        const out = await withPrinter(line, () => withSignal(abort.signal, () => work(control)));
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
      job.finishedAt = this.now().toISOString();
      ofKind.delete(id);
      if (!ofKind.size && this.running.get(kind) === ofKind) this.running.delete(kind);
      this.publish({ type: "job.done", jobId: id, state: job.state });
      this.tell({ type: "state", job });
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

  /** Ask a running job to stop; false when it already finished. */
  cancel(id: string): boolean {
    const j = this.jobs.get(id);
    if (!j || j.state !== "running") return false;
    this.cancelledIds.add(id);
    this.aborts.get(id)?.abort();
    return true;
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
