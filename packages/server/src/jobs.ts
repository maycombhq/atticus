import { withSignal } from "@maycombhq/core";

/**
 * Long work (scans, syncs, reconciles, intake) runs as a job (ADR 0015): the call returns 202 with
 * a job id, progress goes out as live events, and the job can be read or cancelled. Cancelling
 * is cooperative: the work runs inside the job's abort signal (ADR 0119), which a model call
 * stops on at once and a scan checks between repos, and `cancelled` says so between steps.
 */

/** `local`: a person's local step (Apply, Propose, Bring in, round 37): never an AI step's slot. */
export type JobKind = "scan" | "sync" | "reconcile" | "index" | "intake" | "step" | "local";
export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";

export interface Job {
  id: string;
  kind: JobKind;
  state: JobState;
  progress: { done: number; total: number; message: string };
  startedAt: string;
  finishedAt?: string;
  errors: string[];
  result?: Record<string, unknown>;
}

export interface JobControl {
  progress(done: number, total: number, message: string): void;
  readonly cancelled: boolean;
}

export type JobWork = (
  c: JobControl,
) => Promise<{ result?: Record<string, unknown>; errors?: string[] } | void>;

type Publish = (e: { type: string } & Record<string, unknown>) => void;

export class JobManager {
  private jobs = new Map<string, Job>();
  private cancelledIds = new Set<string>();
  private aborts = new Map<string, AbortController>();
  private seq = 0;
  /** Round 41: every running job of a kind, in start order (a later one never hides an earlier). */
  private running = new Map<JobKind, Set<string>>();

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

  start(kind: JobKind, work: JobWork): Job {
    const id = `job-${++this.seq}`;
    const job: Job = {
      id,
      kind,
      state: "running",
      progress: { done: 0, total: 0, message: "Starting" },
      startedAt: this.now().toISOString(),
      errors: [],
    };
    this.jobs.set(id, job);
    const ofKind = this.running.get(kind) ?? new Set<string>();
    ofKind.add(id);
    this.running.set(kind, ofKind);
    const abort = new AbortController();
    this.aborts.set(id, abort);
    const cancelled = this.cancelledIds;
    const control: JobControl = {
      progress: (done, total, message) => {
        job.progress = { done, total, message };
        this.publish({ type: "job.progress", jobId: id, done, total, message });
      },
      get cancelled() {
        return cancelled.has(id);
      },
    };
    void (async () => {
      try {
        const out = await withSignal(abort.signal, () => work(control));
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
      job.finishedAt = this.now().toISOString();
      ofKind.delete(id);
      if (!ofKind.size && this.running.get(kind) === ofKind) this.running.delete(kind);
      this.publish({ type: "job.done", jobId: id, state: job.state });
    })();
    return job;
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
