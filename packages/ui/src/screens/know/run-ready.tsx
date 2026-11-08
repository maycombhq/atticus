import { useState } from "react";
import type { Api } from "@maycombhq/core";
import { api, ApiError, useApi, useLiveEvents, useReloadOnFiles } from "../../api/client.js";
import { useAiOn } from "../../app/me.js";
import { COPY } from "../../copy.js";
import { Note } from "./common.js";

/**
 * ADR 0181 part 4: Run all ready tasks, beside each task's Run with AI on the Task board. The
 * tech lead or architect runs every task whose dependencies are done, in cross-repo order, one
 * task run each, as one server job that stops on the first task that needs a person (API
 * 2.76.0). The click is the approval for the drafts; the app never asks for the pr level, so
 * each PR is raised on its own Raise click. Nothing is merged.
 */

const T = COPY.runReady;
const S = COPY.phase.taskState;

type NoteT = { ok: boolean; text: string; working?: boolean };

/** What the job's end says, in words: each task's state, then where it stopped, or that all ran. */
export function runReadyWords(r: Api.RunReadyResultT): string {
  const lines = r.ran.map((x) =>
    x.refused !== undefined
      ? T.refused(x.task, x.refused)
      : T.ran(x.task, S[x.state ?? ""] ?? x.state ?? ""),
  );
  lines.push(
    r.stopped
      ? T.stopped(r.stopped.task, r.stopped.why, r.left.join(", "))
      : T.allRan(r.ran.length),
  );
  return lines.join("\n");
}

/** The button and what it says, given the ready list (pure, for the page and its tests). */
export function RunReadyView(p: {
  ready: Api.ReadyTasksT | undefined;
  busy: boolean;
  note?: NoteT | undefined;
  onRun: () => void;
}) {
  const n = p.ready?.ready.length ?? 0;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button
          type="button"
          className="btn primary"
          disabled={p.busy || n === 0}
          aria-busy={p.busy}
          aria-describedby="run-ready-why"
          onClick={p.onRun}
        >
          {p.busy ? T.running : n ? T.buttonCount(n) : T.button}
        </button>
      </div>
      <p id="run-ready-why" className="muted" style={{ margin: 0, fontSize: 12 }}>
        {p.ready && n === 0 ? T.noneReady : T.why}
      </p>
      <Note note={p.note} />
    </div>
  );
}

/** The Task board's Run all ready tasks for one change: the ready list, the job and its end. */
export function RunReadyTasks({ change }: { change: string }) {
  const ready = useApi<Api.ReadyTasksT>(`/api/changes/${encodeURIComponent(change)}/tasks/ready`);
  useReloadOnFiles(ready);
  const aiOn = useAiOn();
  const [job, setJob] = useState<string | undefined>();
  const [note, setNote] = useState<NoteT | undefined>();
  const end = async (id: string) => {
    try {
      const j = await api<{ state: string; result?: unknown; errors: string[] }>(`/api/jobs/${id}`);
      if (j.state === "running" || j.state === "queued") return;
      setJob(undefined);
      setNote(
        j.result
          ? {
              ok: !(j.result as Api.RunReadyResultT).stopped,
              text: runReadyWords(j.result as Api.RunReadyResultT),
            }
          : { ok: false, text: j.errors.join("\n") || T.failed },
      );
      ready.reload();
    } catch (e) {
      setJob(undefined);
      setNote({
        ok: false,
        text: e instanceof ApiError ? (e.problem.detail ?? e.problem.title) : String(e),
      });
    }
  };
  useLiveEvents((e) => {
    if (!job) return;
    if (e.type === "job.progress" && e.jobId === job)
      setNote({ ok: true, working: true, text: T.progress(String(e.message ?? "")) });
    if (e.type === "job.done" && e.jobId === job) void end(job);
  });
  if (!aiOn) return null;
  const run = async () => {
    setNote({ ok: true, working: true, text: COPY.app.working });
    try {
      const r = await api<{ jobId: string; tasks: string[] }>(
        `/api/changes/${encodeURIComponent(change)}/tasks/run-ready`,
        {
          method: "POST",
          body: { tasks: ready.state === "ready" ? ready.data.ready : [] },
        },
      );
      setJob(r.jobId);
      // A job that ended before its events reached the page is read once.
      void end(r.jobId);
    } catch (e) {
      setNote({
        ok: false,
        text: e instanceof ApiError ? (e.problem.detail ?? e.problem.title) : String(e),
      });
    }
  };
  return (
    <RunReadyView
      ready={ready.state === "ready" ? ready.data : undefined}
      busy={!!job}
      note={note}
      onRun={() => void run()}
    />
  );
}
