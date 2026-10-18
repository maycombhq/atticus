import { useState, type FormEvent } from "react";
import { api, useApi, useLiveEvents } from "../../api/client.js";
import { GraphView, type Graph } from "../../app/graph.js";
import { Bar, Donut, Panel, Ring, View } from "../../app/ui.js";
import { Note, Table, list, queryParam, setQueryParam, useAction, useView } from "./common.js";

interface Coverage {
  systems: {
    system: string;
    verified: number;
    documentOnly: number;
    unknown: number;
    gaps: number;
    areas: { area: string; state: string; records: string[] }[];
  }[];
  areas: {
    area: string;
    verified: number;
    documentOnly: number;
    unknown: number;
    expected: number;
  }[];
}

// ------------------------------------------------------------------ Ecosystem map

interface Questions {
  questions: {
    id: string;
    system?: string;
    owner?: string;
    question: string;
    questionState?: string;
  }[];
}

const CELL: Record<string, { bg: string; label: string }> = {
  verified: { bg: "rgba(46,230,246,0.55)", label: "verified from code" },
  "document-only": { bg: "rgba(255,181,71,0.45)", label: "from documents only" },
  unknown: { bg: "rgba(255,255,255,0.05)", label: "unknown" },
};

export function EcosystemMap() {
  const graph = useApi<Graph>("/api/graph");
  const cov = useView<Coverage>("coverage");
  const qs = useView<Questions>("questions");
  const [focus, setFocus] = useState<string | undefined>();
  return (
    <div className="bento">
      <Panel
        title={focus ? `Around ${focus}` : "Ecosystem map"}
        kind="hero"
        span="span 8"
        rows="span 2"
        meta={
          focus ? (
            <button type="button" className="btn" onClick={() => setFocus(undefined)}>
              Show all
            </button>
          ) : (
            "Click a node to centre it"
          )
        }
      >
        <View
          of={graph}
          empty={(g) => g.nodes.length === 0}
          emptyText="The catalog is empty. Run a scan from the Scans screen."
        >
          {(g) => <GraphView g={g} {...(focus ? { focus } : {})} onPick={setFocus} height={520} />}
        </View>
      </Panel>
      <Panel title="Systems" span="span 4" rows="span 2">
        <View of={cov} empty={(c) => c.systems.length === 0} emptyText="No systems yet.">
          {(c) => (
            <div className="stack">
              {c.systems.map((s) => {
                const total = s.verified + s.documentOnly + s.unknown;
                return (
                  <button
                    key={s.system}
                    type="button"
                    onClick={() => setFocus(s.system)}
                    className="stack"
                    style={{
                      gap: 4,
                      background: "transparent",
                      border: 0,
                      color: "inherit",
                      textAlign: "left",
                      font: "inherit",
                      cursor: "pointer",
                      padding: "6px 0",
                      borderBottom: "1px solid #18202A",
                    }}
                  >
                    <span className="row between">
                      <span className="mono" style={{ fontSize: 12.5 }}>
                        {s.system}
                      </span>
                      <span className="hud" style={{ fontSize: 9.5 }}>
                        {s.verified}/{total} verified{s.gaps ? ` · ${s.gaps} gaps` : ""}
                      </span>
                    </span>
                    <Bar
                      value={s.verified}
                      max={Math.max(total, 1)}
                      label={`${s.system}: facts verified from code`}
                    />
                  </button>
                );
              })}
            </div>
          )}
        </View>
      </Panel>
      <Panel title="What the catalog knows" span="span 8">
        <View of={cov} empty={(c) => c.systems.length === 0} emptyText="No systems yet.">
          {(c) => {
            const areas = [...new Set(c.systems.flatMap((x) => x.areas.map((a) => a.area)))];
            return (
              <div style={{ overflowX: "auto" }}>
                <table
                  style={{
                    borderCollapse: "separate",
                    borderSpacing: 4,
                    width: "100%",
                    fontSize: 11,
                  }}
                >
                  <caption className="sr">Coverage by system and area</caption>
                  <thead>
                    <tr>
                      <th />
                      {areas.map((a) => (
                        <th
                          key={a}
                          className="hud"
                          style={{ fontSize: 9.5, fontWeight: 400, textAlign: "center" }}
                        >
                          {a}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {c.systems.map((s) => (
                      <tr key={s.system}>
                        <th
                          className="mono"
                          style={{ textAlign: "left", fontWeight: 400, paddingRight: 8 }}
                        >
                          {s.system}
                        </th>
                        {areas.map((name) => {
                          const a = s.areas.find((x) => x.area === name);
                          if (!a)
                            return (
                              <td key={name} title={`${s.system} · ${name}: not expected`}>
                                <span className="sr">not expected</span>
                              </td>
                            );
                          const cell = CELL[a.state] ?? CELL.unknown!;
                          return (
                            <td
                              key={a.area}
                              title={`${s.system} · ${a.area}: ${cell.label}${a.records.length ? ` (${a.records.length})` : ""}`}
                              style={{
                                background: cell.bg,
                                height: 26,
                                borderRadius: 4,
                                textAlign: "center",
                                border: "1px solid rgba(255,255,255,0.06)",
                              }}
                            >
                              <span className="sr">{cell.label}</span>
                              {a.records.length ? (
                                <span aria-hidden="true">{a.records.length}</span>
                              ) : null}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="row" style={{ gap: 14, marginTop: 8, flexWrap: "wrap" }}>
                  {Object.entries(CELL).map(([k, v]) => (
                    <span key={k} className="row" style={{ gap: 6, fontSize: 11.5 }}>
                      <span
                        aria-hidden="true"
                        style={{
                          width: 12,
                          height: 12,
                          borderRadius: 3,
                          background: v.bg,
                          display: "inline-block",
                        }}
                      />
                      {v.label}
                    </span>
                  ))}
                </div>
              </div>
            );
          }}
        </View>
      </Panel>
      <Panel
        title="Questions for owners"
        span="span 4"
        meta={qs.state === "ready" ? qs.data.questions.length : undefined}
      >
        <View
          of={qs}
          empty={(q) => q.questions.length === 0}
          emptyText="No open questions: every gap has an answer."
        >
          {(q) => (
            <ul
              style={{
                listStyle: "none",
                margin: 0,
                padding: 0,
                maxHeight: 300,
                overflowY: "auto",
              }}
              className="stack"
            >
              {q.questions.slice(0, 12).map((x) => (
                <li
                  key={x.id}
                  className="stack"
                  style={{ gap: 2, paddingBottom: 6, borderBottom: "1px solid #18202A" }}
                >
                  <span style={{ fontSize: 12.5 }}>{x.question}</span>
                  <span className="hud" style={{ fontSize: 9.5 }}>
                    {x.system ?? ""}
                    {x.owner ? ` · ask ${x.owner}` : " · owner unknown"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </View>
      </Panel>
    </div>
  );
}

// ------------------------------------------------------------------ Impact explorer

/** The impact paths as a graph: the root in the middle, every hop an edge. */
function blastGraph(d: Impact): Graph {
  const nodes = new Map<string, Graph["nodes"][number]>();
  const kindOf = new Map(d.affected.map((a) => [a.id, a.kind]));
  const edges = new Map<string, Graph["edges"][number]>();
  nodes.set(d.root, { id: d.root, kind: "Component", label: d.root, status: "current" });
  for (const a of d.affected) {
    nodes.set(a.id, { id: a.id, kind: a.kind, label: a.id, status: "current" });
    for (let i = 1; i < a.path.length; i++) {
      const from = a.path[i - 1]!;
      const to = a.path[i]!;
      if (!nodes.has(from))
        nodes.set(from, {
          id: from,
          kind: kindOf.get(from) ?? "Component",
          label: from,
          status: "current",
        });
      edges.set(`${from}>${to}`, {
        id: `${from}>${to}`,
        from,
        to,
        via: "",
        confidence: "verified",
        status: "current",
      });
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

interface Impact {
  root: string;
  affected: { id: string; kind: string; path: string[]; reason: string; owner?: string }[];
  gaps: { record: string; field: string; question: string }[];
}

export function ImpactExplorer({ hash }: { hash: string }) {
  const q = queryParam(hash, "q") ?? "";
  const [text, setText] = useState(q);
  const imp = useApi<Impact>(q ? `/api/impact/${encodeURIComponent(q)}?depth=4` : undefined);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setQueryParam("impact", "q", text.trim());
  };
  const byHop = new Map<number, number>();
  if (imp.state === "ready")
    for (const a of imp.data.affected)
      byHop.set(a.path.length - 1, (byHop.get(a.path.length - 1) ?? 0) + 1);
  const blast: Graph | undefined = imp.state === "ready" ? blastGraph(imp.data) : undefined;
  return (
    <div className="bento">
      <Panel title="What breaks if this changes" span="1 / -1">
        <form onSubmit={submit} className="row" style={{ flexWrap: "wrap" }}>
          <label htmlFor="impact-id" className="sr">
            Record id
          </label>
          <input
            id="impact-id"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="A component, interface, table, column or topic id, e.g. ledger-db.account"
            style={{
              flex: "1 1 360px",
              height: 40,
              background: "#0B1016",
              color: "var(--text)",
              border: "1px solid var(--accent)",
              borderRadius: 10,
              padding: "0 12px",
              font: "inherit",
            }}
          />
          <button type="submit" className="btn primary">
            Show impact
          </button>
          <a href="#/explore" className="muted" style={{ fontSize: 12 }}>
            Find an id in the Knowledge explorer
          </a>
        </form>
      </Panel>
      {!q ? null : (
        <>
          <Panel title={`Blast radius of ${q}`} kind="hero" span="span 9">
            <View
              of={imp}
              empty={(d) => d.affected.length === 0}
              emptyText="Nothing depends on it."
            >
              {() => <GraphView g={blast!} focus={q} height={380} />}
            </View>
          </Panel>
          <Panel title="Blast radius" span="span 3" kind="dark">
            <View of={imp}>
              {(d) => (
                <div className="stack">
                  <span className="big">{d.affected.length}</span>
                  <span className="hud" style={{ fontSize: 10 }}>
                    Records affected by {d.root}
                  </span>
                  {[...byHop.entries()]
                    .sort((a, b) => a[0] - b[0])
                    .map(([hop, n]) => (
                      <div key={hop} className="row" style={{ gap: 8 }}>
                        <span className="hud" style={{ width: 56, fontSize: 10 }}>
                          {hop} hop{hop === 1 ? "" : "s"}
                        </span>
                        <div style={{ flex: 1 }}>
                          <Bar
                            value={n}
                            max={Math.max(...byHop.values())}
                            label={`${n} records ${hop} hops away`}
                          />
                        </div>
                        <span className="n">{n}</span>
                      </div>
                    ))}
                </div>
              )}
            </View>
          </Panel>
          <Panel title="Affected" span="span 8">
            <View
              of={imp}
              empty={(d) => d.affected.length === 0}
              emptyText="Nothing depends on it in the catalog."
            >
              {(d) => (
                <Table
                  caption="Affected records"
                  rows={d.affected}
                  rowKey={(a) => `${a.kind}/${a.id}`}
                  cols={[
                    { label: "Record", cell: (a) => a.id, mono: true },
                    { label: "Kind", cell: (a) => <span className="chip dim">{a.kind}</span> },
                    { label: "Why", cell: (a) => a.reason },
                    {
                      label: "Owner",
                      cell: (a) =>
                        a.owner ? (
                          <span className="chip dim" style={{ whiteSpace: "nowrap" }}>
                            {a.owner}
                          </span>
                        ) : (
                          <span className="chip warn">UNKNOWN</span>
                        ),
                    },
                  ]}
                />
              )}
            </View>
          </Panel>
          <Panel title="What would sharpen this" span="span 4">
            <View
              of={imp}
              empty={(d) => d.gaps.length === 0}
              emptyText="No gaps: the catalog knows every hop."
            >
              {(d) => (
                <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
                  {d.gaps.map((g) => (
                    <li key={`${g.record}/${g.field}`}>
                      <span className="mono">{g.record}</span>: {g.question}
                    </li>
                  ))}
                </ul>
              )}
            </View>
            <p className="muted" style={{ fontSize: 11.5, margin: "10px 0 0" }}>
              Read-only. Atticus never connects to live systems; this is the catalog's view.
            </p>
          </Panel>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Features

interface Feature {
  id: string;
  name?: string;
  status: string;
  confidence: string;
  entryPoints: string[];
  records: string[];
  tags: string[];
  externalRefs: { system?: string; id?: string; url?: string }[];
  namedBy: string;
}
interface FeatureList {
  features: Feature[];
  coverage: { confirmed: string[]; detectedOnly: string[]; unknown: string[] };
}
interface FeatureShow {
  feature: Feature;
  system?: string;
  looseEnds: { kind: string; record: string; text: string }[];
}

function FeatureGraph({ records }: { records: string[] }) {
  const g = useApi<Graph>("/api/graph");
  const lit = new Set(records.flatMap((r) => [r, r.split(".")[0]!]));
  return (
    <View of={g} empty={(x) => x.nodes.length === 0} emptyText="">
      {(x) => (
        <div
          style={{
            border: "1px solid var(--line)",
            borderRadius: 10,
            background: "rgba(7,11,15,0.6)",
          }}
        >
          <GraphView
            g={x}
            highlight={x.nodes.filter((n) => lit.has(n.id)).map((n) => n.id)}
            height={300}
          />
        </div>
      )}
    </View>
  );
}

export function Features({ hash }: { hash: string }) {
  const all = useView<FeatureList>("features");
  const id =
    queryParam(hash, "id") ?? (all.state === "ready" ? all.data.features[0]?.id : undefined);
  const one = useView<FeatureShow>("features", id, !id);
  return (
    <div className="bento">
      <Panel
        title="Features found in code"
        span="span 4"
        rows="span 2"
        meta={all.state === "ready" ? all.data.features.length : undefined}
      >
        <View
          of={all}
          empty={(d) => d.features.length === 0}
          emptyText="No features found yet. Scan the repos first."
        >
          {(d) => (
            <div className="stack" style={{ gap: 10 }}>
              <Donut
                title="Features by how they were named"
                parts={[
                  {
                    label: "Confirmed by people",
                    value: d.coverage.confirmed.length,
                    color: "#3DDC97",
                  },
                  {
                    label: "Found in code only",
                    value: d.coverage.detectedOnly.length,
                    color: "#2EE6F6",
                  },
                  { label: "Unknown", value: d.coverage.unknown.length, color: "#FFB547" },
                ]}
              />
              <nav aria-label="Features" className="stack" style={{ gap: 2 }}>
                {d.features.map((f) => (
                  <a
                    key={f.id}
                    href={`#/features?id=${encodeURIComponent(f.id)}`}
                    aria-current={f.id === id ? "page" : undefined}
                    className="list-row"
                    style={{
                      textDecoration: "none",
                      padding: "7px 6px",
                      borderRadius: 6,
                      background: f.id === id ? "rgba(46,230,246,0.08)" : undefined,
                    }}
                  >
                    <span className="stack" style={{ gap: 2 }}>
                      <span>{f.name ?? f.id}</span>
                      <span className="hud" style={{ fontSize: 9.5 }}>
                        {f.entryPoints.length} entry points
                      </span>
                    </span>
                    <span
                      className={`chip ${f.namedBy === "detected" ? "" : f.namedBy === "ai" ? "ai" : "done"}`}
                    >
                      {f.namedBy.toUpperCase()}
                    </span>
                  </a>
                ))}
              </nav>
            </div>
          )}
        </View>
      </Panel>
      <Panel
        title={one.state === "ready" ? (one.data.feature.name ?? one.data.feature.id) : "Feature"}
        span="span 8"
        rows="span 2"
        meta={one.state === "ready" ? one.data.system : undefined}
      >
        {!id ? (
          <p className="muted">Pick a feature.</p>
        ) : (
          <View of={one}>
            {(d) => (
              <div className="stack" style={{ gap: 14 }}>
                <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                  <span className="chip">{d.feature.confidence.toUpperCase()}</span>
                  {d.feature.tags.map((t) => (
                    <span key={t} className="chip dim">
                      {t}
                    </span>
                  ))}
                  {d.feature.externalRefs.length === 0 ? (
                    <span className="chip warn">NO WORK ITEMS LINKED</span>
                  ) : (
                    d.feature.externalRefs.map((r, i) => (
                      <span key={i} className="chip done">
                        {r.system ?? "item"} {r.id ?? ""}
                      </span>
                    ))
                  )}
                </div>
                <div>
                  <div className="hud" style={{ fontSize: 10, marginBottom: 6 }}>
                    Entry points
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }} className="mono">
                    {d.feature.entryPoints.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                </div>
                <FeatureGraph records={[...d.feature.records, ...d.feature.entryPoints]} />
                <div>
                  <div className="hud" style={{ fontSize: 10, marginBottom: 6 }}>
                    Records in the flow ({d.feature.records.length})
                  </div>
                  <p
                    className="mono"
                    style={{ margin: 0, fontSize: 11.5, lineHeight: 1.7, color: "var(--text-2)" }}
                  >
                    {d.feature.records.join(" · ")}
                  </p>
                </div>
                <div>
                  <div className="hud" style={{ fontSize: 10, marginBottom: 6 }}>
                    Knowledge gaps
                  </div>
                  {d.looseEnds.length === 0 ? (
                    <p className="muted" style={{ margin: 0 }}>
                      None: every hop is known.
                    </p>
                  ) : (
                    <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
                      {d.looseEnds.map((l, i) => (
                        <li key={i}>
                          <span className="chip warn">{l.kind}</span> {l.text}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                  Name, tag or link it with{" "}
                  <span className="mono">atticus feature name {d.feature.id} …</span>,{" "}
                  <span className="mono">feature tag</span> or{" "}
                  <span className="mono">feature link</span>: the change goes in by PR.
                </p>
              </div>
            )}
          </View>
        )}
      </Panel>
    </div>
  );
}

// ------------------------------------------------------------------ Org pack

interface OrgPack {
  defaulted: string[];
  counts: Record<string, number>;
  problems: { file: string; path: string; message: string }[];
  patterns?: {
    code: string;
    name: string;
    definition: string;
    interaction: string;
    route: string;
    targetType: string;
  }[];
  checklists?: { name: string; version: string; rules: number }[];
  procedures?: { id: string; title?: string; steps: number }[];
}
interface Glossary {
  terms: { id: string; term: string; definition?: string; status: string }[];
}

export function OrgPackScreen() {
  const op = useApi<OrgPack>("/api/orgpack");
  const g = useView<Glossary>("glossary");
  return (
    <div className="bento">
      <Panel title="Org pack" span="span 4" kind="dark">
        <View of={op}>
          {(d) => (
            <div className="stack">
              {Object.entries(d.counts).map(([k, v]) => (
                <div key={k} className="list-row">
                  <span className="hud" style={{ fontSize: 10 }}>
                    {k}
                  </span>
                  <span className="n" style={{ fontSize: 16 }}>
                    {v}
                  </span>
                </div>
              ))}
              {d.problems.length ? (
                <p role="alert" style={{ color: "#FF9BCB", margin: 0 }}>
                  {d.problems.length} problems:{" "}
                  {d.problems.map((p) => `${p.file}: ${p.message}`).join("; ")}
                </p>
              ) : (
                <span className="chip done" style={{ width: "fit-content" }}>
                  VALID
                </span>
              )}
              {d.defaulted.length > 0 && (
                <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                  Using built-in defaults for {d.defaulted.join(", ")}.
                </p>
              )}
            </div>
          )}
        </View>
      </Panel>
      <Panel title="Integration patterns" span="span 8">
        <View of={op} empty={(d) => !d.patterns?.length} emptyText="No patterns yet.">
          {(d) => (
            <Table
              caption="Integration patterns"
              rows={d.patterns ?? []}
              rowKey={(p) => p.code}
              cols={[
                {
                  label: "Code",
                  cell: (p) => <span className="chip">{p.code}</span>,
                  width: "130px",
                },
                { label: "Pattern", cell: (p) => <span title={p.definition}>{p.name}</span> },
                { label: "Interaction", cell: (p) => p.interaction },
                { label: "Route", cell: (p) => p.route },
                { label: "Target", cell: (p) => p.targetType },
              ]}
            />
          )}
        </View>
      </Panel>
      <Panel title="Checklists and procedures" span="span 4">
        <View of={op}>
          {(d) => (
            <div className="stack">
              {(d.checklists ?? []).map((c) => (
                <div key={c.name} className="list-row">
                  <span>{c.name}</span>
                  <span className="hud" style={{ fontSize: 10 }}>
                    {c.rules} rules · v{c.version}
                  </span>
                </div>
              ))}
              {(d.procedures ?? []).map((p) => (
                <div key={p.id} className="list-row">
                  <span>{p.title ?? p.id}</span>
                  <span className="hud" style={{ fontSize: 10 }}>
                    {p.steps} steps
                  </span>
                </div>
              ))}
            </div>
          )}
        </View>
      </Panel>
      <Panel title="Glossary" span="span 8">
        <View of={g} empty={(d) => d.terms.length === 0} emptyText="No terms yet.">
          {(d) => (
            <Table
              caption="Glossary"
              rows={d.terms}
              rowKey={(t) => t.id}
              cols={[
                { label: "Term", cell: (t) => t.term, width: "180px" },
                {
                  label: "Definition",
                  cell: (t) =>
                    t.definition ?? <span className="chip warn">NEEDS A DEFINITION</span>,
                },
              ]}
            />
          )}
        </View>
      </Panel>
    </div>
  );
}

// ------------------------------------------------------------------ Intake

interface Intake {
  documents: {
    path: string;
    classification: string;
    status: string;
    title?: string;
    systems: string[];
    unknownNames: string[];
    records: string[];
    defences?: { risk: string; reason: string };
  }[];
  chains: unknown[];
  problems: { path: string; message: string }[];
}
interface Triage {
  items: {
    id: string;
    kind: string;
    summary: string;
    source: { path: string; line?: number };
    options: { label: string }[];
    next?: string;
  }[];
}

function TriageOptions(p: { item: string; options: { label: string }[]; done: () => void }) {
  const act = useAction();
  if (p.options.length === 0) return null;
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
        {p.options.map((o, i) => (
          <button
            key={i}
            type="button"
            className="btn"
            disabled={act.busy}
            onClick={() =>
              void act.run(
                () =>
                  api(`/api/triage/${encodeURIComponent(p.item)}/decide`, {
                    method: "POST",
                    body: { option: i + 1 },
                  }).then(p.done),
                `Decided: ${o.label}.`,
              )
            }
          >
            {o.label}
          </button>
        ))}
      </div>
      <Note note={act.note} />
    </div>
  );
}

const DOC_COLOR: Record<string, string> = {
  read: "#3DDC97",
  "needs-reading": "#2EE6F6",
  "no-reader": "#8F7BFF",
  unresolved: "#FFB547",
  duplicate: "#5B6B7A",
  superseded: "#5B6B7A",
  failed: "#FF4FA3",
};

export function IntakeScreen() {
  const intake = useView<Intake>("intake");
  const triage = useView<Triage>("triage");
  const docs = intake.state === "ready" ? intake.data.documents : [];
  const byStatus = [...new Set(docs.map((d) => d.status))];
  const facts = docs.reduce((a, d) => a + d.records.length, 0);
  return (
    <div className="bento">
      <Panel title="Files" span="span 3" kind="dark">
        <View of={intake}>
          {() => (
            <div className="stack">
              <span className="big">{docs.length}</span>
              <span className="hud" style={{ fontSize: 10 }}>
                files in inputs/
              </span>
            </div>
          )}
        </View>
      </Panel>
      <Panel title="Facts taken" span="span 2" kind="dark">
        <span className="big">{facts}</span>
      </Panel>
      <Panel title="What happened to them" span="span 3">
        <View of={intake} empty={() => docs.length === 0} emptyText="Nothing yet.">
          {() => (
            <Donut
              title="Files by status"
              parts={byStatus.map((st) => ({
                label: st,
                value: docs.filter((d) => d.status === st).length,
                color: DOC_COLOR[st] ?? "#BFEFF7",
              }))}
            />
          )}
        </View>
      </Panel>
      <Panel title="Defences" span="span 4">
        <View of={intake}>
          {() => {
            const flagged = docs.filter((d) => d.defences && d.defences.risk !== "cleared");
            return flagged.length === 0 ? (
              <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
                Nothing hidden or aimed at an AI reader. Ingested content is data, never
                instructions.
              </p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5 }}>
                {flagged.map((d) => (
                  <li key={d.path}>
                    <span className="mono">{d.path}</span>: {d.defences!.reason}
                  </li>
                ))}
              </ul>
            );
          }}
        </View>
      </Panel>
      <Panel title="Intake" span="span 8" meta="inputs/">
        <View
          of={intake}
          empty={(d) => d.documents.length === 0}
          emptyText="Nothing in inputs/ yet. Drop diagrams, documents, API specs and exports there (or run atticus intake add <file>)."
        >
          {(d) => (
            <Table
              caption="Files read from inputs/"
              rows={d.documents}
              rowKey={(x) => x.path}
              cols={[
                { label: "File", cell: (x) => x.path, mono: true },
                { label: "Read as", cell: (x) => x.classification },
                {
                  label: "About",
                  cell: (x) => list(x.systems) || <span className="muted">no system named</span>,
                },
                { label: "Facts", cell: (x) => x.records.length },
                {
                  label: "Status",
                  cell: (x) =>
                    x.defences?.risk === "high" ? (
                      <span className="chip blocking" title={x.defences.reason}>
                        QUARANTINED
                      </span>
                    ) : (
                      <span
                        className={`chip ${x.status === "read" ? "done" : x.status === "failed" || x.status === "unresolved" ? "warn" : "dim"}`}
                      >
                        {x.status.toUpperCase()}
                      </span>
                    ),
                },
              ]}
            />
          )}
        </View>
      </Panel>
      <Panel
        title="Needs you"
        span="span 4"
        meta={triage.state === "ready" ? triage.data.items.length : undefined}
      >
        <View of={triage} empty={(d) => d.items.length === 0} emptyText="Nothing to triage.">
          {(d) => (
            <div className="stack">
              {d.items.map((t) => (
                <div
                  key={t.id}
                  className="stack"
                  style={{ gap: 4, padding: "6px 0", borderBottom: "1px solid #18202A" }}
                >
                  <span className="row between" style={{ alignItems: "flex-start" }}>
                    <span style={{ fontSize: 12.5 }}>{t.summary}</span>
                    <span className={`chip ${t.kind === "defences" ? "blocking" : "warn"}`}>
                      {t.kind.toUpperCase()}
                    </span>
                  </span>
                  <span className="mono muted" style={{ fontSize: 11 }}>
                    {t.id} · {t.source.path}
                    {t.source.line ? `:${t.source.line}` : ""}
                  </span>
                  <TriageOptions item={t.id} options={t.options} done={() => triage.reload()} />
                </div>
              ))}
              <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                Each choice is saved as a curated decision in your name. Code always wins over a
                document until a person decides.
              </p>
            </div>
          )}
        </View>
      </Panel>
    </div>
  );
}

// ------------------------------------------------------------------ Scans

interface Repo {
  id: string;
  platform: string;
  type?: string;
  baseClone: { present: boolean };
}
interface Job {
  id: string;
  state: string;
  progress: { done: number; total: number; message: string };
  errors: string[];
  result?: Record<string, unknown>;
}

export function Scans() {
  const repos = useApi<Repo[]>("/api/repos");
  const kinds = useApi<{ kind: string; count: number }[]>("/api/catalog/kinds");
  const [job, setJob] = useState<Job | undefined>();
  const act = useAction();
  useLiveEvents((e) => {
    if (job && e.jobId === job.id) {
      if (e.type === "job.progress")
        setJob({
          ...job,
          progress: { done: Number(e.done), total: Number(e.total), message: String(e.message) },
        });
      if (e.type === "job.done") {
        void api<Job>(`/api/jobs/${job.id}`).then(setJob);
        repos.reload();
        kinds.reload();
      }
    }
  });
  const start = (path: string, label: string) =>
    act.run(async () => {
      const r = await api<{ jobId: string }>(path, { method: "POST", body: {} });
      setJob(await api<Job>(`/api/jobs/${r.jobId}`));
    }, `${label} started.`);
  const present =
    repos.state === "ready" ? repos.data.filter((r) => r.baseClone.present).length : 0;
  const total = repos.state === "ready" ? repos.data.length : 0;
  return (
    <div className="bento">
      <Panel title="Scan" span="span 4" kind="dark">
        <div className="stack">
          <div className="row">
            <Ring
              value={present}
              max={Math.max(total, 1)}
              size={64}
              label={`${present} of ${total} repos cloned`}
            />
            <span className="muted" style={{ fontSize: 12.5 }}>
              repos cloned locally
            </span>
          </div>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn"
              disabled={act.busy}
              onClick={() => void start("/api/workspace/sync", "Sync")}
            >
              Sync repos
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={act.busy}
              onClick={() => void start("/api/scan", "Scan")}
            >
              Scan now
            </button>
          </div>
          {job && (
            <div className="stack" role="status" aria-live="polite">
              <span className="hud" style={{ fontSize: 10 }}>
                {job.state} · {job.progress.message}
              </span>
              <Bar
                value={job.progress.done}
                max={Math.max(job.progress.total, 1)}
                label="Job progress"
              />
              {job.errors.length > 0 && (
                <span style={{ color: "#FF9BCB" }}>{job.errors.join("; ")}</span>
              )}
            </div>
          )}
          <Note note={act.note} />
          <p className="muted" style={{ margin: 0, fontSize: 11.5 }}>
            Scans read files only: no network, no AI.
          </p>
        </div>
      </Panel>
      <Panel title="Repos" span="span 8">
        <View of={repos} empty={(r) => r.length === 0} emptyText="No repos in any manifest yet.">
          {(r) => (
            <Table
              caption="Repos"
              rows={r}
              rowKey={(x) => x.id}
              cols={[
                { label: "Repo", cell: (x) => x.id, mono: true },
                { label: "Platform", cell: (x) => x.platform },
                { label: "Type", cell: (x) => x.type ?? "" },
                {
                  label: "Base clone",
                  cell: (x) => (
                    <span className={`chip ${x.baseClone.present ? "done" : "dim"}`}>
                      {x.baseClone.present ? "CLONED" : "NOT YET"}
                    </span>
                  ),
                },
              ]}
            />
          )}
        </View>
      </Panel>
      <Panel title="Catalog" span="1 / -1">
        <View of={kinds} empty={(k) => k.length === 0} emptyText="No facts yet.">
          {(k) => (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
                gap: 10,
              }}
            >
              {k.map((x) => (
                <div key={x.kind} className="stack" style={{ gap: 2 }}>
                  <span className="hud" style={{ fontSize: 9.5 }}>
                    {x.kind}
                  </span>
                  <span className="n" style={{ fontSize: 20 }}>
                    {x.count}
                  </span>
                </div>
              ))}
            </div>
          )}
        </View>
      </Panel>
    </div>
  );
}
