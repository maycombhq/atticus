import { useState, type ReactNode } from "react";
import { api, ApiError, useApi, useLiveEvents } from "../../api/client.js";
import { Bar, Panel, Ring, View } from "../../app/ui.js";
import {
  ArtifactEditor,
  FindingActions,
  Pipeline,
  type Artifact,
  type ChangeDetail,
  type Finding,
  type Run,
  type Status,
  type Task,
} from "../Changes.js";
import { Markdown, Note, Table, useAction, useChange, useView } from "./common.js";

const SEV_CHIP: Record<string, string> = {
  blocking: "blocking",
  gap: "warn",
  risk: "warn",
  idea: "dim",
};

/** The change a phase screen works on, its phase, the gate and what to do next. */
function GateHeader(p: {
  id: string;
  title: string;
  picker: ReactNode;
  critic?: string;
  reload: () => void;
}) {
  const detail = useApi<ChangeDetail>(`/api/changes/${p.id}`);
  const status = useApi<Status>(`/api/changes/${p.id}/status`);
  const act = useAction();
  const done = () => {
    detail.reload();
    status.reload();
    p.reload();
  };
  return (
    <>
      <Panel title={p.title} kind="hero" span="span 8" meta={p.picker}>
        <View of={detail}>
          {(d) => (
            <div className="stack" style={{ gap: 14 }}>
              <div className="stack" style={{ gap: 4 }}>
                <span style={{ fontSize: 18, fontWeight: 600 }}>{d.title}</span>
                <span className="hud" style={{ fontSize: 10 }}>
                  {d.id} · {d.type}
                  {d.handoff ? ` · hand-off ${d.handoff.phase} ${d.handoff.state}` : ""}
                </span>
              </div>
              <Pipeline state={d.state} />
            </div>
          )}
        </View>
      </Panel>
      <Panel title="Gate" span="span 4" kind="dark">
        <View of={status}>
          {(s) => (
            <div className="stack" style={{ gap: 10 }}>
              <p style={{ margin: 0, lineHeight: 1.5 }}>{s.nextStep}</p>
              {s.blockers.length > 0 && (
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: "#FF9BCB" }}>
                  {s.blockers.map((b, i) => (
                    <li key={i}>{b.message}</li>
                  ))}
                </ul>
              )}
              {s.required.length > 0 && (
                <span className="muted" style={{ fontSize: 12 }}>
                  Approval: {s.required.map((r) => r.label).join("; ")}
                </span>
              )}
              <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                {p.critic && (
                  <button
                    type="button"
                    className="btn"
                    disabled={act.busy}
                    onClick={() =>
                      void act.run(
                        () =>
                          api(`/api/changes/${p.id}/runs`, {
                            method: "POST",
                            body: { agent: p.critic, runtime: "hand-off" },
                          }).then(done),
                        "The critic's prompts are ready for your assistant. Mark the run done on the Changes screen when it has answered.",
                      )
                    }
                  >
                    Run the critic
                  </button>
                )}
                <button
                  type="button"
                  className="btn primary"
                  disabled={act.busy}
                  onClick={() =>
                    void act.run(
                      () =>
                        api(`/api/changes/${p.id}/handoff`, { method: "POST", body: {} }).then(
                          done,
                        ),
                      "Hand-off PR raised. A person approves and merges it.",
                    )
                  }
                >
                  Raise hand-off
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={act.busy}
                  onClick={() =>
                    void act.run(
                      () =>
                        api(`/api/changes/${p.id}/sync`, { method: "POST", body: {} }).then(done),
                      "Synced with the hand-off PR.",
                    )
                  }
                >
                  Sync
                </button>
              </div>
              <Note note={act.note} />
            </div>
          )}
        </View>
      </Panel>
    </>
  );
}

/** One artifact, rendered; Edit opens the editor in place. */
function ArtifactPanel({
  change,
  artifact,
  span,
}: {
  change: string;
  artifact: string;
  span: string;
}) {
  const a = useApi<Artifact & { artifact: string }>(`/api/changes/${change}/artifacts/${artifact}`);
  const [edit, setEdit] = useState(false);
  if (edit)
    return (
      <ArtifactEditor
        change={change}
        artifact={artifact}
        onClose={() => {
          setEdit(false);
          a.reload();
        }}
      />
    );
  const missing = a.state === "error";
  return (
    <Panel
      title={artifact[0]!.toUpperCase() + artifact.slice(1)}
      span={span}
      meta={
        missing ? undefined : (
          <button type="button" className="btn" onClick={() => setEdit(true)}>
            Edit
          </button>
        )
      }
    >
      {missing ? (
        <div className="state">
          Not written yet for this change. It is drafted when the change reaches this phase, or by
          its agent.
        </div>
      ) : (
        <View of={a}>
          {(d) => (
            <div className="stack" style={{ gap: 6 }}>
              <span className="mono muted" style={{ fontSize: 11 }}>
                {d.path}
              </span>
              <div style={{ maxHeight: 520, overflowY: "auto", paddingRight: 6 }}>
                <Markdown text={d.content} />
              </div>
            </div>
          )}
        </View>
      )}
    </Panel>
  );
}

/** The open findings on the given artifacts, each with its actions. */
function FindingsPanel({
  change,
  artifacts,
  span,
  rows,
}: {
  change: string;
  artifacts: string[];
  span: string;
  rows?: string;
}) {
  const f = useApi<Finding[]>(`/api/findings?change=${change}&state=open`);
  const [open, setOpen] = useState<string | undefined>();
  useLiveEvents((e) => {
    if (e.type === "findings.changed" || e.type === "run.changed") f.reload();
  });
  const mine =
    f.state === "ready"
      ? f.data.filter((x) => artifacts.some((a) => x.artifact.startsWith(a)))
      : [];
  return (
    <Panel
      title="Critic findings"
      span={span}
      {...(rows ? { rows } : {})}
      meta={f.state === "ready" ? `${mine.length} open` : undefined}
    >
      <View
        of={f}
        empty={() => mine.length === 0}
        emptyText="No open findings on this. Run the critic to check it."
      >
        {() => (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }} className="stack">
            {mine.map((x) => (
              <li key={x.id} style={{ borderBottom: "1px solid #18202A", paddingBottom: 8 }}>
                <button
                  type="button"
                  aria-expanded={open === x.id}
                  onClick={() => setOpen(open === x.id ? undefined : x.id)}
                  style={{
                    all: "unset",
                    cursor: "pointer",
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                    width: "100%",
                  }}
                >
                  <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    <span className={`chip ${SEV_CHIP[x.severity] ?? ""}`}>
                      {x.severity.toUpperCase()}
                    </span>
                    {x.lens && <span className="chip ai">{x.lens}</span>}
                    <span className="mono muted" style={{ fontSize: 10.5 }}>
                      {x.artifact}
                    </span>
                  </span>
                  <span style={{ fontSize: 13 }}>{x.summary}</span>
                </button>
                {open === x.id && (
                  <div className="stack" style={{ gap: 8, marginTop: 8 }}>
                    <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
                      {x.why}
                    </p>
                    {x.question && (
                      <p style={{ margin: 0, fontSize: 12.5 }}>
                        Question{x.question.owner ? ` for ${x.question.owner}` : ""}:{" "}
                        {x.question.text}
                      </p>
                    )}
                    <FindingActions change={change} f={x} done={() => f.reload()} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </View>
    </Panel>
  );
}

function NoChange() {
  return (
    <Panel title="No change yet" span="1 / -1">
      <div className="state">
        Start a change on the <a href="#/changes">Changes</a> screen; this screen works on one.
      </div>
    </Panel>
  );
}

/** A phase screen: the change, its gate, its artifacts and their findings, then any extra panels. */
function PhaseScreen(p: {
  hash: string;
  screen: string;
  title: string;
  artifacts: string[];
  critic?: string;
  extra?: (change: string) => ReactNode;
}) {
  const c = useChange(p.hash, p.screen);
  const [tick, setTick] = useState(0);
  if (c.none) return <NoChange />;
  if (!c.id)
    return (
      <div className="bento">
        <Panel title={p.title} span="1 / -1">
          <div className="skeleton" />
        </Panel>
      </div>
    );
  return (
    <div className="bento" key={`${c.id}/${tick}`}>
      <GateHeader
        id={c.id}
        title={p.title}
        picker={c.picker}
        {...(p.critic ? { critic: p.critic } : {})}
        reload={() => setTick(tick + 1)}
      />
      {p.artifacts.map((a) => (
        <ArtifactPanel key={a} change={c.id!} artifact={a} span="span 8" />
      ))}
      <FindingsPanel
        change={c.id}
        artifacts={p.artifacts}
        span="span 4"
        rows={p.artifacts.length > 1 ? `span ${p.artifacts.length}` : undefined}
      />
      {p.extra?.(c.id)}
    </div>
  );
}

// ------------------------------------------------------------------ Define

export function Brief({ hash }: { hash: string }) {
  return (
    <PhaseScreen
      hash={hash}
      screen="brief"
      title="Feature brief"
      artifacts={["brief", "proposal"]}
      critic="business-critic"
    />
  );
}

export function UX({ hash }: { hash: string }) {
  return (
    <PhaseScreen
      hash={hash}
      screen="ux"
      title="Prototypes and UX"
      artifacts={["ux"]}
      critic="ux-critic"
      extra={() => (
        <Panel title="Bring in a prototype" span="span 4">
          <p className="muted" style={{ margin: 0, fontSize: 12.5, lineHeight: 1.6 }}>
            Drop a design export (frames as images or PDF, or a prototype link file) into{" "}
            <span className="mono">inputs/</span> from the <a href="#/intake">Intake</a> screen.
            Atticus reads the screens and states as data, drafts requirements from them into the UX
            artifact, and the UX lens checks loading, empty, error and done states and WCAG 2.1 AA
            contrast.
          </p>
        </Panel>
      )}
    />
  );
}

// ------------------------------------------------------------------ Design

interface Drift {
  change: string;
  plans: { repo: string; feature: string }[];
  findings: { id: string; summary: string; severity: string; state: string; path?: string }[];
}

function DriftPanel({ change }: { change: string }) {
  const d = useView<Drift>("drift", change);
  return (
    <Panel title="Design vs plans vs code" span="span 4">
      <View of={d}>
        {(x) => {
          const open = x.findings.filter((f) => f.state === "open");
          return (
            <div className="stack" style={{ gap: 8 }}>
              <span className="hud" style={{ fontSize: 10 }}>
                {x.plans.length
                  ? `${x.plans.length} repo plans compared`
                  : "No repo plans yet: design compared with code"}
              </span>
              {open.length === 0 ? (
                <span className="chip done" style={{ width: "fit-content" }}>
                  IN SYNC
                </span>
              ) : (
                <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6, fontSize: 12.5 }}>
                  {open.map((f) => (
                    <li key={f.id}>
                      <span className={`chip ${SEV_CHIP[f.severity] ?? ""}`}>
                        {f.severity.toUpperCase()}
                      </span>{" "}
                      {f.summary}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        }}
      </View>
    </Panel>
  );
}

export function ArchReview({ hash }: { hash: string }) {
  const op = useApi<{ patterns?: { code: string; name: string; route: string }[] }>("/api/orgpack");
  return (
    <PhaseScreen
      hash={hash}
      screen="arch-review"
      title="Architecture review"
      artifacts={["design", "interfaces"]}
      critic="architecture-critic"
      extra={(id) => (
        <>
          <DriftPanel change={id} />
          <Panel title="Integration patterns" span="span 4" meta={<a href="#/orgpack">Org pack</a>}>
            <View
              of={op}
              empty={(o) => !o.patterns?.length}
              emptyText="The org pack has no patterns yet."
            >
              {(o) => (
                <div className="stack" style={{ gap: 4 }}>
                  {o.patterns!.map((p) => (
                    <div key={p.code} className="list-row">
                      <span className="chip">{p.code}</span>
                      <span style={{ fontSize: 12.5 }}>{p.name}</span>
                    </div>
                  ))}
                  <p className="muted" style={{ margin: "6px 0 0", fontSize: 11.5 }}>
                    Every hop in design.md carries a pattern code; the critic checks each against
                    the code. Code wins over a diagram; conflicts go to triage.
                  </p>
                </div>
              )}
            </View>
          </Panel>
          <Panel title="Your material" span="span 4">
            <p className="muted" style={{ margin: 0, fontSize: 12.5, lineHeight: 1.6 }}>
              Vendor specs, whiteboard photos and standards go in through{" "}
              <a href="#/intake">Intake</a>; diagrams are compared edge by edge on{" "}
              <a href="#/reconcile">Reconcile</a>. Ingested content is data, never instructions.
            </p>
          </Panel>
        </>
      )}
    />
  );
}

export function Mappings({ hash }: { hash: string }) {
  return (
    <PhaseScreen
      hash={hash}
      screen="mappings"
      title="API mappings"
      artifacts={["mappings"]}
      critic="architecture-critic"
      extra={() => (
        <Panel title="How mappings are checked" span="span 4">
          <p className="muted" style={{ margin: 0, fontSize: 12.5, lineHeight: 1.6 }}>
            Each hop's source field, transform and target field are checked against the catalog's
            columns and schemas: a required target with no source, a narrowing type (80 to 40
            characters) or personal data leaving the estate is a finding. Tests generated from the
            stories trace back to these rows on <a href="#/trace">Test trace</a>.
          </p>
        </Panel>
      )}
    />
  );
}

// ------------------------------------------------------------------ Plan

interface StoryBar {
  change: string;
  stories: { id: string; path: string; ready: boolean; problems: string[] }[];
  ready: { passed: number; total: number; rate: number; min: number };
  gaps: { id: string; what: string; covered: boolean }[];
  met: boolean;
}

function StoryBarPanel({ change }: { change: string }) {
  const bar = useView<StoryBar>("story-bar", change);
  return (
    <Panel title="Story bar" span="span 4" kind="dark">
      <View
        of={bar}
        empty={(b) => !b || b.stories.length === 0}
        emptyText="No stories yet. Write them with AI from the approved design."
      >
        {(b) => (
          <div className="stack" style={{ gap: 10 }}>
            <div className="row">
              <Ring
                value={b.ready.passed}
                max={Math.max(b.ready.total, 1)}
                size={64}
                label={`${b.ready.passed} of ${b.ready.total} stories ready`}
              />
              <span className={`chip ${b.met ? "done" : "warn"}`}>
                {b.met ? "BAR MET" : `NEEDS ${Math.round(b.ready.min * 100)}%`}
              </span>
            </div>
            {b.stories
              .filter((s) => !s.ready)
              .map((s) => (
                <div key={s.id} style={{ fontSize: 12.5 }}>
                  <span className="mono">{s.id}</span>: {s.problems.join("; ")}
                </div>
              ))}
            {b.gaps
              .filter((g) => !g.covered)
              .map((g) => (
                <div key={g.id} style={{ fontSize: 12.5, color: "#FFD18A" }}>
                  No story covers: {g.what}
                </div>
              ))}
          </div>
        )}
      </View>
    </Panel>
  );
}

function StoryWriter({ change }: { change: string }) {
  const act = useAction();
  return (
    <Panel title="Stories and tasks" span="span 4">
      <div className="stack" style={{ gap: 8 }}>
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
          The story writer drafts stories, acceptance criteria and repo tasks from the approved
          design. You edit them before the plan gate.
        </p>
        <button
          type="button"
          className="btn primary"
          disabled={act.busy}
          onClick={() =>
            void act.run(
              () =>
                api(`/api/changes/${change}/runs`, {
                  method: "POST",
                  body: { agent: "story-writer", runtime: "hand-off" },
                }),
              "The story writer's prompt is ready for your assistant.",
            )
          }
        >
          Write stories with AI
        </button>
        <Note note={act.note} />
      </div>
    </Panel>
  );
}

export function Breakdown({ hash }: { hash: string }) {
  return (
    <PhaseScreen
      hash={hash}
      screen="breakdown"
      title="Breakdown"
      artifacts={["stories", "tasks"]}
      critic="story-critic"
      extra={(id) => (
        <>
          <StoryBarPanel change={id} />
          <StoryWriter change={id} />
          <TasksByRepo change={id} span="span 4" compact />
        </>
      )}
    />
  );
}

// ------------------------------------------------------------------ Build

function TasksByRepo({
  change,
  span,
  compact,
}: {
  change: string;
  span: string;
  compact?: boolean;
}) {
  const tasks = useApi<Task[]>(`/api/changes/${change}/tasks`);
  const [ran, setRan] = useState<Record<string, string>>({});
  const run = async (t: Task) => {
    try {
      const r = await api<Run>(`/api/changes/${change}/runs`, {
        method: "POST",
        body: { agent: "task-runner", task: t.id, runtime: "hand-off" },
      });
      setRan({ ...ran, [t.id]: `Run ${r.runId} prepared: your assistant takes it from here.` });
    } catch (e) {
      setRan({
        ...ran,
        [t.id]: e instanceof ApiError ? (e.problem.detail ?? e.problem.title) : String(e),
      });
    }
  };
  return (
    <Panel
      title={compact ? "Hand-down preview" : "Tasks by repo"}
      span={span}
      meta={tasks.state === "ready" ? `${tasks.data.length} tasks` : undefined}
    >
      <View
        of={tasks}
        empty={(t) => t.length === 0}
        emptyText="No tasks yet: they come from tasks.md once the stories are written."
      >
        {(t) => {
          const repos = [...new Set(t.map((x) => x.repo))].sort();
          return (
            <div className="stack" style={{ gap: 12 }}>
              {repos.map((r) => {
                const mine = t.filter((x) => x.repo === r);
                const done = mine.filter((x) => x.done).length;
                return (
                  <div key={r} className="stack" style={{ gap: 6 }}>
                    <div className="row between">
                      <span className="mono" style={{ fontSize: 12.5 }}>
                        {r}
                      </span>
                      <span className="hud" style={{ fontSize: 10 }}>
                        {done}/{mine.length} done
                      </span>
                    </div>
                    <Bar
                      value={done}
                      max={mine.length}
                      label={`${r}: ${done} of ${mine.length} tasks done`}
                    />
                    {!compact &&
                      mine.map((x) => (
                        <div
                          key={x.id}
                          className="stack"
                          style={{
                            gap: 4,
                            padding: "6px 0 6px 10px",
                            borderLeft: `2px solid ${x.done ? "var(--green)" : "var(--line-2)"}`,
                          }}
                        >
                          <div className="row between" style={{ alignItems: "flex-start" }}>
                            <span style={{ fontSize: 13 }}>
                              <span className="mono muted">{x.id}</span> {x.description}
                            </span>
                            {x.done ? (
                              <span className="chip done">DONE</span>
                            ) : (
                              <button type="button" className="btn" onClick={() => void run(x)}>
                                Run with AI
                              </button>
                            )}
                          </div>
                          <span className="mono muted" style={{ fontSize: 10.5 }}>
                            {x.branch}
                            {x.story ? ` · story ${x.story}` : ""}
                          </span>
                          {ran[x.id] && (
                            <span role="status" style={{ fontSize: 12 }}>
                              {ran[x.id]}
                            </span>
                          )}
                        </div>
                      ))}
                  </div>
                );
              })}
            </div>
          );
        }}
      </View>
    </Panel>
  );
}

function RunsPanel({ change }: { change: string }) {
  const runs = useApi<Run[]>(`/api/changes/${change}/runs`);
  useLiveEvents((e) => {
    if (e.type === "run.changed") runs.reload();
  });
  const passed =
    runs.state === "ready" ? runs.data.filter((r) => r.state === "validated").length : 0;
  return (
    <Panel title="AI task runs" span="span 4" kind="dark">
      <View of={runs} empty={(r) => r.length === 0} emptyText="No runs yet.">
        {(r) => (
          <div className="stack" style={{ gap: 8 }}>
            <div className="row">
              <Ring
                value={passed}
                max={r.length}
                size={60}
                label={`${passed} of ${r.length} runs finished`}
              />
              <span className="muted" style={{ fontSize: 12 }}>
                Every write is approved by a person; AI never pushes to protected branches.
              </span>
            </div>
            {r.slice(-8).map((x) => (
              <div key={x.runId} className="list-row">
                <span className="stack" style={{ gap: 2 }}>
                  <span className="mono" style={{ fontSize: 11.5 }}>
                    {x.runId}
                  </span>
                  <span className="hud" style={{ fontSize: 9.5 }}>
                    {x.agent} · {x.runtime}
                  </span>
                </span>
                <span
                  className={`chip ${x.errors.length ? "blocking" : x.state === "validated" ? "done" : x.state === "failed" ? "blocking" : ""}`}
                >
                  {x.state.toUpperCase()}
                </span>
              </div>
            ))}
          </div>
        )}
      </View>
    </Panel>
  );
}

export function Tasks({ hash }: { hash: string }) {
  const c = useChange(hash, "tasks");
  if (c.none) return <NoChange />;
  if (!c.id) return null;
  return (
    <div className="bento" key={c.id}>
      <Panel title="Task board" span="1 / -1" meta={c.picker}>
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
          Tasks in cross-repo order. Run a ready task with AI: Atticus hands the Spec Kit feature
          down to the repo, prepares the prompt for your assistant and reads the result back at the
          PR.
        </p>
      </Panel>
      <TasksByRepo change={c.id} span="span 8" />
      <div className="stack" style={{ gridColumn: "span 4", gap: 16 }}>
        <RunsPanel change={c.id} />
        <DriftPanel change={c.id} />
      </div>
    </div>
  );
}

interface Trace {
  change: string;
  requirements: {
    file: string;
    line: number;
    requirement: string;
    scenario?: string;
    key: string;
  }[];
  rows: {
    requirement: string;
    story?: string;
    criterion?: string;
    tests: string[];
    code: string[];
    records: string[];
    features: string[];
  }[];
  gaps: { kind: string; subject: string; summary: string }[];
}

export function TestTrace({ hash }: { hash: string }) {
  const c = useChange(hash, "trace");
  const t = useView<Trace>("trace", c.id, !c.id);
  const status = useApi<Status & { tests?: { required: string[]; note?: string } }>(
    c.id ? `/api/changes/${c.id}/status` : undefined,
  );
  if (c.none) return <NoChange />;
  const covered = t.state === "ready" ? t.data.rows.filter((r) => r.tests.length > 0).length : 0;
  const total = t.state === "ready" ? t.data.rows.length : 0;
  return (
    <div className="bento">
      <Panel title="Test trace" span="span 8" kind="hero" meta={c.picker}>
        <p className="muted" style={{ margin: "0 0 12px", fontSize: 12.5 }}>
          Every requirement should reach a story, a test, code and a release. Gaps are flagged
          before QA sign-off.
        </p>
        <View
          of={t}
          empty={(d) => d.rows.length === 0}
          emptyText="Nothing to trace yet: the change has no requirements with scenarios."
        >
          {(d) => (
            <Table
              caption="Requirement to code"
              rows={d.rows}
              rowKey={(r) => `${r.requirement}/${r.story ?? ""}/${r.criterion ?? ""}`}
              cols={[
                { label: "Requirement", cell: (r) => r.requirement },
                {
                  label: "Story",
                  cell: (r) => r.story ?? <span className="chip warn">NO STORY</span>,
                  mono: true,
                },
                {
                  label: "Test",
                  cell: (r) =>
                    r.tests.length ? (
                      r.tests.join(", ")
                    ) : (
                      <span className="chip blocking">NO TEST</span>
                    ),
                  mono: true,
                },
                { label: "Code", cell: (r) => r.code.slice(0, 3).join(", "), mono: true },
              ]}
            />
          )}
        </View>
      </Panel>
      <Panel title="Scenario coverage" span="span 4" kind="dark">
        <View of={t}>
          {(d) => (
            <div className="stack" style={{ gap: 10 }}>
              <div className="row">
                <Ring
                  value={covered}
                  max={Math.max(total, 1)}
                  size={72}
                  label={`${covered} of ${total} rows have a test`}
                  text={total ? `${Math.round((covered / total) * 100)}%` : "–"}
                />
                <span className="muted" style={{ fontSize: 12.5 }}>
                  {covered} of {total} traced to a test
                </span>
              </div>
              {d.gaps.length > 0 && (
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.6 }}>
                  {d.gaps.map((g, i) => (
                    <li key={i}>
                      <span className="chip warn">{g.kind}</span> {g.summary}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </View>
      </Panel>
      <Panel title="Test kinds this change needs" span="span 4">
        <View
          of={status}
          empty={(s) => !s.tests?.required?.length}
          emptyText="The test strategy asks for nothing extra here."
        >
          {(s) => (
            <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
              {s.tests!.required.map((k) => (
                <span key={String(k)} className="chip">
                  {String(k).toUpperCase()}
                </span>
              ))}
              {s.tests!.note && (
                <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                  {s.tests!.note}
                </p>
              )}
            </div>
          )}
        </View>
        <p className="muted" style={{ margin: "10px 0 0", fontSize: 11.5 }}>
          Required kinds come from the change type and risk in the org pack's test strategy. Tests
          are generated from story scenarios, then reviewed by a person.
        </p>
      </Panel>
    </div>
  );
}
