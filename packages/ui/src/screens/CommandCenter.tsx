import { useState } from "react";
import { api, ApiError, useApi, useLiveEvents } from "../api/client.js";
import { GraphView, type Graph } from "../app/graph.js";
import { useMe } from "../app/me.js";
import { inboxOf, type InboxData } from "../app/inbox.js";
import { Bar, Donut, Panel, Ring, View } from "../app/ui.js";

interface ChangeSummary {
  id: string;
  title: string;
  type: string;
  state: string;
  repos: string[];
  openFindings: { blocking: number; gap: number; risk: number; idea: number };
  updatedAt: string;
}
interface Finding {
  id: string;
  change: string;
  gate: string;
  lens?: string;
  layer: string;
  severity: "blocking" | "gap" | "risk" | "idea";
  kind: string;
  artifact: string;
  summary: string;
  state: string;
  question?: { text: string; owner?: string };
}
interface KindCount {
  kind: string;
  count: number;
  stale: number;
}

const PHASES = ["define", "design", "plan", "build", "qa", "release-ready"] as const;
const PHASE_LABEL: Record<string, string> = {
  define: "Define",
  design: "Design",
  plan: "Plan",
  build: "Build",
  qa: "QA",
  "release-ready": "Release",
};
const ACTIVE = new Set<string>([...PHASES, "returned", "post-release-review"]);

function stateChip(c: ChangeSummary) {
  if (c.openFindings.blocking > 0) return { cls: "blocking", text: "BLOCKED" };
  return {
    cls: c.state === "release-ready" ? "warn" : "",
    text: (PHASE_LABEL[c.state] ?? c.state).toUpperCase(),
  };
}

interface Setup {
  baselined: boolean;
  steps: {
    id: string;
    label: string;
    done: boolean;
    detail: string;
    fix?: string;
    optional?: boolean;
  }[];
}

/** Guided setup: the checklist until the catalog is accepted (ADR 0047). */
function SetupChecklist() {
  const setup = useApi<Setup>("/api/setup");
  const [note, setNote] = useState<{ ok: boolean; text: string } | undefined>();
  if (setup.state !== "ready" || setup.data.baselined) return null;
  const s = setup.data;
  const done = s.steps.filter((x) => x.done).length;
  const scanned = s.steps.find((x) => x.id === "scan")?.done;
  const accept = async () => {
    try {
      await api("/api/baseline", { method: "POST", body: {} });
      setNote({
        ok: true,
        text: "The catalog is accepted as the baseline, with your name, in catalog/baseline.yaml. Commit it and open a pull request: merging it makes it the baseline on main.",
      });
      setup.reload();
    } catch (e) {
      setNote({
        ok: false,
        text: e instanceof ApiError ? (e.problem.detail ?? e.problem.title) : String(e),
      });
    }
  };
  return (
    <div className="bento">
      <Panel
        title="Set up Atticus"
        kind="hero"
        span="1 / -1"
        meta={`${done} of ${s.steps.length} done`}
      >
        <ol style={{ listStyle: "none", margin: 0, padding: 0 }} className="stack">
          {s.steps.map((x) => (
            <li key={x.id} className="row" style={{ alignItems: "flex-start", gap: 10 }}>
              <span
                aria-hidden="true"
                className={`chip ${x.done ? "done" : x.optional ? "dim" : "warn"}`}
                style={{ minWidth: 24, textAlign: "center" }}
              >
                {x.done ? "✓" : "·"}
              </span>
              <span className="stack" style={{ gap: 2 }}>
                <span style={{ fontSize: 13 }}>
                  {x.label}
                  <span className="sr">{x.done ? " (done)" : " (to do)"}</span>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {" "}
                    · {x.detail}
                    {x.optional ? " · optional" : ""}
                  </span>
                </span>
                {!x.done && x.fix && (
                  <span className="muted" style={{ fontSize: 12 }}>
                    {x.fix}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
        {scanned && (
          <div className="row" style={{ marginTop: 12, gap: 10, flexWrap: "wrap" }}>
            <button type="button" className="btn primary" onClick={() => void accept()}>
              Accept the catalog as the baseline
            </button>
            <span className="muted" style={{ fontSize: 12 }}>
              After walking the ecosystem map with the architect. Every later scan, document and
              change is compared with it. It is a file in the metarepo, so it reaches main through
              a pull request.
            </span>
          </div>
        )}
        {note && (
          <p role={note.ok ? "status" : "alert"} style={{ margin: "8px 0 0", fontSize: 12.5 }}>
            {note.text}
          </p>
        )}
      </Panel>
    </div>
  );
}

interface DigestResult {
  title: string;
  lines: string[];
  sent?: { id: string; channel: string };
  notSent?: string;
}

/** See what waits on you as one message, or send it to yourself through the notify adapter. */
function DigestButtons() {
  const [busy, setBusy] = useState(false);
  const [d, setD] = useState<DigestResult | undefined>();
  const [error, setError] = useState<string | undefined>();
  const go = async (send: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      setD(await api<DigestResult>("/api/me/digest", { method: "POST", body: { send } }));
    } catch (e) {
      setError(e instanceof ApiError ? (e.problem.detail ?? e.problem.title) : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack" style={{ gap: 6, marginTop: 10 }}>
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        <button type="button" className="btn" disabled={busy} onClick={() => void go(false)}>
          Show my digest
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void go(true)}>
          Send it to me
        </button>
      </div>
      {error && (
        <p role="alert" style={{ margin: 0, color: "#FF9BCB", fontSize: 12.5 }}>
          {error}
        </p>
      )}
      {d && (
        <div role="status" className="stack" style={{ gap: 2, fontSize: 12.5 }}>
          <strong>{d.title}</strong>
          {d.lines.map((l, i) => (
            <span key={i} className="clamp2">
              {l}
            </span>
          ))}
          {d.sent && <span style={{ color: "var(--green)" }}>Sent to {d.sent.channel}.</span>}
          {d.notSent && <span className="muted">{d.notSent}</span>}
        </div>
      )}
    </div>
  );
}

export function CommandCenter() {
  const changes = useApi<ChangeSummary[]>("/api/changes");
  const findings = useApi<Finding[]>("/api/findings?state=open");
  const kinds = useApi<KindCount[]>("/api/catalog/kinds");
  const qs = useApi<{ data: { questions?: InboxData["questions"] } | null }>("/api/view/questions");
  const triage = useApi<{ data: { items?: InboxData["triage"] } | null }>("/api/view/triage");
  const todo = useApi<{ steps: InboxData["steps"] }>("/api/todo");
  const { me } = useMe();
  // The same list for everyone: there are no roles (ADR 0073).
  const inbox = inboxOf({
    changes: changes.state === "ready" ? changes.data : [],
    findings: findings.state === "ready" ? findings.data : [],
    questions: qs.state === "ready" ? (qs.data.data?.questions ?? []) : [],
    triage: triage.state === "ready" ? (triage.data.data?.items ?? []) : [],
    steps: todo.state === "ready" ? todo.data.steps : [],
  });
  const graph = useApi<Graph>("/api/graph");
  useLiveEvents((e) => {
    if (e.type === "index.rebuilt" || e.type === "file.changed") {
      kinds.reload();
      graph.reload();
      changes.reload();
      findings.reload();
    }
    if (e.type === "run.changed") findings.reload();
  });

  const inFlight = changes.state === "ready" ? changes.data.filter((c) => ACTIVE.has(c.state)) : [];
  const open = findings.state === "ready" ? findings.data : [];
  const blocking = open.filter((f) => f.severity === "blocking");
  const gaps = open.filter((f) => f.severity === "gap");
  const questions = qs.state === "ready" ? (qs.data.data?.questions?.length ?? 0) : 0;
  const facts = kinds.state === "ready" ? kinds.data.reduce((a, k) => a + k.count, 0) : 0;
  const interfaces =
    kinds.state === "ready" ? (kinds.data.find((k) => k.kind === "Interface")?.count ?? 0) : 0;
  const focus = inFlight[0];
  const byLens = new Map<string, number>();
  for (const f of open) byLens.set(f.lens ?? "checks", (byLens.get(f.lens ?? "checks") ?? 0) + 1);
  const lensMax = Math.max(1, ...byLens.values());

  return (
    <>
      <div className="row between" style={{ flexWrap: "wrap" }}>
        <p className="n" style={{ margin: 0, fontSize: 24, letterSpacing: "0.02em" }}>
          {blocking.length + gaps.length > 0
            ? `${blocking.length + gaps.length} things need attention.`
            : "Nothing is blocked right now."}
        </p>
        <span className="hud">
          {me ? `Live from your metarepo · you are ${me.user}` : "Live from your metarepo"}
        </span>
      </div>
      <SetupChecklist />
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
        Approving is the pull request: each phase ends with a hand-off PR, and merging it approves
        the gate. Your Git host decides who may approve.
      </p>

      <div className="bento" role="list" aria-label="Key numbers">
        {[
          { label: "Changes in flight", value: inFlight.length, color: "var(--text)" },
          {
            label: "Blocking findings",
            value: blocking.length,
            color: blocking.length ? "var(--magenta)" : "var(--text)",
          },
          {
            label: "Open owner questions",
            value: questions,
            color: questions ? "var(--amber)" : "var(--text)",
          },
          { label: "Facts in the catalog", value: facts, color: "var(--accent)" },
        ].map((k) => (
          <div key={k.label} role="listitem" className="panel" style={{ gridColumn: "span 3" }}>
            <div className="hud" style={{ fontSize: 10 }}>
              {k.label}
            </div>
            <div className="n" style={{ fontSize: 30, color: k.color }}>
              {k.value.toLocaleString()}
            </div>
          </div>
        ))}
      </div>

      <div className="bento">
        <Panel title={focus ? `Gate pipeline · ${focus.id}` : "Gate pipeline"} span="span 5">
          <View
            of={changes}
            empty={() => !focus}
            emptyText="No change in flight. Start one with atticus change new."
          >
            {() => {
              const at = PHASES.indexOf(focus!.state as (typeof PHASES)[number]);
              return (
                <div className="row between" style={{ gap: 6 }}>
                  {PHASES.map((p, i) => (
                    <div key={p} className="stack" style={{ alignItems: "center", gap: 6 }}>
                      {i === at ? (
                        <Ring
                          value={i + 1}
                          max={PHASES.length}
                          size={48}
                          label={`${PHASE_LABEL[p]}: current phase`}
                        />
                      ) : (
                        <span
                          aria-label={`${PHASE_LABEL[p]}: ${i < at ? "done" : "to come"}`}
                          role="img"
                          style={{
                            width: 44,
                            height: 44,
                            borderRadius: "50%",
                            border: `1.5px solid ${i < at ? "#DDEFF5" : "#3A4756"}`,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            color: i < at ? "#DDEFF5" : "var(--muted)",
                          }}
                        >
                          {i < at ? "✓" : ""}
                        </span>
                      )}
                      <span
                        className="hud"
                        style={{ fontSize: 10, color: i === at ? "var(--accent)" : undefined }}
                      >
                        {PHASE_LABEL[p]}
                      </span>
                    </div>
                  ))}
                </div>
              );
            }}
          </View>
        </Panel>

        <Panel title="Changes in flight" meta={`${inFlight.length}`} span="span 4">
          <View of={changes} empty={() => inFlight.length === 0} emptyText="No changes in flight.">
            {() =>
              inFlight.map((c) => {
                const s = stateChip(c);
                return (
                  <div key={c.id} className="list-row">
                    <a
                      href={`#/changes/${c.id}`}
                      className="mono"
                      style={{ fontSize: 12, textDecoration: "none" }}
                    >
                      {c.id}
                    </a>
                    <span className={`chip ${s.cls}`}>{s.text}</span>
                  </div>
                );
              })
            }
          </View>
        </Panel>

        <Panel title="Interfaces" kind="dark" span="span 3">
          <View of={kinds}>
            {() => (
              <div className="stack">
                <span className="big">{interfaces}</span>
                <span className="hud" style={{ fontSize: 10 }}>
                  Interfaces in the catalog
                </span>
              </div>
            )}
          </View>
        </Panel>

        <Panel
          title="System map"
          kind="hero"
          span="span 8"
          rows="span 2"
          meta={<a href="#/explore">Explore</a>}
        >
          <View
            of={graph}
            empty={(g) => g.nodes.length === 0}
            emptyText="The catalog is empty. Run a scan to map your repos."
          >
            {(g) => <GraphView g={g} />}
          </View>
        </Panel>

        <Panel title="Needs a person" span="span 4" meta={inbox.length || undefined}>
          {changes.state === "loading" || findings.state === "loading" ? (
            <div className="state" role="status">
              Loading…
            </div>
          ) : changes.state === "error" || findings.state === "error" ? (
            <div className="state" role="alert">
              Couldn't load what needs a person. Check that atticus ui is still running, then
              reload.
            </div>
          ) : inbox.length === 0 ? (
            <div className="state">Nothing needs a person right now.</div>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {inbox.slice(0, 5).map((x, k) => (
                <li key={k}>
                  <a
                    href={x.href}
                    className="list-row"
                    style={{ alignItems: "flex-start", textDecoration: "none", color: "inherit" }}
                  >
                    <span style={{ minWidth: 0 }}>
                      <span className="clamp2" style={{ fontSize: 12.5 }}>
                        {x.title}
                      </span>
                      <span className="hud" style={{ fontSize: 9.5 }}>
                        {x.detail}
                      </span>
                    </span>
                    <span
                      className={`chip ${x.kind === "finding" ? "blocking" : x.kind === "phase" ? "" : "warn"}`}
                    >
                      {x.kind.toUpperCase()}
                    </span>
                  </a>
                </li>
              ))}
              {inbox.length > 5 && (
                <li className="muted" style={{ fontSize: 12, paddingTop: 6 }}>
                  and {inbox.length - 5} more
                </li>
              )}
            </ul>
          )}
          {me && <DigestButtons />}
        </Panel>

        <Panel title="Findings by lens" span="span 4">
          <View of={findings} empty={(f) => f.length === 0} emptyText="No open findings.">
            {() => (
              <div className="stack">
                {[...byLens.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .map(([lens, n]) => (
                    <div key={lens} className="row" style={{ gap: 8 }}>
                      <span className="hud" style={{ width: 96, fontSize: 10 }}>
                        {lens}
                      </span>
                      <div style={{ flex: 1 }}>
                        <Bar value={n} max={lensMax} label={`${lens} findings`} />
                      </div>
                      <span className="n" style={{ fontSize: 14 }}>
                        {n}
                      </span>
                    </div>
                  ))}
              </div>
            )}
          </View>
        </Panel>

        <Panel title="Where findings come from" kind="dark" span="span 4">
          <View of={findings} empty={(f) => f.length === 0} emptyText="No open findings.">
            {(f) => (
              <Donut
                title="Open findings by source"
                parts={[
                  {
                    label: "Checks from code",
                    value: f.filter((x) => x.layer !== "ai").length,
                    color: "#2EE6F6",
                  },
                  {
                    label: "AI lenses",
                    value: f.filter((x) => x.layer === "ai").length,
                    color: "#FF4FA3",
                  },
                ]}
              />
            )}
          </View>
        </Panel>

        <Panel title="Catalog" span="span 4">
          <View of={kinds} empty={(k) => k.length === 0} emptyText="No facts yet.">
            {(k) => {
              const top = [...k].sort((a, b) => b.count - a.count).slice(0, 5);
              const max = Math.max(1, ...top.map((x) => x.count));
              return (
                <div className="stack">
                  {top.map((x) => (
                    <div key={x.kind} className="row" style={{ gap: 8 }}>
                      <span className="hud" style={{ width: 110, fontSize: 10 }}>
                        {x.kind}
                      </span>
                      <div style={{ flex: 1 }}>
                        <Bar value={x.count} max={max} label={`${x.kind} records`} />
                      </div>
                      <span className="n" style={{ fontSize: 14 }}>
                        {x.count}
                      </span>
                    </div>
                  ))}
                </div>
              );
            }}
          </View>
        </Panel>
      </div>
      <p className="hud" style={{ textAlign: "center", fontSize: 10, color: "#5F7A88" }}>
        A person approves every write · Atticus never touches live systems · every fact keeps its
        evidence
      </p>
    </>
  );
}
