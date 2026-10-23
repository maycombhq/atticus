import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, useApi, useLiveEvents, type Loaded } from "../api/client.js";
import { AI_OFF_TEXT, useAiOn } from "../app/me.js";
import { escapeCloses, Panel, Ring, View } from "../app/ui.js";
import { ACROSS, AcrossPanel, type AcrossId } from "./Across.js";
import { NeedsPanel } from "./knowledge/Needs.js";
import { COPY } from "../copy.js";
import { Note, useAction } from "./know/common.js";

const T = COPY.changes;

export interface ChangeSummary {
  id: string;
  title: string;
  type: string;
  state: string;
  repos?: string[];
  openFindings: { blocking: number; gap: number; risk: number; idea: number };
}

/** Changes matching the words (id, title, repos) and the state; "blocked" means a blocking finding is open. */
export function filterChanges(list: ChangeSummary[], text: string, state: string): ChangeSummary[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter((c) => {
    if (state === "blocked" && !c.openFindings.blocking) return false;
    if (state && state !== "blocked" && c.state !== state) return false;
    const hay = [c.id, c.title, c.type, ...(c.repos ?? [])].join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
export interface ArtifactStatus {
  artifact: string;
  path: string;
  status: "blocked" | "ready" | "done" | "not-required";
  openFindings: number;
}
export interface ChangeDetail extends ChangeSummary {
  artifacts: ArtifactStatus[];
  handoff?: { phase: string; pr?: string; state: string };
}
export interface Reason {
  code: string;
  message: string;
}
export interface Status {
  state: string;
  phase?: string;
  next?: string;
  nextStep: string;
  risk: { level: string; score: number };
  /** The open hand-off PR: merging it approves the gate (ADR 0073). */
  handoff?: { pr: { number: number; url: string }; state: string; phase: string };
  blockers: Reason[];
  reasons: Reason[];
}
export interface Task {
  id: string;
  repo: string;
  description: string;
  done: boolean;
  story?: string;
  branch?: string;
}
export interface Run {
  runId: string;
  agent: string;
  runtime: string;
  state: string;
  startedAt: string;
  errors: string[];
  promptPath?: string;
}
export interface Finding {
  id: string;
  gate: string;
  lens?: string;
  severity: "blocking" | "gap" | "risk" | "idea";
  artifact: string;
  summary: string;
  why: string;
  state: string;
  waivable: boolean;
  question?: { text: string; owner?: string };
}
export interface Artifact {
  path: string;
  content: string;
  sha256: string;
}

const PHASES = ["define", "design", "plan", "build", "qa", "release-ready"];
const LABEL: Record<string, string> = {
  define: T.define,
  design: T.design,
  plan: T.plan,
  build: T.build,
  qa: "QA",
  "release-ready": T.release,
};

// One button that runs an action and shows its outcome in words: know/common.tsx.

function ChangeList({
  list,
  current,
  across,
}: {
  list: Loaded<ChangeSummary[]>;
  current?: string;
  across?: AcrossId;
}) {
  const [text, setText] = useState("");
  const [state, setState] = useState("");
  return (
    <Panel title={T.changes} span="span 3" rows="span 3">
      <View of={list} empty={(l) => l.length === 0} emptyText={T.noChangesYetStart}>
        {(all) => {
          const states = [...new Set(all.map((c) => c.state))];
          const l = filterChanges(all, text, state);
          return (
            <div className="stack" style={{ gap: 8 }}>
              <div className="stack" style={{ gap: 4 }}>
                <label htmlFor="change-filter" className="hud" style={{ fontSize: 10 }}>
                  {T.findAChange}
                </label>
                <input
                  id="change-filter"
                  className="field"
                  value={text}
                  placeholder={T.idTitleOrRepo}
                  onChange={(e) => setText(e.target.value)}
                />
                <label htmlFor="change-state" className="sr">
                  {T.state}
                </label>
                <select
                  id="change-state"
                  className="field"
                  value={state}
                  onChange={(e) => setState(e.target.value)}
                >
                  <option value="">{T.everyState}</option>
                  <option value="blocked">{T.blocked}</option>
                  {states.map((x) => (
                    <option key={x} value={x}>
                      {LABEL[x] ?? x}
                    </option>
                  ))}
                </select>
              </div>
              <nav aria-label={T.changes} className="stack" style={{ gap: 2 }}>
                {l.map((c) => (
                  <a
                    key={c.id}
                    href={`#/changes/${c.id}`}
                    aria-current={!across && c.id === current ? "page" : undefined}
                    className="list-row"
                    style={{
                      textDecoration: "none",
                      padding: "8px 6px",
                      borderRadius: 6,
                      background: !across && c.id === current ? "var(--picked)" : undefined,
                    }}
                  >
                    <span className="stack" style={{ gap: 2, minWidth: 0 }}>
                      <span className="mono" style={{ fontSize: 12 }}>
                        {c.id}
                      </span>
                      <span className="muted" style={{ fontSize: 11.5 }}>
                        {c.title}
                      </span>
                    </span>
                    <span className={`chip ${c.openFindings.blocking ? "blocking" : ""}`}>
                      {c.openFindings.blocking
                        ? T.blocked2
                        : (LABEL[c.state] ?? c.state).toUpperCase()}
                    </span>
                  </a>
                ))}
                {l.length === 0 && (
                  <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
                    {T.noChangeMatches}
                  </p>
                )}
              </nav>
              <div
                className="stack"
                style={{ gap: 4, borderTop: "1px solid var(--line)", paddingTop: 8 }}
              >
                <span className="hud" style={{ fontSize: 10 }}>
                  {T.acrossAllChanges}
                </span>
                <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                  {ACROSS.map((a) => (
                    <a
                      key={a.id}
                      href={`#/changes?across=${a.id}`}
                      aria-current={across === a.id ? "page" : undefined}
                      className="chip"
                      style={{ textDecoration: "none" }}
                    >
                      {a.label}
                    </a>
                  ))}
                </div>
              </div>
            </div>
          );
        }}
      </View>
    </Panel>
  );
}

export function Pipeline({ state }: { state: string }) {
  const at = PHASES.indexOf(state);
  return (
    <ol
      className="row between"
      style={{ listStyle: "none", margin: 0, padding: 0 }}
      aria-label={T.phases}
    >
      {PHASES.map((p, i) => (
        <li
          key={p}
          className="stack"
          style={{ alignItems: "center", gap: 6 }}
          aria-current={i === at ? "step" : undefined}
        >
          {i === at ? (
            <Ring
              value={i + 1}
              max={PHASES.length}
              size={46}
              label={T.currentPhase(LABEL[p] ?? "")}
            />
          ) : (
            <span
              role="img"
              aria-label={`${LABEL[p]}: ${i < at ? T.done : T.toCome}`}
              style={{
                width: 42,
                height: 42,
                borderRadius: "50%",
                border: `1.5px solid ${i < at ? "var(--btn-text)" : "var(--step-off)"}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {i < at ? "✓" : ""}
            </span>
          )}
          <span
            className="hud"
            style={{ fontSize: 10, color: i === at ? "var(--accent)" : undefined }}
          >
            {LABEL[p]}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function ArtifactEditor({
  change,
  artifact,
  onClose,
}: {
  change: string;
  artifact: string;
  onClose: () => void;
}) {
  const a = useApi<Artifact>(`/api/changes/${change}/artifacts/${artifact}`);
  const [text, setText] = useState<string | undefined>();
  const act = useAction();
  // The keyboard goes into the text once it loads, so Escape (or Close) can close it at once.
  const box = useRef<HTMLTextAreaElement>(null);
  const ready = a.state === "ready";
  useEffect(() => {
    if (ready) box.current?.focus();
  }, [ready]);
  return (
    <Panel
      title={T.edit(artifact)}
      span="1 / -1"
      meta={a.state === "ready" ? a.data.path : undefined}
    >
      <View of={a}>
        {(d) => (
          <form
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void act.run(
                () =>
                  api(`/api/changes/${change}/artifacts/${artifact}`, {
                    method: "PUT",
                    body: { content: text ?? d.content, baseSha256: d.sha256 },
                  }).then(() => a.reload()),
                `Saved ${d.path}.`,
              );
            }}
            onKeyDown={escapeCloses(onClose)}
            className="stack"
          >
            <label htmlFor="artifact-text" className="sr">
              {T.text(artifact)}
            </label>
            <textarea
              ref={box}
              id="artifact-text"
              value={text ?? d.content}
              onChange={(e) => setText(e.target.value)}
              rows={18}
              spellCheck
              style={{
                width: "100%",
                background: "var(--box)",
                color: "var(--text)",
                border: "1px solid var(--line-2)",
                borderRadius: 8,
                padding: 12,
                font: "13px/1.6 var(--mono)",
              }}
            />
            <div className="row">
              <button type="submit" className="btn primary" disabled={act.busy}>
                {T.save}
              </button>
              <button type="button" className="btn" onClick={onClose}>
                {T.close}
              </button>
              <span className="muted" style={{ fontSize: 12 }}>
                {T.ifSomeoneSavedMeanwhile}
              </span>
            </div>
            <Note note={act.note} />
          </form>
        )}
      </View>
    </Panel>
  );
}

const NEEDS_REASON = COPY.findings.needsReason;
const CANT_WAIVE = COPY.findings.cantWaive;

export function FindingActions({
  change,
  f,
  done,
}: {
  change: string;
  f: Finding;
  done: () => void;
}) {
  const [reason, setReason] = useState("");
  const act = useAction();
  const go = (action: string) =>
    act.run(
      () =>
        api(`/api/findings/${change}/${f.id}/action`, {
          method: "POST",
          body: { action, gate: f.gate, ...(reason ? { reason } : {}) },
        }).then(done),
      `Recorded: ${action.replace(/-/g, " ")}.`,
    );
  return (
    <div className="stack" style={{ gap: 6 }}>
      <label className="sr" htmlFor={`reason-${f.id}`}>
        {T.reason}
      </label>
      <input
        id={`reason-${f.id}`}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder={T.reasonNeededToWaive}
        style={{
          height: 30,
          background: "var(--box)",
          color: "var(--text)",
          border: "1px solid var(--line-2)",
          borderRadius: 6,
          padding: "0 8px",
        }}
      />
      <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
        <button type="button" className="btn" disabled={act.busy} onClick={() => void go("apply")}>
          {T.applyFix}
        </button>
        {f.question && (
          <button type="button" className="btn" disabled={act.busy} onClick={() => void go("ask")}>
            {T.ask(f.question.owner ?? T.owner)}
          </button>
        )}
        <button
          type="button"
          className="btn"
          disabled={act.busy || !reason}
          title={reason ? undefined : NEEDS_REASON}
          aria-describedby={reason ? undefined : `why-${f.id}`}
          onClick={() => void go("not-relevant")}
        >
          {T.notRelevant}
        </button>
        <button
          type="button"
          className="btn"
          disabled={act.busy || !reason || !f.waivable}
          title={!f.waivable ? CANT_WAIVE : reason ? undefined : NEEDS_REASON}
          aria-describedby={!f.waivable || !reason ? `why-${f.id}` : undefined}
          onClick={() => void go("waive")}
        >
          {T.waive}
        </button>
      </div>
      {(!reason || !f.waivable) && (
        <p id={`why-${f.id}`} className="muted" style={{ margin: 0, fontSize: 11.5 }}>
          {[!reason ? NEEDS_REASON : "", !f.waivable ? `${CANT_WAIVE}.` : ""]
            .filter(Boolean)
            .join(" ")}
        </p>
      )}
      <Note note={act.note} />
    </div>
  );
}

function Detail({ id }: { id: string }) {
  const aiOn = useAiOn();
  const detail = useApi<ChangeDetail>(`/api/changes/${id}`);
  const status = useApi<Status>(`/api/changes/${id}/status`);
  const tasks = useApi<Task[]>(`/api/changes/${id}/tasks`);
  const runs = useApi<Run[]>(`/api/changes/${id}/runs`);
  const findings = useApi<Finding[]>(`/api/findings?change=${id}&state=open`);
  const [editing, setEditing] = useState<string | undefined>();
  // Each artifact's Edit button, so closing the editor puts the keyboard back on the one used.
  const editBtns = useRef(new Map<string, HTMLButtonElement>());
  const closeEditor = () => {
    const was = editing;
    setEditing(undefined);
    if (was) editBtns.current.get(was)?.focus();
  };
  const handoff = useAction();
  const critic = useAction();
  const runAct = useAction();
  const reloadAll = () => {
    detail.reload();
    status.reload();
    findings.reload();
    runs.reload();
    tasks.reload();
  };
  useLiveEvents((e) => {
    if (e.type === "file.changed" || e.type === "run.changed") reloadAll();
  });

  return (
    <>
      <Panel
        title={detail.state === "ready" ? `${detail.data.id} · ${detail.data.title}` : id}
        span="span 9"
        kind="hero"
      >
        <View of={detail}>
          {(d) => (
            <div className="stack" style={{ gap: 14 }}>
              <Pipeline state={d.state} />
              <View of={status}>
                {(s) => (
                  <div className="stack">
                    <p style={{ margin: 0, fontSize: 14 }}>
                      <span className="hud" style={{ marginRight: 8 }}>
                        {T.next}
                      </span>
                      {s.nextStep}
                    </p>
                    <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                      <span
                        className={`chip ${s.risk.level === "high" ? "blocking" : s.risk.level === "medium" ? "warn" : ""}`}
                      >
                        {T.risk(s.risk.level.toUpperCase())}
                      </span>

                      {d.handoff && (
                        <span className="chip">
                          {T.handOff(
                            d.handoff.phase.toUpperCase(),
                            d.handoff.state.toUpperCase(),
                            d.handoff.pr ? ` · ${d.handoff.pr}` : "",
                          )}
                        </span>
                      )}
                    </div>
                    {s.blockers.length > 0 && (
                      <ul
                        style={{
                          margin: 0,
                          paddingLeft: 18,
                          color: "var(--text-2)",
                          lineHeight: 1.6,
                        }}
                        aria-label={T.whatBlocksTheHand}
                      >
                        {s.blockers.map((b) => (
                          <li key={b.message}>{b.message}</li>
                        ))}
                      </ul>
                    )}
                    <div className="row" style={{ flexWrap: "wrap" }}>
                      <button
                        type="button"
                        className="btn primary"
                        disabled={handoff.busy}
                        onClick={() =>
                          void handoff.run(
                            () =>
                              api(`/api/changes/${id}/handoff`, { method: "POST", body: {} }).then(
                                reloadAll,
                              ),
                            T.handOffPrOpened,
                          )
                        }
                      >
                        {T.raiseHandOff}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={handoff.busy}
                        onClick={() =>
                          void handoff.run(
                            () =>
                              api(`/api/changes/${id}/sync`, { method: "POST", body: {} }).then(
                                reloadAll,
                              ),
                            T.syncedWithTheGit,
                          )
                        }
                      >
                        {T.syncAndMergeWhen}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={critic.busy}
                        onClick={() =>
                          void critic.run(
                            () =>
                              api(`/api/changes/${id}/critic`, { method: "POST", body: {} }).then(
                                reloadAll,
                              ),
                            aiOn ? T.criticRoundStartedThe : T.theRuleChecksRan,
                          )
                        }
                      >
                        {aiOn ? T.runTheCriticYour : T.runTheRuleChecks}
                      </button>
                    </div>
                    <Note note={handoff.note} />
                    <Note note={critic.note} />
                  </div>
                )}
              </View>
            </div>
          )}
        </View>
      </Panel>

      {editing && <ArtifactEditor change={id} artifact={editing} onClose={closeEditor} />}

      <Panel title={T.artifacts} span="span 5">
        <View of={detail} empty={(d) => d.artifacts.length === 0}>
          {(d) => (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead>
                <tr className="hud" style={{ textAlign: "left", fontSize: 10 }}>
                  <th style={{ padding: "4px 0", fontWeight: 400 }}>{T.artifact}</th>
                  <th style={{ fontWeight: 400 }}>{T.status}</th>
                  <th style={{ fontWeight: 400 }}>{T.findings}</th>
                  <th style={{ fontWeight: 400 }}>
                    <span className="sr">{T.actions}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {d.artifacts.map((a) => (
                  <tr key={a.artifact} style={{ borderTop: "1px solid var(--rule)" }}>
                    <td className="mono" style={{ padding: "7px 0" }}>
                      {a.artifact}
                    </td>
                    <td>
                      <span
                        className={`chip ${a.status === "done" ? "done" : a.status === "blocked" ? "dim" : "warn"}`}
                      >
                        {a.status.toUpperCase()}
                      </span>
                    </td>
                    <td>{a.openFindings || ""}</td>
                    <td style={{ textAlign: "right" }}>
                      {a.status !== "blocked" && (
                        <button
                          type="button"
                          className="btn"
                          ref={(b) => {
                            if (b) editBtns.current.set(a.artifact, b);
                            else editBtns.current.delete(a.artifact);
                          }}
                          onClick={() => setEditing(a.artifact)}
                          aria-label={T.edit(a.artifact)}
                        >
                          {T.edit2}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </View>
      </Panel>

      <Panel
        title={T.openFindings}
        span="span 4"
        meta={findings.state === "ready" ? findings.data.length : undefined}
      >
        <View of={findings} empty={(f) => f.length === 0} emptyText={T.noOpenFindingsOn}>
          {(list) => (
            <div className="stack" style={{ gap: 12 }}>
              {list.map((f) => (
                <article
                  key={`${f.gate}/${f.id}`}
                  className="stack"
                  style={{ gap: 6, borderTop: "1px solid var(--rule)", paddingTop: 10 }}
                >
                  <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    <span
                      className={`chip ${f.severity === "blocking" ? "blocking" : f.severity === "gap" ? "warn" : "dim"}`}
                    >
                      {f.severity.toUpperCase()}
                    </span>
                    <span className="hud" style={{ fontSize: 10 }}>
                      {f.gate} · {f.lens ?? T.checks} · {f.artifact}
                    </span>
                  </div>
                  <div style={{ fontSize: 13 }}>{f.question?.text ?? f.summary}</div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {f.why}
                  </div>
                  <FindingActions change={id} f={f} done={reloadAll} />
                </article>
              ))}
            </div>
          )}
        </View>
      </Panel>

      <Panel title={T.tasks} span="span 5">
        <View of={tasks} empty={(t) => t.length === 0} emptyText={T.noTasksYetThey}>
          {(list) =>
            list.map((t) => (
              <div key={t.id} className="list-row">
                <span className="stack" style={{ gap: 2, minWidth: 0 }}>
                  <span style={{ fontSize: 12.5 }}>
                    <span className="mono">{t.id}</span> {t.description}
                  </span>
                  <span className="hud" style={{ fontSize: 9.5 }}>
                    {t.repo}
                    {t.story ? ` · ${t.story}` : ""}
                  </span>
                </span>
                {t.done ? (
                  <span className="chip done">{T.done2}</span>
                ) : !aiOn ? (
                  <span className="chip dim" title={AI_OFF_TEXT}>
                    {T.byHand}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="btn"
                    disabled={runAct.busy}
                    onClick={() =>
                      void runAct.run(
                        () =>
                          api(`/api/changes/${id}/runs`, {
                            method: "POST",
                            body: {
                              agent: "task-runner",
                              runtime: "hand-off",
                              task: t.id,
                              autonomy: "draft",
                            },
                          }).then(reloadAll),
                        `Task ${t.id} handed to your assistant. Open the prompt, then mark it done.`,
                      )
                    }
                  >
                    {T.runWithAi}
                  </button>
                )}
              </div>
            ))
          }
        </View>
        <Note note={runAct.note} />
      </Panel>

      <Panel title={T.aiRuns} span="span 4">
        <View of={runs} empty={(r) => r.length === 0} emptyText={T.noAiRunsYet}>
          {(list) =>
            list
              .slice()
              .reverse()
              .map((r) => (
                <div key={r.runId} className="list-row" style={{ alignItems: "flex-start" }}>
                  <span className="stack" style={{ gap: 2, minWidth: 0 }}>
                    <span style={{ fontSize: 12.5 }}>{r.agent}</span>
                    <span className="hud" style={{ fontSize: 9.5 }}>
                      {r.runtime} · {r.promptPath ?? r.runId}
                    </span>
                    {r.errors.length > 0 && (
                      <span style={{ color: "var(--magenta-text)", fontSize: 12 }}>
                        {r.errors.join("; ")}
                      </span>
                    )}
                  </span>
                  <span className="row" style={{ gap: 6 }}>
                    <span
                      className={`chip ${r.state === "validated" ? "done" : r.state === "failed" ? "blocking" : "ai"}`}
                    >
                      {r.state.toUpperCase()}
                    </span>
                    {(r.state === "waiting" || r.state === "prepared") && (
                      <button
                        type="button"
                        className="btn"
                        onClick={() =>
                          void runAct.run(
                            () =>
                              api(`/api/runs/${r.runId}/done`, { method: "POST", body: {} }).then(
                                reloadAll,
                              ),
                            T.checkedTheAnswer,
                          )
                        }
                      >
                        {T.markDone}
                      </button>
                    )}
                    {r.state === "failed" && (
                      <button
                        type="button"
                        className="btn"
                        onClick={() =>
                          void runAct.run(
                            () =>
                              api(`/api/runs/${r.runId}/retry`, { method: "POST", body: {} }).then(
                                reloadAll,
                              ),
                            T.readyToTryAgain,
                          )
                        }
                      >
                        {T.retry}
                      </button>
                    )}
                  </span>
                </div>
              ))
          }
        </View>
      </Panel>

      {/* ADR 0102: what the change needs from the organisation. */}
      <NeedsPanel change={id} span="span 9" />
    </>
  );
}

export function Changes({ hash }: { hash: string }) {
  const id = hash.replace(/^#\/?changes\/?/, "").split("?")[0] || undefined;
  const wanted = new URLSearchParams(hash.split("?")[1] ?? "").get("across");
  const across = ACROSS.find((a) => a.id === wanted)?.id;
  const list = useApi<ChangeSummary[]>("/api/changes");
  const first = list.state === "ready" ? list.data[0]?.id : undefined;
  const current = id ?? first;
  return (
    <div className="bento">
      <ChangeList list={list} current={current} across={across} />
      {across && !id ? (
        <AcrossPanel key={across} view={across} />
      ) : current ? (
        <Detail key={current} id={current} />
      ) : (
        <Panel title={T.noChangeSelected} span="span 9">
          <p className="muted" style={{ margin: 0 }}>
            {T.pickAChangeOn}
            <code className="mono">{T.atticusChangeNew}</code>.
          </p>
        </Panel>
      )}
    </div>
  );
}
