import { useState } from "react";
import { useApi, useLiveEvents } from "../../api/client.js";
import { FlowCanvas, type FlowViewData } from "../../app/flow.js";
import { GraphView, type Graph } from "../../app/graph.js";
import { Bar, Donut, Panel, Ring, View } from "../../app/ui.js";
import { Table, queryParam, setQueryParam, useView } from "./common.js";

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
        emptyText={`No ${title.toLowerCase()} in the catalog.`}
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
                Evidence
              </div>
              {(d.evidence ?? []).length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>
                  No evidence: treat it as unconfirmed.
                </p>
              ) : (
                (d.evidence ?? []).map((e, i) => (
                  <div key={i} style={{ fontSize: 12.5, marginBottom: 4 }}>
                    <span className={`chip ${e.source === "code" ? "" : "warn"}`}>
                      {e.source.toUpperCase()}
                    </span>{" "}
                    <span className="mono">
                      {e.repo ? `${e.repo} · ` : ""}
                      {e.path ?? ""}
                      {e.line ? `:${e.line}` : ""}
                    </span>
                  </div>
                ))
              )}
            </div>
            <div>
              <div className="hud" style={{ fontSize: 10, marginBottom: 6 }}>
                Consumers and dependants
              </div>
              <View
                of={imp}
                empty={(x) => x.affected.length === 0}
                emptyText="Nothing in the catalog depends on it."
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
                    <a href={`#/impact?q=${encodeURIComponent(r.id)}`}>See impact</a>
                  </div>
                )}
              </View>
            </div>
            <details>
              <summary className="hud" style={{ fontSize: 10, cursor: "pointer" }}>
                Record
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
    <div className="bento">
      <Panel title="Contracts" span="span 4" rows="span 2">
        <div
          className="stack"
          tabIndex={0}
          role="region"
          aria-label="Contracts list"
          style={{ gap: 14, maxHeight: 640, overflowY: "auto" }}
        >
          <ContractList
            kind="Endpoint"
            title="APIs"
            pick={setPicked}
            {...(picked ? { picked: picked.id } : {})}
          />
          <ContractList
            kind="Interface"
            title="Interfaces and events"
            pick={setPicked}
            {...(picked ? { picked: picked.id } : {})}
          />
          <ContractList
            kind="Table"
            title="Data stores"
            pick={setPicked}
            {...(picked ? { picked: picked.id } : {})}
          />
          <p className="muted" style={{ margin: 0, fontSize: 11.5 }}>
            Data stores come from DDL, migrations, ORM mappings and DBA exports, never live
            databases.
          </p>
        </div>
      </Panel>
      {picked ? (
        <ContractDetail key={`${picked.kind}/${picked.id}`} r={picked} />
      ) : (
        <Panel title="Pick a contract" span="span 5" rows="span 2">
          <div className="state">
            Choose an API, an interface or a table to see its evidence and who depends on it.
          </div>
        </Panel>
      )}
      <Panel title="Contract mix" span="span 3" kind="dark">
        <View of={kinds}>
          {() => (
            <Donut
              title="Contracts by kind"
              parts={[
                { label: "APIs", value: n("Endpoint"), color: "var(--accent)" },
                { label: "Interfaces", value: n("Interface"), color: "var(--violet)" },
                { label: "Tables", value: n("Table"), color: "var(--amber)" },
              ]}
            />
          )}
        </View>
      </Panel>
      <Panel title="Verified from code" span="span 3">
        <View of={iface}>
          {() => (
            <div className="stack">
              <Ring
                value={verified}
                max={Math.max(total, 1)}
                size={64}
                label={`${verified} of ${total} interfaces verified from code`}
              />
              <p className="muted" style={{ margin: 0, fontSize: 11.5 }}>
                A vendor spec is a document until its caller is scanned; code wins when they differ.
              </p>
              <a href="#/mappings">Field mappings</a>
            </div>
          )}
        </View>
      </Panel>
    </div>
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

function useReconcile() {
  const r = useApi<{ code: number; data: ReconcileOut }>("/api/view/reconcile");
  return r;
}

const noDiagrams = (e: string) => /No diagrams to reconcile/.test(e);

export function Reconcile({ hash }: { hash: string }) {
  const r = useReconcile();
  const file = queryParam(hash, "file");
  const [filter, setFilter] = useState<string>("all");
  useLiveEvents((e) => {
    if (e.type === "job.done") r.reload();
  });
  if (r.state === "error" && noDiagrams(r.error))
    return (
      <div className="bento">
        <Panel title="Reconcile a diagram against the catalog" span="1 / -1">
          <div className="state">
            No diagrams yet. Put draw.io, Visio, Lucid CSV or Mermaid files under{" "}
            <span className="mono">inputs/diagrams/</span> (or add them on{" "}
            <a href="#/intake">Intake</a>), then come back.
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
      <Panel title="Diagrams" span="span 4">
        <View of={r} empty={() => diagrams.length === 0} emptyText="No diagrams could be read.">
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
                      {x.matches.length}/{x.edges} edges match code
                    </span>
                  </span>
                  <span className={`chip ${x.items.length ? "warn" : "done"}`}>
                    {x.items.length ? `${x.items.length} TO RESOLVE` : "IN SYNC"}
                  </span>
                </a>
              ))}
              <button type="button" className="btn" onClick={() => r.reload()}>
                Check again
              </button>
              {d && (
                <div className="stack" style={{ gap: 12, marginTop: 10 }}>
                  <div className="row">
                    <Ring
                      value={d.matches.length}
                      max={Math.max(d.edges, 1)}
                      size={72}
                      label={`${d.matches.length} of ${d.edges} drawn edges agree with code`}
                    />
                    <span className="muted" style={{ fontSize: 12.5 }}>
                      drawn edges agree with the code
                    </span>
                  </div>
                  <Donut
                    title="Items to resolve by kind"
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
                      {d.names.filter((x) => x.id).length}/{d.names.length} labels matched to the
                      catalog
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </View>
      </Panel>
      <Panel
        title={d ? `Edge by edge · ${d.file.split("/").pop()}` : "Edge by edge"}
        span="span 8"
        meta={
          d ? (
            <Bar
              value={d.matches.length}
              max={Math.max(d.edges, 1)}
              label={`${d.matches.length} of ${d.edges} edges agree with code`}
            />
          ) : undefined
        }
      >
        {!d ? (
          <div className="state">Pick a diagram.</div>
        ) : (
          <div className="stack" style={{ gap: 10 }}>
            <div
              className="row"
              role="group"
              aria-label="Filter items"
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
                    ? `All ${d.items.length}`
                    : `${t} ${d.items.filter((i) => i.type === t).length}`}
                </button>
              ))}
            </div>
            {items.length === 0 ? (
              <div className="state">Every drawn edge agrees with the code.</div>
            ) : (
              <Table
                caption="Items to resolve"
                rows={items}
                rowKey={(i) => i.id}
                cols={[
                  {
                    label: "Result",
                    cell: (i) => (
                      <span
                        className={`chip ${/mismatch|conflict|unknown/.test(i.type) ? "blocking" : "warn"}`}
                      >
                        {i.type}
                      </span>
                    ),
                    width: "150px",
                  },
                  { label: "What", cell: (i) => i.summary },
                  { label: "Next", cell: (i) => i.suggestion?.text ?? "" },
                ]}
              />
            )}
            <p className="muted" style={{ margin: 0, fontSize: 11.5 }}>
              Code wins over a diagram: a conflict goes to <a href="#/intake">triage</a> until a
              person decides.
            </p>
          </div>
        )}
      </Panel>
      {d && d.names.some((n) => !n.id || n.how !== "exact") && (
        <Panel title="Name matching" span="1 / -1">
          <Table
            caption="Diagram labels"
            rows={d.names.filter((n) => !n.id || n.how !== "exact")}
            rowKey={(n) => n.name}
            cols={[
              { label: "Diagram label", cell: (n) => n.name },
              {
                label: "Matched",
                cell: (n) =>
                  n.id ? (
                    <span className="mono">{n.id}</span>
                  ) : (
                    <span className="chip warn">NO MATCH</span>
                  ),
              },
              { label: "How", cell: (n) => n.how ?? "" },
              { label: "Similar", cell: (n) => n.similar.slice(0, 3).join(", "), mono: true },
            ]}
          />
          <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
            Confirm a name with{" "}
            <span className="mono">atticus alias "&lt;label&gt;" &lt;id&gt;</span>; it is saved to
            the alias table.
          </p>
        </Panel>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Diagrams

const VIEWS = [
  { id: "context", label: "Context", focus: false },
  { id: "data", label: "Data", focus: false },
  { id: "event", label: "Events", focus: false },
  { id: "container", label: "Container", focus: true },
  { id: "sequence", label: "Sequence", focus: true },
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
      <Panel title="Generated views" span="1 / -1">
        <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
          <div role="tablist" aria-label="View" className="row" style={{ gap: 6 }}>
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
                System
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
            Drawn from the catalog; rebuilt on every scan. Edits happen in draw.io and come back
            through the metarepo.
          </span>
        </div>
      </Panel>
      <Panel title={`${v.label} view`} kind="hero" span="span 7" rows="span 2">
        {canvas ? (
          <View
            of={flow}
            empty={(x) => x.view.nodes.length === 0}
            emptyText={`Nothing to draw: the catalog has nothing for the ${v.label.toLowerCase()} view.`}
          >
            {(x) => <FlowCanvas view={x.view} height={460} />}
          </View>
        ) : (
          <View
            of={graph}
            empty={(g) => g.nodes.length === 0}
            emptyText="The catalog is empty. Run a scan first."
          >
            {(g) => <GraphView g={g} {...(v.focus && f ? { focus: f } : {})} height={460} />}
          </View>
        )}
      </Panel>
      <Panel
        title="Mermaid"
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
              {copied ? "Copied" : "Copy"}
            </button>
          ) : undefined
        }
      >
        <View
          of={text}
          empty={(t) => !t.text.trim()}
          emptyText="Nothing to draw for this view yet."
        >
          {(t) => (
            <pre
              className="mono"
              tabIndex={0}
              aria-label="Mermaid source"
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
      <Panel title="Diagrams in the metarepo" span="span 7">
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
          Diagrams under <span className="mono">inputs/diagrams/</span> are compared with the
          catalog on <a href="#/reconcile">Reconcile</a>.
        </p>
      </Panel>
      <Panel title="Catalog shape library" span="span 5">
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
          Write the draw.io shape library with{" "}
          <span className="mono">atticus diagram library &lt;file&gt;</span> and load it in draw.io,
          or in the draw.io integration for IntelliJ or VS Code: boxes keep their catalog ids.
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
  if (items.length === 0) return <div className="state">Nothing planned yet.</div>;
  const lo = Math.min(day(s.today), ...items.map((i) => day(i.start)));
  const hi = Math.max(...items.map((i) => Math.max(day(i.due), day(i.projectedFinish))), lo + 1);
  const W = 760;
  const L = 230;
  const x = (d: string) => L + ((day(d) - lo) / (hi - lo)) * (W - L - 10);
  const H = items.length * 26 + 30;
  return (
    <svg
      role="img"
      aria-label={`Timeline of ${items.length} plan items from ${items[0]!.start}; today ${s.today}`}
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
        today {s.today}
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
          target {s.targetRelease}
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
      <Panel title="Initiatives" span="span 4">
        <View of={all} empty={(a) => a.length === 0} emptyText="No initiatives yet.">
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
                    {i.journey} · {i.changes.length} changes ·{" "}
                    {new Set(i.commitments.map((c) => c.party)).size} parties
                  </span>
                </a>
              ))}
            </div>
          )}
        </View>
        <p className="muted" style={{ margin: "10px 0 0", fontSize: 12 }}>
          Start one from a guided journey:{" "}
          <span className="mono">atticus initiative new "&lt;title&gt;" --journey new-feature</span>
          .
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
                ? `Target ${one.targetRelease}${one.projectedRelease ? ` · forecast ${one.projectedRelease}` : ""}`
                : undefined
            }
          >
            <div className="stack" style={{ gap: 10 }}>
              {one.criticalPath.length > 0 && (
                <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                  <span className="hud" style={{ fontSize: 10 }}>
                    Critical path
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
                caption="Plan items"
                rows={one.items}
                rowKey={(i) => i.key}
                cols={[
                  {
                    label: "Item",
                    cell: (i) => <span className={i.critical ? "" : "muted"}>{i.what}</span>,
                  },
                  { label: "Party", cell: (i) => i.party ?? "" },
                  { label: "Due", cell: (i) => i.due, mono: true },
                  { label: "Forecast", cell: (i) => i.projectedFinish, mono: true },
                  {
                    label: "Status",
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
          <Panel title="Timeline" span="span 8" kind="dark">
            <Timeline s={one} />
          </Panel>
          <Panel title="Who owes what" span="span 8">
            {one.commitments.length === 0 ? (
              <div className="state">No commitments yet.</div>
            ) : (
              <Table
                caption="Commitments"
                rows={one.commitments}
                rowKey={(c) => c.id}
                cols={[
                  { label: "Party", cell: (c) => c.party },
                  { label: "Commitment", cell: (c) => c.what },
                  { label: "Needed by", cell: (c) => c.neededBy, mono: true },
                  {
                    label: "Status",
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
