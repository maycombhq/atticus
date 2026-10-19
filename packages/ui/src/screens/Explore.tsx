import { useEffect, useState, type FormEvent } from "react";
import { useApi } from "../api/client.js";
import { GraphView, type Graph } from "../app/graph.js";
import { Panel, View } from "../app/ui.js";

interface Row {
  kind: string;
  id: string;
  name?: string;
  status: string;
  confidence?: string;
  system?: string;
}
interface SearchResult {
  rows: Row[];
  total: number;
}
interface Evidence {
  source: string;
  repo?: string;
  path?: string;
  line?: number;
  extractor?: string;
}
type CatalogRecord = Record<string, unknown> & { kind: string; id: string; evidence?: Evidence[] };

/** The fields worth showing first for a record, by kind; the rest follow. */
const LEAD = [
  "name",
  "description",
  "system",
  "owner",
  "ownerComponent",
  "from",
  "to",
  "via",
  "method",
  "normalizedPath",
  "type",
  "runtime",
  "table",
  "dataType",
];

function value(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(value).join(", ");
  return JSON.stringify(v);
}

function paramOf(hash: string, name: string): string {
  const q = hash.split("?")[1];
  return q ? (new URLSearchParams(q).get(name) ?? "") : "";
}
const queryOf = (hash: string) => paramOf(hash, "q");

interface Asked {
  question: string;
  action: "query" | "impact" | "owner";
  query: string;
  explanation: string;
  id?: string;
  owner?: string | null;
  error?: string;
}

function Detail({ row }: { row: Row }) {
  const rec = useApi<CatalogRecord>(`/api/catalog/${row.kind}/${encodeURIComponent(row.id)}`);
  return (
    <Panel title={row.id} meta={row.kind} span="span 4" rows="span 2">
      <View of={rec}>
        {(r) => {
          const keys = Object.keys(r).filter(
            (k) => !["kind", "id", "evidence", "schemaVersion", "flags"].includes(k),
          );
          const ordered = [
            ...LEAD.filter((k) => keys.includes(k)),
            ...keys.filter((k) => !LEAD.includes(k)),
          ];
          return (
            <div className="stack" style={{ gap: 12 }}>
              <dl
                style={{
                  margin: 0,
                  display: "grid",
                  gridTemplateColumns: "120px 1fr",
                  gap: "6px 10px",
                  fontSize: 12.5,
                }}
              >
                {ordered.map((k) => (
                  <div key={k} style={{ display: "contents" }}>
                    <dt className="hud" style={{ fontSize: 10 }}>
                      {k}
                    </dt>
                    <dd
                      className={
                        /^(from|to|system|owner|ownerComponent|table)$/.test(k) ? "mono" : ""
                      }
                      style={{ margin: 0, wordBreak: "break-word" }}
                    >
                      {value(r[k])}
                    </dd>
                  </div>
                ))}
              </dl>
              <div>
                <div className="hud" style={{ fontSize: 10, marginBottom: 6 }}>
                  Evidence
                </div>
                {(r.evidence ?? []).length === 0 ? (
                  <p className="muted" style={{ margin: 0 }}>
                    No evidence recorded: treat this fact as unconfirmed.
                  </p>
                ) : (
                  <ul
                    style={{
                      listStyle: "none",
                      margin: 0,
                      padding: 0,
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                    }}
                  >
                    {(r.evidence ?? []).map((e, i) => (
                      <li key={i} style={{ fontSize: 12.5 }}>
                        <span
                          className={`chip ${e.source === "code" || e.source === "config" ? "" : e.source === "document" || e.source === "diagram" ? "warn" : "ai"}`}
                        >
                          {e.source.toUpperCase()}
                        </span>{" "}
                        <span className="mono">
                          {e.repo ? `${e.repo} · ` : ""}
                          {e.path ?? ""}
                          {e.line ? `:${e.line}` : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <a
                href={`#/impact?q=${encodeURIComponent(r.id)}`}
                className="btn"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  textDecoration: "none",
                  width: "fit-content",
                }}
              >
                What breaks if this changes
              </a>
            </div>
          );
        }}
      </View>
    </Panel>
  );
}

export function Explore({ hash }: { hash: string }) {
  const initial = queryOf(hash);
  const askText = paramOf(hash, "ask");
  const asked = useApi<Asked>(askText ? `/api/ask?q=${encodeURIComponent(askText)}` : undefined);
  const [text, setText] = useState(initial);
  const [q, setQ] = useState(initial);
  useEffect(() => {
    setText(initial);
    setQ(initial);
  }, [initial]);
  useEffect(() => {
    if (asked.state !== "ready") return;
    if (asked.data.action === "impact" && asked.data.id) {
      location.hash = `#/impact?q=${encodeURIComponent(asked.data.id)}`;
      return;
    }
    setText(asked.data.query);
    setQ(asked.data.query);
  }, [asked.state, asked.state === "ready" ? asked.data : undefined]);
  const [picked, setPicked] = useState<Row | undefined>();
  const results = useApi<SearchResult>(
    q ? `/api/search?q=${encodeURIComponent(q)}&limit=60` : undefined,
  );
  const focusId =
    picked && (picked.kind === "Component" || picked.kind === "System")
      ? picked.id
      : picked?.system;
  const graph = useApi<Graph>(
    focusId ? `/api/graph?focus=${encodeURIComponent(focusId)}&depth=2` : "/api/graph",
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setPicked(undefined);
    setQ(text.trim());
    history.replaceState(null, "", `#/explore?q=${encodeURIComponent(text.trim())}`);
  };

  return (
    <div className="bento">
      {askText && (
        <Panel title={`Ask: ${askText}`} kind="hero" span="1 / -1">
          <View of={asked}>
            {(a) => (
              <div className="stack" style={{ gap: 6 }}>
                <p style={{ margin: 0 }}>{a.explanation}</p>
                {a.action === "owner" && (
                  <p style={{ margin: 0, fontSize: 18 }}>
                    {a.owner ? (
                      <>
                        <span className="mono">{a.id}</span> is owned by{" "}
                        <span className="chip done">{a.owner}</span>
                      </>
                    ) : (
                      <>
                        The catalog doesn't know who owns <span className="mono">{a.id}</span> yet.
                      </>
                    )}
                  </p>
                )}
                <span className="hud" style={{ fontSize: 10 }}>
                  Query run:{" "}
                  <span className="mono" style={{ color: "var(--accent)" }}>
                    {a.query}
                  </span>{" "}
                  · edit it below to refine
                </span>
                {a.error && (
                  <span role="alert" style={{ color: "#FF9BCB" }}>
                    {a.error}
                  </span>
                )}
              </div>
            )}
          </View>
        </Panel>
      )}
      <Panel title="Search the catalog" span="1 / -1">
        <form role="search" onSubmit={submit} className="row" style={{ flexWrap: "wrap" }}>
          <label htmlFor="kq" className="sr">
            Search
          </label>
          <input
            id="kq"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder='Try: daily limit · kind:interface via:gateway · "ledger-db"'
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
            Search
          </button>
          <span className="muted" style={{ fontSize: 12 }}>
            Words match ids and names; <span className="mono">kind:</span>,{" "}
            <span className="mono">system:</span>, <span className="mono">status:</span> narrow it.
          </span>
        </form>
      </Panel>

      <Panel
        title="Results"
        span="span 3"
        rows="span 2"
        meta={results.state === "ready" ? results.data.total : undefined}
      >
        {!q ? (
          <p className="muted" style={{ margin: 0 }}>
            Search for a service, a table, a topic, a term or a feature.
          </p>
        ) : (
          <View
            of={results}
            empty={(r) => r.rows.length === 0}
            emptyText="Nothing matches. Try fewer words."
          >
            {(r) => (
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }} aria-label="Search results">
                {r.rows.map((row) => (
                  <li key={`${row.kind}/${row.id}`}>
                    <button
                      type="button"
                      onClick={() => setPicked(row)}
                      aria-pressed={picked?.id === row.id && picked?.kind === row.kind}
                      className="list-row"
                      style={{
                        width: "100%",
                        background: picked?.id === row.id ? "rgba(46,230,246,0.08)" : "transparent",
                        border: 0,
                        color: "inherit",
                        font: "inherit",
                        textAlign: "left",
                        cursor: "pointer",
                        padding: "7px 6px",
                        borderRadius: 6,
                      }}
                    >
                      <span className="stack" style={{ gap: 2, minWidth: 0 }}>
                        <span className="mono" style={{ fontSize: 12, wordBreak: "break-all" }}>
                          {row.id}
                        </span>
                        {row.name && row.name !== row.id && (
                          <span className="muted" style={{ fontSize: 11.5 }}>
                            {row.name}
                          </span>
                        )}
                      </span>
                      <span className="chip dim">{row.kind}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </View>
        )}
      </Panel>

      <Panel
        title={focusId ? `Around ${focusId}` : "The whole estate"}
        kind="hero"
        span={picked ? "span 5" : "span 9"}
        rows="span 2"
      >
        <View
          of={graph}
          empty={(g) => g.nodes.length === 0}
          emptyText="The catalog is empty. Run a scan first."
        >
          {(g) => (
            <GraphView
              g={g}
              {...(focusId ? { focus: focusId } : {})}
              highlight={results.state === "ready" ? results.data.rows.map((r) => r.id) : []}
            />
          )}
        </View>
      </Panel>

      {picked && <Detail key={`${picked.kind}/${picked.id}`} row={picked} />}
    </div>
  );
}
