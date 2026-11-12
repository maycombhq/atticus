import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { BriefForm } from "../BriefForm.js";
import type { Api } from "@maycombhq/core";
import { RunStep } from "../../app/runstep.js";
import { inAppWords } from "../../app/app-words.js";
import { message } from "../run/shared.js";
import { api, ApiError, useApi, useLiveEvents } from "../../api/client.js";
import { confirmed } from "../../api/confirm.js";
import { Bar, Donut, ExternalLink, Panel, Ring, View } from "../../app/ui.js";
import {
  ArtifactEditor,
  artifactUrl,
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
import { lensesWaiting, type CriticRan } from "../work/critic-ran.js";
import { NoChangeYet } from "../work/RunNext.js";
import { ChangeInputs } from "../ChangeInputs.js";
import { ChangePrototypes } from "../ChangePrototypes.js";
import { RunReadyTasks } from "./run-ready.js";
import {
  ChangeWaiting,
  Markdown,
  Note,
  queryParam,
  Said,
  Table,
  useAction,
  useChange,
  useSaid,
  useView,
} from "./common.js";
import {
  isManualLink,
  ManualHandoff,
  runIsTheStep,
  TaskRunState,
  taskRunsShown,
  TaskTick,
} from "./task-pr.js";

const T = COPY.phase;

const SEV_CHIP: Record<string, string> = {
  blocking: "blocking",
  gap: "warn",
  risk: "warn",
  idea: "dim",
};

/** The change a phase screen works on, its phase, the gate and what to do next. */
export function GateHeader(p: {
  part: "hero" | "gate";
  id: string;
  title: string;
  picker: ReactNode;
  critic?: string;
  reload: () => void;
  /** Eighth UX walk: bumped when an artifact was saved on the page; the gate reads again. */
  refresh?: number;
}) {
  const detail = useApi<ChangeDetail>(`/api/changes/${p.id}`);
  const status = useApi<Status>(`/api/changes/${p.id}/status`);
  const act = useAction();
  const aiOn = useAiOn();
  // Eighth UX walk: a saved brief no longer reads "still holds only the template" until reload.
  useEffect(() => {
    if (!p.refresh) return;
    detail.reload();
    status.reload();
  }, [p.refresh]);
  useLiveEvents((e) => {
    if (e.type !== "file.changed") return;
    detail.reload();
    status.reload();
  });
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
                {d.handoff
                  ? isManualLink(d.handoff.pr)
                    ? T.handOffManual(d.handoff.phase)
                    : T.handOff(d.handoff.phase, d.handoff.state)
                  : ""}
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
            {/* Sixth UX walk: a manual Git host's PR isn't open until a person opens it. */}
            <p style={{ margin: 0, lineHeight: 1.5 }}>
              {s.handoff && isManualLink(s.handoff.pr.url) ? (
                <ManualHandoff phase={s.handoff.phase} />
              ) : (
                s.nextStep
              )}
            </p>
            {s.blockers.length > 0 && (
              <ul
                style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: "var(--magenta-text)" }}
              >
                {s.blockers.map((b, i) => (
                  <li key={i}>{b.message}</li>
                ))}
              </ul>
            )}
            {s.handoff && isManualLink(s.handoff.pr.url) ? null : s.handoff ? (
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
                        api<CriticRan>(`/api/changes/${p.id}/critic`, {
                          method: "POST",
                          body: {},
                        }).then((r) => {
                          done();
                          return r;
                        }),
                      // ADR 0189 (app-only audit): a lens is said to wait only when one does.
                      (r) => (aiOn ? COPY.thread.criticRan(lensesWaiting(r)) : T.theRuleChecksRan2),
                    )
                  }
                >
                  {aiOn ? T.runTheCritic : T.runTheRuleChecks}
                </button>
              )}
              <RaiseHandoff
                change={p.id}
                blockers={s.blockers.length}
                {...(s.stepFirst ? { first: s.nextStep } : {})}
                onDone={done}
                act={act}
              />
              <button
                type="button"
                className="btn"
                disabled={act.busy}
                onClick={() =>
                  void act.run(
                    // ADR 0186: merging a ready PR is the person's confirmation.
                    async () =>
                      api(`/api/changes/${p.id}/sync`, {
                        method: "POST",
                        body: await confirmed("merge", p.id),
                      }).then(done),
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

/**
 * Raise hand-off: the person's click is the approval to open the phase's hand-off PR (ADR
 * 0073). Held while something blocks the gate, with how many. The gate and At a glance use it;
 * given `act`, it shares that note, else it says its own.
 */
export function RaiseHandoff(p: {
  change: string;
  blockers: number;
  /** Eighth UX walk: what blocks the gate isn't read yet, so it waits rather than flicker on. */
  held?: boolean;
  /** Beta.27 review: another step comes first, in At a glance's words: held, and said. */
  first?: string;
  onDone?: () => void;
  act?: ReturnType<typeof useAction>;
}) {
  const own = useAction();
  const act = p.act ?? own;
  const why = useId();
  const blocked = p.blockers > 0 || !!p.first;
  const button = (
    <button
      type="button"
      className="btn primary"
      disabled={act.busy || blocked || p.held === true}
      title={blocked ? (p.blockers > 0 ? T.blockedBy(p.blockers) : p.first) : undefined}
      aria-describedby={blocked ? why : undefined}
      onClick={() =>
        void act.run(
          async () =>
            api<{ notes?: string[] }>(`/api/changes/${encodeURIComponent(p.change)}/handoff`, {
              method: "POST",
              // ADR 0186: the click is the person's confirmation.
              body: await confirmed("handoff", p.change),
            }).then(
              (r) => {
                p.onDone?.();
                return r;
              },
              // ADR 0188: a refusal that names a flag (pass --repo) in the app's words.
              (e: unknown) => {
                throw new Error(inAppWords(message(e)), { cause: e });
              },
            ),
          (r) => [T.handOffPrRaised, ...(r.notes ?? [])].join(" "),
        )
      }
    >
      {T.raiseHandOff}
    </button>
  );
  // Eighth UX walk: held, it says why where it is seen, not only in a tooltip.
  const reason = blocked && (
    <span id={why} className="muted" style={{ fontSize: 12 }}>
      {p.blockers > 0 ? T.blockedBy(p.blockers) : p.first}
    </span>
  );
  if (p.act)
    return (
      <>
        {button}
        {reason}
      </>
    );
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div>{button}</div>
      {reason}
      <Note note={act.note} />
    </div>
  );
}

/**
 * Whether a change has an artifact to show: the ones its detail lists (an Atticus 2 change lists
 * the stages' and only the others that are there). Undefined while the detail loads; true when it
 * can't be read, so the artifact is asked for as before. Exported for tests.
 */
export function listsArtifact(
  detail: Pick<ChangeDetail, "artifacts"> | "error" | undefined,
  artifact: string,
): boolean | undefined {
  if (detail === "error") return true;
  return detail ? detail.artifacts.some((a) => a.artifact === artifact) : undefined;
}

/**
 * One artifact, rendered; Edit opens the editor in place. One the change doesn't have (an
 * Atticus 1 artifact on an Atticus 2 change) says so, without asking the server for it.
 */
export function ArtifactPanel({
  change,
  artifact,
  listed,
  span,
  file,
  title: named,
  onSaved,
}: {
  change: string;
  artifact: string;
  /** Whether the change lists it (listsArtifact). */
  listed: boolean | undefined;
  span?: string;
  /** Seventh UX walk: one file of a many-file artifact (a story), read and edited alone. */
  file?: string;
  title?: string;
  /** Eighth UX walk: told after each save, so the page's gate reads again. */
  onSaved?: () => void;
}) {
  const a = useApi<Artifact & { artifact: string }>(
    listed ? artifactUrl(change, artifact, file) : undefined,
  );
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
        {...(file ? { file } : {})}
        {...(onSaved ? { onSaved } : {})}
        onClose={() => {
          setEdit(false);
          a.reload();
        }}
      />
    );
  const title = named ?? artifact[0]!.toUpperCase() + artifact.slice(1);
  if (listed === false)
    return (
      <Panel title={title} span={span}>
        <div className="state">{T.noSuchArtifact(artifact)}</div>
      </Panel>
    );
  // Not written yet is a 404; any other failure is said as one, with a way to try again.
  const missing =
    a.state === "error" &&
    (a.status === 404 ||
      (a.status === undefined && /not found|no such|isn't there/i.test(a.error)));
  return (
    <Panel
      title={title}
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
        <div className="stack" style={{ gap: 6 }}>
          <div className="state">{T.notWrittenYetFor}</div>
          {/* Third UX walk: a new change's proposal and specs are drafted from here. */}
          {(artifact === "proposal" || artifact === "specs") && (
            <RunStep command={`atticus change draft ${change}`} />
          )}
        </div>
      ) : (
        <View of={a}>
          {(d) =>
            d.content === "" ? (
              <div className="stack" style={{ gap: 6 }}>
                <div className="state">{T.notWrittenYetEdit}</div>
                {(artifact === "proposal" || artifact === "specs") && (
                  <RunStep command={`atticus change draft ${change}`} />
                )}
              </div>
            ) : (
              <div className="stack" style={{ gap: 6 }}>
                <div
                  tabIndex={0}
                  role="region"
                  aria-label={T.text(artifact)}
                  style={{ maxHeight: 520, overflowY: "auto", paddingRight: 6 }}
                >
                  <Markdown text={d.content} />
                </div>
                {/* ADR 0191: the file's path behind Details, never the main label. */}
                <details>
                  <summary className="muted" style={{ fontSize: 11.5 }}>
                    {COPY.roleWork.passage.details}
                  </summary>
                  <span className="mono muted" style={{ fontSize: 11 }}>
                    {d.path}
                  </span>
                </details>
              </div>
            )
          }
        </View>
      )}
    </Panel>
  );
}

/** ADR 0191: a review question's name in plain words ("Is it complete?"), not its id. */
export function lensWords(lens: string): string {
  return COPY.roleWork.lens[lens] ?? lens.replace(/-/g, " ");
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
  const findingSaid = useSaid();
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
      <Said said={findingSaid.said} />
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
                    {/* ADR 0191: the review question in words, not the lens's id; the file under Details. */}
                    {x.lens && <span className="chip ai">{lensWords(x.lens)}</span>}
                  </span>
                  <span style={{ fontSize: 13 }}>{x.summary}</span>
                </button>
                {open === x.id && (
                  <div className="stack" style={{ gap: 8, marginTop: 8 }}>
                    <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
                      {x.why}
                    </p>
                    <details>
                      <summary className="muted" style={{ fontSize: 11.5 }}>
                        {COPY.roleWork.passage.details}
                      </summary>
                      <span className="mono muted" style={{ fontSize: 10.5 }}>
                        {x.artifact}
                      </span>
                    </details>
                    {x.question && (
                      <p style={{ margin: 0, fontSize: 12.5 }}>
                        {T.question(
                          x.question.owner ? T.for(x.question.owner) : "",
                          x.question.text,
                        )}
                      </p>
                    )}
                    <FindingActions
                      change={change}
                      f={x}
                      done={() => f.reload()}
                      say={findingSaid.say}
                    />
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
  // Eighth UX walk: an artifact saved here makes the gate read again.
  const [saved, setSaved] = useState(0);
  // Which of its artifacts the change has: an Atticus 1 page asks only for those (2026-10-25).
  const detail = useApi<ChangeDetail>(c.id ? `/api/changes/${c.id}` : undefined);
  const known =
    detail.state === "ready" ? detail.data : detail.state === "error" ? "error" : undefined;
  if (c.none) return <NoChange />;
  if (!c.id) return <ChangeWaiting list={c.list} title={p.title} />;
  const header = {
    id: c.id,
    title: p.title,
    picker: c.picker,
    ...(p.critic ? { critic: p.critic } : {}),
    reload: () => setTick(tick + 1),
    refresh: saved,
  };
  return (
    <div className="bento" key={c.id}>
      <div className="column" style={{ gridColumn: "span 8" }}>
        <GateHeader part="hero" {...header} />
        {p.main?.(c.id)}
        {p.artifacts.map((a) =>
          // ADR 0191: the product owner writes the brief in a form, one box per section.
          a === "brief" && listsArtifact(known, a) !== false ? (
            <BriefForm
              key={a}
              change={c.id!}
              onSaved={() => {
                setSaved((n) => n + 1);
                detail.reload();
              }}
            />
          ) : (
            <ArtifactPanel
              key={a}
              change={c.id!}
              artifact={a}
              listed={listsArtifact(known, a)}
              onSaved={() => {
                setSaved((n) => n + 1);
                detail.reload();
              }}
            />
          ),
        )}
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
      // Round 36 (UX review): the export is attached and the prototype compared from here, not
      // only from a terminal; the same code as atticus change attach (and --prototype).
      extra={(id) => (
        <>
          <Panel title={T.bringInAPrototype} span="span 4">
            <p className="muted" style={{ margin: 0, fontSize: 12.5, lineHeight: 1.6 }}>
              {T.attachADesignExport}
              <span className="mono">{T.inputs}</span>
              {T.screenAtticusReadsThe}
            </p>
          </Panel>
          <ChangeInputs change={id} />
          <ChangePrototypes change={id} />
        </>
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

/**
 * What the drift check found. Eighth UX walk: nothing open before any task has run isn't "in
 * sync" (there is no code to compare yet), so it says no code yet.
 */
export function DriftSummary({ open, codeYet }: { open: Drift["findings"]; codeYet: boolean }) {
  if (open.length === 0 && !codeYet)
    return (
      <>
        <span className="chip dim" style={{ width: "fit-content" }}>
          {T.noCodeYet}
        </span>
        <span className="muted" style={{ fontSize: 12 }}>
          {T.noCodeYetWhy}
        </span>
      </>
    );
  if (open.length === 0)
    return (
      <span className="chip done" style={{ width: "fit-content" }}>
        {T.inSync}
      </span>
    );
  return (
    <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6, fontSize: 12.5 }}>
      {open.map((f) => (
        <li key={f.id}>
          <span className={`chip ${SEV_CHIP[f.severity] ?? ""}`}>{f.severity.toUpperCase()}</span>{" "}
          {f.summary}
        </li>
      ))}
    </ul>
  );
}

function DriftPanel({ change }: { change: string }) {
  const d = useView<Drift>("drift", change);
  // Code exists once a task has run with AI or been ticked; a list that doesn't read counts as yes.
  const tasks = useApi<Task[]>(`/api/changes/${encodeURIComponent(change)}/tasks`);
  const codeYet =
    tasks.state !== "ready" || tasks.data.some((t) => t.done || t.taskRun !== undefined);
  return (
    <Panel title={T.designVsPlansVs} span="span 4">
      <View of={tasks.state === "loading" ? { state: "loading" } : d}>
        {(x) => (
          <div className="stack" style={{ gap: 8 }}>
            <span className="hud" style={{ fontSize: 10 }}>
              {x.plans.length ? T.repoPlansCompared(x.plans.length) : T.noRepoPlansYet}
            </span>
            <DriftSummary open={x.findings.filter((f) => f.state === "open")} codeYet={codeYet} />
          </div>
        )}
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
  /** The change's file the hop was read from (ADR 0129): mappings.md, or a target flow. */
  from?: string;
}

/** Where a hop's rows came from, in the reader's words; nothing when the API didn't say. */
export function hopSource(from: string | undefined): string | undefined {
  if (!from) return undefined;
  if (from === "mappings.md") return T.readFromMappingsFile;
  const flow = from.replace(/^target-flows\//, "").replace(/\.yaml$/, "");
  return T.readFromTargetFlow(flow);
}

/**
 * Each hop's field mappings, beside what the catalog maps today (ADR 0048). The rows come from
 * `mappings.md` on a change that has one, and from the architecture stage's target flows on a
 * change taken through the stages (ADR 0129 §2.3); each hop says which.
 */
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
              <section
                key={`${h.from ?? ""}#${h.line}`}
                aria-label={h.heading}
                className="stack"
                style={{ gap: 6 }}
              >
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
                {hopSource(h.from) && (
                  <span className="hud" style={{ fontSize: 10 }}>
                    {hopSource(h.from)}
                  </span>
                )}
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

/**
 * Eighth UX walk: stories have one path, the stories stage's Prepare on its tab (where the critic
 * checks each draft). Breakdown links to it and runs nothing of its own; once the stage is done,
 * it says so and the tab offers Run again under a disclosure.
 */
export function StoriesAtTheStage({ change }: { change: string }) {
  const v = useApi<Api.StageReviewViewT>(
    `/api/changes/${encodeURIComponent(change)}/stages/stories`,
  );
  const href = `#/stories?change=${encodeURIComponent(change)}`;
  // The link is there whatever the stage's state reads as; only the words follow it.
  const done = v.state === "ready" && v.data.loop.state === "done";
  return (
    <Panel title={T.storiesAndTasks} span="span 4">
      <div className="stack" style={{ gap: 8 }}>
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
          {done ? T.storiesStageDone : T.storiesAtTheStage}
        </p>
        <p style={{ margin: 0 }}>
          <a className={done ? undefined : "btn primary"} href={href}>
            {T.openStoriesStage}
          </a>
        </p>
      </div>
    </Panel>
  );
}

/**
 * Seventh UX walk: the stories themselves on the Stories tab, as Breakdown shows them, each with
 * Edit: the index, then each story's own file (the story bar lists them), read-only until Edit.
 */
export function StoryFiles({
  change,
  listed,
}: {
  change: string;
  /** Whether the change lists its stories (listsArtifact). */
  listed: boolean | undefined;
}) {
  const bar = useView<StoryBar>("story-bar", change, listed === false);
  const W = COPY.work;
  return (
    <>
      <ArtifactPanel
        change={change}
        artifact="stories"
        listed={listed}
        span="1 / -1"
        title={W.storiesIndex}
      />
      {listed !== false && (
        <View
          of={bar}
          empty={(b) => !b || b.stories.length === 0}
          emptyContent={<div className="state">{W.noStoryFiles}</div>}
        >
          {(b) => (
            <>
              {b.stories.map((s) => (
                <ArtifactPanel
                  key={s.path}
                  change={change}
                  artifact="stories"
                  listed={listed}
                  file={s.path}
                  span="1 / -1"
                  title={W.storyFile(s.id)}
                />
              ))}
            </>
          )}
        </View>
      )}
    </>
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
          <StoriesAtTheStage change={id} />
          <TasksByRepo change={id} span="span 4" compact />
        </>
      )}
    />
  );
}

// ------------------------------------------------------------------ Build

/** A task's row on the Task board, for a link's `?task=` (an id is safe in an element id). */
const taskRowId = (task: string) => `task-row-${task.replace(/[^A-Za-z0-9_-]/g, "-")}`;

/**
 * Ninth UX walk: what a task waits for, in words ("Waits for 1.1 (same repo)"); undefined when it
 * waits for nothing or is done.
 */
export function taskWaitsWords(t: Pick<Task, "done" | "waits">): string | undefined {
  if (t.done || !t.waits?.tasks.length) return undefined;
  const same = new Set(t.waits.sameRepo);
  return T.waitsForTasks(
    t.waits.tasks.map((id) => (same.has(id) ? T.sameRepo(id) : id)).join(", "),
  );
}

/** Review round 46: the tasks whose state differs between two reads of the board (or left it). */
export function tasksThatChanged(before: readonly Task[], after: readonly Task[]): Set<string> {
  const now = new Map(after.map((t) => [t.id, JSON.stringify(t)]));
  const out = new Set<string>();
  for (const t of before) if (now.get(t.id) !== JSON.stringify(t)) out.add(t.id);
  return out;
}

/** The same per-task record without the tasks named; the same object when none is in it. */
export function withoutTasks<V>(o: Record<string, V>, ids: ReadonlySet<string>): Record<string, V> {
  if (!Object.keys(o).some((k) => ids.has(k))) return o;
  return Object.fromEntries(Object.entries(o).filter(([k]) => !ids.has(k)));
}

function TasksByRepo({
  change,
  span,
  compact,
  focus,
}: {
  change: string;
  span: string;
  compact?: boolean;
  /** Seventh UX walk: the task a link asked for (`?task=`), scrolled to and focused once. */
  focus?: string | undefined;
}) {
  const tasks = useApi<Task[]>(`/api/changes/${change}/tasks`);
  const aiOn = useAiOn();
  const focused = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!focus || tasks.state !== "ready" || focused.current === focus) return;
    const row = document.getElementById(taskRowId(focus));
    if (!row) return;
    focused.current = focus;
    row.scrollIntoView({ block: "center" });
    row.focus({ preventScroll: true });
  }, [focus, tasks.state]);
  const [ran, setRan] = useState<Record<string, string>>({});
  // UX re-walk: the run a task's Run with AI prepared, to open (its prompt, Done and Cancel).
  const [runOf, setRunOf] = useState<Record<string, string>>({});
  const [running, setRunning] = useState<Record<string, boolean>>({});
  // Sixth UX walk: a run's Done (or a PR raised elsewhere) moves a task on: the board follows,
  // and each task's own line says where it stands from then on.
  useLiveEvents((e) => {
    if (e.type !== "run.changed" && e.type !== "file.changed") return;
    tasks.reload();
  });
  // Review round 46: a task's own message goes only when that task's state changed in the board
  // read again; any other file's change leaves every message where it is.
  const board = tasks.state === "ready" ? tasks.data : undefined;
  const seen = useRef<readonly Task[] | undefined>(undefined);
  useEffect(() => {
    if (!board) return;
    const before = seen.current;
    seen.current = board;
    if (!before) return;
    const moved = tasksThatChanged(before, board);
    if (moved.size === 0) return;
    setRan((o) => withoutTasks(o, moved));
    setRunOf((o) => withoutTasks(o, moved));
  }, [board]);
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
      say(t.id, T.runPrepared(r.runId));
      setRunOf((o) => ({ ...o, [t.id]: r.runId }));
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
                          id={taskRowId(x.id)}
                          tabIndex={x.id === focus ? -1 : undefined}
                          aria-current={x.id === focus ? "true" : undefined}
                          className="stack"
                          style={{
                            gap: 4,
                            padding: "6px 0 6px 10px",
                            borderLeft: `2px solid ${x.done ? "var(--green)" : x.id === focus ? "var(--accent)" : "var(--line-2)"}`,
                          }}
                        >
                          <div className="row between" style={{ alignItems: "flex-start" }}>
                            <span style={{ fontSize: 13 }}>
                              <span className="mono muted">{x.id}</span> {x.description}
                            </span>
                            {x.done ? (
                              <span className="chip done">{T.done2}</span>
                            ) : !runIsTheStep(x) ? null : aiOn ? (
                              // Sixth UX walk: a drafted task's step is its PR, said below.
                              <button
                                type="button"
                                className="btn"
                                disabled={running[x.id]}
                                onClick={() => void run(x)}
                              >
                                {x.taskRun ? T.runAgainWithAi : T.runWithAi}
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
                          {!ran[x.id] && (
                            <TaskRunState change={change} task={x} onDone={tasks.reload} />
                          )}
                          {taskWaitsWords(x) && (
                            <span className="muted" style={{ fontSize: 12 }}>
                              {taskWaitsWords(x)}
                            </span>
                          )}
                          <TaskTick change={change} task={x} onDone={tasks.reload} />
                          {ran[x.id] && (
                            <span role="status" style={{ fontSize: 12 }}>
                              {ran[x.id]}{" "}
                              {runOf[x.id] && (
                                <a href={`#/runs?run=${encodeURIComponent(runOf[x.id]!)}`}>
                                  {T.openTheRun}
                                </a>
                              )}
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
  // Ninth UX walk: a task with the assistant names its run; it counts here too.
  const tasks = useApi<Task[]>(`/api/changes/${encodeURIComponent(change)}/tasks`);
  useLiveEvents((e) => {
    if (e.type === "run.changed" || e.type === "file.changed") {
      runs.reload();
      tasks.reload();
    }
  });
  // Sixth UX walk: the task runs only; the critics' and stages' runs are on Model runs.
  const mine =
    runs.state === "ready"
      ? taskRunsShown(runs.data, tasks.state === "ready" ? tasks.data : undefined)
      : [];
  const passed = mine.filter((r) => r.state === "validated").length;
  return (
    <Panel title={T.aiTaskRuns} span="span 4" kind="dark">
      <View of={runs} empty={() => mine.length === 0} emptyText={T.noTaskRunsYet}>
        {() => (
          <div className="stack" style={{ gap: 8 }}>
            <div className="row">
              <Ring
                value={passed}
                max={mine.length}
                size={60}
                label={T.ofRunsFinished(passed, mine.length)}
              />
              <span className="muted" style={{ fontSize: 12 }}>
                {T.everyWriteIsApproved}
              </span>
            </div>
            {mine.slice(-8).map((x) => (
              <div key={x.runId} className="list-row">
                <span className="stack" style={{ gap: 2 }}>
                  <a
                    className="mono"
                    style={{ fontSize: 11.5 }}
                    href={`#/runs?run=${encodeURIComponent(x.runId)}`}
                  >
                    {x.runId}
                  </a>
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
        {/* ADR 0181 part 4: the tech lead or architect runs every ready task, beside Run with AI. */}
        <RunReadyTasks change={c.id} />
      </Panel>
      <TasksByRepo change={c.id} span="span 8" focus={queryParam(hash, "task")} />
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
