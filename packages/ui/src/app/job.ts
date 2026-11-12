import { api, ApiError } from "../api/client.js";

/** API 3.9.0 (ADR 0188): the step the app offers after a refusal or a failed job. */
export interface NextStep {
  step: "sync";
  repos: string[];
}

/** A job's or a problem's `next`, when it is one the app offers; undefined otherwise. */
export function nextStepOf(x: unknown): NextStep | undefined {
  const n = (x as { next?: unknown } | undefined)?.next as
    { step?: unknown; repos?: unknown } | undefined;
  if (!n || n.step !== "sync" || !Array.isArray(n.repos)) return undefined;
  const repos = n.repos.filter((r): r is string => typeof r === "string" && r !== "");
  return repos.length ? { step: "sync", repos } : undefined;
}

/** The step offered after an error: a failed job's `next`, or a refusal's problem's. */
export function nextAfter(e: unknown): NextStep | undefined {
  if (e instanceof JobFailed) return e.next;
  if (e instanceof ApiError) return nextStepOf(e.problem);
  return undefined;
}

/** A job that failed or stopped: its lines (why), and what the app offers next. */
export class JobFailed extends Error {
  constructor(
    message: string,
    readonly lines: string[],
    readonly next?: NextStep,
  ) {
    super(message);
  }
}

/**
 * Windows review: Apply, Propose and Bring in run as server jobs (an editor panel waits 30 s for
 * one answer). Starts one and follows it to the end: its lines, or an error with them. Review of
 * beta.23: a job that failed says why (its errors, when its result's lines don't), and what the
 * app offers next (`next`, Sync the repos with no base clone here).
 */
export async function followJob(
  path: string,
  body: unknown,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  /** App-only audit: hears the job's id at once, so the page can link its Console entry. */
  onJob?: (jobId: string) => void,
): Promise<{ code: number; lines: string[]; result?: Record<string, unknown> }> {
  const { jobId } = await api<{ jobId: string }>(path, { method: "POST", body });
  onJob?.(jobId);
  for (;;) {
    const j = await api<{
      state: string;
      errors: string[];
      result?: { code?: number; lines?: string[]; next?: unknown; [k: string]: unknown };
    }>(`/api/jobs/${encodeURIComponent(jobId)}`, { quiet: true });
    if (j.state !== "running" && j.state !== "queued") {
      const code = j.result?.code ?? (j.state === "done" ? 0 : 1);
      const failed = j.state !== "done" || code !== 0;
      const said = j.result?.lines ?? [];
      const errors = j.errors ?? [];
      // A failure's own words: its errors (a sync's stderr), else what it printed.
      const lines = failed ? (errors.length ? errors : said) : said.length ? said : errors;
      if (failed) throw new JobFailed(lines.join(" ") || j.state, lines, nextStepOf(j.result));
      // Beta.27 review, final round: the rest of the result (the upgrade's `upgraded`).
      return { code, lines, ...(j.result ? { result: j.result } : {}) };
    }
    await wait(700);
  }
}
