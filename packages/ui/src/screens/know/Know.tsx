import { useState, type FormEvent } from "react";
import { api, useApi, useLiveEvents } from "../../api/client.js";
import { GraphView, type Graph } from "../../app/graph.js";
import { Bar, Donut, Panel, Ring, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { Markdown, Note, Table, list, queryParam, useAction, useView } from "./common.js";

const T = COPY.know;

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
  verified: { bg: "var(--cov-verified)", label: T.verifiedFromCode },
  "document-only": { bg: "var(--cov-doc)", label: T.fromDocumentsOnly },
  unknown: { bg: "var(--cov-unknown)", label: "unknown" },
};

function SystemGuide({ system }: { system: string }) {
  const g = useApi<{ markdown: string; gaps: string[] }>(
    `/api/guide/${encodeURIComponent(system)}`,
  );
  return (
    <Panel title={T.guide(system)} span="1 / -1" meta={T.generatedFromTheCatalog}>
      <View of={g}>
        {(d) => (
          <div
            tabIndex={0}
            role="region"
            aria-label={T.guideTo(system)}
            style={{ maxHeight: 560, overflowY: "auto", paddingRight: 6 }}
          >
            <Markdown text={d.markdown} />
          </div>
        )}
      </View>
    </Panel>
  );
}

export function EcosystemMap() {
  const graph = useApi<Graph>("/api/graph");
  const cov = useView<Coverage>("coverage");
  const qs = useView<Questions>("questions");
  const [focus, setFocus] = useState<string | undefined>();
  return (
    <div className="bento">
      <Panel
        title={focus ? T.around(focus) : T.ecosystemMap}
        kind="hero"
        span="span 8"
        rows="span 2"
        meta={
          focus ? (
            <button type="button" className="btn" onClick={() => setFocus(undefined)}>
              {T.showAll}
            </button>
          ) : (
            T.clickANodeTo
          )
        }
      >
        <View of={graph} empty={(g) => g.nodes.length === 0} emptyText={T.theCatalogIsEmpty}>
          {(g) => <GraphView g={g} {...(focus ? { focus } : {})} onPick={setFocus} height={520} />}
        </View>
      </Panel>
      <Panel title={T.systems} span="span 4" rows="span 2">
        <View of={cov} empty={(c) => c.systems.length === 0} emptyText={T.noSystemsYet}>
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
                      borderBottom: "1px solid var(--rule)",
                    }}
                  >
                    <span className="row between">
                      <span className="mono" style={{ fontSize: 12.5 }}>
                        {s.system}
                      </span>
                      <span className="hud" style={{ fontSize: 9.5 }}>
                        {T.verified(s.verified, total, s.gaps ? T.gaps(s.gaps) : "")}
                      </span>
                    </span>
                    <Bar
                      value={s.verified}
                      max={Math.max(total, 1)}
                      label={T.factsVerifiedFromCode(s.system)}
                    />
                  </button>
                );
              })}
            </div>
          )}
        </View>
      </Panel>
      {focus && cov.state === "ready" && cov.data.systems.some((x) => x.system === focus) && (
        <SystemGuide system={focus} />
      )}
      <Panel title={T.whatTheCatalogKnows} span="span 8">
        <View of={cov} empty={(c) => c.systems.length === 0} emptyText={T.noSystemsYet}>
          {(c) => {
            const areas = [...new Set(c.systems.flatMap((x) => x.areas.map((a) => a.area)))];
            // Positioned, so the hidden words in its cells scroll with it instead of widening the page.
            return (
              <div
                style={{ overflowX: "auto", position: "relative" }}
                tabIndex={0}
                role="region"
                aria-label={COPY.app.scrollTable(T.coverageBySystemAnd2)}
              >
                <table
                  style={{
                    borderCollapse: "separate",
                    borderSpacing: 4,
                    width: "100%",
                    fontSize: 11,
                  }}
                >
                  <caption className="sr">{T.coverageBySystemAnd}</caption>
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
                              <td key={name} title={T.notExpected2(s.system, name)}>
                                <span className="sr">{T.notExpected}</span>
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
                                border: "1px solid var(--cov-line)",
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
        title={T.questionsForOwners}
        span="span 4"
        meta={qs.state === "ready" ? qs.data.questions.length : undefined}
      >
        <View of={qs} empty={(q) => q.questions.length === 0} emptyText={T.noOpenQuestionsEvery}>
          {(q) => (
            <ul
              tabIndex={0}
              aria-label={T.questionsForOwners}
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
                  style={{ gap: 2, paddingBottom: 6, borderBottom: "1px solid var(--rule)" }}
                >
                  <span style={{ fontSize: 12.5 }}>{x.question}</span>
                  <span className="hud" style={{ fontSize: 9.5 }}>
                    {x.system ?? ""}
                    {x.owner ? T.ask(x.owner) : T.ownerUnknown}
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

interface Incident {
  call: { owner: string; systems: string[] }[];
  ownerUnknown: string[];
  watch: { component: string; kind: string; name: string }[];
  recentChanges: {
    id: string;
    title: string;
    state: string;
    updatedAt: string;
    systems: string[];
  }[];
}

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
          kind: kindOf.get(from) ?? T.component,
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
  const incident = queryParam(hash, "incident") === "1";
  const imp = useApi<Impact>(q ? `/api/impact/${encodeURIComponent(q)}?depth=4` : undefined);
  const inc = useApi<Incident>(
    q && incident ? `/api/incident/${encodeURIComponent(q)}` : undefined,
  );
  const [blank, setBlank] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    // No id yet: say what to type, rather than a button that changes nothing.
    if (!text.trim()) {
      setBlank(true);
      return;
    }
    setBlank(false);
    location.hash = `#/impact?q=${encodeURIComponent(text.trim())}${incident ? "&incident=1" : ""}`;
  };
  const byHop = new Map<number, number>();
  if (imp.state === "ready")
    for (const a of imp.data.affected)
      byHop.set(a.path.length - 1, (byHop.get(a.path.length - 1) ?? 0) + 1);
  const blast: Graph | undefined = imp.state === "ready" ? blastGraph(imp.data) : undefined;
  return (
    <div className="bento">
      <Panel title={T.whatBreaksIfThis} span="1 / -1">
        <form onSubmit={submit} className="row" style={{ flexWrap: "wrap" }}>
          <label htmlFor="impact-id" className="sr">
            {T.recordId}
          </label>
          <input
            id="impact-id"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setBlank(false);
            }}
            aria-describedby={blank ? "impact-blank" : undefined}
            placeholder={T.aComponentInterfaceTable}
            style={{
              flex: "1 1 360px",
              height: 40,
              background: "var(--box)",
              color: "var(--text)",
              border: "1px solid var(--accent)",
              borderRadius: 10,
              padding: "0 12px",
              font: "inherit",
            }}
          />
          <button type="submit" className="btn primary">
            {T.showImpact}
          </button>
          <button
            type="button"
            className={`btn ${incident ? "danger" : ""}`}
            aria-pressed={incident}
            onClick={() =>
              (location.hash = `#/impact?q=${encodeURIComponent(text.trim())}${incident ? "" : "&incident=1"}`)
            }
          >
            {incident ? T.incidentModeOn : T.incidentMode}
          </button>
          <a href="#/explore" className="muted" style={{ fontSize: 12 }}>
            {T.findAnIdIn}
          </a>
        </form>
        {blank && (
          <p id="impact-blank" role="alert" className="run-note bad">
            {COPY.app.needId}
          </p>
        )}
      </Panel>
      {q && incident && (
        <>
          <Panel title={T.ownersToCall} span="span 4" kind="dark">
            <View of={inc}>
              {(d) => (
                <div className="stack" style={{ gap: 8 }}>
                  {d.call.map((c) => (
                    <div key={c.owner} className="list-row">
                      <span className="chip blocking">{c.owner}</span>
                      <span className="mono" style={{ fontSize: 11.5 }}>
                        {c.systems.join(", ")}
                      </span>
                    </div>
                  ))}
                  {d.ownerUnknown.length > 0 && (
                    <p style={{ margin: 0, fontSize: 12.5, color: "var(--amber-text)" }}>
                      {T.noOwnerRecordedFor(d.ownerUnknown.join(", "))}
                    </p>
                  )}
                  <p className="muted" style={{ margin: 0, fontSize: 11.5 }}>
                    {T.fromTheLastScan}
                  </p>
                </div>
              )}
            </View>
          </Panel>
          <Panel title={T.whatWatchesIt} span="span 4">
            <View of={inc} empty={(d) => d.watch.length === 0} emptyText={T.noAlertsDashboardsOr}>
              {(d) => (
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.6 }}>
                  {d.watch.map((w, i) => (
                    <li key={i}>
                      <span className="chip dim">{w.kind}</span> {w.name}{" "}
                      <span className="mono muted">({w.component})</span>
                    </li>
                  ))}
                </ul>
              )}
            </View>
          </Panel>
          <Panel title={T.recentNearbyChanges} span="span 4">
            <View
              of={inc}
              empty={(d) => d.recentChanges.length === 0}
              emptyText={T.noChangeTouchesWhat}
            >
              {(d) => (
                <div className="stack" style={{ gap: 6 }}>
                  {d.recentChanges.map((c) => (
                    <a
                      key={c.id}
                      href={`#/changes/${encodeURIComponent(c.id)}`}
                      className="list-row"
                      style={{ textDecoration: "none", color: "inherit" }}
                    >
                      <span className="stack" style={{ gap: 2 }}>
                        <span style={{ fontSize: 12.5 }}>{c.title}</span>
                        <span className="hud" style={{ fontSize: 9.5 }}>
                          {c.id} · {c.updatedAt.slice(0, 10)} · {c.systems.join(", ")}
                        </span>
                      </span>
                      <span className="chip">{c.state.toUpperCase()}</span>
                    </a>
                  ))}
                </div>
              )}
            </View>
          </Panel>
        </>
      )}
      {!q ? null : (
        <>
          <Panel title={T.blastRadiusOf(q)} kind="hero" span="span 9">
            <View of={imp} empty={(d) => d.affected.length === 0} emptyText={T.nothingDependsOnIt}>
              {() => <GraphView g={blast!} focus={q} height={380} />}
            </View>
          </Panel>
          <Panel title={T.blastRadius} span="span 3" kind="dark">
            <View of={imp}>
              {(d) => (
                <div className="stack">
                  <span className="big">{d.affected.length}</span>
                  <span className="hud" style={{ fontSize: 10 }}>
                    {T.recordsAffectedBy(d.root)}
                  </span>
                  {[...byHop.entries()]
                    .sort((a, b) => a[0] - b[0])
                    .map(([hop, n]) => (
                      <div key={hop} className="row" style={{ gap: 8 }}>
                        <span className="hud" style={{ width: 56, fontSize: 10 }}>
                          {T.hop(hop, hop === 1 ? "" : "s")}
                        </span>
                        <div style={{ flex: 1 }}>
                          <Bar
                            value={n}
                            max={Math.max(...byHop.values())}
                            label={T.recordsHopsAway(n, hop)}
                          />
                        </div>
                        <span className="n">{n}</span>
                      </div>
                    ))}
                </div>
              )}
            </View>
          </Panel>
          <Panel title={T.affected} span="span 8">
            <View of={imp} empty={(d) => d.affected.length === 0} emptyText={T.nothingDependsOnIt2}>
              {(d) => (
                <Table
                  caption={T.affectedRecords}
                  rows={d.affected}
                  rowKey={(a) => `${a.kind}/${a.id}`}
                  cols={[
                    { label: T.record, cell: (a) => a.id, mono: true },
                    { label: T.kind, cell: (a) => <span className="chip dim">{a.kind}</span> },
                    { label: T.why, cell: (a) => a.reason },
                    {
                      label: T.owner,
                      cell: (a) =>
                        a.owner ? (
                          <span className="chip dim" style={{ whiteSpace: "nowrap" }}>
                            {a.owner}
                          </span>
                        ) : (
                          <span className="chip warn">{T.unknown}</span>
                        ),
                    },
                  ]}
                />
              )}
            </View>
          </Panel>
          <Panel title={T.whatWouldSharpenThis} span="span 4">
            <View of={imp} empty={(d) => d.gaps.length === 0} emptyText={T.noGapsTheCatalog}>
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
              {T.readOnlyAtticusNever}
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
            background: "var(--inset)",
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
        title={T.featuresFoundInCode}
        span="span 4"
        rows="span 2"
        meta={all.state === "ready" ? all.data.features.length : undefined}
      >
        <View of={all} empty={(d) => d.features.length === 0} emptyText={T.noFeaturesFoundYet}>
          {(d) => (
            <div className="stack" style={{ gap: 10 }}>
              <Donut
                title={T.featuresByHowThey}
                parts={[
                  {
                    label: T.confirmedByPeople,
                    value: d.coverage.confirmed.length,
                    color: "var(--green)",
                  },
                  {
                    label: T.foundInCodeOnly,
                    value: d.coverage.detectedOnly.length,
                    color: "var(--accent)",
                  },
                  { label: T.unknown2, value: d.coverage.unknown.length, color: "var(--amber)" },
                ]}
              />
              <nav aria-label={T.features} className="stack" style={{ gap: 2 }}>
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
                      background: f.id === id ? "var(--picked)" : undefined,
                    }}
                  >
                    <span className="stack" style={{ gap: 2 }}>
                      <span>{f.name ?? f.id}</span>
                      <span className="hud" style={{ fontSize: 9.5 }}>
                        {T.entryPoints(f.entryPoints.length)}
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
        title={one.state === "ready" ? (one.data.feature.name ?? one.data.feature.id) : T.feature}
        span="span 8"
        rows="span 2"
        meta={one.state === "ready" ? one.data.system : undefined}
      >
        {!id ? (
          <p className="muted">{T.pickAFeature}</p>
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
                    <span className="chip warn">{T.noWorkItemsLinked}</span>
                  ) : (
                    d.feature.externalRefs.map((r, i) => (
                      <span key={i} className="chip done">
                        {r.system ?? T.item} {r.id ?? ""}
                      </span>
                    ))
                  )}
                </div>
                <div>
                  <div className="hud" style={{ fontSize: 10, marginBottom: 6 }}>
                    {T.entryPoints2}
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
                    {T.recordsInTheFlow(d.feature.records.length)}
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
                    {T.knowledgeGaps}
                  </div>
                  {d.looseEnds.length === 0 ? (
                    <p className="muted" style={{ margin: 0 }}>
                      {T.noneEveryHopIs}
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
                  {T.nameTagOrLink}
                  <span className="mono">{T.atticusFeatureName(d.feature.id)}</span>,{" "}
                  <span className="mono">{T.featureTag}</span> {T.or}
                  <span className="mono">{T.featureLink}</span>
                  {T.theChangeGoesIn}
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
      <Panel title={T.orgPack} span="span 4" kind="dark">
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
                <p role="alert" style={{ color: "var(--magenta-text)", margin: 0 }}>
                  {T.problems(
                    d.problems.length,
                    d.problems.map((p) => `${p.file}: ${p.message}`).join("; "),
                  )}
                </p>
              ) : (
                <span className="chip done" style={{ width: "fit-content" }}>
                  {T.valid}
                </span>
              )}
              {d.defaulted.length > 0 && (
                <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                  {T.usingBuiltInDefaults(d.defaulted.join(", "))}
                </p>
              )}
            </div>
          )}
        </View>
      </Panel>
      <Panel title={T.integrationPatterns} span="span 8">
        <View of={op} empty={(d) => !d.patterns?.length} emptyText={T.noPatternsYet}>
          {(d) => (
            <Table
              caption={T.integrationPatterns}
              rows={d.patterns ?? []}
              rowKey={(p) => p.code}
              cols={[
                {
                  label: T.code,
                  cell: (p) => <span className="chip">{p.code}</span>,
                  width: "130px",
                },
                { label: T.pattern, cell: (p) => <span title={p.definition}>{p.name}</span> },
                { label: T.interaction, cell: (p) => p.interaction },
                { label: T.route, cell: (p) => p.route },
                { label: T.target, cell: (p) => p.targetType },
              ]}
            />
          )}
        </View>
      </Panel>
      <Panel title={T.checklistsAndProcedures} span="span 4">
        <View of={op}>
          {(d) => (
            <div className="stack">
              {(d.checklists ?? []).map((c) => (
                <div key={c.name} className="list-row">
                  <span>{c.name}</span>
                  <span className="hud" style={{ fontSize: 10 }}>
                    {T.rulesV(c.rules, c.version)}
                  </span>
                </div>
              ))}
              {(d.procedures ?? []).map((p) => (
                <div key={p.id} className="list-row">
                  <span>{p.title ?? p.id}</span>
                  <span className="hud" style={{ fontSize: 10 }}>
                    {T.steps(p.steps)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </View>
      </Panel>
      <Panel title={T.glossary} span="span 8">
        <View of={g} empty={(d) => d.terms.length === 0} emptyText={T.noTermsYet}>
          {(d) => (
            <Table
              caption={T.glossary}
              rows={d.terms}
              rowKey={(t) => t.id}
              cols={[
                { label: T.term, cell: (t) => t.term, width: "180px" },
                {
                  label: T.definition,
                  cell: (t) =>
                    t.definition ?? <span className="chip warn">{T.needsADefinition}</span>,
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

function TriageOptions(p: {
  item: string;
  options: { label: string }[];
  /** Called with what was decided; the item leaves the list, so the panel shows the outcome. */
  done: (decided: string) => void;
}) {
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
                  }).then(() => p.done(`Decided: ${o.label}.`)),
                `Decided: ${o.label}.`,
              )
            }
          >
            {o.label}
          </button>
        ))}
      </div>
      {/* Success shows above the list: this item leaves it. */}
      <Note note={act.note?.ok && !act.note.working ? undefined : act.note} />
    </div>
  );
}

const DOC_COLOR: Record<string, string> = {
  read: "var(--green)",
  "needs-reading": "var(--accent)",
  "no-reader": "var(--violet)",
  unresolved: "var(--amber)",
  duplicate: "var(--gone)",
  superseded: "var(--gone)",
  failed: "var(--magenta)",
};

export function IntakeScreen() {
  const intake = useView<Intake>("intake");
  const triage = useView<Triage>("triage");
  const [decided, setDecided] = useState<string | undefined>();
  const docs = intake.state === "ready" ? intake.data.documents : [];
  const byStatus = [...new Set(docs.map((d) => d.status))];
  const facts = docs.reduce((a, d) => a + d.records.length, 0);
  return (
    <div className="bento">
      <Panel title={T.files} span="span 3" kind="dark">
        <View of={intake}>
          {() => (
            <div className="stack">
              <span className="big">{docs.length}</span>
              <span className="hud" style={{ fontSize: 10 }}>
                {T.filesInInputs}
              </span>
            </div>
          )}
        </View>
      </Panel>
      <Panel title={T.factsTaken} span="span 2" kind="dark">
        <span className="big">{facts}</span>
      </Panel>
      <Panel title={T.whatHappenedToThem} span="span 3">
        <View of={intake} empty={() => docs.length === 0} emptyText={T.nothingYet}>
          {() => (
            <Donut
              title={T.filesByStatus}
              parts={byStatus.map((st) => ({
                label: st,
                value: docs.filter((d) => d.status === st).length,
                color: DOC_COLOR[st] ?? "var(--accent-pale)",
              }))}
            />
          )}
        </View>
      </Panel>
      <Panel title={T.defences} span="span 4">
        <View of={intake}>
          {() => {
            const flagged = docs.filter((d) => d.defences && d.defences.risk !== "cleared");
            return flagged.length === 0 ? (
              <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
                {T.nothingHiddenOrAimed}
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
      <Panel title={T.intake} span="span 8" meta={T.inputs}>
        <View of={intake} empty={(d) => d.documents.length === 0} emptyText={T.nothingInInputsYet}>
          {(d) => (
            <Table
              caption={T.filesReadFromInputs}
              rows={d.documents}
              rowKey={(x) => x.path}
              cols={[
                { label: T.file, cell: (x) => x.path, mono: true },
                { label: T.readAs, cell: (x) => x.classification },
                {
                  label: T.about,
                  cell: (x) => list(x.systems) || <span className="muted">{T.noSystemNamed}</span>,
                },
                { label: T.facts, cell: (x) => x.records.length },
                {
                  label: T.status,
                  cell: (x) =>
                    x.defences?.risk === "high" ? (
                      <span className="chip blocking" title={x.defences.reason}>
                        {T.quarantined}
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
        title={T.needsYou}
        span="span 4"
        meta={triage.state === "ready" ? triage.data.items.length : undefined}
      >
        <View of={triage} empty={(d) => d.items.length === 0} emptyText={T.nothingToTriage}>
          {(d) => (
            <div className="stack">
              {decided && <Note note={{ ok: true, text: decided }} />}
              {d.items.map((t) => (
                <div
                  key={t.id}
                  className="stack"
                  style={{ gap: 4, padding: "6px 0", borderBottom: "1px solid var(--rule)" }}
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
                  <TriageOptions
                    item={t.id}
                    options={t.options}
                    done={(text) => {
                      setDecided(text);
                      triage.reload();
                    }}
                  />
                </div>
              ))}
              <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                {T.eachChoiceIsSaved}
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
      <Panel title={T.scan} span="span 4" kind="dark">
        <div className="stack">
          <div className="row">
            <Ring
              value={present}
              max={Math.max(total, 1)}
              size={64}
              label={T.ofReposCloned(present, total)}
            />
            <span className="muted" style={{ fontSize: 12.5 }}>
              {T.reposClonedLocally}
            </span>
          </div>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn"
              disabled={act.busy}
              onClick={() => void start("/api/workspace/sync", T.sync)}
            >
              {T.syncRepos}
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={act.busy}
              onClick={() => void start("/api/scan", T.scan2)}
            >
              {T.scanNow}
            </button>
          </div>
          {job && (
            <div className="stack" role="status" aria-live="polite">
              <span className="hud" style={{ fontSize: 10 }}>
                {job.state}
                {job.state === "failed" ? "" : ` · ${job.progress.message}`}
              </span>
              <Bar
                value={job.progress.done}
                max={Math.max(job.progress.total, 1)}
                label={T.jobProgress}
              />
              {job.errors.length > 0 && (
                <span style={{ color: "var(--magenta-text)" }}>{job.errors.join("; ")}</span>
              )}
            </div>
          )}
          <Note note={act.note} />
          <p className="muted" style={{ margin: 0, fontSize: 11.5 }}>
            {T.scansReadFilesOnly}
          </p>
        </div>
      </Panel>
      <Panel title={T.repos} span="span 8">
        <View of={repos} empty={(r) => r.length === 0} emptyText={T.noReposInAny}>
          {(r) => (
            <Table
              caption={T.repos}
              rows={r}
              rowKey={(x) => x.id}
              cols={[
                { label: T.repo, cell: (x) => x.id, mono: true },
                { label: T.platform, cell: (x) => x.platform },
                { label: T.type, cell: (x) => x.type ?? "" },
                {
                  label: T.baseClone,
                  cell: (x) => (
                    <span className={`chip ${x.baseClone.present ? "done" : "dim"}`}>
                      {x.baseClone.present ? T.cloned : T.notYet}
                    </span>
                  ),
                },
              ]}
            />
          )}
        </View>
      </Panel>
      <Panel title={T.catalog} span="1 / -1">
        <View of={kinds} empty={(k) => k.length === 0} emptyText={T.noFactsYet}>
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
