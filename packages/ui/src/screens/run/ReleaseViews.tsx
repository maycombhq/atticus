import { useEffect, useState, type FormEvent } from "react";
import { api, useApi } from "../../api/client.js";
import { hostBridge } from "../../api/bridge.js";
import { COPY } from "../../copy.js";
import { Panel, View } from "../../app/ui.js";
import { Choice, CopyButton, Note, day, plural, useAction } from "./shared.js";

const TX = COPY.releaseViews;

/**
 * The generated views of a change on the Release screen (ADR 0045): the deployment plan and its
 * forecast, the release sections from design.md, the security review draft, release notes,
 * outcomes after release and the evidence pack export. Each is computed from files on every
 * read, so it never goes stale; where the data isn't there the panel says so in words.
 */

interface RequestWait {
  heading: string;
  requestType: string;
  record?: string;
  state: "to-file" | "waiting" | "filed";
  number?: string;
  leadTimeDays?: number;
  leadTimeSource?: string;
  waitDays?: number;
  readyBy?: string;
  missing: string[];
  source: string;
  why: string;
}
interface PlanStep {
  n: number;
  repo: string;
  kind: "migration" | "topic" | "gateway-route" | "code";
  what: string[];
  why: string[];
  after: number[];
  rollback: { text?: string; source?: string; gap?: string };
  waitsOn: RequestWait[];
  earliest: string;
  waitDays: number;
}
interface PlanSection {
  name: string;
  heading?: string;
  source?: string;
  text?: string;
  gap?: string;
}
interface Forecast {
  ready?: string;
  basis: string;
  status: "released" | "on-track" | "at-risk" | "late" | "no-target";
  target?: { date: string; source: string };
  waitDays: number;
  drivers: { what: string; until: string; days: number; source: string }[];
  tasks: { total: number; open: number; done: number; waitingOnRequests: string[] };
  initiative?: { id: string; title: string; criticalPath: string[] };
  notes: string[];
}
interface Plan {
  steps: PlanStep[];
  before: RequestWait[];
  external: { name: string; what: string; beforeStep?: number }[];
  unplaced: { id: string; why: string }[];
  sections: PlanSection[];
  findings: { id: string; severity: string; summary: string; path: string }[];
  gaps: string[];
  notes: string[];
  forecast: Forecast;
}

const KIND: Record<PlanStep["kind"], string> = {
  migration: "MIGRATION",
  topic: "TOPIC",
  "gateway-route": TX.gatewayRoute,
  code: "CODE",
};
const SECTION: Record<string, string> = {
  rollout: TX.rollout,
  rollback: TX.rollback2,
  readiness: TX.readiness,
  verification: TX.verification,
  hypercare: TX.hypercare,
};
const STATUS: Record<Forecast["status"], { label: string; chip: string }> = {
  released: { label: "RELEASED", chip: "done" },
  "on-track": { label: TX.onTrack, chip: "done" },
  "at-risk": { label: TX.atRisk, chip: "warn" },
  late: { label: "LATE", chip: "blocking" },
  "no-target": { label: TX.noTarget, chip: "dim" },
};

/** Reload a view whenever the screen hears a file changed (the tick comes from the screen). */
function useReloadOn<T extends { reload: () => void }>(x: T, tick: number): T {
  useEffect(() => {
    if (tick) x.reload();
  }, [tick]);
  return x;
}

function waitText(w: RequestWait): string {
  const state =
    w.state === "filed"
      ? `filed${w.number ? ` as ${w.number}` : ""}`
      : w.state === "waiting"
        ? TX.waitingForAPerson
        : TX.notFiled;
  return `${w.requestType}${w.record ? ` for ${w.record}` : ""}: ${state}${w.readyBy ? `, ready by ${w.readyBy} (${plural(w.waitDays ?? 0, TX.workingDay)})` : TX.noLeadTimeTo}${w.missing.length ? `. Missing ${w.missing.join(", ")}` : ""}.`;
}

/** The deployment plan, its forecast and the release sections: one read, three panels. */
export function PlanPanels({ id, tick }: { id: string; tick: number }) {
  const p = useReloadOn(useApi<Plan>(`/api/release/${id}/plan`), tick);
  return (
    <>
      <Panel
        title={TX.deploymentPlan}
        meta={p.state === "ready" ? plural(p.data.steps.length, "step") : TX.computed}
        span="span 5"
      >
        <View of={p} empty={(x) => x.steps.length === 0} emptyText={TX.nothingToDeployYet}>
          {(x) => (
            <div className="stack" style={{ gap: 10 }}>
              <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                {TX.workedOutFromInterfaces}
              </p>
              {x.before.length > 0 && (
                <div className="list-row" style={{ alignItems: "flex-start" }}>
                  <span className="stack" style={{ gap: 2 }}>
                    <span style={{ fontSize: 12.5 }}>{TX.n0BeforeAnything}</span>
                    {x.before.map((w) => (
                      <span key={w.heading} className="muted" style={{ fontSize: 12 }}>
                        {waitText(w)} <span className="hud">{w.source}</span>
                      </span>
                    ))}
                  </span>
                </div>
              )}
              <ol
                aria-label={TX.deployOrder}
                className="stack"
                style={{ listStyle: "none", margin: 0, padding: 0, gap: 0 }}
              >
                {x.steps.map((s) => (
                  <li
                    key={s.n}
                    className="list-row"
                    style={{ alignItems: "flex-start", padding: "8px 0" }}
                  >
                    <span className="stack" style={{ gap: 3, minWidth: 0 }}>
                      <span style={{ fontSize: 12.5 }}>
                        {s.n} · <span className="mono">{s.repo}</span>
                        {s.waitDays > 0 && (
                          <span className="muted" style={{ fontSize: 11.5 }}>
                            {TX.from(s.earliest)}
                          </span>
                        )}
                      </span>
                      {s.what.map((w) => (
                        <span key={w} style={{ fontSize: 12 }}>
                          {w}
                        </span>
                      ))}
                      {s.why.map((w) => (
                        <span key={w} className="muted" style={{ fontSize: 11.5 }}>
                          {w}
                        </span>
                      ))}
                      {s.waitsOn.map((w) => (
                        <span key={w.heading} style={{ fontSize: 11.5, color: "var(--amber)" }}>
                          {TX.waitsOn(waitText(w))}
                        </span>
                      ))}
                      <span style={{ fontSize: 11.5 }}>
                        <span className="hud" style={{ fontSize: 9.5, marginRight: 6 }}>
                          {TX.rollback}
                        </span>
                        {s.rollback.text ? (
                          <>
                            {s.rollback.text}{" "}
                            <span className="hud" style={{ fontSize: 9.5 }}>
                              {s.rollback.source}
                            </span>
                          </>
                        ) : (
                          <span style={{ color: "var(--magenta-text)" }}>{s.rollback.gap}</span>
                        )}
                      </span>
                    </span>
                    <span className={`chip ${s.kind === "code" ? "dim" : "warn"}`}>
                      {KIND[s.kind]}
                    </span>
                  </li>
                ))}
              </ol>
              {x.external.map((e) => (
                <p key={e.what} className="muted" style={{ margin: 0, fontSize: 12 }}>
                  {e.what}
                  {e.beforeStep ? TX.beforeStep(e.beforeStep) : ""}.
                </p>
              ))}
              {x.unplaced.length > 0 && (
                <div className="stack" style={{ gap: 4 }}>
                  <span className="hud" style={{ fontSize: 10 }}>
                    {TX.notPlaced}
                  </span>
                  <ul className="run-steps">
                    {x.unplaced.map((u) => (
                      <li key={u.id}>{u.why}</li>
                    ))}
                  </ul>
                </div>
              )}
              {x.findings.length > 0 && (
                <div className="stack" style={{ gap: 4 }}>
                  <span className="hud" style={{ fontSize: 10 }}>
                    {TX.criticReleaseLensStill}
                  </span>
                  <ul className="run-steps">
                    {x.findings.map((f) => (
                      <li key={f.id}>
                        {f.summary} <span className="hud">{f.path}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </View>
      </Panel>

      <Panel title={TX.forecast} meta={TX.fromDatesNoEstimates} span="span 4">
        <View of={p}>
          {(x) => {
            const f = x.forecast;
            const s = STATUS[f.status];
            return (
              <div className="stack" style={{ gap: 10 }}>
                <div className="row" style={{ flexWrap: "wrap", gap: 8, alignItems: "baseline" }}>
                  <span style={{ fontSize: 20 }} className="mono">
                    {f.ready ?? TX.noDate}
                  </span>
                  <span className={`chip ${s.chip}`}>{s.label}</span>
                </div>
                <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                  {f.status === "released"
                    ? TX.released
                    : TX.readyToReleaseBy(plural(f.waitDays, TX.workingDay))}{" "}
                  {f.target ? TX.target(f.target.date, f.target.source) : TX.noTargetDateThe}
                </p>
                {f.drivers.length > 0 && (
                  <ul className="run-steps" aria-label={TX.whatSetsTheDay}>
                    {f.drivers.map((d) => (
                      <li key={d.what}>
                        {d.until}: {d.what}{" "}
                        <span className="hud" style={{ fontSize: 9.5 }}>
                          {d.source}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                  {TX.tasksOfDone(
                    f.tasks.done,
                    f.tasks.total,
                    f.tasks.waitingOnRequests.length
                      ? TX.waitOnAService(f.tasks.waitingOnRequests.join(", "))
                      : "",
                  )}
                </p>
                {f.notes.map((n) => (
                  <p key={n} className="muted" style={{ margin: 0, fontSize: 11.5 }}>
                    {n}
                  </p>
                ))}
              </div>
            );
          }}
        </View>
      </Panel>

      <Panel title={TX.rolloutReadinessAndHypercare} meta={TX.fromDesignMd} span="span 9">
        <View of={p}>
          {(x) => (
            <dl className="run-facts">
              {x.sections.map((s) => (
                <div key={s.name} style={{ display: "contents" }}>
                  <dt className="hud">{SECTION[s.name] ?? s.name}</dt>
                  <dd>
                    {s.text ? (
                      <>
                        <span className="run-text">{s.text}</span>{" "}
                        <span className="hud" style={{ fontSize: 9.5 }}>
                          {s.source}
                        </span>
                      </>
                    ) : (
                      <span style={{ color: "var(--amber)" }}>{s.gap}</span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </View>
      </Panel>
    </>
  );
}

interface Security {
  interfaces: {
    operation: string;
    caller: string;
    callee: string;
    change: string;
    auth: string;
    authSource?: string;
    crosses?: string;
  }[];
  fields: { field: string; classification: string; personalLooking: boolean }[];
  crossings: {
    operation: string;
    from: string;
    to: string;
    toBoundary: string;
    fields: { field: string; classification: string; sensitive: string; transform?: string }[];
    note?: string;
  }[];
  vendors: { name: string; isNew: boolean; operations: string[]; existing: number }[];
  secrets: { what: string; source: string }[];
  findings: { id: string; severity: string; summary: string; path: string }[];
  signOff: {
    how: string;
    gates: { gate: string; handoff?: { state: string; pr: string } }[];
  };
  gaps: string[];
  markdown: string;
}

export function SecurityPanel({ id, tick }: { id: string; tick: number }) {
  const s = useReloadOn(useApi<Security>(`/api/release/${id}/security`), tick);
  return (
    <Panel title={TX.securityReviewDraft} meta={TX.fromTheCatalogAnd} span="span 12">
      <View of={s}>
        {(r) => (
          <div className="stack" style={{ gap: 12 }}>
            <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}>
              <p style={{ margin: 0, fontSize: 12.5 }}>
                <span className="hud" style={{ marginRight: 8 }}>
                  {TX.signsOff}
                </span>
                {r.signOff.how}
              </p>
              <CopyButton text={r.markdown} label={TX.copyTheSecurityReview} />
            </div>
            {r.interfaces.length === 0 ? (
              <p className="state">{TX.interfacesMdListsNo}</p>
            ) : (
              <table className="run-table">
                <caption className="sr">{TX.newOrChangedInterfaces}</caption>
                <thead>
                  <tr>
                    <th scope="col">{TX.operation}</th>
                    <th scope="col">{TX.callerCallee}</th>
                    <th scope="col">{TX.auth}</th>
                    <th scope="col">{TX.crosses}</th>
                  </tr>
                </thead>
                <tbody>
                  {r.interfaces.map((i) => (
                    <tr key={`${i.operation}|${i.caller}`}>
                      <td className="mono">{i.operation}</td>
                      <td>
                        {i.caller} → {i.callee} ({i.change})
                      </td>
                      <td>
                        <span className={`chip ${i.auth === "not stated" ? "blocking" : "done"}`}>
                          {i.auth.toUpperCase()}
                        </span>{" "}
                        <span className="hud" style={{ fontSize: 9.5 }}>
                          {i.authSource ?? TX.saidNowhere}
                        </span>
                      </td>
                      <td>{i.crosses ?? TX.no}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="row" style={{ flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
              <div className="stack" style={{ flex: "1 1 260px", gap: 4 }}>
                <span className="hud" style={{ fontSize: 10 }}>
                  {TX.dataFieldsTouched}
                </span>
                {r.fields.length === 0 ? (
                  <span className="muted" style={{ fontSize: 12 }}>
                    {TX.dataMdAddsNo}
                  </span>
                ) : (
                  <ul className="run-steps">
                    {r.fields.map((f) => (
                      <li key={f.field}>
                        <span className="mono">{f.field}</span>: {f.classification}
                        {f.personalLooking ? TX.looksLikePersonalData : ""}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="stack" style={{ flex: "1 1 260px", gap: 4 }}>
                <span className="hud" style={{ fontSize: 10 }}>
                  {TX.dataCrossingABoundary}
                </span>
                {r.crossings.length === 0 ? (
                  <span className="muted" style={{ fontSize: 12 }}>
                    {TX.noNewOrChanged}
                  </span>
                ) : (
                  <ul className="run-steps">
                    {r.crossings.map((x) => (
                      <li key={x.operation}>
                        {x.operation}: {x.from} → {x.to} ({x.toBoundary}).{" "}
                        {x.fields.length
                          ? x.fields
                              .map(
                                (f) =>
                                  `${f.field} (${f.classification}${f.sensitive === "yes" ? ", sensitive" : ""})`,
                              )
                              .join("; ")
                          : (x.note ?? TX.mappingsMdDoesntSay)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="stack" style={{ flex: "1 1 260px", gap: 4 }}>
                <span className="hud" style={{ fontSize: 10 }}>
                  {TX.vendorsSecretsAndFindings}
                </span>
                <ul className="run-steps">
                  {r.vendors.map((v) => (
                    <li key={v.name}>
                      {v.name}:{" "}
                      {v.isNew ? TX.aNewVendor : TX.alreadyCalled(plural(v.existing, "interface"))};{" "}
                      {v.operations.join(", ")}
                    </li>
                  ))}
                  {r.secrets.map((x) => (
                    <li key={`${x.what}|${x.source}`}>
                      {x.what}{" "}
                      <span className="hud" style={{ fontSize: 9.5 }}>
                        {x.source}
                      </span>
                    </li>
                  ))}
                  {r.findings.map((f) => (
                    <li key={f.id}>
                      {f.severity}: {f.summary}
                    </li>
                  ))}
                  {r.vendors.length + r.secrets.length + r.findings.length === 0 && (
                    <li>{TX.noVendorSecretOr}</li>
                  )}
                </ul>
              </div>
            </div>
            {r.gaps.length > 0 && (
              <div className="stack" style={{ gap: 4 }}>
                <span className="hud" style={{ fontSize: 10 }}>
                  {TX.gapsForTheReviewer}
                </span>
                <ul className="run-steps">
                  {r.gaps.map((g) => (
                    <li key={g}>{g}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </View>
    </Panel>
  );
}

type Audience = "business" | "technical";

export function NotesPanel({ id, tick }: { id: string; tick: number }) {
  const [audience, setAudience] = useState<Audience>("business");
  const n = useReloadOn(
    useApi<{ markdown: string }>(`/api/release/${id}/notes?audience=${audience}`),
    tick,
  );
  return (
    <Panel title={TX.releaseNotes} meta={TX.generatedNoAi} span="span 6">
      <div className="stack" style={{ gap: 10 }}>
        <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}>
          <Choice
            label={TX.audience}
            value={audience}
            options={[
              { value: "business", label: TX.business },
              { value: "technical", label: TX.technical },
            ]}
            onChange={setAudience}
          />
          {n.state === "ready" && (
            <CopyButton text={n.data.markdown} label={TX.copyTheReleaseNotes} />
          )}
        </div>
        <View of={n}>
          {(x) => (
            <pre
              className="run-text"
              tabIndex={0}
              aria-label={TX.releaseNotes}
              style={{ maxHeight: 320, overflow: "auto", fontFamily: "var(--mono)", fontSize: 12 }}
            >
              {x.markdown}
            </pre>
          )}
        </View>
      </div>
    </Panel>
  );
}

interface OutcomeValue {
  value: string;
  by: string;
  at: string;
  note?: string;
}
interface Outcomes {
  state: string;
  source?: string;
  measures: {
    id: string;
    n: number;
    measure: string;
    source: string;
    values: OutcomeValue[];
    latest?: OutcomeValue;
  }[];
  orphans: { id: string; measure: string }[];
  canRecord: boolean;
  why?: string;
  gaps: string[];
}

export function OutcomesPanel({ id, tick }: { id: string; tick: number }) {
  const o = useReloadOn(useApi<Outcomes>(`/api/outcomes?change=${id}`), tick);
  const who = useApi<{ user: string }>("/api/health");
  const act = useAction();
  const [measure, setMeasure] = useState("");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void act.run(
      () =>
        api(`/api/release/${id}/outcomes`, {
          method: "POST",
          body: { measure, value, ...(note.trim() ? { note } : {}) },
        }).then(() => {
          setValue("");
          setNote("");
          o.reload();
        }),
      TX.recorded,
    );
  };
  return (
    <Panel title={TX.outcomes} meta={TX.theBriefsSuccessMeasures} span="span 6">
      <View of={o} empty={(x) => x.measures.length === 0} emptyText={TX.briefMdHasNo}>
        {(x) => (
          <div className="stack" style={{ gap: 10 }}>
            <ul className="stack" style={{ listStyle: "none", margin: 0, padding: 0, gap: 0 }}>
              {x.measures.map((m) => (
                <li key={m.id} className="list-row" style={{ alignItems: "flex-start" }}>
                  <span className="stack" style={{ gap: 2 }}>
                    <span style={{ fontSize: 12.5 }}>
                      {m.n} · {m.measure}
                    </span>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {m.latest
                        ? TX.measuredByOn(
                            m.latest.value,
                            m.latest.by,
                            day(m.latest.at),
                            m.values.length > 1 ? ` (${plural(m.values.length, "value")})` : "",
                          )
                        : TX.notMeasuredYet}
                    </span>
                  </span>
                  <span className={`chip ${m.latest ? "done" : "dim"}`}>
                    {m.latest ? TX.measured : TX.open}
                  </span>
                </li>
              ))}
            </ul>
            {x.orphans.map((y) => (
              <p key={y.id} className="muted" style={{ margin: 0, fontSize: 12 }}>
                {TX.recordedButBriefMd(y.measure)}
              </p>
            ))}
            {x.canRecord ? (
              <form onSubmit={submit} className="stack" aria-label={TX.recordAnOutcome}>
                <div className="row" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
                  <label className="run-label" htmlFor={`om-${id}`} style={{ flex: "1 1 200px" }}>
                    {TX.measure}
                    <select
                      id={`om-${id}`}
                      className="run-select"
                      value={measure}
                      required
                      onChange={(e) => setMeasure(e.target.value)}
                    >
                      <option value="">{TX.chooseAMeasure}</option>
                      {x.measures.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.n} · {m.measure}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="run-label" htmlFor={`ov-${id}`} style={{ flex: "1 1 160px" }}>
                    {TX.whatYouMeasured}
                    <input
                      id={`ov-${id}`}
                      className="run-input"
                      value={value}
                      required
                      onChange={(e) => setValue(e.target.value)}
                    />
                  </label>
                </div>
                <div className="row" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
                  <label className="run-label" htmlFor={`on-${id}`} style={{ flex: "1 1 240px" }}>
                    {TX.howOptional}
                    <input
                      id={`on-${id}`}
                      className="run-input"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                    />
                  </label>
                  <button
                    type="submit"
                    className="btn primary"
                    disabled={act.busy || !measure || !value.trim()}
                  >
                    {TX.record(who.state === "ready" ? TX.as(who.data.user) : "")}
                  </button>
                </div>
                <Note note={act.note} />
              </form>
            ) : (
              <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                {x.why}
              </p>
            )}
          </div>
        )}
      </View>
    </Panel>
  );
}

/** Save text as a file in the browser: nothing leaves the machine. */
function saveFile(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Where the evidence pack goes: a file the browser saves, or, in a VS Code panel (which can
 * save no file, ADR 0097), the text itself to copy, with the command that writes the files.
 */
export function evidenceOutcome(
  id: string,
  pack: { markdown: string; files: unknown[] },
  inPanel: boolean,
): { saved: boolean; text: string } {
  const file = `evidence-${id}.md`;
  if (inPanel)
    return {
      saved: false,
      text: COPY.app.panelNoSave(file, `atticus release evidence ${id} --out <folder>`),
    };
  return {
    saved: true,
    text: `Saved ${file}: the summary, ${plural(pack.files.length, "file")} with their sha-256, rounds, waivers, approvals, trace, requests, drift and AI runs.`,
  };
}

export function ExportEvidence({ id }: { id: string }) {
  const act = useAction();
  const [shown, setShown] = useState<string | undefined>();
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn primary"
          disabled={act.busy}
          onClick={() =>
            void act.run(
              () =>
                api<{ markdown: string; files: unknown[] }>(`/api/release/${id}/evidence`).then(
                  (pack) => {
                    const inPanel = !!hostBridge();
                    if (inPanel) setShown(pack.markdown);
                    else saveFile(`evidence-${id}.md`, pack.markdown);
                    return evidenceOutcome(id, pack, inPanel);
                  },
                ),
              (r) => (r as { text: string }).text,
            )
          }
        >
          {TX.exportEvidencePack}
        </button>
      </div>
      <Note note={act.note} />
      {shown !== undefined && (
        <>
          <label htmlFor={`evidence-${id}`} className="sr">
            {TX.evidenceMd(id)}
          </label>
          <textarea
            id={`evidence-${id}`}
            className="run-textarea"
            readOnly
            rows={10}
            value={shown}
          />
          <div>
            <CopyButton text={shown} label={TX.copyEvidenceMd(id)} />
          </div>
        </>
      )}
    </div>
  );
}
