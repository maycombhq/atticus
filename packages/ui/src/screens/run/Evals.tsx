import { useState } from "react";
import { api, useApi, useLiveEvents } from "../../api/client.js";
import { Bar, Panel, View } from "../../app/ui.js";
import { Note, day, plural, useAction } from "./shared.js";

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
          Test a skill before anyone relies on it.
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
                return `Eval run ${rep.runId} finished: ${failed ? `${plural(failed, "case")} failed` : "every case passed"}.`;
              },
            );
          }}
        >
          <label className="run-label" htmlFor="eval-mode">
            Mode
            <select
              id="eval-mode"
              className="run-select"
              value={mode}
              onChange={(ev) => setMode(ev.target.value as "mock" | "replay")}
            >
              <option value="mock">Mock (no model)</option>
              <option value="replay">Replay saved answers</option>
            </select>
          </label>
          <label className="run-label" htmlFor="eval-agent">
            Agent
            <select
              id="eval-agent"
              className="run-select"
              value={agent}
              onChange={(ev) => setAgent(ev.target.value)}
            >
              <option value="">Every agent</option>
              {agents.map((a) => (
                <option key={a.agent}>{a.agent}</option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn primary" disabled={act.busy}>
            {act.busy ? "Running…" : "New eval run"}
          </button>
        </form>
      </div>
      <Note note={act.note} />

      <div className="bento">
        <Panel title="Quality signals" span="span 5">
          <View of={e}>
            {(x) => {
              const resolved = x.findings.applied + x.findings.dismissed + x.findings.waived;
              const passing = agents.filter((a) => a.passRate === 1).length;
              return (
                <div className="row between" style={{ flexWrap: "wrap", alignItems: "flex-start" }}>
                  <Signal
                    label="Findings kept by people"
                    value={resolved ? pct(x.findings.applied / resolved) : "–"}
                    sub={
                      resolved
                        ? `${x.findings.applied} of ${resolved} acted on`
                        : "no findings resolved yet"
                    }
                  />
                  <Signal
                    label="Agents passing"
                    value={agents.length ? `${passing}/${agents.length}` : "–"}
                    sub={agents.length ? "every case, latest run" : "no eval run yet"}
                  />
                  <Signal
                    label="Hidden instructions held"
                    value={
                      d.state === "ready" ? String(quarantined.length + d.data.items.length) : "–"
                    }
                    sub="quarantined, never sent to a model"
                  />
                </div>
              );
            }}
          </View>
        </Panel>

        <Panel title="Pass rate by agent" span="span 7">
          <View
            of={e}
            empty={() => agents.length === 0}
            emptyText="No eval runs yet. Start one above (mock or replay)."
          >
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
                            LIVE {a.liveBar.min}/{a.liveBar.runs}{" "}
                            {a.liveBar.pass ? "MET" : "NOT MET"}
                          </span>
                        )}
                        {a.regressed.length > 0 && (
                          <span className="chip blocking" title={a.regressed.join(", ")}>
                            {a.regressed.length} REGRESSED
                          </span>
                        )}
                        <span style={{ fontSize: 12 }}>{pct(a.passRate)}</span>
                      </span>
                    </div>
                    <Bar
                      value={Math.round(a.passRate * 100)}
                      max={100}
                      color={a.passRate < 1 ? "var(--amber)" : undefined}
                      label={`${a.agent} pass rate`}
                    />
                  </div>
                ))}
              </div>
            )}
          </View>
        </Panel>

        <Panel
          title="Ingested-content defences"
          meta={
            d.state === "ready"
              ? `${quarantined.length + d.data.items.length} quarantined`
              : undefined
          }
          span="span 7"
          rows="span 2"
        >
          <p className="muted" style={{ margin: "0 0 8px", fontSize: 12.5 }}>
            Ingested content is data, never instructions. A document with hidden or imperative text
            aimed at an AI reader is left out of every context pack until a person cleans the
            source. Facts verified from code are never overridden by a document.
          </p>
          <View
            of={d}
            empty={(x) => x.files.length === 0 && x.items.length === 0}
            emptyText="Nothing risky in inputs/ or the wiki folders."
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
                        {f.risk === "high" ? "QUARANTINED" : "MARKED"}
                      </span>
                    </div>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {f.reason}. {f.action}.
                    </span>
                    {f.signals.slice(0, 2).map((s) => (
                      <code
                        key={`${s.line}${s.rule}`}
                        className="run-inert"
                        aria-label={`Flagged text on line ${s.line}, shown inert`}
                      >
                        line {s.line} · {s.rule}
                        {s.hidden ? " · hidden" : s.encoded ? " · encoded" : ""}: {s.excerpt}
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
                      <span className="chip blocking">QUARANTINED · {q.change}</span>
                    </div>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {q.summary}
                    </span>
                    <span style={{ fontSize: 12 }}>{q.fix}</span>
                  </article>
                ))}
                <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                  Atticus never lets a quarantined source through on its own: clean or replace it,
                  then scan again. Scanned {plural(x.scanned, "file")}.
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
                }, "Scanning inputs/ and the wiki folders again.")
              }
            >
              Scan again
            </button>
          </div>
          <Note note={scan.note} />
        </Panel>

        <Panel title="Eval runs" span="span 5">
          <View of={e} empty={(x) => x.runs.length === 0} emptyText="No eval runs yet.">
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
                        {r.skipped ? ` · ${r.skipped} skipped` : ""}
                      </span>
                    </span>
                    <span className={`chip ${r.failed ? "blocking" : "done"}`}>
                      {r.failed ? `${r.failed} FAILED` : "ALL PASSED"}
                    </span>
                  </div>
                ))
            }
          </View>
        </Panel>

        <Panel title="Compare models" span="span 5">
          <View of={e}>
            {(x) =>
              x.modes.allowed.includes("model") && x.models.length > 1 ? (
                <p style={{ margin: 0, fontSize: 12.5 }}>
                  Approved models: {x.models.join(", ")}. Live evals call a real model, so run them
                  from a terminal: <code className="mono">atticus eval run --mode live</code>.
                </p>
              ) : (
                <div className="stack">
                  <span className="chip dim" style={{ alignSelf: "flex-start" }}>
                    LOCKED
                  </span>
                  <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
                    Available once model mode is approved in runtime.yaml. It runs the same eval
                    suite on each model and shows pass rate side by side. Not available in{" "}
                    {x.modes.default} mode.
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
