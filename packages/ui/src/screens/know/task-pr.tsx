import { useState } from "react";
import { api, ApiError } from "../../api/client.js";
import { confirmed } from "../../api/confirm.js";
import { ExternalLink } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import type { Task } from "../Changes.js";
import { Note, useAction } from "./common.js";

/**
 * Sixth UX walk: a task's step after its draft. The Task board and At a glance say where each
 * task's Run with AI stands (its task-run.yaml, API 2.69.0), and a drafted task's PR is raised
 * on the person's click, as Raise hand-off is: never automatically, and the AI step isn't run
 * again.
 */

const T = COPY.phase;

/** Where Home lists the steps a manual Git host leaves for a person. */
export const MANUAL_STEPS_HREF = "#/todo";

/** A manual Git host's link to a PR no person has opened yet (manual:// until one records it). */
export const isManualLink = (url: string | undefined): boolean =>
  !!url && /^manual:\/\//i.test(url.trim());

/**
 * The states in which a task has run and its next step is its PR, or its assistant's Done.
 * App-only audit: an unverified task (drafted, never built) may also Run again, beside Build and
 * raise PR, so it isn't one of them.
 */
const PAST_THE_RUN = new Set(["built", "pr-open", "waiting"]);

/**
 * Review round 42: a built task whose PR wasn't raised (the push or the Git host failed) keeps
 * its build, and its last note, which says why, starts so (packages/taskrun run.ts).
 */
export const isPrNotRaised = (note: string | undefined): boolean =>
  !!note && note.startsWith("The PR wasn't raised:");

/**
 * Review round 43: the task's PR as the Git host says it now (API 2.70.0), merged or closed;
 * undefined while it is open, or when the host couldn't say (the record's PR open stands).
 */
export function prSettled(t: Pick<Task, "taskRun">): "merged" | "closed" | undefined {
  const s = t.taskRun?.state === "pr-open" ? t.taskRun.pr?.state : undefined;
  return s === "merged" || s === "closed" ? s : undefined;
}

/**
 * Whether Run with AI is still the task's step: it never ran, it stopped, or (review round 43)
 * its PR was merged or closed on the Git host, which no longer holds the task.
 */
export function runIsTheStep(t: Pick<Task, "done" | "taskRun">): boolean {
  return !t.done && (!PAST_THE_RUN.has(t.taskRun?.state ?? "") || !!prSettled(t));
}

/** Only the runs of tasks (Run with AI), not the critics' and stages' runs. */
export function taskRunsOnly<R extends { agent: string; taskRun?: unknown }>(runs: readonly R[]) {
  return runs.filter((r) => r.agent === "task-runner" || r.taskRun !== undefined);
}

/**
 * Ninth UX walk: the AI task runs, with each run a task names as its latest (a task with the
 * assistant waits on a run the run list may not mark as a task's yet): "No task has run with AI
 * yet" was said while task 1.1 was with the assistant.
 */
export function taskRunsShown<R extends { runId: string; agent: string; taskRun?: unknown }>(
  runs: readonly R[],
  tasks: readonly { run?: string | undefined }[] | undefined,
) {
  const named = new Set((tasks ?? []).map((t) => t.run).filter(Boolean));
  return runs.filter(
    (r) => r.agent === "task-runner" || r.taskRun !== undefined || named.has(r.runId),
  );
}

/**
 * At a glance's next step when it names a task (`atticus task run <change> <task>`) that has run
 * already: drafted and waiting for its PR, its PR raised, or with the assistant. Then the task's
 * step is said, and the first task not run yet is offered beside it. Undefined otherwise.
 */
export function taskNext(
  command: string | undefined,
  tasks: readonly Task[] | undefined,
): { change: string; task: Task; then?: Task } | undefined {
  const m = command ? /^atticus task run (\S+) (\S+)$/.exec(command.trim()) : null;
  if (!m || !tasks) return undefined;
  const task = tasks.find((x) => x.id === m[2]);
  if (!task || runIsTheStep(task)) return undefined;
  const then = tasks.find((x) => x !== task && runIsTheStep(x));
  return { change: m[1]!, task, ...(then ? { then } : {}) };
}

/** A manual Git host's PR: opening it is a step waiting on the person, on Home. */
export function ManualPr() {
  return (
    <span>
      {T.manualPrWaits} <a href={MANUAL_STEPS_HREF}>{T.manualSteps}</a>.
    </span>
  );
}

/** A hand-off whose PR a manual Git host leaves for a person to open: where that step waits. */
export function ManualHandoff({ phase }: { phase: string }) {
  return (
    <>
      {T.handOffWaitsManual(phase)} <a href={MANUAL_STEPS_HREF}>{T.manualSteps}</a>
    </>
  );
}

/**
 * App-only audit (API 3.3.0): the open hand-off's branch wasn't pushed (a hook, the proxy, the
 * host) and is kept here: said, with Push again, whose click is the person's confirmation (ADR
 * 0186) to push it by name, never forced. What git says when it fails is said.
 */
export function PushAgain(p: { change: string; branch: string; onDone?: () => void }) {
  const act = useAction();
  return (
    <div className="stack" style={{ gap: 4, fontSize: 12 }}>
      <span role="note">{T.handoffUnpushed(p.branch)}</span>
      <span className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <button
          type="button"
          className="btn"
          disabled={act.busy}
          onClick={() =>
            void act.run(
              async () =>
                api<{ notes?: string[] }>(
                  `/api/changes/${encodeURIComponent(p.change)}/handoff/push`,
                  { method: "POST", body: await confirmed("handoff", p.change) },
                ).finally(() => p.onDone?.()),
              (r) => (r.notes ?? []).join(" ") || T.handoffPushed(p.branch),
            )
          }
        >
          {act.busy ? T.pushingAgain : T.pushAgain}
        </button>
        <span className="muted">{T.pushAgainWhy}</span>
      </span>
      <Note note={act.note} />
    </div>
  );
}

/** A PR's link, or, on a manual Git host before anyone opened it, where its step waits. */
export function PrLink({ pr }: { pr: { number: number; url: string } }) {
  return isManualLink(pr.url) ? (
    <ManualPr />
  ) : (
    <ExternalLink href={pr.url}>{T.taskPrNumber(pr.number)}</ExternalLink>
  );
}

/** Raise the task's PR: the person's click is the approval to push its branch and open the PR. */
export function RaiseTaskPr(p: { change: string; task: string; onDone?: () => void }) {
  const act = useAction();
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <button
          type="button"
          className="btn primary"
          disabled={act.busy}
          onClick={() =>
            void act.run(
              // A PR that wasn't raised (422) still changed the task's note: the board reloads
              // either way, and offers Raise again with why.
              // ADR 0186: the click is the person's confirmation to push and open the PR.
              async () =>
                api<Task>(
                  `/api/changes/${encodeURIComponent(p.change)}/tasks/${encodeURIComponent(p.task)}/pr`,
                  { method: "POST", body: await confirmed("task-pr", `${p.change}/${p.task}`) },
                ).finally(() => p.onDone?.()),
              (r) =>
                isManualLink(r.taskRun?.pr?.url) ? T.taskPrManual(p.task) : T.taskPrRaised(p.task),
            )
          }
        >
          {act.busy ? T.raisingTaskPr : T.raiseTaskPr}
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          {T.raiseTaskPrWhy}
        </span>
      </div>
      <Note note={act.note} />
    </div>
  );
}

/**
 * App-only audit (API 3.3.0): Build and raise PR on a task drafted but never built (UNVERIFIED),
 * or one a person took over: Atticus builds it where it is with its repo's build command as it is
 * now, and the person's click is the approval (ADR 0186) to push its branch and open its PR.
 */
export function BuildAndRaise(p: { change: string; task: string; onDone?: () => void }) {
  const act = useAction();
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <button
          type="button"
          className="btn primary"
          disabled={act.busy}
          onClick={() =>
            void act.run(
              async () =>
                api<Task>(
                  `/api/changes/${encodeURIComponent(p.change)}/tasks/${encodeURIComponent(p.task)}/build`,
                  {
                    method: "POST",
                    body: {
                      raise: true,
                      ...(await confirmed("task-pr", `${p.change}/${p.task}`)),
                    },
                  },
                ).finally(() => p.onDone?.()),
              (r) =>
                r.taskRun?.state === "pr-open"
                  ? isManualLink(r.taskRun.pr?.url)
                    ? T.taskPrManual(p.task)
                    : T.taskBuiltAndRaised(p.task)
                  : T.taskBuiltOnly(p.task),
            )
          }
        >
          {act.busy ? T.buildingTask : T.buildAndRaise}
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          {T.buildAndRaiseWhy}
        </span>
      </div>
      <Note note={act.note} />
    </div>
  );
}

/**
 * Seventh UX walk (API 2.72.0): tick or untick the task in tasks.md, on the person's click (a
 * local edit to the change's files, which rides its build hand-off). A task Atticus ticked because
 * its PR merged says so. App-only audit (3.3.0): a task whose branch has commits the change branch
 * hasn't says so, and is marked done only with the person's reason (the server asks for it, 409).
 */
export function TaskTick(p: {
  change: string;
  task: Pick<Task, "id" | "done" | "taskRun" | "unmerged" | "decision">;
  onDone?: () => void;
}) {
  const act = useAction();
  const t = p.task;
  const done = t.done;
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [missing, setMissing] = useState(false);
  const reasonId = `task-${t.id.replace(/[^a-z0-9]/gi, "-")}-reason`;
  const tick = (body: { done: boolean; reason?: string }) =>
    void act.run(
      () =>
        api<Task>(
          `/api/changes/${encodeURIComponent(p.change)}/tasks/${encodeURIComponent(t.id)}/done`,
          { method: "POST", body },
        )
          .then((r) => {
            setAsking(false);
            return r;
          })
          .catch((e: unknown) => {
            // The server asks for the reason: the form says why, and takes it.
            if (e instanceof ApiError && e.problem.status === 409) setAsking(true);
            throw e;
          })
          .finally(() => p.onDone?.()),
      (r) => (r.done ? T.tickedTask(t.id) : T.untickedTask(t.id)),
    );
  // Eighth UX walk: who ticked it last, a person by hand or Atticus at the PR's merge.
  const marked = t.taskRun?.marked;
  const byHand = marked && marked.done === done ? marked : undefined;
  return (
    <div className="stack" style={{ gap: 4, fontSize: 12 }}>
      {byHand ? (
        <span>
          {byHand.done
            ? T.markedDoneBy(byHand.by, byHand.at.slice(0, 10))
            : T.markedNotDoneBy(byHand.by, byHand.at.slice(0, 10))}
        </span>
      ) : (
        done && t.taskRun?.ticked && <span>{T.tickedByMerge}</span>
      )}
      {t.decision && (
        <span>{T.taskDecided(t.decision.by, t.decision.at.slice(0, 10), t.decision.reason)}</span>
      )}
      {!done && t.unmerged && (
        <span role="note" style={{ color: "var(--magenta-text)" }}>
          {T.taskUnmerged(t.unmerged.branch, t.unmerged.commits, `change/${p.change}`)}
        </span>
      )}
      <span className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <button
          type="button"
          className="btn"
          disabled={act.busy}
          aria-label={done ? T.untickTaskLabel(t.id) : T.tickTaskLabel(t.id)}
          onClick={() => {
            if (!done && t.unmerged) setAsking(true);
            else tick({ done: !done });
          }}
        >
          {done ? T.untickTask : T.tickTask}
        </button>
      </span>
      {asking && !done && (
        <form
          className="stack"
          style={{ gap: 4 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!reason.trim()) {
              setMissing(true);
              return;
            }
            setMissing(false);
            tick({ done: true, reason: reason.trim() });
          }}
        >
          <label htmlFor={reasonId}>{T.markDoneReason}</label>
          <textarea
            id={reasonId}
            rows={2}
            value={reason}
            aria-describedby={`${reasonId}-help`}
            aria-invalid={missing || undefined}
            onChange={(e) => setReason(e.target.value)}
          />
          <span id={`${reasonId}-help`} className="muted">
            {missing ? T.markDoneNeedsReason : T.markDoneReasonHelp}
          </span>
          <span className="row" style={{ gap: 6 }}>
            <button type="submit" className="btn" disabled={act.busy}>
              {T.markDoneAnyway}
            </button>
          </span>
        </form>
      )}
      <Note note={act.note} />
    </div>
  );
}

/** What a task that has run says under its row: its state, its run, and its next step. */
export function TaskRunState(p: { change: string; task: Task; onDone?: () => void }) {
  const t = p.task;
  const tr = t.taskRun;
  if (!tr || t.done) return null;
  const last = tr.notes.at(-1);
  const notRaised = tr.state === "built" && isPrNotRaised(last);
  const stopped = tr.state === "needs-person" || tr.state === "failed";
  const settled = prSettled(t);
  const alert = stopped || notRaised;
  // Eighth UX walk: a PR the person records is open, by its number; one a manual Git host left
  // for a person to open waits on them, said once.
  const pr = tr.state === "pr-open" && !settled ? tr.pr : undefined;
  const toOpen = !!pr && isManualLink(pr.url);
  const chip =
    (settled && T.taskPrStateChip[settled]) ??
    (pr ? (toOpen ? T.taskPrToOpen : T.taskPrOpenChip(pr.number)) : undefined) ??
    T.taskState[tr.state] ??
    tr.state.toUpperCase();
  return (
    <div className="stack" style={{ gap: 4, fontSize: 12 }}>
      <span className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <span
          className={`chip ${stopped ? "blocking" : tr.state === "waiting" || toOpen ? "ai" : tr.state === "unverified" || settled === "closed" ? "warn" : "done"}`}
        >
          {chip}
        </span>
        {t.run && <a href={`#/runs?run=${encodeURIComponent(t.run)}`}>{T.openItsRun}</a>}
      </span>
      {tr.state === "built" && tr.commit && <span>{T.taskBuilt(tr.branch, tr.commit)}</span>}
      {notRaised && <span>{T.taskPrNotRaised}</span>}
      {/* Review round 43: nothing committed is nothing to raise. */}
      {tr.state === "built" && tr.commit && (
        <RaiseTaskPr change={p.change} task={t.id} onDone={p.onDone} />
      )}
      {/* App-only audit: said from the state now (a build command set since), never stale. */}
      {tr.state === "unverified" && (
        <span>
          {t.repoBuilds
            ? T.taskUnverifiedBuildable(t.repo, tr.branch)
            : T.taskUnverified(t.repo, tr.branch, `change/${p.change}`)}
        </span>
      )}
      {tr.state === "needs-person" && t.repoBuilds && tr.commit && (
        <span>{T.taskNeedsPersonBuild(tr.branch)}</span>
      )}
      {(tr.state === "unverified" || (tr.state === "needs-person" && !!tr.commit)) &&
        t.repoBuilds && <BuildAndRaise change={p.change} task={t.id} onDone={p.onDone} />}
      {tr.state === "pr-open" &&
        tr.pr &&
        (toOpen ? (
          <span>
            {T.taskPrWaitsOnYou} <a href={MANUAL_STEPS_HREF}>{T.manualSteps}</a>.
          </span>
        ) : (
          <span>
            {settled === "merged"
              ? T.taskPrMerged
              : settled === "closed"
                ? T.taskPrClosed
                : T.taskPrOpen}{" "}
            <PrLink pr={tr.pr} />
          </span>
        ))}
      {tr.state === "waiting" && <span>{T.taskWaiting}</span>}
      {alert && last && (
        <span role="alert" style={{ color: "var(--magenta-text)" }}>
          {last}
        </span>
      )}
    </div>
  );
}
