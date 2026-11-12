import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { api, ApiError, callAsJob, useApi, useLiveEvents, type Loaded } from "../api/client.js";
import { confirmed } from "../api/confirm.js";
import { NewChange } from "./work/NewChange.js";
import { nextStepWords } from "../app/app-words.js";
import { BringIn } from "../app/propose.js";
import { RunStep } from "../app/runstep.js";
import { artifactStatusWord } from "../app/artifact-status.js";
import { AI_OFF_TEXT, useAiOn } from "../app/me.js";
import { escapeCloses, ExternalLink, GlanceLink, Panel, View } from "../app/ui.js";
import { ACROSS, AcrossPanel, type AcrossId } from "./Across.js";
import { NeedsPanel } from "./knowledge/Needs.js";
import { ChangeInputs } from "./ChangeInputs.js";
import { ChangePrototypes } from "./ChangePrototypes.js";
import { COPY } from "../copy.js";
import { lensesWaiting, type CriticRan } from "./work/critic-ran.js";
import { Note, Said, useAction, useSaid } from "./know/common.js";
import { isManualLink, ManualHandoff, PushAgain } from "./know/task-pr.js";
import { ChangeOwners } from "./change-owners.js";
import { BrokenChanges } from "./work/BrokenChanges.js";
import "./work/cw.css";

const T = COPY.changes;
const CW = COPY.changeWork;

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
  /** API 2.70.0: whether its file is there (and holds more than the template). */
  written?: boolean;
  openFindings: number;
}
export interface ChangeDetail extends ChangeSummary {
  artifacts: ArtifactStatus[];
  /** API 3.3.0 (app-only audit): `unpushed` when its branch is kept here, its push failed. */
  handoff?: { phase: string; pr?: string; state: string; unpushed?: boolean; branch?: string };
  /** API 2.83.0 (ninth UX walk): change.yaml's owners, role id to handles. */
  owners?: Record<string, string[]>;
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
  /**
   * Beta.27 review (API 3.11.0): nothing in the gate's checks blocks, yet another step comes
   * first. `nextStep` then names that step's reason (At a glance says "the step below" instead),
   * which the page says in the app's words (`nextStepWords`).
   */
  stepFirst?: boolean;
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
  /** API 2.69.0: the task's latest AI run. */
  run?: string;
  /** API 2.69.0 (sixth UX walk): where its Run with AI stands, from its task-run.yaml. */
  taskRun?: {
    state: string;
    level: string;
    branch: string;
    commit?: string;
    /** API 2.70.0 (review round 43): `state` is the PR's on the Git host now, when it said. */
    pr?: { number: number; url: string; state?: "open" | "merged" | "closed" };
    /** API 2.72.0 (seventh UX walk): when Atticus ticked it because its PR merged. */
    ticked?: string;
    /** API 2.76.0 (eighth UX walk): who last ticked or unticked it by hand, and when. */
    marked?: { done: boolean; by: string; at: string };
    notes: string[];
  };
  /** API 2.83.0 (ninth UX walk): the not-done tasks it waits for; `sameRepo`, its own repo's. */
  waits?: { tasks: string[]; sameRepo: string[] };
  /** API 3.3.0 (app-only audit): its branch's commits the change branch here hasn't. */
  unmerged?: { commits: number; branch: string };
  /** API 3.3.0: a person let its work go, and why. */
  decision?: { by: string; at: string; reason: string };
  /** API 3.3.0: whether its repo has a build command now. */
  repoBuilds?: boolean;
}
export interface Run {
  runId: string;
  agent: string;
  runtime: string;
  state: string;
  startedAt: string;
  errors: string[];
  promptPath?: string;
  /** API 2.61.0: the task run this run is part of. */
  taskRun?: TaskRunOfRun;
}
export interface TaskRunOfRun {
  task: string;
  repo: string;
  level: string;
  state: string;
  branch: string;
  worktree: string;
  notes: string[];
  commit?: string;
  log?: string;
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
  qa: T.qa,
  "release-ready": T.release,
};

// One button that runs an action and shows its outcome in words: know/common.tsx.

export function ChangeList({
  list,
  current,
  across,
  onCreated,
}: {
  list: Loaded<ChangeSummary[]>;
  current?: string;
  across?: AcrossId;
  /** UX re-walk: a change started here shows in the list at once, and opens. */
  onCreated?: () => void;
}) {
  const [text, setText] = useState("");
  const [state, setState] = useState("");
  return (
    <Panel
      title={T.changes}
      className="cw-list-panel"
      meta={list.state === "ready" ? CW.changeCount(list.data.length) : undefined}
    >
      <NewChange
        onCreated={(id) => {
          onCreated?.();
          window.location.hash = `#/changes/${id}`;
        }}
      />
      <BrokenChanges />
      <View of={list} empty={(l) => l.length === 0} emptyText={T.noChangesYetStart}>
        {(all) => {
          const states = [...new Set(all.map((c) => c.state))];
          const l = filterChanges(all, text, state);
          return (
            <div className="stack" style={{ gap: 10, marginTop: 8 }}>
              <div className="cw-list-tools">
                {/* beta.26 review: the field's name in view, not only its placeholder. */}
                <label htmlFor="change-filter" className="cw-label">
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
              <nav aria-label={T.changes} className="cw-list">
                {l.map((c) => (
                  <a
                    key={c.id}
                    href={`#/changes/${c.id}`}
                    aria-current={!across && c.id === current ? "page" : undefined}
                    // beta.26 review: the title wraps to two lines and the id wraps, so no hover
                    // title repeats what the link already says.
                    className="cw-row"
                  >
                    <span className="cw-row-main">
                      <span className="cw-row-title">{c.title}</span>
                      <span className="cw-row-sub">{c.id}</span>
                    </span>
                    <span className={`chip ${c.openFindings.blocking ? "blocking" : "dim"}`}>
                      {c.openFindings.blocking ? T.blocked : (LABEL[c.state] ?? c.state)}
                    </span>
                  </a>
                ))}
                {l.length === 0 && <p className="state">{T.noChangeMatches}</p>}
              </nav>
              <div className="cw-across">
                <span className="cw-label">{T.acrossAllChanges}</span>
                <div className="cw-across-links">
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

/**
 * A change's phases as a row of small steps (beta.26, as Home's gates): each a dot named by its
 * phase and where it stands (done, the current phase, to come), the phase's name under it.
 */
export function Pipeline({ state }: { state: string }) {
  const at = PHASES.indexOf(state);
  return (
    <ol className="cw-gates" aria-label={T.phases}>
      {PHASES.map((p, i) => (
        <li
          key={p}
          className={`cw-gate${i < at ? " done" : i === at ? " now" : ""}`}
          aria-current={i === at ? "step" : undefined}
        >
          <span
            role="img"
            className="cw-gate-dot"
            aria-label={
              i === at
                ? T.currentPhase(LABEL[p] ?? "")
                : `${LABEL[p]}: ${i < at ? T.done : T.toCome}`
            }
          >
            {i < at ? "✓" : i === at ? i + 1 : ""}
          </span>
          <span className="cw-gate-name" aria-hidden="true">
            {LABEL[p]}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** An artifact's address in the API; with `file`, that one of its files (a story, a spec). */
export const artifactUrl = (change: string, artifact: string, file?: string) =>
  `/api/changes/${change}/artifacts/${artifact}${file ? `?file=${encodeURIComponent(file)}` : ""}`;

/** A generated file's own mark ("Generated by atticus …"), which is no guidance for a person. */
const GENERATED = /^(generated|drafted) by atticus\b/i;

/**
 * Eighth UX walk: a template's guidance, its `<!-- … -->` comments, as hints to show beside the
 * text (the file keeps them: the template is unchanged). A generated file's mark isn't one.
 */
export function templateHints(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/<!--([\s\S]*?)-->/g)) {
    const hint = m[1]!.replace(/\s+/g, " ").trim();
    if (hint && !GENERATED.test(hint) && !out.includes(hint)) out.push(hint);
  }
  return out;
}

export function ArtifactEditor({
  change,
  artifact,
  file,
  onClose,
  onSaved,
  line,
}: {
  change: string;
  artifact: string;
  /** 2.72.0: one file of a many-file artifact, such as stories/<id>.md. */
  file?: string;
  onClose: () => void;
  /** Eighth UX walk: told after each save, so the page's gate reads again. */
  onSaved?: () => void;
  /** ADR 0189: the line a finding cites, selected when the file opens (Make the fix). */
  line?: number;
}) {
  const a = useApi<Artifact>(artifactUrl(change, artifact, file));
  const textId = `artifact-text${file ? `-${file.replace(/[^a-z0-9]+/gi, "-")}` : ""}`;
  const [text, setText] = useState<string | undefined>();
  const act = useAction();
  // The keyboard goes into the text once it loads, so Escape (or Close) can close it at once.
  const box = useRef<HTMLTextAreaElement>(null);
  // Someone saved meanwhile (409): the person's text is kept and the file read again, so the
  // next Save goes against the file as it is now.
  const [changedMeanwhile, setChangedMeanwhile] = useState(false);
  // Review round 46: the save's own answer (its text and sha), used until the file read again
  // lands, so the box never shows the text from before the save and the next Save goes against it.
  const [saved, setSaved] = useState<{ from: string; content: string; sha256: string }>();
  const ready = a.state === "ready";
  useEffect(() => {
    if (!ready) return;
    const b = box.current;
    b?.focus();
    // ADR 0189: the cited line, selected and scrolled to, so the fix starts where the finding is.
    if (b && line && line > 0) {
      const lines = b.value.split("\n");
      const n = Math.min(line, lines.length);
      const start = lines.slice(0, n - 1).reduce((x, l) => x + l.length + 1, 0);
      b.setSelectionRange(start, start + (lines[n - 1]?.length ?? 0));
      b.scrollTop = Math.max(0, (n - 4) * 20.8);
    }
  }, [ready, line]);
  return (
    <Panel
      title={T.edit(file ?? artifact)}
      span="1 / -1"
      meta={a.state === "ready" ? a.data.path : undefined}
    >
      <View of={a}>
        {(loaded) => {
          const d =
            saved && saved.from === loaded.sha256
              ? { ...loaded, content: saved.content, sha256: saved.sha256 }
              : loaded;
          return (
            <form
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                setChangedMeanwhile(false);
                void act.run(
                  () =>
                    api<{ content: string; sha256: string }>(artifactUrl(change, artifact, file), {
                      method: "PUT",
                      body: { content: text ?? d.content, baseSha256: d.sha256 },
                    })
                      .then((r) => {
                        setSaved({ from: loaded.sha256, content: r.content, sha256: r.sha256 });
                        setText(undefined);
                        a.reload();
                        onSaved?.();
                      })
                      .catch((e: unknown) => {
                        if (e instanceof ApiError && e.problem.status === 409)
                          setChangedMeanwhile(true);
                        throw e;
                      }),
                  T.saved(d.path),
                );
              }}
              onKeyDown={escapeCloses(onClose)}
              className="stack"
            >
              <label htmlFor={textId} className="sr">
                {T.text(file ?? artifact)}
              </label>
              {/* Eighth UX walk: the template's guidance, readable beside the text. */}
              {templateHints(d.content).length > 0 && (
                <div id={`${textId}-hints`} className="work-why" style={{ margin: 0 }}>
                  <span className="hud" style={{ fontSize: 10 }}>
                    {T.templateAsks}
                  </span>
                  <ul style={{ margin: "4px 0 0", paddingLeft: 18, lineHeight: 1.6 }}>
                    {templateHints(d.content).map((h) => (
                      <li key={h}>{h}</li>
                    ))}
                  </ul>
                </div>
              )}
              <textarea
                ref={box}
                id={textId}
                aria-describedby={
                  templateHints(d.content).length > 0 ? `${textId}-hints` : undefined
                }
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
                {/* Eighth UX walk: unsaved text is cancelled (the file stays as it was). */}
                <button type="button" className="btn" onClick={onClose}>
                  {text !== undefined && text !== d.content ? T.cancel : T.close}
                </button>
                <span className="muted" style={{ fontSize: 12 }}>
                  {T.ifSomeoneSavedMeanwhile}
                </span>
              </div>
              <Note note={act.note} />
              {changedMeanwhile && (
                <p role="alert" className="state error">
                  {T.changedMeanwhile}{" "}
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      // The text stays; the file is read again, so Save goes against it.
                      setChangedMeanwhile(false);
                      a.reload();
                    }}
                  >
                    {T.reloadKeepMine}
                  </button>
                </p>
              )}
            </form>
          );
        }}
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
  say,
}: {
  change: string;
  f: Finding;
  done: () => void;
  /**
   * Eighth UX walk: the list's own status line. An acted-on finding leaves the open ones, and
   * this note with it, so the list says what was recorded and takes the keyboard.
   */
  say?: (text: string) => void;
}) {
  const [reason, setReason] = useState("");
  const act = useAction();
  const go = (action: string) => {
    const words = T.recordedOn(action.replace(/-/g, " "), f.id);
    return act.run(
      () =>
        api(`/api/findings/${change}/${f.id}/action`, {
          method: "POST",
          body: { action, gate: f.gate, ...(reason ? { reason } : {}) },
        }).then(() => {
          say?.(words);
          done();
        }),
      words,
    );
  };
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

/**
 * beta.26 review: a change's hand-off as a chip. Its PR is a short link ("PR #42") whose target is
 * the whole address, so a narrow panel (VS Code's, about 780 px) doesn't scroll sideways.
 */
export function HandoffChip({
  handoff,
}: {
  handoff: { phase: string; state: string; pr?: string | undefined };
}) {
  const phase = handoff.phase.toUpperCase();
  if (handoff.pr && isManualLink(handoff.pr))
    return <span className="chip">{T.handOffManual(phase)}</span>;
  const number = handoff.pr ? /(\d+)\/?(?:[?#].*)?$/.exec(handoff.pr)?.[1] : undefined;
  return (
    <span className="chip">
      {T.handOff(phase, handoff.state.toUpperCase(), "")}
      {handoff.pr && (
        <>
          {" · "}
          <ExternalLink href={handoff.pr}>{CW.prShort(number)}</ExternalLink>
        </>
      )}
    </span>
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
  const findingSaid = useSaid();
  const heldId = useId();
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
    <div className="cw-detail">
      <Panel
        title={detail.state === "ready" ? `${detail.data.id} · ${detail.data.title}` : id}
        kind="hero"
        className="cw-summary-panel"
      >
        <View of={detail}>
          {(d) => (
            <div className="cw-summary">
              <Pipeline state={d.state} />
              <View of={status}>
                {(s) => (
                  <div className="cw-next">
                    <p className="cw-next-line">
                      <span className="cw-label">{T.next}</span>
                      {/* Sixth UX walk: a manual Git host's PR isn't open until a person opens it. */}
                      <span>
                        {s.handoff && isManualLink(s.handoff.pr.url) ? (
                          <ManualHandoff phase={s.handoff.phase} />
                        ) : (
                          nextStepWords(s.nextStep, s.stepFirst)
                        )}
                        {/* Beta.27 review: the step that comes first, with its button, is there. */}
                        {s.stepFirst && (
                          <>
                            {" "}
                            <GlanceLink change={id} />
                          </>
                        )}
                      </span>
                    </p>
                    <div className="cw-chips">
                      <span
                        className={`chip ${s.risk.level === "high" ? "blocking" : s.risk.level === "medium" ? "warn" : ""}`}
                      >
                        {T.risk(s.risk.level.toUpperCase())}
                      </span>

                      {d.handoff && <HandoffChip handoff={d.handoff} />}
                    </div>
                    {d.handoff?.unpushed && d.handoff.branch && (
                      <PushAgain change={d.id} branch={d.handoff.branch} onDone={reloadAll} />
                    )}
                    {s.blockers.length > 0 && (
                      <ul className="cw-blockers" aria-label={T.whatBlocksTheHand}>
                        {s.blockers.map((b) => (
                          <li key={b.message}>{b.message}</li>
                        ))}
                      </ul>
                    )}
                    {/* Beta.27 review: why Raise hand-off waits, in words on the page, not a title. */}
                    {(s.blockers.length > 0 || s.stepFirst) && (
                      <p id={heldId} className="cw-held">
                        {s.blockers.length > 0 ? T.blockedBy(s.blockers.length) : T.heldFirst}
                      </p>
                    )}
                    <div className="cw-actions">
                      <button
                        type="button"
                        className="btn primary"
                        disabled={handoff.busy || s.blockers.length > 0 || !!s.stepFirst}
                        aria-describedby={s.blockers.length > 0 || s.stepFirst ? heldId : undefined}
                        onClick={() =>
                          void handoff.run(
                            async () =>
                              api<{ notes?: string[] }>(`/api/changes/${id}/handoff`, {
                                method: "POST",
                                // ADR 0186: the click is the person's confirmation.
                                body: await confirmed("handoff", id),
                              }).then((r) => {
                                reloadAll();
                                return r;
                              }),
                            (r) => [T.handOffPrOpened, ...(r.notes ?? [])].join(" "),
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
                            async () =>
                              api(`/api/changes/${id}/sync`, {
                                method: "POST",
                                // ADR 0186: merging a ready PR is the person's confirmation.
                                body: await confirmed("merge", id),
                              }).then(reloadAll),
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
                              api<CriticRan>(`/api/changes/${id}/critic`, {
                                method: "POST",
                                body: {},
                              }).then((r) => {
                                reloadAll();
                                return r;
                              }),
                            // ADR 0189 (app-only audit): a lens is said to wait only when one does.
                            (r) =>
                              aiOn ? COPY.thread.criticRan(lensesWaiting(r)) : T.theRuleChecksRan,
                          )
                        }
                      >
                        {aiOn ? T.runTheCriticYour : T.runTheRuleChecks}
                      </button>
                    </div>
                    <Note note={handoff.note} />
                    <Note note={critic.note} />
                    {/* After the hand-off PR merges, the person's copy catches up (ADR 0183). */}
                    <BringIn />
                  </div>
                )}
              </View>
              {/* Ninth UX walk: name the change's owners per role, so each sees their questions. */}
              <ChangeOwners change={d.id} owners={d.owners} onSaved={detail.reload} />
            </div>
          )}
        </View>
      </Panel>

      {editing && <ArtifactEditor change={id} artifact={editing} onClose={closeEditor} />}

      <div className="cw-pairs">
        <Panel title={T.artifacts}>
          <View of={detail} empty={(d) => d.artifacts.length === 0}>
            {(d) => (
              <table className="cw-table">
                <thead>
                  <tr>
                    <th>{T.artifact}</th>
                    <th>{T.status}</th>
                    <th>{T.findings}</th>
                    <th>
                      <span className="sr">{T.actions}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {d.artifacts.map((a) => (
                    <tr key={a.artifact}>
                      <td className="mono">{a.artifact}</td>
                      <td>
                        <span
                          className={`chip ${a.status === "done" ? "done" : a.status === "blocked" ? "dim" : "warn"}`}
                        >
                          {artifactStatusWord(a)}
                        </span>
                      </td>
                      <td>{a.openFindings || ""}</td>
                      <td>
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
          {/* Fourth UX walk: a change whose proposal or specs aren't written yet drafts them here. */}
          {detail.state === "ready" &&
            detail.data.artifacts.some(
              (a) => (a.artifact === "proposal" || a.artifact === "specs") && a.status !== "done",
            ) && <RunStep command={`atticus change draft ${id}`} />}
        </Panel>

        <Panel
          title={T.openFindings}
          meta={findings.state === "ready" ? findings.data.length : undefined}
        >
          <Said said={findingSaid.said} />
          <View of={findings} empty={(f) => f.length === 0} emptyText={T.noOpenFindingsOn}>
            {(list) => (
              <div className="stack" style={{ gap: 0 }}>
                {list.map((f) => (
                  <article key={`${f.gate}/${f.id}`} className="cw-finding">
                    <div className="cw-chips">
                      <span
                        className={`chip ${f.severity === "blocking" ? "blocking" : f.severity === "gap" ? "warn" : "dim"}`}
                      >
                        {f.severity.toUpperCase()}
                      </span>
                      <span className="cw-row-sub">
                        {f.gate} · {f.lens ?? T.checks} · {f.artifact}
                      </span>
                    </div>
                    <div className="cw-finding-what">{f.question?.text ?? f.summary}</div>
                    <div className="cw-finding-why">{f.why}</div>
                    <FindingActions change={id} f={f} done={reloadAll} say={findingSaid.say} />
                  </article>
                ))}
              </div>
            )}
          </View>
        </Panel>

        <Panel title={T.tasks}>
          <View of={tasks} empty={(t) => t.length === 0} emptyText={T.noTasksYetThey}>
            {(list) =>
              list.map((t) => (
                <div key={t.id} className="list-row">
                  <span className="cw-row-main">
                    <span style={{ fontSize: 12.5 }}>
                      <span className="mono">{t.id}</span> {t.description}
                    </span>
                    <span className="cw-row-sub">
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
                                // runtime.yaml's level, lowered to the repo's cap, at most draft.
                                task: t.id,
                              },
                            }).then(reloadAll),
                          T.taskHanded(t.id),
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

        <Panel title={T.aiRuns}>
          <View of={runs} empty={(r) => r.length === 0} emptyText={T.noAiRunsYet}>
            {(list) =>
              list
                .slice()
                .reverse()
                .map((r) => (
                  <div key={r.runId} className="list-row" style={{ alignItems: "flex-start" }}>
                    <span className="cw-row-main">
                      <span style={{ fontSize: 12.5 }}>{r.agent}</span>
                      {/* beta.26 review: the prompt's path wraps whole, not cut to a hover title. */}
                      <span className="cw-row-sub">
                        {r.runtime} · {r.promptPath ?? r.runId}
                      </span>
                      {r.errors.length > 0 && (
                        <span style={{ color: "var(--magenta-text)", fontSize: 12 }}>
                          {r.errors.join("; ")}
                        </span>
                      )}
                      {r.taskRun && (
                        <TaskRunLine
                          of={r.taskRun}
                          pr={
                            tasks.state === "ready"
                              ? tasks.data.find((x) => x.id === r.taskRun!.task)?.taskRun?.pr?.state
                              : undefined
                          }
                        />
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
                          disabled={runAct.busy}
                          onClick={() =>
                            void runAct.run(
                              () => callAsJob(`/api/runs/${r.runId}/done`).then(reloadAll),
                              T.checkedTheAnswer,
                            )
                          }
                        >
                          {T.markDone}
                        </button>
                      )}
                      {(r.state === "waiting" || r.state === "prepared") && (
                        <button
                          type="button"
                          className="btn"
                          disabled={runAct.busy}
                          onClick={() =>
                            void runAct.run(
                              () =>
                                api(`/api/runs/${r.runId}/cancel`, {
                                  method: "POST",
                                  body: {},
                                }).then(reloadAll),
                              T.runCancelled,
                            )
                          }
                        >
                          {T.cancelRun}
                        </button>
                      )}
                      {r.state === "failed" && (
                        <button
                          type="button"
                          className="btn"
                          disabled={runAct.busy}
                          onClick={() =>
                            void runAct.run(
                              () =>
                                api(`/api/runs/${r.runId}/retry`, {
                                  method: "POST",
                                  body: {},
                                }).then(reloadAll),
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

        <ChangeInputs change={id} />

        <ChangePrototypes change={id} />
      </div>

      {/* ADR 0102: what the change needs from the organisation. */}
      <NeedsPanel change={id} span="1 / -1" />
    </div>
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
    <div className="cw-split">
      <ChangeList list={list} current={current} across={across} onCreated={list.reload} />
      {across && !id ? (
        <AcrossPanel key={across} view={across} />
      ) : current ? (
        <Detail key={current} id={current} />
      ) : (
        <Panel title={T.noChangeSelected}>
          <p className="state">{T.pickAChangeOn}</p>
        </Panel>
      )}
    </div>
  );
}

/** Where a run's task stands: its state, its last note (stopped, a person takes over) and log. */
export function TaskRunLine({
  of: t,
  pr,
}: {
  of: TaskRunOfRun;
  /** Eighth UX walk: the task's PR state on the Git host now, from the tasks view. */
  pr?: "open" | "merged" | "closed" | undefined;
}) {
  const alert = t.state === "needs-person" || t.state === "failed";
  const last = t.notes.at(-1);
  return (
    <span className="stack" style={{ gap: 2, fontSize: 12 }}>
      <span className={`chip ${alert ? "blocking" : t.state === "waiting" ? "ai" : "done"}`}>
        {T.taskRunLine(t.task, t.state, pr)}
      </span>
      {last && (
        <span
          role={alert ? "alert" : undefined}
          style={alert ? { color: "var(--magenta-text)" } : undefined}
        >
          {last}
        </span>
      )}
      {t.log && <code className="mono">{T.taskRunLog(t.log)}</code>}
    </span>
  );
}
