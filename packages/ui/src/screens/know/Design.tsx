import { useEffect, useState } from "react";
import { useApi, useLiveEvents } from "../../api/client.js";
import { FlowCanvas, type FlowViewData } from "../../app/flow.js";
import { GraphView, type Graph } from "../../app/graph.js";
import { Bar, CheckAgain, Donut, Panel, Ring, View } from "../../app/ui.js";
import { Table, queryParam, setQueryParam, useView } from "./common.js";
import { COPY } from "../../copy.js";
import {
  Citation,
  EvidenceProvider,
  GapMarks,
  gapsOfEvidence,
  reposOf,
  useEvidence,
} from "../../app/evidence.js";

const T = COPY.design;

// ------------------------------------------------------------------ Contracts

interface Evidence {
  source: string;
  repo?: string;
  path?: string;
  line?: number;
}
type Rec = Record<string, unknown> & {
  kind: string;
  id: string;
  name?: string;
  confidence?: string;
  evidence?: Evidence[];
};

const label = (r: Rec): string => {
  if (r.kind === "Endpoint")
    return `${String(r.method ?? "")} ${String(r.normalizedPath ?? r.path ?? r.id)}`.trim();
  if (r.kind === "Interface")
    return `${String(r.from ?? "?")} → ${String(r.to ?? "?")}${r.via ? ` · ${String(r.via)}` : ""}`;
  return r.name ?? r.id;
};

function ContractList({
  kind,
  title,
  pick,
  picked,
}: {
  kind: string;
  title: string;
  pick: (r: Rec) => void;
  picked?: string;
}) {
  const l = useApi<{ items: Rec[]; total: number }>(`/api/catalog/${kind}?limit=200`);
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="row between">
        <span className="hud" style={{ fontSize: 10 }}>
          {title}
        </span>
        <span className="n" style={{ fontSize: 14 }}>
          {l.state === "ready" ? l.data.total : ""}
        </span>
      </div>
      <View
        of={l}
        empty={(d) => d.items.length === 0}
        emptyText={T.noInTheCatalog(title.toLowerCase())}
      >
        {(d) => (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {d.items.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  aria-pressed={picked === r.id}
                  onClick={() => pick(r)}
                  className="list-row"
                  style={{
                    width: "100%",
                    background: picked === r.id ? "var(--picked)" : "transparent",
                    border: 0,
                    color: "inherit",
                    font: "inherit",
                    textAlign: "left",
                    cursor: "pointer",
                    padding: "6px",
                    borderRadius: 6,
                  }}
                >
                  <span className="mono" style={{ fontSize: 11.5, wordBreak: "break-all" }}>
                    {label(r)}
                  </span>
                  <span className={`chip ${r.confidence === "verified" ? "done" : "warn"}`}>
                    {(r.confidence ?? "unknown").toUpperCase()}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </View>
    </div>
  );
}

/**
 * A contract's own gaps (ADR 0124 addendum D-app, F3): no fact verified from code on any of its
 * lines, or an open question on one, from the repos' facts; a shape and words, never colour.
 */
function RecordGaps({ evidence }: { evidence: Evidence[] }) {
  const ev = useEvidence();
  const repos = reposOf(evidence).join(" ");
  useEffect(() => {
    for (const x of repos.split(" ").filter(Boolean)) ev?.need(x);
  }, [repos, ev]);
  const of = (repo: string) => {
    const v = ev?.of(repo);
    return v?.state === "ready" ? v.data : undefined;
  };
  return <GapMarks gaps={gapsOfEvidence(evidence, of, { bare: true })} />;
}

/**
 * The whole path of a call through the gateways (ADR 0124 addendum A-gateway2): each hop's
 * proxy and base path, what it checks and the scopes it demands, in the order the call meets
 * them. The hops are the GatewayRoute records the Interface cites on its gateway side, matched
 * by the line each rests on, so what is shown is what the catalog holds and nothing more.
 */
function CallPath({ r }: { r: Rec }) {
  const routes = useApi<{ items: Rec[] }>("/api/catalog/GatewayRoute?limit=500");
  const at = (e: Evidence) => `${e.repo ?? ""}|${e.path ?? ""}:${e.line ?? ""}`;
  const order = (r.evidence ?? [])
    .filter((e) => (e as Evidence & { side?: string }).side === "gateway" && e.path)
    .map(at);
  const hopsOf = (items: Rec[]) =>
    order.length
      ? items
          .flatMap((x) => {
            const own = (x.evidence ?? [])[0];
            const n = own?.path ? order.indexOf(at(own)) : -1;
            return n < 0 ? [] : [{ x, n }];
          })
          .sort((a, b) => a.n - b.n || (a.x.id < b.x.id ? -1 : 1))
          .map((h) => h.x)
      : [];
  return (
    <div>
      <div className="hud" style={{ fontSize: 10, marginBottom: 6 }}>
        {T.thePathOfTheCall}
      </div>
      {/* Loading and error states are the View's; a call with no route in the catalog says so. */}
      <View
        of={routes}
        empty={(d) => hopsOf(d.items).length === 0}
        emptyText={T.noRouteRecordedFor}
      >
        {(d) => (
          <ol className="stack" style={{ gap: 4, margin: 0, paddingLeft: 18, fontSize: 12.5 }}>
            {hopsOf(d.items).map((h, i) => {
              const scopes = (h.scopes as string[] | undefined) ?? [];
              const policies = (h.policies as string[] | undefined) ?? [];
              return (
                <li key={h.id}>
                  <span className="mono">
                    {String(h.proxy ?? h.id)} {String(h.basepath ?? "")}
                  </span>{" "}
                  <span className={`chip ${scopes.length ? "done" : "blocking"}`}>
                    {scopes.length ? T.scopesIt(scopes.join(", ")) : T.noScopeDemanded}
                  </span>{" "}
                  <span className="hud" style={{ fontSize: 9.5 }}>
                    {i === 0 && r.auth
                      ? T.theCallerMeets(String(r.auth))
                      : policies.join(", ") || T.thenReaches(String(h.target ?? ""))}
                  </span>
                </li>
              );
            })}
            <li>
              <span className="mono">
                {String(r.to ?? "")} {String(r.method ?? "")} {String(r.normalizedPath ?? "")}
              </span>
            </li>
          </ol>
        )}
      </View>
    </div>
  );
}

function ContractDetail({ r }: { r: Rec }) {
  const rec = useApi<Rec>(`/api/catalog/${r.kind}/${encodeURIComponent(r.id)}`);
  const imp = useApi<{ affected: { id: string; kind: string; owner?: string }[] }>(
    `/api/impact/${encodeURIComponent(r.id)}?depth=2`,
  );
  return (
    <Panel title={label(r)} span="span 5" rows="span 2" meta={r.kind}>
      <View of={rec}>
        {(d) => (
          <div className="stack" style={{ gap: 12 }}>
            <div>
              <div className="hud" style={{ fontSize: 10, marginBottom: 6 }}>
                {T.evidence}
              </div>
              <RecordGaps evidence={d.evidence ?? []} />
              {(d.evidence ?? []).length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>
                  {T.noEvidenceTreatIt}
                </p>
              ) : (
                (d.evidence ?? []).map((e, i) => (
                  <div key={i} style={{ fontSize: 12.5, marginBottom: 4 }}>
                    <span className={`chip ${e.source === "code" ? "" : "warn"}`}>
                      {e.source.toUpperCase()}
                    </span>{" "}
                    {e.path && e.line ? (
                      <>
                        {e.repo && <span className="mono">{e.repo} · </span>}
                        <Citation repo={e.repo} at={`${e.path}:${e.line}`} />
                      </>
                    ) : (
                      <span className="mono">
                        {e.repo ? `${e.repo} · ` : ""}
                        {e.path ?? ""}
                      </span>
                    )}
                  </div>
                ))
              )}
            </div>
            {d.kind === "Interface" && d.via === "gateway" ? <CallPath r={d} /> : null}
            <div>
              <div className="hud" style={{ fontSize: 10, marginBottom: 6 }}>
                {T.consumersAndDependants}
              </div>
              <View
                of={imp}
                empty={(x) => x.affected.length === 0}
                emptyText={T.nothingInTheCatalog}
              >
                {(x) => (
                  <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                    {x.affected
                      .filter((a) => a.kind === "Component")
                      .map((a) => (
                        <span key={a.id} className="chip dim">
                          {a.id}
                        </span>
                      ))}
                    <a href={`#/impact?q=${encodeURIComponent(r.id)}`}>{T.seeImpact}</a>
                  </div>
                )}
              </View>
            </div>
            <details>
              <summary className="hud" style={{ fontSize: 10, cursor: "pointer" }}>
                {T.record}
              </summary>
              <pre
                className="mono"
                style={{ fontSize: 11, whiteSpace: "pre-wrap", color: "var(--text-2)" }}
              >
                {JSON.stringify(
                  Object.fromEntries(Object.entries(d).filter(([k]) => k !== "evidence")),
                  null,
                  2,
                )}
              </pre>
            </details>
          </div>
        )}
      </View>
    </Panel>
  );
}

export function Contracts() {
  const kinds = useApi<{ kind: string; count: number }[]>("/api/catalog/kinds");
  const iface = useApi<{ items: Rec[] }>("/api/catalog/Interface?limit=500");
  const [chosen, setPicked] = useState<Rec | undefined>();
  const first = useApi<{ items: Rec[] }>("/api/catalog/Endpoint?limit=1");
  const picked = chosen ?? (first.state === "ready" ? first.data.items[0] : undefined);
  const n = (k: string) =>
    kinds.state === "ready" ? (kinds.data.find((x) => x.kind === k)?.count ?? 0) : 0;
  const verified =
    iface.state === "ready"
      ? iface.data.items.filter((i) => i.confidence === "verified").length
      : 0;
  const total = iface.state === "ready" ? iface.data.items.length : 0;
  return (
    <EvidenceProvider>
      <div className="bento">
        <Panel title={T.contracts} span="span 4" rows="span 2">
          <div
            className="stack"
            tabIndex={0}
            role="region"
            aria-label={T.contractsList}
            style={{ gap: 14, maxHeight: 640, overflowY: "auto" }}
          >
            <ContractList
              kind="Endpoint"
              title={T.apis}
              pick={setPicked}
              {...(picked ? { picked: picked.id } : {})}
            />
            <ContractList
              kind="Interface"
              title={T.interfacesAndEvents}
              pick={setPicked}
              {...(picked ? { picked: picked.id } : {})}
            />
            <ContractList
              kind="Table"
              title={T.dataStores}
              pick={setPicked}
              {...(picked ? { picked: picked.id } : {})}
            />
            <p className="muted" style={{ margin: 0, fontSize: 11.5 }}>
              {T.dataStoresComeFrom}
            </p>
          </div>
        </Panel>
        {picked ? (
          <ContractDetail key={`${picked.kind}/${picked.id}`} r={picked} />
        ) : (
          <Panel title={T.pickAContract} span="span 5" rows="span 2">
            <div className="state">{T.chooseAnApiAn}</div>
          </Panel>
        )}
        <Panel title={T.contractMix} span="span 3" kind="dark">
          <View of={kinds}>
            {() => (
              <Donut
                title={T.contractsByKind}
                parts={[
                  { label: "APIs", value: n("Endpoint"), color: "var(--accent)" },
                  { label: T.interfaces, value: n("Interface"), color: "var(--violet)" },
                  { label: T.tables, value: n("Table"), color: "var(--amber)" },
                ]}
              />
            )}
          </View>
        </Panel>
        <Panel title={T.verifiedFromCode} span="span 3">
          <View of={iface}>
            {() => (
              <div className="stack">
                <Ring
                  value={verified}
                  max={Math.max(total, 1)}
                  size={64}
                  label={T.ofInterfacesVerifiedFrom(verified, total)}
                />
                <p className="muted" style={{ margin: 0, fontSize: 11.5 }}>
                  {T.aVendorSpecIs}
                </p>
                <a href="#/mappings">{T.fieldMappings}</a>
              </div>
            )}
          </View>
        </Panel>
      </div>
    </EvidenceProvider>
  );
}

// ------------------------------------------------------------------ Reconcile

interface ReconcileItem {
  id: string;
  type: string;
  summary: string;
  diagram?: { cell: string; line: number };
  records: string[];
  suggestion?: { text: string };
}
interface ReconcileOut {
  diagrams: {
    file: string;
    edges: number;
    matches: { cell: string; interfaces: string[] }[];
    items: ReconcileItem[];
    names: { name: string; id?: string; how?: string; similar: string[] }[];
    problems: { cell: string; message: string }[];
  }[];
}

/** The diagrams `atticus reconcile` reads by itself: under inputs/diagrams/ (reconcile-commands). */
const DIAGRAM = /^inputs\/diagrams\/.+\.(drawio|drawio\.xml|vsdx|mmd|mermaid|csv)$/i;

/**
 * Whether inputs/diagrams/ holds a diagram to reconcile, from the Documents list: undefined while
 * it loads, true when it can't be read (reconcile is asked as before). Exported for tests.
 */
export function hasDiagrams(
  docs: { documents: { path: string }[] } | "error" | undefined,
): boolean | undefined {
  if (docs === "error") return true;
  return docs ? docs.documents.some((d) => DIAGRAM.test(d.path)) : undefined;
}

/** Reconcile, asked only when there is a diagram (with none, the command refuses: 2026-10-25). */
function useReconcile() {
  const docs = useApi<{ documents: { path: string }[] }>("/api/knowledge/documents");
  const some = hasDiagrams(
    docs.state === "ready" ? docs.data : docs.state === "error" ? "error" : undefined,
  );
  const r = useApi<{ code: number; data: ReconcileOut }>(some ? "/api/view/reconcile" : undefined);
  return { r, none: some === false };
}

const noDiagrams = (e: string) => /No diagrams to reconcile/.test(e);

export function Reconcile({ hash }: { hash: string }) {
  const { r, none } = useReconcile();
  const file = queryParam(hash, "file");
  const [filter, setFilter] = useState<string>("all");
  useLiveEvents((e) => {
    if (e.type === "job.done") r.reload();
  });
  if (none || (r.state === "error" && noDiagrams(r.error)))
    return (
      <div className="bento">
        <Panel title={T.reconcileADiagramAgainst} span="1 / -1">
          <div className="state">
            {T.noDiagramsYetPut}
            <span className="mono">{T.inputsDiagrams}</span> {T.orAddThemOn}
            <a href="#/intake">{T.intake}</a>
            {T.thenComeBack}
          </div>
        </Panel>
      </div>
    );
  const diagrams = r.state === "ready" ? r.data.data.diagrams : [];
  const d = diagrams.find((x) => x.file === file) ?? diagrams[0];
  const types = d ? [...new Set(d.items.map((i) => i.type))] : [];
  const items = d ? d.items.filter((i) => filter === "all" || i.type === filter) : [];
  return (
    <div className="bento">
      <Panel title={T.diagrams} span="span 4">
        <View of={r} empty={() => diagrams.length === 0} emptyText={T.noDiagramsCouldBe}>
          {() => (
            <div className="stack" style={{ gap: 8 }}>
              {diagrams.map((x) => (
                <a
                  key={x.file}
                  href={`#/reconcile?file=${encodeURIComponent(x.file)}`}
                  aria-current={x === d ? "page" : undefined}
                  className="list-row"
                  style={{
                    textDecoration: "none",
                    padding: 6,
                    borderRadius: 6,
                    background: x === d ? "var(--picked)" : undefined,
                  }}
                >
                  <span className="stack" style={{ gap: 2 }}>
                    <span className="mono" style={{ fontSize: 11.5 }}>
                      {x.file.replace(/^inputs\/diagrams\//, "")}
                    </span>
                    <span className="hud" style={{ fontSize: 9.5 }}>
                      {T.edgesMatchCode(x.matches.length, x.edges)}
                    </span>
                  </span>
                  <span className={`chip ${x.items.length ? "warn" : "done"}`}>
                    {x.items.length ? T.toResolve(x.items.length) : T.inSync}
                  </span>
                </a>
              ))}
              <CheckAgain of={r} label={T.checkAgain} />
              {d && (
                <div className="stack" style={{ gap: 12, marginTop: 10 }}>
                  <div className="row">
                    <Ring
                      value={d.matches.length}
                      max={Math.max(d.edges, 1)}
                      size={72}
                      label={T.ofDrawnEdgesAgree(d.matches.length, d.edges)}
                    />
                    <span className="muted" style={{ fontSize: 12.5 }}>
                      {T.drawnEdgesAgreeWith}
                    </span>
                  </div>
                  <Donut
                    title={T.itemsToResolveBy}
                    parts={types.map((t, i) => ({
                      label: t,
                      value: d.items.filter((x) => x.type === t).length,
                      color: [
                        "var(--magenta)",
                        "var(--amber)",
                        "var(--accent)",
                        "var(--violet)",
                        "var(--green)",
                        "var(--accent-pale)",
                      ][i % 6]!,
                    }))}
                  />
                  {d.names.length > 0 && (
                    <span className="hud" style={{ fontSize: 10 }}>
                      {T.labelsMatchedToThe(d.names.filter((x) => x.id).length, d.names.length)}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </View>
      </Panel>
      <Panel
        title={d ? T.edgeByEdge(d.file.split("/").pop() ?? "") : T.edgeByEdge2}
        span="span 8"
        meta={
          d ? (
            <Bar
              value={d.matches.length}
              max={Math.max(d.edges, 1)}
              label={T.ofEdgesAgreeWith(d.matches.length, d.edges)}
            />
          ) : undefined
        }
      >
        {!d ? (
          <div className="state">{T.pickADiagram}</div>
        ) : (
          <div className="stack" style={{ gap: 10 }}>
            <div
              className="row"
              role="group"
              aria-label={T.filterItems}
              style={{ flexWrap: "wrap", gap: 6 }}
            >
              {["all", ...types].map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`btn ${filter === t ? "primary" : ""}`}
                  aria-pressed={filter === t}
                  onClick={() => setFilter(t)}
                >
                  {t === "all"
                    ? T.all(d.items.length)
                    : `${t} ${d.items.filter((i) => i.type === t).length}`}
                </button>
              ))}
            </div>
            {items.length === 0 ? (
              <div className="state">{T.everyDrawnEdgeAgrees}</div>
            ) : (
              <Table
                caption={T.itemsToResolve}
                rows={items}
                rowKey={(i) => i.id}
                cols={[
                  {
                    label: T.result,
                    cell: (i) => (
                      <span
                        className={`chip ${/mismatch|conflict|unknown/.test(i.type) ? "blocking" : "warn"}`}
                      >
                        {i.type}
                      </span>
                    ),
                    width: "150px",
                  },
                  { label: T.what, cell: (i) => i.summary },
                  { label: T.next, cell: (i) => i.suggestion?.text ?? "" },
                ]}
              />
            )}
            <p className="muted" style={{ margin: 0, fontSize: 11.5 }}>
              {T.codeWinsOverA}
              <a href="#/intake">{T.triage}</a> {T.untilAPersonDecides}
            </p>
          </div>
        )}
      </Panel>
      {d && d.names.some((n) => !n.id || n.how !== "exact") && (
        <Panel title={T.nameMatching} span="1 / -1">
          <Table
            caption={T.diagramLabels}
            rows={d.names.filter((n) => !n.id || n.how !== "exact")}
            rowKey={(n) => n.name}
            cols={[
              { label: T.diagramLabel, cell: (n) => n.name },
              {
                label: T.matched,
                cell: (n) =>
                  n.id ? (
                    <span className="mono">{n.id}</span>
                  ) : (
                    <span className="chip warn">{T.noMatch}</span>
                  ),
              },
              { label: T.how, cell: (n) => n.how ?? "" },
              { label: T.similar, cell: (n) => n.similar.slice(0, 3).join(", "), mono: true },
            ]}
          />
          <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
            {T.confirmANameWith}
            <span className="mono">{T.atticusAliasLabelId}</span>
            {T.itIsSavedTo}
          </p>
        </Panel>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Diagrams

const VIEWS = [
  { id: "context", label: T.context, focus: false },
  { id: "data", label: T.data, focus: false },
  { id: "event", label: T.events, focus: false },
  { id: "container", label: T.container, focus: true },
  { id: "sequence", label: T.sequence, focus: true },
];

export function Diagrams({ hash }: { hash: string }) {
  const view = queryParam(hash, "view") ?? "context";
  const v = VIEWS.find((x) => x.id === view) ?? VIEWS[0]!;
  const cov = useView<{ systems: { system: string }[] }>("coverage");
  const systems = cov.state === "ready" ? cov.data.systems.map((s) => s.system) : [];
  const [focus, setFocus] = useState<string | undefined>();
  const f = focus ?? systems[0];
  const text = useApi<{ text: string; problems: string[] }>(
    v.focus && !f
      ? undefined
      : `/api/diagram/${v.id}${v.focus && f ? `?focus=${encodeURIComponent(f)}` : ""}`,
  );
  // The canvas draws the chosen view itself (its groups, nodes and edges); a sequence view,
  // which has no canvas form, keeps the map of its system.
  const canvas = v.id !== "sequence";
  const flow = useApi<{ view: FlowViewData }>(
    !canvas || (v.focus && !f)
      ? undefined
      : `/api/diagram/${v.id}/graph${v.focus && f ? `?focus=${encodeURIComponent(f)}` : ""}`,
  );
  const graph = useApi<Graph>(
    canvas ? undefined : f ? `/api/graph?focus=${encodeURIComponent(f)}&depth=1` : "/api/graph",
  );
  const [copied, setCopied] = useState(false);
  return (
    <div className="bento">
      <Panel title={T.generatedViews} span="1 / -1">
        <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
          <div role="tablist" aria-label={T.view} className="row" style={{ gap: 6 }}>
            {VIEWS.map((x) => (
              <button
                key={x.id}
                type="button"
                role="tab"
                aria-selected={x.id === v.id}
                className={`btn ${x.id === v.id ? "primary" : ""}`}
                onClick={() => setQueryParam("diagrams", "view", x.id)}
              >
                {x.label}
              </button>
            ))}
          </div>
          {v.focus && (
            <label className="row" style={{ gap: 6 }}>
              <span className="hud" style={{ fontSize: 10 }}>
                {T.system}
              </span>
              <select
                value={f ?? ""}
                onChange={(e) => setFocus(e.target.value)}
                style={{
                  height: 32,
                  background: "var(--box)",
                  color: "var(--text)",
                  border: "1px solid var(--line-2)",
                  borderRadius: 7,
                  padding: "0 8px",
                  font: "inherit",
                }}
              >
                {systems.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
          )}
          <span className="muted" style={{ fontSize: 12 }}>
            {T.drawnFromTheCatalog}
          </span>
        </div>
      </Panel>
      <Panel title={T.view2(v.label)} kind="hero" span="span 7" rows="span 2">
        {canvas ? (
          <View
            of={flow}
            empty={(x) => x.view.nodes.length === 0}
            emptyText={T.nothingToDrawThe(v.label.toLowerCase())}
          >
            {(x) => <FlowCanvas view={x.view} height={460} />}
          </View>
        ) : (
          <View of={graph} empty={(g) => g.nodes.length === 0} emptyText={T.theCatalogIsEmpty}>
            {(g) => <GraphView g={g} {...(v.focus && f ? { focus: f } : {})} height={460} />}
          </View>
        )}
      </Panel>
      <Panel
        title={T.mermaid}
        span="span 5"
        rows="span 2"
        meta={
          text.state === "ready" ? (
            <button
              type="button"
              className="btn"
              onClick={() => {
                void navigator.clipboard?.writeText(text.data.text).then(() => setCopied(true));
              }}
            >
              {copied ? T.copied : T.copy}
            </button>
          ) : undefined
        }
      >
        <View of={text} empty={(t) => !t.text.trim()} emptyText={T.nothingToDrawFor}>
          {(t) => (
            <pre
              className="mono"
              tabIndex={0}
              aria-label={T.mermaidSource}
              style={{
                margin: 0,
                fontSize: 11.5,
                lineHeight: 1.55,
                whiteSpace: "pre-wrap",
                maxHeight: 460,
                overflowY: "auto",
                color: "var(--text-2)",
              }}
            >
              {t.text}
            </pre>
          )}
        </View>
      </Panel>
      <Panel title={T.diagramsInTheMetarepo} span="span 7">
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
          {T.diagramsUnder}
          <span className="mono">{T.inputsDiagrams}</span> {T.areComparedWithThe}
          <a href="#/reconcile">{T.reconcile}</a>.
        </p>
      </Panel>
      <Panel title={T.catalogShapeLibrary} span="span 5">
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
          {T.writeTheDrawIo}
          <span className="mono">{T.atticusDiagramLibraryFile}</span> {T.andLoadItIn}
        </p>
      </Panel>
    </div>
  );
}

// ------------------------------------------------------------------ Initiatives

interface InitiativeStatus {
  initiative: string;
  title: string;
  journey: string;
  targetRelease?: string;
  projectedRelease?: string;
  status: string;
  today: string;
  items: {
    key: string;
    start: string;
    kind: string;
    what: string;
    party?: string;
    due: string;
    projectedFinish: string;
    float: number;
    critical: boolean;
    status: string;
    why: string;
  }[];
  criticalPath: string[];
  commitments: {
    id: string;
    what: string;
    party: string;
    neededBy: string;
    status: string;
    why: string;
  }[];
  changes: { id: string; state?: string }[];
  notes: string[];
}

const STATUS_COLOR: Record<string, string> = {
  done: "var(--green)",
  open: "var(--accent)",
  "at-risk": "var(--amber)",
  slipped: "var(--magenta)",
};

/** Plan items as bars from start to forecast, with the due date marked and today as a line. */
function Timeline({ s }: { s: InitiativeStatus }) {
  const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86400000;
  const items = s.items;
  if (items.length === 0) return <div className="state">{T.nothingPlannedYet}</div>;
  const lo = Math.min(day(s.today), ...items.map((i) => day(i.start)));
  const hi = Math.max(...items.map((i) => Math.max(day(i.due), day(i.projectedFinish))), lo + 1);
  const W = 760;
  const L = 230;
  const x = (d: string) => L + ((day(d) - lo) / (hi - lo)) * (W - L - 10);
  const H = items.length * 26 + 30;
  return (
    <svg
      role="img"
      aria-label={T.timelineOfPlanItems(items.length, items[0]!.start, s.today)}
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: "100%", display: "block" }}
    >
      {items.map((i, k) => {
        const y = 10 + k * 26;
        const c = STATUS_COLOR[i.status] ?? "var(--accent)";
        return (
          <g key={i.key}>
            <text
              x={0}
              y={y + 13}
              fill={i.critical ? "var(--text)" : "var(--muted-2)"}
              fontSize={11}
              fontFamily="IBM Plex Sans, sans-serif"
            >
              {i.what.length > 34 ? `${i.what.slice(0, 33)}…` : i.what}
            </text>
            <rect
              x={x(i.start)}
              y={y + 3}
              width={Math.max(x(i.projectedFinish) - x(i.start), 3)}
              height={12}
              rx={3}
              fill={c}
              opacity={0.75}
              style={{ filter: `drop-shadow(0 0 var(--glow-size) ${c})` }}
            />
            <line
              x1={x(i.due)}
              x2={x(i.due)}
              y1={y}
              y2={y + 18}
              stroke="var(--text)"
              strokeWidth={1.5}
            />
          </g>
        );
      })}
      <line
        x1={x(s.today)}
        x2={x(s.today)}
        y1={0}
        y2={H - 16}
        stroke="var(--magenta)"
        strokeDasharray="3 3"
      />
      <text
        x={x(s.today) + 4}
        y={H - 4}
        fill="var(--magenta-text)"
        fontSize={10}
        fontFamily="JetBrains Mono, monospace"
      >
        {T.today(s.today)}
      </text>
      {s.targetRelease && (
        <text
          x={W - 10}
          y={H - 4}
          textAnchor="end"
          fill="var(--muted-2)"
          fontSize={10}
          fontFamily="JetBrains Mono, monospace"
        >
          {T.target(s.targetRelease)}
        </text>
      )}
    </svg>
  );
}

const STATUS_CHIP: Record<string, string> = {
  "on-track": "done",
  done: "done",
  "at-risk": "warn",
  slipped: "blocking",
  open: "dim",
  "not-planned": "dim",
};

export function Initiatives({ hash }: { hash: string }) {
  const all = useApi<InitiativeStatus[]>("/api/initiatives");
  const id = queryParam(hash, "id");
  const one =
    all.state === "ready" ? (all.data.find((i) => i.initiative === id) ?? all.data[0]) : undefined;
  return (
    <div className="bento">
      <Panel title={T.initiatives} span="span 4">
        <View of={all} empty={(a) => a.length === 0} emptyText={T.noInitiativesYet}>
          {(a) => (
            <div className="stack" style={{ gap: 6 }}>
              {a.map((i) => (
                <a
                  key={i.initiative}
                  href={`#/initiatives?id=${encodeURIComponent(i.initiative)}`}
                  aria-current={i === one ? "page" : undefined}
                  className="stack"
                  style={{
                    gap: 4,
                    textDecoration: "none",
                    color: "inherit",
                    padding: 8,
                    borderRadius: 8,
                    border: "1px solid var(--line)",
                    background: i === one ? "var(--picked-faint)" : undefined,
                  }}
                >
                  <span className="row between">
                    <span style={{ fontWeight: 600 }}>{i.title}</span>
                    <span className={`chip ${STATUS_CHIP[i.status] ?? ""}`}>
                      {i.status.toUpperCase()}
                    </span>
                  </span>
                  <span className="hud" style={{ fontSize: 9.5 }}>
                    {T.changesParties(
                      i.journey,
                      i.changes.length,
                      new Set(i.commitments.map((c) => c.party)).size,
                    )}
                  </span>
                </a>
              ))}
            </div>
          )}
        </View>
        <p className="muted" style={{ margin: "10px 0 0", fontSize: 12 }}>
          {T.startOneFromA}
          <span className="mono">{T.atticusInitiativeNewTitle}</span>.
        </p>
      </Panel>
      {one ? (
        <div className="column" style={{ gridColumn: "span 8" }}>
          <Panel
            title={one.title}
            kind="hero"
            span="span 8"
            meta={
              one.targetRelease
                ? T.target2(
                    one.targetRelease,
                    one.projectedRelease ? T.forecast(one.projectedRelease) : "",
                  )
                : undefined
            }
          >
            <div className="stack" style={{ gap: 10 }}>
              {one.criticalPath.length > 0 && (
                <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                  <span className="hud" style={{ fontSize: 10 }}>
                    {T.criticalPath}
                  </span>
                  {one.criticalPath.map((k, i) => (
                    <span key={k} className="row" style={{ gap: 6 }}>
                      {i > 0 && <span aria-hidden="true">›</span>}
                      <span className="chip">{k}</span>
                    </span>
                  ))}
                </div>
              )}
              <Table
                caption={T.planItems}
                rows={one.items}
                rowKey={(i) => i.key}
                cols={[
                  {
                    label: T.item,
                    cell: (i) => <span className={i.critical ? "" : "muted"}>{i.what}</span>,
                  },
                  { label: T.party, cell: (i) => i.party ?? "" },
                  { label: T.due, cell: (i) => i.due, mono: true },
                  { label: T.forecast2, cell: (i) => i.projectedFinish, mono: true },
                  {
                    label: T.status,
                    cell: (i) => (
                      <span className={`chip ${STATUS_CHIP[i.status] ?? ""}`} title={i.why}>
                        {i.status.toUpperCase()}
                      </span>
                    ),
                  },
                ]}
              />
            </div>
          </Panel>
          <Panel title={T.timeline} span="span 8" kind="dark">
            <Timeline s={one} />
          </Panel>
          <Panel title={T.whoOwesWhat} span="span 8">
            {one.commitments.length === 0 ? (
              <div className="state">{T.noCommitmentsYet}</div>
            ) : (
              <Table
                caption={T.commitments}
                rows={one.commitments}
                rowKey={(c) => c.id}
                cols={[
                  { label: T.party, cell: (c) => c.party },
                  { label: T.commitment, cell: (c) => c.what },
                  { label: T.neededBy, cell: (c) => c.neededBy, mono: true },
                  {
                    label: T.status,
                    cell: (c) => (
                      <span className={`chip ${STATUS_CHIP[c.status] ?? ""}`} title={c.why}>
                        {c.status.toUpperCase()}
                      </span>
                    ),
                  },
                ]}
              />
            )}
            {one.notes.map((n, i) => (
              <p key={i} className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
                {n}
              </p>
            ))}
          </Panel>
        </div>
      ) : null}
    </div>
  );
}
