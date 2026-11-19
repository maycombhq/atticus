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

/**
 * API 3.19.0 (ADR 0202 point 3): the build an error's Undo would take back, with what its confirm
 * sends to POST /api/build/undo. `ofThis`: the job that failed took that undo copy itself.
 */
export interface UndoWay {
  n: number;
  files: number;
  plan: string;
  command: string;
  at: string;
  ofThis: boolean;
}

/** A job's result's or a 409 problem's `undo`, when it is one; undefined otherwise. */
export function undoWayOf(x: unknown): UndoWay | undefined {
  const u = (x as { undo?: unknown } | undefined)?.undo as Partial<UndoWay> | undefined;
  if (!u || typeof u !== "object") return undefined;
  return Number.isInteger(u.n) &&
    Number.isInteger(u.files) &&
    typeof u.plan === "string" &&
    typeof u.command === "string" &&
    typeof u.at === "string"
    ? {
        n: u.n!,
        files: u.files!,
        plan: u.plan,
        command: u.command,
        at: u.at,
        ofThis: u.ofThis === true,
      }
    : undefined;
}

/**
 * The Undo an error offers: a failed job's or a build route's 409's. `known` is whether the
 * server is one that says (3.19.0 on): then no `undo` means there is no build to take back, and
 * no button is shown; an older server's error keeps the link to the Undo panel.
 */
export function undoAfter(e: unknown): { undo?: UndoWay; known: boolean } {
  if (e instanceof JobFailed) {
    const undo = undoWayOf(e.result);
    return { ...(undo ? { undo } : {}), known: e.saysStop };
  }
  if (e instanceof ApiError) {
    const undo = undoWayOf(e.problem);
    return { ...(undo ? { undo } : {}), known: !!undo };
  }
  return { known: false };
}

/** What a job says of Stop (API 3.19.0); nothing from an older server. */
export interface StopStands {
  stoppable?: boolean;
  stopLands?: "now" | "after-write";
}

/** A job that failed or stopped: its lines (why), and what the app offers next. */
export class JobFailed extends Error {
  constructor(
    message: string,
    readonly lines: string[],
    readonly next?: NextStep,
    /** The job's exit code, when it ended with one (a step that says which part refused). */
    readonly code?: number,
    /** The rest of its result (Apply's refused build, ADR 0195 point 4: what a person confirms). */
    readonly result?: Record<string, unknown>,
    /** Beta.30: a person's Stop ended it (the job's state is `cancelled`), not a failure. */
    readonly stopped: boolean = false,
    /** API 3.19.0: the server said `stoppable` (so it also says `undo` when there is one). */
    readonly saysStop: boolean = false,
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
  /** Beta.28.4: hears how far the job is on each look while it runs (the repo an Apply is on). */
  onProgress?: (
    p: { done: number; total: number; message: string; stopping?: boolean } & StopStands,
  ) => void,
): Promise<{ code: number; lines: string[]; result?: Record<string, unknown> }> {
  const { jobId } = await api<{ jobId: string }>(path, { method: "POST", body });
  onJob?.(jobId);
  for (;;) {
    const j = await api<{
      state: string;
      errors: string[];
      progress?: { done: number; total: number; message: string };
      /** Stop was asked and it is ending (a run over several repos: after the repo it writes). */
      stopping?: boolean;
      /** API 3.19.0: whether a Stop asked now would end it, and where it would land. */
      stoppable?: boolean;
      stopLands?: "now" | "after-write";
      result?: { code?: number; lines?: string[]; next?: unknown; [k: string]: unknown };
    }>(`/api/jobs/${encodeURIComponent(jobId)}`, { quiet: true });
    if (j.state !== "running" && j.state !== "queued") {
      const code = j.result?.code ?? (j.state === "done" ? 0 : 1);
      const failed = j.state !== "done" || code !== 0;
      const said = j.result?.lines ?? [];
      const errors = j.errors ?? [];
      // A failure's own words: its errors (a sync's stderr), else what it printed.
      const lines = failed ? (errors.length ? errors : said) : said.length ? said : errors;
      if (failed)
        throw new JobFailed(
          lines.join(" ") || j.state,
          lines,
          nextStepOf(j.result),
          j.result?.code,
          j.result,
          j.state === "cancelled",
          typeof j.stoppable === "boolean",
        );
      // Beta.27 review, final round: the rest of the result (the upgrade's `upgraded`).
      return { code, lines, ...(j.result ? { result: j.result } : {}) };
    }
    if (j.progress)
      onProgress?.({
        ...j.progress,
        ...(j.stopping ? { stopping: true } : {}),
        ...(typeof j.stoppable === "boolean" ? { stoppable: j.stoppable } : {}),
        ...(j.stopLands ? { stopLands: j.stopLands } : {}),
      });
    await wait(700);
  }
}
