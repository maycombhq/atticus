import { useEffect, useState } from "react";
import { stopJob } from "../api/client.js";
import { COPY } from "../copy.js";
import { followJob, JobFailed } from "./job.js";

const J = COPY.app.jobRun;
const W = COPY.app.jobWait;

/**
 * Beta.30, slice 2: a step the app runs as a job, as the panel that started it shows it. While
 * it runs: the step it is on (the job's own progress message, as the server says it), since
 * when, and whether Stop was asked. Once it ended: how, and when, so its line stays.
 */
export interface JobRun {
  state: "running" | "done" | "failed" | "stopped";
  /** When the page started it and when it heard it end (the page's clock, ms). */
  startedAt: number;
  endedAt?: number;
  jobId?: string;
  /** What the job says it is doing now. */
  step?: string;
  stopping?: boolean;
}

/** What followJob tells of a running job: handed to work that follows one elsewhere. */
export interface JobHears {
  onJob: (jobId: string) => void;
  onProgress: (p: { done: number; total: number; message: string; stopping?: boolean }) => void;
}

/** From this long on, a running job says it is still running. */
export const STILL_FROM_MS = 30_000;

/**
 * A panel's hold on the job it started: `follow` starts one and follows it to its end (as
 * followJob does, throwing as it throws), `watch` does the same for work that follows a job
 * itself, and `stop` asks the server to stop the one running. A step the server refused to
 * start (no job was named) leaves nothing behind.
 */
export function useJobRun(o: { clock?: () => number; wait?: (ms: number) => Promise<void> } = {}) {
  const clock = o.clock ?? Date.now;
  const [run, setRun] = useState<JobRun | undefined>();
  const watch = async <T,>(work: (on: JobHears) => Promise<T>): Promise<T> => {
    setRun({ state: "running", startedAt: clock() });
    const running = (f: (was: JobRun) => JobRun) =>
      setRun((was) => (was?.state === "running" ? f(was) : was));
    let named = false;
    try {
      const r = await work({
        onJob: (jobId) => {
          named = true;
          running((was) => ({ ...was, jobId }));
        },
        onProgress: (p) => {
          named = true;
          running((was) => ({
            ...was,
            step: p.message,
            ...(p.stopping ? { stopping: true } : {}),
          }));
        },
      });
      running(({ stopping: _s, ...was }) => ({ ...was, state: "done", endedAt: clock() }));
      return r;
    } catch (e) {
      if (!named) setRun(undefined);
      else
        running(({ stopping: _s, ...was }) => ({
          ...was,
          state: e instanceof JobFailed && e.stopped ? "stopped" : "failed",
          endedAt: clock(),
        }));
      throw e;
    }
  };
  const follow = (path: string, body: unknown, on: { onJob?: (jobId: string) => void } = {}) =>
    watch((h) =>
      followJob(
        path,
        body,
        o.wait,
        (id) => {
          h.onJob(id);
          on.onJob?.(id);
        },
        h.onProgress,
      ),
    );
  const jobId = run?.state === "running" ? run.jobId : undefined;
  const stop = jobId
    ? () => {
        setRun((was) => (was?.state === "running" ? { ...was, stopping: true } : was));
        // The server didn't hear it: Stop can be pressed again.
        void stopJob(jobId).catch(() =>
          setRun((was) => {
            if (was?.state !== "running" || was.jobId !== jobId) return was;
            const { stopping: _s, ...rest } = was;
            return rest;
          }),
        );
      }
    : undefined;
  return { run, follow, watch, stop };
}

/** The page's clock, read each second while something runs. */
function useTick(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return undefined;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    (t as { unref?: () => void }).unref?.();
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/**
 * The job in the panel. Running: `what` (the wait's own words), the step now, the time so far,
 * a line that says it is still running (heard every half minute, not every second) and Stop when
 * the job hears one (`onStop`). Ended: one line that says how and how long it took, which stays
 * until the next run. `now` is the page's clock unless a test gives one.
 */
export function JobProgress(p: {
  what: string;
  run: JobRun | undefined;
  onStop?: (() => void) | undefined;
  now?: number;
}) {
  const ticked = useTick(p.run?.state === "running" && p.now === undefined);
  const r = p.run;
  if (!r) return null;
  if (r.state !== "running") {
    const took = J.time((r.endedAt ?? r.startedAt) - r.startedAt);
    return (
      <p role="status" className="ev-say" style={{ margin: 0 }}>
        {r.state === "done"
          ? J.done(took)
          : r.state === "stopped"
            ? J.stopped(took)
            : J.ended(took)}
      </p>
    );
  }
  const spent = Math.max(0, (p.now ?? ticked) - r.startedAt);
  const still = Math.floor(spent / STILL_FROM_MS) * STILL_FROM_MS;
  return (
    <div className="stack" style={{ gap: 4 }}>
      <p role="status" aria-busy="true" className="ev-say" style={{ margin: 0 }}>
        {p.what}
      </p>
      {/* Kept mounted, empty until the first step: a screen reader hears each as it comes. */}
      <p className="ev-say mono" aria-live="polite" style={{ margin: 0 }}>
        {r.step ? W.now(r.step) : ""}
      </p>
      <p className="ev-say" style={{ margin: 0 }}>
        {J.soFar(J.time(spent))}
      </p>
      <p className="ev-say" aria-live="polite" style={{ margin: 0 }}>
        {still > 0 ? J.still(J.time(still)) : ""}
      </p>
      {p.onStop && (
        <div className="row" style={{ gap: 6 }}>
          <button
            type="button"
            className="btn"
            onClick={p.onStop}
            disabled={!!r.stopping}
            aria-busy={!!r.stopping}
            aria-label={W.stopLabel(p.what)}
          >
            {r.stopping ? W.stopping : W.stop}
          </button>
        </div>
      )}
    </div>
  );
}
