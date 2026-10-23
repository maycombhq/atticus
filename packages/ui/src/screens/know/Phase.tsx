import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError, useApi, useLiveEvents } from "../../api/client.js";
import { Bar, Donut, ExternalLink, Panel, Ring, View } from "../../app/ui.js";
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
import { AI_OFF_TEXT, useAiOn } from "../../app/me.js";
import { COPY } from "../../copy.js";
import { withForceHint } from "../run/shared.js";
import { NoChangeYet } from "../work/RunNext.js";
import { ChangeWaiting, Markdown, Note, Table, useAction, useChange, useView } from "./common.js";

const T = COPY.phase;

const SEV_CHIP: Record<string, string> = {
  blocking: "blocking",
  gap: "warn",
  risk: "warn",
  idea: "dim",
};

/** The change a phase screen works on, its phase, the gate and what to do next. */
function GateHeader(p: {
  part: "hero" | "gate";
  id: string;
  title: string;
  picker: ReactNode;
  critic?: string;
  reload: () => void;
}) {
  const detail = useApi<ChangeDetail>(`/api/changes/${p.id}`);
  const status = useApi<Status>(`/api/changes/${p.id}/status`);
  const act = useAction();
  const aiOn = useAiOn();
  const done = () => {
    detail.reload();
    status.reload();
    p.reload();
  };
  const hero = (
    <Panel title={p.title} kind="hero" meta={p.picker}>
      <View of={detail}>
        {(d) => (
          <div className="stack" style={{ gap: 14 }}>
            <div className="stack" style={{ gap: 4 }}>
              <span style={{ fontSize: 18, fontWeight: 600 }}>{d.title}</span>
              <span className="hud" style={{ fontSize: 10 }}>
                {d.id} · {d.type}
                {d.handoff ? T.handOff(d.handoff.phase, d.handoff.state) : ""}
              </span>
            </div>
            <Pipeline state={d.state} />
          </div>
        )}
      </View>
    </Panel>
  );
  const gate = (
    <Panel title={T.gate} kind="dark">
      <View of={status}>
        {(s) => (
          <div className="stack" style={{ gap: 10 }}>
            <p style={{ margin: 0, lineHeight: 1.5 }}>{s.nextStep}</p>
            {s.blockers.length > 0 && (
              <ul
                style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: "var(--magenta-text)" }}
              >
                {s.blockers.map((b, i) => (
                  <li key={i}>{b.message}</li>
                ))}
              </ul>
            )}
            {s.handoff ? (
              <span className="muted" style={{ fontSize: 12 }}>
                {T.approvalMerge}
                <ExternalLink href={s.handoff.pr.url}>
                  {T.pr(s.handoff.pr.number)}
                </ExternalLink>{" "}
                {T.onTheGitHost}
              </span>
            ) : (
              <span className="muted" style={{ fontSize: 12 }}>
                {T.approvalRaiseTheHand}
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
                        api(`/api/changes/${p.id}/critic`, { method: "POST", body: {} }).then(done),
                      aiOn ? T.theRuleChecksRan : T.theRuleChecksRan2,
                    )
                  }
                >
                  {aiOn ? T.runTheCritic : T.runTheRuleChecks}
                </button>
              )}
              <button
                type="button"
                className="btn primary"
                disabled={act.busy}
                onClick={() =>
                  void act.run(
                    () =>
                      api(`/api/changes/${p.id}/handoff`, { method: "POST", body: {} }).then(done),
                    T.handOffPrRaised,
                  )
                }
              >
                {T.raiseHandOff}
              </button>
              <button
                type="button"
                className="btn"
                disabled={act.busy}
                onClick={() =>
                  void act.run(
                    () => api(`/api/changes/${p.id}/sync`, { method: "POST", body: {} }).then(done),
                    T.syncedWithTheHand,
                  )
                }
              >
                {T.syncAndMergeWhen}
              </button>
            </div>
            <Note note={act.note} />
          </div>
        )}
      </View>
    </Panel>
  );
  return p.part === "hero" ? hero : gate;
}

/** One artifact, rendered; Edit opens the editor in place. */
function ArtifactPanel({
  change,
  artifact,
  span,
}: {
  change: string;
  artifact: string;
  span?: string;
}) {
  const a = useApi<Artifact & { artifact: string }>(`/api/changes/${change}/artifacts/${artifact}`);
  const [edit, setEdit] = useState(false);
  // Closing the editor puts the keyboard back on Edit, which comes back with the panel.
  const editBtn = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (!edit && wasEditing.current) editBtn.current?.focus();
    wasEditing.current = edit;
  }, [edit]);
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
          <button ref={editBtn} type="button" className="btn" onClick={() => setEdit(true)}>
            {T.edit}
          </button>
        )
      }
    >
      {missing ? (
        <div className="state">{T.notWrittenYetFor}</div>
      ) : (
        <View of={a}>
          {(d) => (
            <div className="stack" style={{ gap: 6 }}>
              <span className="mono muted" style={{ fontSize: 11 }}>
                {d.path}
              </span>
              <div
                tabIndex={0}
                role="region"
                aria-label={T.text(artifact)}
                style={{ maxHeight: 520, overflowY: "auto", paddingRight: 6 }}
              >
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
  tick = 0,
}: {
  change: string;
  artifacts: string[];
  span?: string;
  rows?: string;
  /** Bumped when the gate ran something; the findings reload. */
  tick?: number;
}) {
  const f = useApi<Finding[]>(`/api/findings?change=${change}&state=open`);
  const [open, setOpen] = useState<string | undefined>();
  useLiveEvents((e) => {
    if (e.type === "file.changed" || e.type === "run.changed") f.reload();
  });
  useEffect(() => {
    if (tick) f.reload();
  }, [tick]);
  const mine =
    f.state === "ready"
      ? f.data.filter((x) => artifacts.some((a) => x.artifact.startsWith(a)))
      : [];
  return (
    <Panel
      title={T.criticFindings}
      span={span}
      {...(rows ? { rows } : {})}
      meta={f.state === "ready" ? T.open(mine.length) : undefined}
    >
      <View of={f} empty={() => mine.length === 0} emptyText={T.noOpenFindingsOn}>
        {() => (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }} className="stack">
            {mine.map((x) => (
              <li key={x.id} style={{ borderBottom: "1px solid var(--rule)", paddingBottom: 8 }}>
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
                        {T.question(
                          x.question.owner ? T.for(x.question.owner) : "",
                          x.question.text,
                        )}
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
    <div className="bento">
      <NoChangeYet />
    </div>
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
  /** Panels for the wide column, between the header and the artifacts. */
  main?: (change: string) => ReactNode;
}) {
  const c = useChange(p.hash, p.screen);
  const [tick, setTick] = useState(0);
  if (c.none) return <NoChange />;
  if (!c.id) return <ChangeWaiting list={c.list} title={p.title} />;
  const header = {
    id: c.id,
    title: p.title,
    picker: c.picker,
    ...(p.critic ? { critic: p.critic } : {}),
    reload: () => setTick(tick + 1),
  };
  return (
    <div className="bento" key={c.id}>
      <div className="column" style={{ gridColumn: "span 8" }}>
        <GateHeader part="hero" {...header} />
        {p.main?.(c.id)}
        {p.artifacts.map((a) => (
          <ArtifactPanel key={a} change={c.id!} artifact={a} />
        ))}
      </div>
      <div className="column" style={{ gridColumn: "span 4" }}>
        <GateHeader part="gate" {...header} />
        <FindingsPanel change={c.id} artifacts={p.artifacts} tick={tick} />
        {p.extra?.(c.id)}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Define

export function Brief({ hash }: { hash: string }) {
  return (
    <PhaseScreen
      hash={hash}
      screen="brief"
      title={T.featureBrief}
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
      title={T.prototypesAndUx}
      artifacts={["ux"]}
      critic="ux-critic"
      extra={() => (
        <Panel title={T.bringInAPrototype} span="span 4">
          <p className="muted" style={{ margin: 0, fontSize: 12.5, lineHeight: 1.6 }}>
            {T.dropADesignExport}
            <span className="mono">{T.inputs}</span> {T.fromThe}
            <a href="#/intake">{T.intake}</a> {T.screenAtticusReadsThe}
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
    <Panel title={T.designVsPlansVs} span="span 4">
      <View of={d}>
        {(x) => {
          const open = x.findings.filter((f) => f.state === "open");
          return (
            <div className="stack" style={{ gap: 8 }}>
              <span className="hud" style={{ fontSize: 10 }}>
                {x.plans.length ? T.repoPlansCompared(x.plans.length) : T.noRepoPlansYet}
              </span>
              {open.length === 0 ? (
                <span className="chip done" style={{ width: "fit-content" }}>
                  {T.inSync}
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
      title={T.architectureReview}
      artifacts={["design", "interfaces"]}
      critic="architecture-critic"
      extra={(id) => (
        <>
          <DriftPanel change={id} />
          <Panel
            title={T.integrationPatterns}
            span="span 4"
            meta={<a href="#/orgpack">{T.orgPack}</a>}
          >
            <View of={op} empty={(o) => !o.patterns?.length} emptyText={T.theOrgPackHas}>
              {(o) => (
                <div className="stack" style={{ gap: 4 }}>
                  {o.patterns!.map((p) => (
                    <div key={p.code} className="list-row">
                      <span className="chip">{p.code}</span>
                      <span style={{ fontSize: 12.5 }}>{p.name}</span>
                    </div>
                  ))}
                  <p className="muted" style={{ margin: "6px 0 0", fontSize: 11.5 }}>
                    {T.everyHopInDesign}
                  </p>
                </div>
              )}
            </View>
          </Panel>
          <Panel title={T.yourMaterial} span="span 4">
            <p className="muted" style={{ margin: 0, fontSize: 12.5, lineHeight: 1.6 }}>
              {T.vendorSpecsWhiteboardPhotos}
              <a href="#/intake">{T.intake}</a>
              {T.diagramsAreComparedEdge}
              <a href="#/reconcile">{T.reconcile}</a>
              {T.ingestedContentIsData}
            </p>
          </Panel>
        </>
      )}
    />
  );
}

interface MappingHop {
  heading: string;
  line: number;
  noChange: boolean;
  note?: string;
  rows: { line: number; source: string; target: string; rule: string; whenMissing: string }[];
  asIs: { id: string; interface: string; source: string; target: string; transform?: string }[];
}

/** Each hop's field mappings from mappings.md, beside what the catalog maps today (ADR 0048). */
function MappingGrid({ change }: { change: string }) {
  const g = useApi<{ hops: MappingHop[]; catalogMappings: number }>(
    `/api/changes/${encodeURIComponent(change)}/mappings`,
  );
  return (
    <Panel title={T.fieldMappings} meta={T.byHopWithThe}>
      <View of={g} empty={(d) => d.hops.length === 0} emptyText={T.noHopsInMappings}>
        {(d) => (
          <div className="stack" style={{ gap: 14 }}>
            {d.hops.map((h) => (
              <section key={h.line} aria-label={h.heading} className="stack" style={{ gap: 6 }}>
                <div className="row between" style={{ flexWrap: "wrap", gap: 6 }}>
                  <h3 className="mono" style={{ margin: 0, fontSize: 13 }}>
                    {h.heading}
                  </h3>
                  {h.noChange ? (
                    <span className="chip">{T.noMappingChange}</span>
                  ) : (
                    <span className="chip">{T.fields(h.rows.length)}</span>
                  )}
                </div>
                {h.note && (
                  <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
                    {h.note}
                  </p>
                )}
                {h.rows.length > 0 && (
                  <Table
                    rows={h.rows}
                    rowKey={(r) => String(r.line)}
                    caption={T.fieldMappingsFor(h.heading)}
                    cols={[
                      { label: T.sourceField, cell: (r) => r.source, mono: true },
                      { label: T.targetField, cell: (r) => r.target, mono: true },
                      { label: T.rule, cell: (r) => r.rule },
                      { label: T.whenMissingOrInvalid, cell: (r) => r.whenMissing },
                    ]}
                  />
                )}
                {!h.noChange && h.rows.length === 0 && (
                  <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
                    {T.noFieldRowsYet}
                  </p>
                )}
                {h.asIs.length > 0 && (
                  <details>
                    <summary className="hud" style={{ fontSize: 10, cursor: "pointer" }}>
                      {T.mappedTodayInThe(h.asIs.length)}
                    </summary>
                    <Table
                      rows={h.asIs}
                      rowKey={(r) => r.id}
                      caption={T.catalogFieldMappingsFor(h.heading)}
                      cols={[
                        { label: T.sourceField, cell: (r) => r.source, mono: true },
                        { label: T.targetField, cell: (r) => r.target, mono: true },
                        { label: T.transform, cell: (r) => r.transform ?? "" },
                        { label: T.record, cell: (r) => r.id, mono: true },
                      ]}
                    />
                  </details>
                )}
              </section>
            ))}
            {d.catalogMappings === 0 && (
              <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                {T.theCatalogHasNo}
              </p>
            )}
          </div>
        )}
      </View>
    </Panel>
  );
}

export function Mappings({ hash }: { hash: string }) {
  return (
    <PhaseScreen
      hash={hash}
      screen="mappings"
      title={T.apiMappings}
      artifacts={["mappings"]}
      critic="architecture-critic"
      main={(id) => <MappingGrid change={id} />}
      extra={() => (
        <Panel title={T.howMappingsAreChecked} span="span 4">
          <p className="muted" style={{ margin: 0, fontSize: 12.5, lineHeight: 1.6 }}>
            {T.eachHopsSourceField}
            <a href="#/trace">{T.testTrace}</a>.
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
    <Panel title={T.storyBar} span="span 4" kind="dark">
      <View of={bar} empty={(b) => !b || b.stories.length === 0} emptyText={T.noStoriesYetWrite}>
        {(b) => (
          <div className="stack" style={{ gap: 10 }}>
            <div className="row">
              <Ring
                value={b.ready.passed}
                max={Math.max(b.ready.total, 1)}
                size={64}
                label={T.ofStoriesReady(b.ready.passed, b.ready.total)}
              />
              <span className={`chip ${b.met ? "done" : "warn"}`}>
                {b.met ? T.barMet : T.needs(Math.round(b.ready.min * 100))}
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
                <div key={g.id} style={{ fontSize: 12.5, color: "var(--amber-text)" }}>
                  {T.noStoryCovers(g.what)}
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
  const aiOn = useAiOn();
  return (
    <Panel title={T.storiesAndTasks} span="span 4">
      <div className="stack" style={{ gap: 8 }}>
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
          {T.theStoryWriterDrafts}
        </p>
        {aiOn ? (
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
                  }).catch(withForceHint(COPY.app.forceStories(change))),
                T.theStoryWritersPrompt,
              )
            }
          >
            {T.writeStoriesWithAi}
          </button>
        ) : (
          <p style={{ margin: 0, fontSize: 12.5 }}>{AI_OFF_TEXT}</p>
        )}
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
      title={T.breakdown}
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
  const aiOn = useAiOn();
  const [ran, setRan] = useState<Record<string, string>>({});
  const [running, setRunning] = useState<Record<string, boolean>>({});
  // Each task keeps its own outcome: set from the latest state, so two runs don't erase each other.
  const say = (id: string, text: string) => setRan((o) => ({ ...o, [id]: text }));
  const run = async (t: Task) => {
    setRunning((o) => ({ ...o, [t.id]: true }));
    say(t.id, COPY.app.working);
    try {
      const r = await api<Run>(`/api/changes/${change}/runs`, {
        method: "POST",
        body: { agent: "task-runner", task: t.id, runtime: "hand-off" },
      });
      say(t.id, `Run ${r.runId} prepared: your assistant takes it from here.`);
    } catch (e) {
      say(t.id, e instanceof ApiError ? (e.problem.detail ?? e.problem.title) : String(e));
    } finally {
      setRunning((o) => ({ ...o, [t.id]: false }));
    }
  };
  return (
    <Panel
      title={compact ? T.handDownPreview : T.tasksByRepo}
      span={span}
      meta={tasks.state === "ready" ? T.tasks(tasks.data.length) : undefined}
    >
      <View of={tasks} empty={(t) => t.length === 0} emptyText={T.noTasksYetThey}>
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
                        {T.done(done, mine.length)}
                      </span>
                    </div>
                    <Bar
                      value={done}
                      max={mine.length}
                      label={T.ofTasksDone(r, done, mine.length)}
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
                              <span className="chip done">{T.done2}</span>
                            ) : aiOn ? (
                              <button
                                type="button"
                                className="btn"
                                disabled={running[x.id]}
                                onClick={() => void run(x)}
                              >
                                {T.runWithAi}
                              </button>
                            ) : (
                              <span className="chip dim" title={AI_OFF_TEXT}>
                                {T.byHand}
                              </span>
                            )}
                          </div>
                          <span className="mono muted" style={{ fontSize: 10.5 }}>
                            {x.branch}
                            {x.story ? T.story(x.story) : ""}
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
    <Panel title={T.aiTaskRuns} span="span 4" kind="dark">
      <View of={runs} empty={(r) => r.length === 0} emptyText={T.noRunsYet}>
        {(r) => (
          <div className="stack" style={{ gap: 8 }}>
            <div className="row">
              <Ring
                value={passed}
                max={r.length}
                size={60}
                label={T.ofRunsFinished(passed, r.length)}
              />
              <span className="muted" style={{ fontSize: 12 }}>
                {T.everyWriteIsApproved}
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
  if (!c.id) return <ChangeWaiting list={c.list} title={T.taskBoard} />;
  return (
    <div className="bento" key={c.id}>
      <Panel title={T.taskBoard} span="1 / -1" meta={c.picker}>
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
          {T.tasksInCrossRepo}
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
    requirement?: { requirement: string; scenario?: string; key: string };
    story?: string;
    criterion?: { n: number; text: string };
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
  if (!c.id) return <ChangeWaiting list={c.list} title={T.testTrace} />;
  const covered = t.state === "ready" ? t.data.rows.filter((r) => r.tests.length > 0).length : 0;
  const total = t.state === "ready" ? t.data.rows.length : 0;
  return (
    <div className="bento">
      <div className="column" style={{ gridColumn: "span 8" }}>
        <Panel title={T.testTrace} kind="hero" meta={c.picker}>
          <p className="muted" style={{ margin: "0 0 12px", fontSize: 12.5 }}>
            {T.everyRequirementShouldReach}
          </p>
          <View of={t} empty={(d) => d.rows.length === 0} emptyText={T.nothingToTraceYet}>
            {(d) => (
              <Table
                caption={T.requirementToCode}
                rows={d.rows}
                rowKey={(r) =>
                  `${r.requirement?.key ?? ""}/${r.story ?? ""}/${r.criterion?.n ?? ""}`
                }
                cols={[
                  {
                    label: T.requirement,
                    cell: (r) =>
                      r.requirement ? (
                        <span className="stack" style={{ gap: 2 }}>
                          <span>{r.requirement.requirement}</span>
                          {r.requirement.scenario && (
                            <span className="muted" style={{ fontSize: 11.5 }}>
                              {r.requirement.scenario}
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="stack" style={{ gap: 2 }}>
                          <span className="chip warn" style={{ width: "fit-content" }}>
                            {T.noRequirement}
                          </span>
                          {r.criterion && (
                            <span className="muted" style={{ fontSize: 11.5 }}>
                              {r.criterion.text}
                            </span>
                          )}
                        </span>
                      ),
                  },
                  {
                    label: T.story2,
                    cell: (r) => r.story ?? <span className="chip warn">{T.noStory}</span>,
                    mono: true,
                  },
                  {
                    label: T.test,
                    cell: (r) =>
                      r.tests.length ? (
                        r.tests.join(", ")
                      ) : (
                        <span className="chip blocking">{T.noTest}</span>
                      ),
                    mono: true,
                  },
                  { label: T.code, cell: (r) => r.code.slice(0, 3).join(", "), mono: true },
                ]}
              />
            )}
          </View>
        </Panel>
        <Panel
          title={T.gapsBeforeQaSign}
          meta={t.state === "ready" ? t.data.gaps.length : undefined}
        >
          <View of={t} empty={(d) => d.gaps.length === 0} emptyText={T.noGapsEveryRequirement}>
            {(d) => (
              <Table
                caption={T.traceGaps}
                rows={d.gaps}
                rowKey={(g) => `${g.kind}/${g.subject}`}
                cols={[
                  {
                    label: T.gap,
                    cell: (g) => <span className="chip warn">{g.kind}</span>,
                    width: "190px",
                  },
                  { label: T.what, cell: (g) => g.summary },
                ]}
              />
            )}
          </View>
        </Panel>
      </div>
      <div className="column" style={{ gridColumn: "span 4" }}>
        <Panel title={T.scenarioCoverage} kind="dark">
          <View of={t}>
            {(d) => (
              <div className="stack" style={{ gap: 10 }}>
                <div className="row">
                  <Ring
                    value={covered}
                    max={Math.max(total, 1)}
                    size={72}
                    label={T.ofRowsHaveA(covered, total)}
                    text={total ? `${Math.round((covered / total) * 100)}%` : "–"}
                  />
                  <span className="muted" style={{ fontSize: 12.5 }}>
                    {T.ofTracedToA(covered, total)}
                  </span>
                </div>
                <Donut
                  title={T.gapsByKind}
                  parts={[...new Set(d.gaps.map((g) => g.kind))].map((k, i) => ({
                    label: k,
                    value: d.gaps.filter((g) => g.kind === k).length,
                    color: ["var(--amber)", "var(--magenta)", "var(--violet)", "var(--accent)"][
                      i % 4
                    ]!,
                  }))}
                />
              </div>
            )}
          </View>
        </Panel>
        <Panel title={T.testKindsThisChange}>
          <View
            of={status}
            empty={(s) => !s.tests?.required?.length}
            emptyText={T.theTestStrategyAsks}
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
            {T.requiredKindsComeFrom}
          </p>
        </Panel>
      </div>
    </div>
  );
}
