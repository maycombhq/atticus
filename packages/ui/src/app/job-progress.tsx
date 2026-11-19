import { useEffect, useRef, useState } from "react";
import { stopJob } from "../api/client.js";
import { COPY } from "../copy.js";
import { followJob, JobFailed } from "./job.js";
import { JobWait } from "./job-wait.js";
import { focusIfLost } from "./ui.js";

const J = COPY.app.jobRun;

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
  /** Stop was asked and nothing says yet that it wasn't taken, or the job says it is stopping. */
  stopping?: boolean;
  /**
   * Stop was asked and heard, and the job goes on without saying it is stopping: its write had
   * started (past that point the server answers a Stop and carries on, saying so only in the
   * Console). No Stop is offered again.
   */
  tooLate?: boolean;
}

/** What followJob tells of a running job: handed to work that follows a job elsewhere. */
export interface JobHears {
  onJob: (jobId: string) => void;
  onProgress: (p: { done: number; total: number; message: string; stopping?: boolean }) => void;
}

/**
 * How long a job had run when it last said it was still running: at 30 s, 1 min and 2 min, then
 * every 5 min, so a long job isn't announced every half minute for ever; 0 before the first.
 */
export function stillAt(spent: number): number {
  const five = Math.floor(spent / 300_000) * 300_000;
  return five || ([120_000, 60_000, 30_000].find((t) => spent >= t) ?? 0);
}

/** A step as the panel says it: without the server's "(9 s in)", the time its step began. */
const stepWords = (step: string) => step.replace(/\s*\((?:\d+ (?:s|min|h) ?)+in\)\.?$/, "");

/**
 * A panel's hold on the job it started: `follow` starts one and follows it to its end (as
 * followJob does, throwing as it throws), `watch` does the same for work that follows a job
 * itself, and `stop` asks the server to stop the one running. A step the server refused to
 * start (no job was named) leaves nothing behind, and one asked while another runs here leaves
 * that one's progress as it is.
 */
export function useJobRun(o: { clock?: () => number; wait?: (ms: number) => Promise<void> } = {}) {
  const clock = o.clock ?? Date.now;
  const [run, setRun] = useState<JobRun | undefined>();
  const busy = useRef(false);
  /** Where a Stop stands: sent, heard by the server, and one look at the job since. */
  const asked = useRef<"sent" | "heard" | "looked" | undefined>(undefined);
  const watch = async <T,>(work: (on: JobHears) => Promise<T>): Promise<T> => {
    if (busy.current) return work({ onJob: () => undefined, onProgress: () => undefined });
    busy.current = true;
    asked.current = undefined;
    setRun({ state: "running", startedAt: clock() });
    const running = (f: (was: JobRun) => JobRun) =>
      setRun((was) => (was?.state === "running" ? f(was) : was));
    const end = (state: JobRun["state"]) =>
      running(({ stopping: _s, tooLate: _t, ...was }) => ({ ...was, state, endedAt: clock() }));
    let named = false;
    try {
      const r = await work({
        onJob: (jobId) => {
          named = true;
          running((was) => ({ ...was, jobId }));
        },
        onProgress: (p) => {
          named = true;
          // The job says whether the Stop was taken. The first look after the server heard it
          // may have been on its way already, so the second one decides.
          const late = !p.stopping && asked.current === "looked";
          if (p.stopping || late) asked.current = undefined;
          else if (asked.current === "heard") asked.current = "looked";
          running(({ stopping: _s, ...was }) => ({
            ...was,
            step: p.message,
            ...(p.stopping || asked.current ? { stopping: true } : {}),
            ...(late ? { tooLate: true } : {}),
          }));
        },
      });
      end("done");
      return r;
    } catch (e) {
      if (!named) setRun(undefined);
      else end(e instanceof JobFailed && e.stopped ? "stopped" : "failed");
      throw e;
    } finally {
      busy.current = false;
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
  const jobId = run?.state === "running" && !run.tooLate ? run.jobId : undefined;
  const stop = jobId
    ? () => {
        asked.current = "sent";
        setRun((was) => (was?.state === "running" ? { ...was, stopping: true } : was));
        void stopJob(jobId).then(
          () => {
            if (asked.current === "sent") asked.current = "heard";
          },
          // The server didn't hear it: Stop can be pressed again.
          () => {
            asked.current = undefined;
            setRun((was) => {
              if (was?.state !== "running" || was.jobId !== jobId) return was;
              const { stopping: _s, ...rest } = was;
              return rest;
            });
          },
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
 * The job in the panel. Running: JobWait (`what`, the step now, Stop when the job hears one),
 * the time so far, and a line that says it is still running (heard at 30 s, 1 min, 2 min, then
 * every 5 min). A Stop that came too late is said, and Stop goes. Ended: one line that says how
 * and how long it took, which stays until the next run. The line that replaces Stop takes the
 * keyboard when nothing else has it. `now` is the page's clock unless a test gives one.
 */
export function JobProgress(p: {
  what: string;
  run: JobRun | undefined;
  onStop?: (() => void) | undefined;
  now?: number;
}) {
  const r = p.run;
  const ticked = useTick(r?.state === "running" && p.now === undefined);
  const said = useRef<HTMLParagraphElement | null>(null);
  const ended = !!r && r.state !== "running";
  const late = !!r?.tooLate;
  useEffect(() => {
    if (ended || late) focusIfLost(said.current);
  }, [ended, late]);
  if (!r) return null;
  if (r.state !== "running") {
    const took = J.time((r.endedAt ?? r.startedAt) - r.startedAt);
    return (
      <p role="status" className="ev-say" style={{ margin: 0 }} tabIndex={-1} ref={said}>
        {r.state === "done"
          ? J.done(took)
          : r.state === "stopped"
            ? J.stopped(took)
            : J.ended(took)}
      </p>
    );
  }
  const spent = Math.max(0, (p.now ?? ticked) - r.startedAt);
  const still = stillAt(spent);
  return (
    <div className="stack" style={{ gap: 4 }}>
      <JobWait
        what={p.what}
        line={r.step ? stepWords(r.step) : undefined}
        onStop={late ? undefined : p.onStop}
        stopping={!!r.stopping}
      />
      {late && (
        <p role="status" className="ev-say" style={{ margin: 0 }} tabIndex={-1} ref={said}>
          {J.tooLate}
        </p>
      )}
      <p className="ev-say" style={{ margin: 0 }}>
        {J.soFar(J.time(spent))}
      </p>
      <p className="ev-say" aria-live="polite" style={{ margin: 0 }}>
        {still > 0 ? J.still(J.time(still)) : ""}
      </p>
    </div>
  );
}
