import { useEffect, useRef, useState } from "react";
import type { Api } from "@maycombhq/core";
import { api, stopJob } from "../api/client.js";
import { COPY } from "../copy.js";
import {
  followJob,
  followJobId,
  JobFailed,
  JobLost,
  stopOffered,
  undoWayOf,
  type StopStands,
} from "./job.js";
import { JobWait } from "./job-wait.js";
import { focusIfLost } from "./ui.js";
import { CATALOG_BUILDS_HREF, ErrorWaysOn } from "./ways-on.js";

const J = COPY.app.jobRun;

/**
 * Beta.30, slice 2: a step the app runs as a job, as the panel that started it shows it. While
 * it runs: the step it is on (the job's own progress message, as the server says it), since
 * when, and whether Stop was asked. Once it ended: how, and when, so its line stays.
 */
export interface JobRun {
  /**
   * ADR 0202 point 5, of a job found again: `refused`, it ended by refusing and nothing was
   * written; `lost`, the page could no longer ask the server about it (it may still be running).
   */
  state: "running" | "done" | "failed" | "stopped" | "refused" | "lost";
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
  /**
   * API 3.19.0 (ADR 0202 point 2): what the job itself says of Stop: whether one asked now
   * would end it, and where it would land. Absent from an older server (the page then offers
   * Stop while the job runs, and tells a late one by looking twice, as before).
   */
  stoppable?: boolean;
  stopLands?: "now" | "after-write";
  /** The job said it was stoppable at some point: only then can it turn "too late". */
  couldStop?: boolean;
}

/** What followJob tells of a running job: handed to work that follows a job elsewhere. */
export interface JobHears {
  onJob: (jobId: string) => void;
  onProgress: (
    p: { done: number; total: number; message: string; stopping?: boolean } & StopStands,
  ) => void;
}

/** A job's word on Stop, as the run keeps it; nothing when the server says nothing. */
const stopStands = (p: StopStands): Pick<JobRun, "stoppable" | "stopLands"> =>
  typeof p.stoppable === "boolean"
    ? { stoppable: p.stoppable, ...(p.stoppable && p.stopLands ? { stopLands: p.stopLands } : {}) }
    : {};

/** Whether the job says a Stop can no longer take effect: it runs on, its write started. */
export const cantStopNow = (r: JobRun | undefined): boolean =>
  r?.state === "running" && r.stoppable === false && !r.stopping && !!r.couldStop;

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
export function useJobRun(
  o: {
    clock?: () => number;
    wait?: (ms: number) => Promise<void>;
    /**
     * Stop is offered only when the job itself says it is stoppable: for work an older server
     * (one that says nothing) would carry on with all the same, a push among it.
     */
    stopOnlyWhenSaid?: boolean;
  } = {},
) {
  const clock = o.clock ?? Date.now;
  const [run, setRun] = useState<JobRun | undefined>();
  const busy = useRef(false);
  /** Where a Stop stands: sent, heard by the server, and one look at the job since. */
  const asked = useRef<"sent" | "heard" | "looked" | undefined>(undefined);
  const watch = async <T,>(
    work: (on: JobHears) => Promise<T>,
    /** When the job started, when it wasn't just now (one found again: the server's time). */
    startedAt?: number,
  ): Promise<T> => {
    if (busy.current) return work({ onJob: () => undefined, onProgress: () => undefined });
    busy.current = true;
    asked.current = undefined;
    setRun({ state: "running", startedAt: startedAt ?? clock() });
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
          // A server that says `stoppable` says so itself: no second look is needed.
          const says = typeof p.stoppable === "boolean";
          const late = !says && !p.stopping && asked.current === "looked";
          if (p.stopping || late || (says && asked.current === "heard")) asked.current = undefined;
          else if (asked.current === "heard") asked.current = "looked";
          running(({ stopping: _s, stoppable: _a, stopLands: _l, ...was }) => ({
            ...was,
            step: p.message,
            ...(p.stopping || asked.current ? { stopping: true } : {}),
            ...(late ? { tooLate: true } : {}),
            ...stopStands(p),
            ...(p.stoppable ? { couldStop: true } : {}),
          }));
        },
      });
      end("done");
      return r;
    } catch (e) {
      if (!named) setRun(undefined);
      else
        end(
          e instanceof JobLost
            ? "lost"
            : e instanceof JobFailed && e.stopped
              ? "stopped"
              : "failed",
        );
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
  /**
   * ADR 0202 point 5: a job this page didn't start (found again after a reload), followed to its
   * end as one it started: its time counts from the server's start, and three polls that fail
   * in a row end it `lost` rather than leave it ticking with a Stop nothing answers.
   */
  const resume = (j: Api.JobT, on: { onProgress?: () => void } = {}) =>
    watch(
      (h) => {
        h.onJob(j.id);
        h.onProgress({
          ...j.progress,
          ...(j.stopping ? { stopping: true } : {}),
          ...stopStands(j),
        });
        return followJobId(
          j.id,
          o.wait,
          (p) => {
            h.onProgress(p);
            on.onProgress?.();
          },
          3,
        );
      },
      Date.parse(j.startedAt) || clock(),
    );
  /** A job that had ended when the page found it: shown as it ended. */
  const show = (r: JobRun | undefined) => setRun(r);
  // ADR 0202 point 2: Stop only while the job says one can take effect (`stopOffered`).
  const jobId =
    run?.state === "running" && !run.tooLate && stopOffered(run, !o.stopOnlyWhenSaid)
      ? run.jobId
      : undefined;
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
  return { run, follow, watch, stop, resume, show };
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
  /** A job found again and lost touch with: look for it again. */
  onAgain?: (() => void) | undefined;
}) {
  const r = p.run;
  const ticked = useTick(r?.state === "running" && p.now === undefined);
  const said = useRef<HTMLParagraphElement | null>(null);
  const ended = !!r && r.state !== "running";
  // Too late, as the page worked out (an older server) or as the job says (ADR 0202 point 2).
  const saysLate = cantStopNow(r);
  const late = !!r?.tooLate || saysLate;
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
            : r.state === "refused"
              ? J.refused(took)
              : r.state === "lost"
                ? J.lost
                : J.ended(took)}{" "}
        {r.state === "lost" && p.onAgain && (
          <button type="button" className="btn" onClick={p.onAgain}>
            {J.checkAgain}
          </button>
        )}
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
        onStop={late || r.stoppable === false ? undefined : p.onStop}
        stopping={!!r.stopping}
        afterRepo={r.stopLands === "after-write"}
      />
      {late && (
        <p role="status" className="ev-say" style={{ margin: 0 }} tabIndex={-1} ref={said}>
          {saysLate ? J.tooLateNow : J.tooLate}
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

/** How long a finished job is still shown by the panel that finds it again. */
export const FOUND_FOR_MS = 10 * 60_000;
/** The lines of a job found again that the panel shows (its last ones). */
export const FOUND_LINES = 6;

/** How a job that had ended when the page found it ended, with the server's own times. */
export function endedRun(j: Api.JobT, now: number): JobRun {
  const code = j.result?.code;
  return {
    state:
      j.state === "cancelled"
        ? "stopped"
        : j.state === "done" && (code === undefined || code === 0)
          ? "done"
          : "failed",
    startedAt: Date.parse(j.startedAt) || now,
    endedAt: Date.parse(j.finishedAt ?? "") || now,
    jobId: j.id,
  };
}

/**
 * A job a panel found again, under its button: that it was started before this page was loaded,
 * its progress as the panel shows any job, what it printed last, and once it ended its ways on:
 * the refusal's page, or Undo and the support bundle after a failure.
 */
export function JobFoundView(p: {
  what: string;
  run: JobRun | undefined;
  lines?: readonly string[];
  result?: Record<string, unknown> | undefined;
  onStop?: (() => void) | undefined;
  onAgain?: (() => void) | undefined;
  now?: number;
  /** Where to build again after a failure, when a build is what the job ran. */
  againHref?: string | undefined;
}) {
  if (!p.run) return null;
  // One that failed by refusing wrote nothing, and says so.
  const run: JobRun =
    p.run.state === "failed" && p.result?.refused ? { ...p.run, state: "refused" } : p.run;
  const lines = p.lines ?? [];
  return (
    <div className="stack" role="group" aria-label={J.found} style={{ gap: 4 }}>
      <p className="ev-say" style={{ margin: 0 }}>
        {J.found}
      </p>
      <JobProgress
        what={p.what}
        run={run}
        onStop={p.onStop}
        onAgain={p.onAgain}
        {...(p.now !== undefined ? { now: p.now } : {})}
      />
      {lines.length > 0 && (
        <pre
          className="ev-say mono"
          role="group"
          tabIndex={0}
          aria-label={J.linesLabel(p.what)}
          style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
        >
          {lines.join("\n")}
        </pre>
      )}
      {run.state === "refused" && (
        <div>
          <a className="btn primary" href={CATALOG_BUILDS_HREF}>
            {J.seeRefusal}
          </a>
        </div>
      )}
      {run.state === "failed" && (
        <ErrorWaysOn short againHref={p.againHref} undo={undoWayOf(p.result)} undoKnown />
      )}
    </div>
  );
}

/**
 * ADR 0202 point 5: the job this panel's action started before the page was loaded, found again:
 * GET /api/jobs?action=&repo= on load. A running one is followed to its end as any job the
 * panel follows (`resume`: its message, the time since the server's `startedAt`, Stop as the job
 * says), with its last lines from GET /api/activity/{id}/lines; with none running, the newest
 * finished within the last ten minutes is shown as it ended. An older server (no such route) or
 * one that restarted since (no such job) leaves the panel as it was. `skip`: the panel has a job
 * of its own, which is the one shown.
 */
export function JobFound(p: {
  action: Api.JobForT["action"];
  repo?: string | undefined;
  what: string;
  skip?: boolean | undefined;
  onEnd?: (() => void) | undefined;
  clock?: () => number;
  wait?: (ms: number) => Promise<void>;
}) {
  const clock = p.clock ?? Date.now;
  const job = useJobRun({
    ...(p.clock ? { clock: p.clock } : {}),
    ...(p.wait ? { wait: p.wait } : {}),
  });
  const [lines, setLines] = useState<string[]>([]);
  const [result, setResult] = useState<Record<string, unknown> | undefined>();
  const [looks, setLooks] = useState(0);
  const skip = !!p.skip;
  useEffect(() => {
    if (skip) return undefined;
    let gone = false;
    const read = (id: string) =>
      api<Api.ActivityLinesT>(`/api/activity/${encodeURIComponent(id)}/lines`, {
        quiet: true,
      }).then(
        (l) => void (gone || setLines((l.lines ?? []).slice(-FOUND_LINES))),
        () => undefined,
      );
    void (async () => {
      const q = `action=${p.action}${p.repo ? `&repo=${encodeURIComponent(p.repo)}` : ""}`;
      const j = await api<Api.JobListT>(`/api/jobs?${q}`, { quiet: true }).then(
        (l) => l.jobs?.[0],
        () => undefined,
      );
      if (!j || gone) return;
      if (j.state !== "running" && j.state !== "queued") {
        const ended = endedRun(j, clock());
        // One that ended before the page looked is shown only while it is news.
        if (clock() - ended.endedAt! > FOUND_FOR_MS) return;
        job.show(ended);
        setResult(j.result);
        void read(j.id);
        return;
      }
      void read(j.id);
      const ended = (r: Record<string, unknown> | undefined) => {
        if (gone) return;
        setResult(r);
        void read(j.id);
        p.onEnd?.();
      };
      job.resume(j, { onProgress: () => void read(j.id) }).then(
        (r) => ended(r.result),
        (e: unknown) => (e instanceof JobFailed ? ended(e.result) : undefined),
      );
    })();
    return () => {
      gone = true;
    };
    // Once per action and repo, and again when asked: the clock, the wait and onEnd are the
    // caller's of that render.
  }, [p.action, p.repo, skip, looks]);
  if (skip) return null;
  return (
    <JobFoundView
      what={p.what}
      run={job.run}
      lines={lines}
      result={result}
      onStop={job.stop}
      onAgain={() => setLooks((n) => n + 1)}
      againHref={p.action === "apply" ? undefined : CATALOG_BUILDS_HREF}
    />
  );
}
