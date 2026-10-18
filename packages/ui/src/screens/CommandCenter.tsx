import { useApi, useLiveEvents } from "../api/client.js";
import { GraphView, type Graph } from "../app/graph.js";
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

export function CommandCenter() {
  const changes = useApi<ChangeSummary[]>("/api/changes");
  const findings = useApi<Finding[]>("/api/findings?state=open");
  const kinds = useApi<KindCount[]>("/api/catalog/kinds");
  const qs = useApi<{ data: { questions?: unknown[] } | null }>("/api/view/questions");
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
        <span className="hud">Live from your metarepo</span>
      </div>

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

        <Panel title="Your queue" span="span 4" meta={`${blocking.length + gaps.length}`}>
          <View of={findings} empty={(f) => f.length === 0} emptyText="Nothing waiting on you.">
            {() => (
              <div className="stack" style={{ gap: 0 }}>
                {[...blocking, ...gaps].slice(0, 6).map((f) => (
                  <div
                    key={`${f.change}/${f.id}`}
                    className="list-row"
                    style={{ alignItems: "flex-start" }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12.5 }}>{f.question?.text ?? f.summary}</div>
                      <div className="hud" style={{ fontSize: 9.5 }}>
                        {f.change} · {f.gate} · {f.lens ?? "checks"}
                      </div>
                    </div>
                    <span className={`chip ${f.severity === "blocking" ? "blocking" : "warn"}`}>
                      {f.severity === "blocking" ? "BLOCKING" : "ASK"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </View>
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
