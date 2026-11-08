import { api } from "../../api/client.js";
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

/** The states in which a task has run and its next step is its PR, or its assistant's Done. */
const PAST_THE_RUN = new Set(["built", "unverified", "pr-open", "waiting"]);

/**
 * Review round 42: a built task whose PR wasn't raised (the push or the Git host failed) keeps
 * its build, and its last note, which says why, starts so (packages/taskrun run.ts).
 */
export const isPrNotRaised = (note: string | undefined): boolean =>
  !!note && note.startsWith("The PR wasn't raised:");

/** Whether Run with AI is still the task's step (it never ran, or it stopped). */
export function runIsTheStep(t: Pick<Task, "done" | "taskRun">): boolean {
  return !t.done && !PAST_THE_RUN.has(t.taskRun?.state ?? "");
}

/** Only the runs of tasks (Run with AI), not the critics' and stages' runs. */
export function taskRunsOnly<R extends { agent: string; taskRun?: unknown }>(runs: readonly R[]) {
  return runs.filter((r) => r.agent === "task-runner" || r.taskRun !== undefined);
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
              () =>
                api<Task>(
                  `/api/changes/${encodeURIComponent(p.change)}/tasks/${encodeURIComponent(p.task)}/pr`,
                  { method: "POST", body: {} },
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

/** What a task that has run says under its row: its state, its run, and its next step. */
export function TaskRunState(p: { change: string; task: Task; onDone?: () => void }) {
  const t = p.task;
  const tr = t.taskRun;
  if (!tr || t.done) return null;
  const last = tr.notes.at(-1);
  const notRaised = tr.state === "built" && isPrNotRaised(last);
  const stopped = tr.state === "needs-person" || tr.state === "failed";
  const alert = stopped || notRaised;
  return (
    <div className="stack" style={{ gap: 4, fontSize: 12 }}>
      <span className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <span
          className={`chip ${stopped ? "blocking" : tr.state === "waiting" ? "ai" : tr.state === "unverified" ? "warn" : "done"}`}
        >
          {T.taskState[tr.state] ?? tr.state.toUpperCase()}
        </span>
        {t.run && <a href={`#/runs?run=${encodeURIComponent(t.run)}`}>{T.openItsRun}</a>}
      </span>
      {tr.state === "built" && tr.commit && <span>{T.taskBuilt(tr.branch, tr.commit)}</span>}
      {notRaised && <span>{T.taskPrNotRaised}</span>}
      {tr.state === "built" && <RaiseTaskPr change={p.change} task={t.id} onDone={p.onDone} />}
      {tr.state === "unverified" && (
        <span>{T.taskUnverified(t.repo, tr.branch, `change/${p.change}`)}</span>
      )}
      {tr.state === "pr-open" && tr.pr && (
        <span>
          {T.taskPrOpen} <PrLink pr={tr.pr} />
        </span>
      )}
      {tr.state === "waiting" && <span>{T.taskWaiting}</span>}
      {alert && last && (
        <span role="alert" style={{ color: "var(--magenta-text)" }}>
          {last}
        </span>
      )}
    </div>
  );
}
