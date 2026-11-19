import { useEffect, useRef, useState } from "react";
import { api, stopJob } from "../api/client.js";
import { COPY } from "../copy.js";
import { followJob, JobFailed, undoWayOf, type StopStands } from "./job.js";
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
  /** `refused` (ADR 0202 point 5): a job found again that ended by refusing; nothing written. */
  state: "running" | "done" | "failed" | "stopped" | "refused";
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
  r?.state === "running" && r.stoppable === false && !r.stopping;

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
  // ADR 0202 point 2: no Stop once the job says one can no longer take effect.
  const jobId =
    run?.state === "running" && !run.tooLate && run.stoppable !== false ? run.jobId : undefined;
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

/** A job as GET /api/jobs gives it (API 3.19.0), as far as a panel reads it. */
interface FoundJobView extends StopStands {
  id: string;
  state: string;
  progress?: { done: number; total: number; message: string };
  startedAt: string;
  finishedAt?: string;
  stopping?: boolean;
  result?: Record<string, unknown>;
}

/** How long a finished job is still shown by the panel that finds it again. */
export const FOUND_FOR_MS = 10 * 60_000;
/** The lines of a job found again that the panel shows (its last ones). */
export const FOUND_LINES = 6;

/** A job found again: as the panel shows it, its last lines, and its result once it ended. */
export interface FoundJob {
  run: JobRun;
  lines: string[];
  result?: Record<string, unknown>;
}

const isRunning = (j: FoundJobView) => j.state === "running" || j.state === "queued";

/** The run of a job as the server tells it: its own start, and how it ended. */
export function foundRun(j: FoundJobView, now: number): JobRun {
  const startedAt = Date.parse(j.startedAt) || now;
  if (isRunning(j))
    return {
      state: "running",
      startedAt,
      jobId: j.id,
      ...(j.progress?.message ? { step: j.progress.message } : {}),
      ...(j.stopping ? { stopping: true } : {}),
      ...stopStands(j),
    };
  const code = j.result?.code;
  return {
    state:
      j.state === "cancelled"
        ? "stopped"
        : j.result?.refused
          ? "refused"
          : j.state === "done" && (code === undefined || code === 0)
            ? "done"
            : "failed",
    startedAt,
    endedAt: Date.parse(j.finishedAt ?? "") || now,
    jobId: j.id,
  };
}

/**
 * ADR 0202 point 5: the job this panel's action started before the page was loaded, found again:
 * GET /api/jobs?action=&repo= on load. A running one is followed to its end (its message, the
 * time since the server's `startedAt`, Stop as the job says, its last lines from
 * GET /api/activity/{id}/lines); with none running, the newest finished within the last ten
 * minutes is shown as it ended. An older server (no such route) or one that restarted since (no
 * such job) leaves the panel as it was: nothing is said. `skip`: the panel has a job of its own.
 */
export function useJobFound(
  action: string,
  repo?: string,
  o: {
    skip?: boolean;
    clock?: () => number;
    wait?: (ms: number) => Promise<void>;
    onEnd?: () => void;
  } = {},
) {
  const clock = o.clock ?? Date.now;
  const [found, setFound] = useState<FoundJob | undefined>();
  const [asked, setAsked] = useState(false);
  const skip = !!o.skip;
  useEffect(() => {
    if (skip) return undefined;
    let gone = false;
    const wait = o.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    void (async () => {
      const q = `action=${encodeURIComponent(action)}${repo ? `&repo=${encodeURIComponent(repo)}` : ""}`;
      let j: FoundJobView | undefined;
      try {
        j = (await api<{ jobs?: FoundJobView[] }>(`/api/jobs?${q}`, { quiet: true })).jobs?.[0];
      } catch {
        return;
      }
      if (!j || gone) return;
      let followed = false;
      for (;;) {
        const running = isRunning(j);
        const run = foundRun(j, clock());
        // One that ended before the page looked is shown only while it is news.
        if (!running && !followed && clock() - (run.endedAt ?? 0) > FOUND_FOR_MS) return;
        const lines = await api<{ lines?: string[] }>(
          `/api/activity/${encodeURIComponent(j.id)}/lines`,
          { quiet: true },
        ).then(
          (l) => (l.lines ?? []).slice(-FOUND_LINES),
          () => [] as string[],
        );
        if (gone) return;
        setFound({ run, lines, ...(j.result ? { result: j.result } : {}) });
        if (!running) {
          if (followed) o.onEnd?.();
          return;
        }
        followed = true;
        await wait(700);
        if (gone) return;
        try {
          j = await api<FoundJobView>(`/api/jobs/${encodeURIComponent(j.id)}`, { quiet: true });
        } catch {
          return;
        }
      }
    })();
    return () => {
      gone = true;
    };
    // Once per action and repo: the clock, the wait and onEnd are the caller's of that render.
  }, [action, repo, skip]);
  const run = skip ? undefined : found?.run;
  const jobId = run?.state === "running" && run.stoppable !== false ? run.jobId : undefined;
  const stop =
    jobId && !asked
      ? () => {
          setAsked(true);
          void stopJob(jobId).catch(() => setAsked(false));
        }
      : undefined;
  // A Stop asked here is said at once, until the job says how it took it.
  const pressed = asked && run?.state === "running" && run.stoppable !== false;
  return {
    found:
      skip || !found
        ? undefined
        : pressed
          ? { ...found, run: { ...found.run, stopping: true } }
          : found,
    stop,
  };
}

/**
 * The job a panel found again, under its button: that it was started before this page was
 * loaded, its progress as the panel shows any job (JobProgress), what it printed last, and once
 * it ended its ways on: the refusal's page, or Undo and the support bundle after a failure.
 */
export function JobFoundView(p: {
  what: string;
  found: FoundJob | undefined;
  onStop?: (() => void) | undefined;
  now?: number;
  /** Where to build again after a failure, when a build is what the job ran. */
  againHref?: string | undefined;
}) {
  const f = p.found;
  if (!f) return null;
  const undo = undoWayOf(f.result);
  return (
    <div className="stack" role="group" aria-label={J.found} style={{ gap: 4 }}>
      <p className="ev-say" style={{ margin: 0 }}>
        {J.found}
      </p>
      <JobProgress
        what={p.what}
        run={f.run}
        onStop={p.onStop}
        {...(p.now !== undefined ? { now: p.now } : {})}
      />
      {f.lines.length > 0 && (
        <pre
          className="ev-say mono"
          role="group"
          tabIndex={0}
          aria-label={J.linesLabel(p.what)}
          style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
        >
          {f.lines.join("\n")}
        </pre>
      )}
      {f.run.state === "refused" && (
        <div>
          <a className="btn primary" href={CATALOG_BUILDS_HREF}>
            {J.seeRefusal}
          </a>
        </div>
      )}
      {f.run.state === "failed" && (
        <ErrorWaysOn short againHref={p.againHref} undo={undo} undoKnown />
      )}
    </div>
  );
}

/** useJobFound and its view in one: what a panel puts under its button. */
export function JobFound(p: {
  action: string;
  repo?: string | undefined;
  what: string;
  /** The panel started a job of its own: that one is shown, not one found. */
  skip?: boolean | undefined;
  onEnd?: (() => void) | undefined;
}) {
  const j = useJobFound(p.action, p.repo, {
    ...(p.skip ? { skip: true } : {}),
    ...(p.onEnd ? { onEnd: p.onEnd } : {}),
  });
  return (
    <JobFoundView
      what={p.what}
      found={j.found}
      onStop={j.stop}
      againHref={p.action === "apply" ? undefined : CATALOG_BUILDS_HREF}
    />
  );
}
