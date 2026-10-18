/**
 * Long work (scans, syncs, reconciles, intake) runs as a job (ADR 0015): the call returns 202 with
 * a job id, progress goes out as live events, and the job can be read or cancelled. Cancelling
 * is cooperative: the work checks `cancelled` between steps.
 */

export type JobKind = "scan" | "sync" | "reconcile" | "index" | "intake";
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
  private seq = 0;
  private running = new Map<JobKind, string>();

  constructor(
    private readonly publish: Publish,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The running job of a kind, if any (one scan at a time: a second asks gets 409). */
  runningOf(kind: JobKind): Job | undefined {
    const id = this.running.get(kind);
    return id ? this.jobs.get(id) : undefined;
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
    this.running.set(kind, id);
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
        const out = await work(control);
        if (out?.result) job.result = out.result;
        if (out?.errors?.length) job.errors.push(...out.errors);
        job.state = this.cancelledIds.has(id) ? "cancelled" : job.errors.length ? "failed" : "done";
      } catch (e) {
        job.errors.push(e instanceof Error ? e.message : String(e));
        job.state = "failed";
      }
      job.finishedAt = this.now().toISOString();
      if (this.running.get(kind) === id) this.running.delete(kind);
      this.publish({ type: "job.done", jobId: id, state: job.state });
    })();
    return job;
  }

  /** Ask a running job to stop; false when it already finished. */
  cancel(id: string): boolean {
    const j = this.jobs.get(id);
    if (!j || j.state !== "running") return false;
    this.cancelledIds.add(id);
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
