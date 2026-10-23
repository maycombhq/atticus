import { useState } from "react";
import { api, useApi, useLiveEvents } from "../../api/client.js";
import { Bar, Panel, View } from "../../app/ui.js";
import { Note, day, plural, useAction } from "./shared.js";
import { COPY } from "../../copy.js";

const T = COPY.evals;

interface Evals {
  quality: {
    updatedAt: string;
    agents: {
      agent: string;
      lastRunAt: string;
      mode: string;
      cases: number;
      passRate: number;
      liveBar?: { runs: number; min: number; pass: boolean };
      regressed: string[];
    }[];
  } | null;
  runs: {
    runId: string;
    mode: string;
    startedAt: string;
    runs: number;
    agents: { agent: string; cases: number; passed: number; runs: number; passRate: number }[];
    failed: number;
    skipped: number;
    liveBar?: boolean;
  }[];
  findings: {
    total: number;
    applied: number;
    dismissed: number;
    waived: number;
    asked: number;
    open: number;
  };
  modes: { allowed: string[]; default: string };
  models: string[];
}
interface Defences {
  files: {
    path: string;
    risk: "high" | "medium" | "low" | "none";
    action: string;
    reason: string;
    signals: { rule: string; line: number; excerpt: string; hidden?: boolean; encoded?: boolean }[];
  }[];
  scanned: number;
  items: {
    change: string;
    file: string;
    source: string;
    origin: string;
    summary: string;
    fix: string;
    question: string;
  }[];
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

function Signal({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="stack" style={{ gap: 2 }}>
      <span className="hud" style={{ fontSize: 10 }}>
        {label}
      </span>
      <span className="n" style={{ fontSize: 28, color: "var(--accent)" }}>
        {value}
      </span>
      <span className="muted" style={{ fontSize: 11.5 }}>
        {sub}
      </span>
    </div>
  );
}

export function Evals() {
  const e = useApi<Evals>("/api/evals");
  const d = useApi<Defences>("/api/evals/defences");
  const [mode, setMode] = useState<"mock" | "replay">("mock");
  const [agent, setAgent] = useState("");
  const act = useAction();
  const scan = useAction();
  useLiveEvents((ev) => {
    if (ev.type === "file.changed") e.reload();
  });
  const agents = e.state === "ready" ? (e.data.quality?.agents ?? []) : [];
  const quarantined = d.state === "ready" ? d.data.files.filter((f) => f.risk === "high") : [];
  const flagged = d.state === "ready" ? d.data.files.filter((f) => f.risk === "medium") : [];

  return (
    <>
      <div className="row between" style={{ flexWrap: "wrap" }}>
        <p className="n" style={{ margin: 0, fontSize: 24 }}>
          {T.testASkillBefore}
        </p>
        <form
          className="row"
          style={{ flexWrap: "wrap", alignItems: "flex-end" }}
          onSubmit={(ev) => {
            ev.preventDefault();
            void act.run(
              () =>
                api<{ report: { runId: string; agents: { passRate: number }[] } }>(
                  "/api/evals/run",
                  {
                    method: "POST",
                    body: { mode, ...(agent ? { agents: [agent] } : {}) },
                  },
                ).then((r) => {
                  e.reload();
                  return r;
                }),
              (r) => {
                const rep = (r as { report: { runId: string; results?: { pass: boolean }[] } })
                  .report;
                const failed = rep.results?.filter((x) => !x.pass).length ?? 0;
                return `Eval run ${rep.runId} finished: ${failed ? `${plural(failed, "case")} failed` : T.everyCasePassed}.`;
              },
            );
          }}
        >
          <label className="run-label" htmlFor="eval-mode">
            {T.mode}
            <select
              id="eval-mode"
              className="run-select"
              value={mode}
              onChange={(ev) => setMode(ev.target.value as "mock" | "replay")}
            >
              <option value="mock">{T.mockNoModel}</option>
              <option value="replay">{T.replaySavedAnswers}</option>
            </select>
          </label>
          <label className="run-label" htmlFor="eval-agent">
            {T.agent}
            <select
              id="eval-agent"
              className="run-select"
              value={agent}
              onChange={(ev) => setAgent(ev.target.value)}
            >
              <option value="">{T.everyAgent}</option>
              {agents.map((a) => (
                <option key={a.agent}>{a.agent}</option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn primary" disabled={act.busy}>
            {act.busy ? T.running : T.newEvalRun}
          </button>
        </form>
      </div>
      <Note note={act.note} />

      <div className="bento">
        <Panel title={T.qualitySignals} span="span 5">
          <View of={e}>
            {(x) => {
              const resolved = x.findings.applied + x.findings.dismissed + x.findings.waived;
              const passing = agents.filter((a) => a.passRate === 1).length;
              return (
                <div className="row between" style={{ flexWrap: "wrap", alignItems: "flex-start" }}>
                  <Signal
                    label={T.findingsKeptByPeople}
                    value={resolved ? pct(x.findings.applied / resolved) : "–"}
                    sub={
                      resolved ? T.actedOn(x.findings.applied, resolved) : T.noFindingsResolvedYet
                    }
                  />
                  <Signal
                    label={T.agentsPassing}
                    value={agents.length ? `${passing}/${agents.length}` : "–"}
                    sub={agents.length ? T.everyCaseLatestRun : T.noEvalRunYet}
                  />
                  <Signal
                    label={T.hiddenInstructionsHeld}
                    value={
                      d.state === "ready" ? String(quarantined.length + d.data.items.length) : "–"
                    }
                    sub={T.quarantinedNeverSentTo}
                  />
                </div>
              );
            }}
          </View>
        </Panel>

        <Panel title={T.passRateByAgent} span="span 7">
          <View of={e} empty={() => agents.length === 0} emptyText={T.noEvalRunsYet}>
            {() => (
              <div className="stack" style={{ gap: 8 }}>
                {agents.map((a) => (
                  <div key={a.agent} className="stack" style={{ gap: 4 }}>
                    <div className="row between">
                      <span className="mono" style={{ fontSize: 12 }}>
                        {a.agent}
                      </span>
                      <span className="row" style={{ gap: 6 }}>
                        <span className="chip dim">{a.mode.toUpperCase()}</span>
                        {a.liveBar && (
                          <span className={`chip ${a.liveBar.pass ? "done" : "blocking"}`}>
                            {T.live(
                              a.liveBar.min,
                              a.liveBar.runs,
                              a.liveBar.pass ? T.met : T.notMet,
                            )}
                          </span>
                        )}
                        {a.regressed.length > 0 && (
                          <span className="chip blocking" title={a.regressed.join(", ")}>
                            {T.regressed(a.regressed.length)}
                          </span>
                        )}
                        <span style={{ fontSize: 12 }}>{pct(a.passRate)}</span>
                      </span>
                    </div>
                    <Bar
                      value={Math.round(a.passRate * 100)}
                      max={100}
                      color={a.passRate < 1 ? "var(--amber)" : undefined}
                      label={T.passRate(a.agent)}
                    />
                  </div>
                ))}
              </div>
            )}
          </View>
        </Panel>

        <Panel
          title={T.ingestedContentDefences}
          meta={
            d.state === "ready"
              ? T.quarantined3(quarantined.length + d.data.items.length)
              : undefined
          }
          span="span 7"
          rows="span 2"
        >
          <p className="muted" style={{ margin: "0 0 8px", fontSize: 12.5 }}>
            {T.ingestedContentIsData}
          </p>
          <View
            of={d}
            empty={(x) => x.files.length === 0 && x.items.length === 0}
            emptyText={T.nothingRiskyInInputs}
          >
            {(x) => (
              <div className="stack" style={{ gap: 12 }}>
                {[...quarantined, ...flagged].map((f) => (
                  <article
                    key={f.path}
                    className="stack"
                    style={{ gap: 4, borderTop: "1px solid var(--rule)", paddingTop: 8 }}
                  >
                    <div className="row between" style={{ flexWrap: "wrap" }}>
                      <span className="mono" style={{ fontSize: 12 }}>
                        {f.path}
                      </span>
                      <span className={`chip ${f.risk === "high" ? "blocking" : "warn"}`}>
                        {f.risk === "high" ? T.quarantined : T.marked}
                      </span>
                    </div>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {f.reason}. {f.action}.
                    </span>
                    {f.signals.slice(0, 2).map((s) => (
                      <code
                        key={`${s.line}${s.rule}`}
                        className="run-inert"
                        aria-label={T.flaggedTextOnLine(s.line)}
                      >
                        {T.line(
                          s.line,
                          s.rule,
                          s.hidden ? T.hidden : s.encoded ? T.encoded : "",
                          s.excerpt,
                        )}
                      </code>
                    ))}
                  </article>
                ))}
                {x.items.map((q) => (
                  <article
                    key={`${q.change}${q.file}${q.source}`}
                    className="stack"
                    style={{ gap: 4, borderTop: "1px solid var(--rule)", paddingTop: 8 }}
                  >
                    <div className="row between" style={{ flexWrap: "wrap" }}>
                      <span style={{ fontSize: 12.5 }}>{q.origin}</span>
                      <span className="chip blocking">{T.quarantined2(q.change)}</span>
                    </div>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {q.summary}
                    </span>
                    <span style={{ fontSize: 12 }}>{q.fix}</span>
                  </article>
                ))}
                <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                  {T.atticusNeverLetsA(plural(x.scanned, "file"))}
                </p>
              </div>
            )}
          </View>
          <div className="row" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="btn"
              disabled={scan.busy}
              onClick={() =>
                void scan.run(async () => {
                  d.reload();
                }, T.scanningInputsAndThe)
              }
            >
              {T.scanAgain}
            </button>
          </div>
          <Note note={scan.note} />
        </Panel>

        <Panel title={T.evalRuns} span="span 5">
          <View of={e} empty={(x) => x.runs.length === 0} emptyText={T.noEvalRunsYet2}>
            {(x) =>
              x.runs
                .slice()
                .reverse()
                .slice(0, 8)
                .map((r) => (
                  <div key={r.runId} className="list-row">
                    <span className="stack" style={{ gap: 2 }}>
                      <span className="mono" style={{ fontSize: 11.5 }}>
                        {r.runId}
                      </span>
                      <span className="hud" style={{ fontSize: 9.5 }}>
                        {day(r.startedAt)} · {plural(r.agents.length, "agent")}
                        {r.skipped ? T.skipped(r.skipped) : ""}
                      </span>
                    </span>
                    <span className={`chip ${r.failed ? "blocking" : "done"}`}>
                      {r.failed ? T.failed(r.failed) : T.allPassed}
                    </span>
                  </div>
                ))
            }
          </View>
        </Panel>

        <Panel title={T.compareModels} span="span 5">
          <View of={e}>
            {(x) =>
              x.modes.allowed.includes("model") && x.models.length > 1 ? (
                <p style={{ margin: 0, fontSize: 12.5 }}>
                  {T.approvedModelsLiveEvals(x.models.join(", "))}
                  <code className="mono">{T.atticusEvalRunMode}</code>.
                </p>
              ) : (
                <div className="stack">
                  <span className="chip dim" style={{ alignSelf: "flex-start" }}>
                    {T.locked}
                  </span>
                  <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
                    {T.availableOnceModelMode(x.modes.default)}
                  </p>
                </div>
              )
            }
          </View>
        </Panel>
      </div>
    </>
  );
}
