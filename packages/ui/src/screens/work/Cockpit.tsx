import type { Api } from "@maycombhq/core";
import { api, useApi, useReloadOnFiles, type Loaded } from "../../api/client.js";
import { screenOf, tabHref } from "../../app/screens.js";
import { ExternalLink, Panel, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { Note, queryParam, useAction } from "../know/common.js";
import { isManualLink, ManualPr, TaskRunState, taskNext } from "../know/task-pr.js";
import type { Task } from "../Changes.js";
import { kindOfStep, type ChangeRow } from "./next.js";
import { inAppWords } from "../../app/app-words.js";
import { Command, PickAChange } from "./RunNext.js";
import { ChangePicker } from "./Stage.js";
import { hasAction, StepAction } from "./step-action.js";
import { StageThreadPanel } from "./StageThread.js";

/**
 * The change cockpit (WP7.1): one page per change with what a person needs to follow it. Where
 * it is, the next step with its slash command, what blocks it, each stage's progress, the risk,
 * and each repo's change branch and base. It reads; the steps run in the assistant or the CLI.
 */

const C = COPY.cockpit;

type Cockpit = Api.ChangeCockpitT;

/** A tab's address by its id, keeping the change. */
const hrefOf = (id: string, change: string) => {
  const s = screenOf(id);
  return s ? tabHref(s, change) : `#/${id}`;
};

/** Which step of the stage path a stage is: done, the current one, or still to come. */
export function stageMark(s: Cockpit["stages"][number]): "done" | "current" | "todo" {
  if (s.state === "done") return "done";
  if (s.state === "not-started") return "todo";
  return "current";
}

/** The next step's command is a phase's hand-off (`atticus change handoff <change>`). */
export const isHandoffCommand = (command: string): boolean =>
  /^atticus change handoff \S+/.test(command.trim());

/**
 * The cockpit's next step: its in-app action first (seventh UX walk: Raise hand-off, the Task
 * board, Questions, Prepare), then the slash command, and the command under Or in a terminal.
 */
function NextAction({ change, next }: { change: string; next: NonNullable<Cockpit["next"]> }) {
  // Round 42: the brief is written on Feature brief, not a command to copy.
  if (next.step === "brief")
    return (
      <p style={{ margin: 0 }}>
        <a href={`#/brief?change=${encodeURIComponent(change)}`}>{C.writeBrief}</a>
      </p>
    );
  // Sixth UX walk: a hand-off is raised from here too, on the person's click.
  // ADR 0188: a finding that holds the gate is answered on the change's page.
  const kind = isHandoffCommand(next.command)
    ? "handoff"
    : next.step === "finding"
      ? /\bask$/.test(next.command.trim())
        ? "gap"
        : "findings"
      : kindOfStep(next.step);
  const step = { kind, command: next.command, change, pr: next.pr };
  const action = hasAction(step);
  return (
    <>
      {action && <StepAction {...step} />}
      {next.slash && <Command text={next.slash} label={C.copySlash} />}
      {action ? (
        <details className="work-terminal">
          <summary>{COPY.runNext.orTerminal}</summary>
          <Command text={next.command} label={C.copyCommand} noRun />
        </details>
      ) : (
        <Command text={next.command} label={C.copyCommand} />
      )}
    </>
  );
}

/** The next step names a task that is drafted: its PR is the step, and the next task is offered. */
function DraftedTaskNext({
  d,
  onDone,
}: {
  d: NonNullable<ReturnType<typeof taskNext>>;
  onDone?: (() => void) | undefined;
}) {
  const s = d.task.taskRun!.state;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <p className="muted" style={{ margin: 0 }}>
        {s === "built"
          ? C.taskDrafted(d.task.id)
          : s === "unverified"
            ? C.taskUnverified(d.task.id)
            : s === "pr-open"
              ? C.taskPrRaised(d.task.id)
              : C.taskWaiting(d.task.id)}
      </p>
      <TaskRunState change={d.change} task={d.task} {...(onDone ? { onDone } : {})} />
      {d.then ? (
        <>
          <p className="muted" style={{ margin: 0 }}>
            {C.thenTask(d.then.id)}
          </p>
          <Command text={`/atticus-task ${d.change} ${d.then.id}`} label={C.copySlash} />
          <Command text={`atticus task run ${d.change} ${d.then.id}`} label={C.copyCommand} />
        </>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          {C.noOtherTask}
        </p>
      )}
      <p style={{ margin: 0 }}>
        <a href={hrefOf("tasks", d.change)}>{C.openTaskBoard}</a>
      </p>
    </div>
  );
}

/**
 * ADR 0191 (app-only audit): At a glance said what the change waits on but never who. Who it
 * waits on now, by name and role: the next role's reviewers of an open hand-off, else the
 * phase's own role; or that nobody is named for the role yet.
 */
export function WaitsOnLine({ w }: { w: NonNullable<Cockpit["waitsOn"]> }) {
  const R = COPY.roleWork;
  const role = R.roleNames[w.role] ?? w.role;
  return (
    <p style={{ margin: 0 }} className="row" aria-live="polite">
      <strong>
        {w.people.length
          ? R.waitsOn(w.people.map((p) => `@${p}`).join(", "), role)
          : R.waitsOnNobody(role)}
      </strong>
      {w.people.length > 0 && (
        <span className="muted" style={{ marginLeft: 6 }}>
          {w.because === "handoff" ? R.waitsOnReview : R.waitsOnWork}
        </span>
      )}
    </p>
  );
}

export function CockpitView(p: {
  c: Cockpit;
  /** The change's tasks, when the next step names one (sixth UX walk). */
  tasks?: Task[] | undefined;
  onTasks?: () => void;
}) {
  const c = p.c;
  const drafted = taskNext(c.next?.command, p.tasks);
  return (
    <div className="stack">
      <section aria-labelledby="cockpit-where" className="stack" style={{ gap: 6 }}>
        <h3 id="cockpit-where" className="hud">
          {C.where}
        </h3>
        <p style={{ margin: 0 }}>{C.state(c.state, c.risk.level)}</p>
        {c.waitsOn && <WaitsOnLine w={c.waitsOn} />}
        {/* Where the stages' work is when it ran ahead of the gates (ADR 0124 addendum B-change). */}
        {c.work && (
          <p className="muted" style={{ margin: 0 }}>
            {c.work}
          </p>
        )}
        <ol
          className="row"
          style={{ gap: 6, flexWrap: "wrap", listStyle: "none", padding: 0, margin: 0 }}
        >
          {c.stages.map((s) => {
            const mark = stageMark(s);
            return (
              <li key={s.stage}>
                <a
                  className={`chip ${mark === "done" ? "" : mark === "current" ? "warn" : ""}`}
                  href={hrefOf(C.stageScreen[s.stage]!, c.id)}
                  aria-current={mark === "current" ? "step" : undefined}
                >
                  {C.stage(C.stages[s.stage]!, C.marks[mark]!)}
                </a>
                {/* Ninth UX walk: "done2 drafts" ran together; a space keeps them apart. */}
                {(s.drafts > 0 || s.openQuestions > 0) && " "}
                {(s.drafts > 0 || s.openQuestions > 0) && (
                  <span className="muted" style={{ fontSize: 11.5, marginLeft: 4 }}>
                    {C.progress(s.drafts, s.rounds, s.openQuestions)}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </section>

      <section aria-labelledby="cockpit-next" className="stack" style={{ gap: 6 }}>
        <h3 id="cockpit-next" className="hud">
          {C.next}
        </h3>
        <p style={{ margin: 0 }}>{c.nextStep}</p>
        {drafted ? (
          <DraftedTaskNext d={drafted} onDone={p.onTasks} />
        ) : (
          c.next && (
            <>
              <p className="muted" style={{ margin: 0 }}>
                {inAppWords(c.next.why)}
              </p>
              <NextAction change={c.id} next={c.next} />
            </>
          )
        )}
      </section>

      {c.reasons.length > 0 && (
        <section aria-labelledby="cockpit-blocks" className="stack" style={{ gap: 6 }}>
          <h3 id="cockpit-blocks" className="hud">
            {C.blocks}
          </h3>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {c.reasons.map((r) => (
              <li key={`${r.code}-${r.message}`}>{r.message}</li>
            ))}
          </ul>
        </section>
      )}

      {c.openQuestions > 0 && (
        <p style={{ margin: 0 }}>
          <a href={hrefOf("questions", c.id)}>{C.questions(c.openQuestions)}</a>
        </p>
      )}

      <section aria-labelledby="cockpit-repos" className="stack" style={{ gap: 6 }}>
        <h3 id="cockpit-repos" className="hud">
          {C.repos}
        </h3>
        {c.repos.length === 0 ? (
          <OpenWorkspace change={c.id} />
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {c.repos.map((r) => (
              <li key={r.id}>
                <span className="mono">{r.id}</span>: {C.branchOn(r.branch, r.base)}
                {r.pr && !isManualLink(r.pr) && (
                  <>
                    {" · "}
                    <ExternalLink href={r.pr}>{C.pr}</ExternalLink>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {/* Ninth UX walk: one PR a manual Git host leaves to a person is said once, not per repo. */}
        {c.repos.some((r) => r.pr && isManualLink(r.pr)) && (
          <p className="muted" style={{ margin: 0 }}>
            <ManualPr />
          </p>
        )}
      </section>
    </div>
  );
}

/**
 * Eighth UX walk: no repo has the change's branch yet. The app makes them on the person's click
 * (the change's workspace, over the repos it names); the command stays under "Or in a terminal".
 * A change that names no repo says so, with the command.
 */
export function OpenWorkspace({ change, onDone }: { change: string; onDone?: () => void }) {
  const detail = useApi<{ repos: string[] }>(`/api/changes/${encodeURIComponent(change)}`);
  const act = useAction();
  const repos = detail.state === "ready" ? detail.data.repos : [];
  const command = `atticus workspace open ${change} --repos ${repos.length ? repos.join(",") : "<repo>,<repo>"}`;
  return (
    <div className="stack" style={{ gap: 4 }}>
      <p className="muted" style={{ margin: 0 }}>
        {C.noRepos}
      </p>
      <View of={detail}>
        {() =>
          repos.length > 0 ? (
            <>
              <p style={{ margin: 0 }}>
                <button
                  type="button"
                  className="btn primary"
                  disabled={act.busy}
                  onClick={() =>
                    void act.run(
                      () =>
                        api(`/api/changes/${encodeURIComponent(change)}/workspace`, {
                          method: "POST",
                          body: { repos },
                        }).then((r) => {
                          onDone?.();
                          return r;
                        }),
                      C.workspaceOpened,
                    )
                  }
                >
                  {C.openWorkspace(repos.length)}
                </button>
              </p>
              <Note note={act.note} />
              <details className="work-terminal">
                <summary>{COPY.runNext.orTerminal}</summary>
                <Command text={command} label={C.copyCommand} noRun />
              </details>
            </>
          ) : (
            <>
              <p className="muted" style={{ margin: 0 }}>
                {C.noReposToOpen}{" "}
                <a href={`#/architecture?change=${encodeURIComponent(change)}`}>
                  {C.openArchitecture}
                </a>
              </p>
              {/* Ninth UX walk: the command only under Or in a terminal, never the step itself. */}
              <details className="work-terminal">
                <summary>{COPY.runNext.orTerminal}</summary>
                <Command text={command} label={C.copyCommand} noRun />
              </details>
            </>
          )
        }
      </View>
    </div>
  );
}

/** WP7.6: the archived changes nearest this one, each one click from being its example. */
export function PastChangesView(p: {
  r: Api.SimilarChangesT;
  onUse?: (id: string) => void;
  busy?: boolean;
}) {
  const L = C.like;
  return (
    <section aria-label={L.title}>
      <h3>{L.title}</h3>
      <p className="muted">{L.intro}</p>
      {p.r.how === "words" && p.r.note && p.r.changes.length > 0 && (
        <p className="muted">{L.byWords(p.r.note)}</p>
      )}
      {p.r.changes.length === 0 ? (
        <p className="muted">{L.none}</p>
      ) : (
        <ul className="plain">
          {p.r.changes.map((c) => (
            <li key={c.id}>
              <strong>{c.title}</strong>
              {c.archived && <span className="muted"> · {L.archived(c.archived)}</span>}
              {c.summary && <div>{c.summary}</div>}
              {p.onUse && (
                <button
                  type="button"
                  className="btn"
                  disabled={p.busy}
                  onClick={() => p.onUse?.(c.id)}
                >
                  {L.use}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PastChanges({ change }: { change: string }) {
  const r = useApi<Api.SimilarChangesT>(`/api/past-changes?change=${encodeURIComponent(change)}`);
  const act = useAction();
  return (
    <View of={r}>
      {(d) => (
        <>
          <PastChangesView
            r={d}
            busy={act.busy}
            onUse={(id) =>
              void act.run(
                () =>
                  api(`/api/changes/${encodeURIComponent(change)}/like`, {
                    method: "POST",
                    body: { like: id },
                  }),
                C.like.used,
              )
            }
          />
          <Note note={act.note} />
        </>
      )}
    </View>
  );
}

/** Follow this change without being on it (WP7.5): kept in the person's own file. */
export function WatchButton(p: { change: string; watching: boolean; onChanged?: () => void }) {
  const act = useAction();
  return (
    <span className="row" style={{ gap: 6 }}>
      <button
        type="button"
        className="btn"
        aria-pressed={p.watching}
        disabled={act.busy}
        onClick={() =>
          void act.run(
            async () => {
              await api("/api/me/watch", {
                method: "PUT",
                body: { change: p.change, watch: !p.watching },
              });
              p.onChanged?.();
            },
            p.watching ? C.unwatched : C.watched,
          )
        }
      >
        {p.watching ? C.unwatch : C.watch}
      </button>
      <Note note={act.note} />
    </span>
  );
}

/**
 * The page once the list is loaded: the change its address names, picked in All changes; without
 * one (or with one not in the list), say to pick it there.
 */
export function CockpitPicked(p: {
  list: ChangeRow[];
  current: string | undefined;
  c: Loaded<Cockpit>;
}) {
  // Sixth UX walk: a next step that names a task reads the tasks, to see whether it has run.
  const command = p.c.state === "ready" ? p.c.data.next?.command : undefined;
  const tasks = useApi<Task[]>(
    p.current && command?.startsWith("atticus task run ")
      ? `/api/changes/${encodeURIComponent(p.current)}/tasks`
      : undefined,
  );
  useReloadOnFiles(tasks);
  if (!p.current || !p.list.some((x) => x.id === p.current)) return <PickAChange bare />;
  return (
    <>
      <ChangePicker list={p.list} current={p.current} screen="cockpit" />
      <View of={p.c}>
        {(d) => (
          <>
            <CockpitView
              c={d}
              tasks={tasks.state === "ready" ? tasks.data : undefined}
              onTasks={tasks.reload}
            />
            {/* ADR 0189: the first step, and a small change's one step, as conversations too. */}
            <div className="bento" style={{ marginTop: 12 }}>
              {d.next?.command?.startsWith("atticus change small ") ? (
                <StageThreadPanel change={d.id} stage="small" />
              ) : (
                <StageThreadPanel change={d.id} stage="proposal" />
              )}
            </div>
          </>
        )}
      </View>
      <PastChanges change={p.current} />
    </>
  );
}

export function ChangeCockpit({ hash }: { hash: string }) {
  const list = useApi<ChangeRow[]>("/api/changes");
  const current = queryParam(hash, "change");
  const c = useApi<Cockpit>(
    current ? `/api/changes/${encodeURIComponent(current)}/cockpit` : undefined,
  );
  const me = useApi<{ watching?: string[] }>("/api/me");
  useReloadOnFiles(c);
  return (
    <Panel
      title={C.title}
      meta={
        current && me.state === "ready" ? (
          <WatchButton
            change={current}
            watching={(me.data.watching ?? []).includes(current)}
            onChanged={me.reload}
          />
        ) : undefined
      }
    >
      <View of={list} empty={(l) => l.length === 0} emptyText={C.none}>
        {(l) => <CockpitPicked list={l} current={current} c={c} />}
      </View>
    </Panel>
  );
}
