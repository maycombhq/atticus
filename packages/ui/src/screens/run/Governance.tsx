import { useEffect, useState } from "react";
import { useApi, useLiveEvents } from "../../api/client.js";
import { Bar, Panel, Ring, View } from "../../app/ui.js";
import { day, plural } from "./shared.js";

interface Governance {
  conformance: {
    passed: boolean;
    results: { check: string; status: "pass" | "fail" | "warn"; message: string; file?: string }[];
    summary: { pass: number; fail: number; warn: number };
  };
  rules: {
    constitution: number;
    org: number;
    team: number;
    inForce: number;
    waivable: number;
    refused: { pack: string; file: string; rule?: string; reason: string }[];
    problems: string[];
  };
  waivers: {
    change: string;
    gate: string;
    rule: string;
    summary: string;
    by?: string;
    at?: string;
    reason?: string;
  }[];
  overrides: {
    changes: number;
    rules: {
      rule: string;
      total: number;
      dismissed: number;
      waived: number;
      overrideRate: number;
      reasons: { reason: string; count: number }[];
    }[];
    suggestions: { rule: string; message: string; file?: string }[];
  };
}
interface Search {
  rows: { kind: string; id: string; name: string; system: string | null }[];
  total: number;
}

/** A catalog question asked with the query language, its answers linking to the explorer. */
function CatalogCheck(p: {
  title: string;
  why: string;
  query: string;
  emptyText: string;
  span: string;
  warn?: boolean;
  /** False until the check before it has answered: the first search may build the index. */
  go: boolean;
  onDone: () => void;
}) {
  const r = useApi<Search>(
    p.go ? `/api/search?q=${encodeURIComponent(p.query)}&limit=8` : undefined,
  );
  const { onDone } = p;
  useEffect(() => {
    if (r.state !== "loading") onDone();
  }, [r.state, onDone]);
  return (
    <Panel
      title={p.title}
      span={p.span}
      meta={r.state === "ready" && r.data.total ? r.data.total : undefined}
    >
      <p className="muted" style={{ margin: "0 0 6px", fontSize: 12 }}>
        {p.why}
      </p>
      <View of={r} empty={(d) => d.total === 0} emptyText={p.emptyText}>
        {(d) => (
          <div className="stack" style={{ gap: 0 }}>
            {d.rows.map((x) => (
              <div key={x.id} className="list-row">
                <a href={`#/explore?q=${encodeURIComponent(x.id)}`} style={{ fontSize: 12.5 }}>
                  {x.name || x.id}
                </a>
                <span className={`chip ${p.warn ? "warn" : "dim"}`}>{x.system ?? x.kind}</span>
              </div>
            ))}
            {d.total > d.rows.length && (
              <a
                href={`#/explore?q=${encodeURIComponent(p.query)}`}
                style={{ fontSize: 12, marginTop: 6 }}
              >
                All {d.total} in the explorer
              </a>
            )}
          </div>
        )}
      </View>
    </Panel>
  );
}

export function Governance() {
  const g = useApi<Governance>("/api/governance");
  // The catalog checks ask one at a time, so the first one can build the index alone.
  const [answered, setAnswered] = useState(0);
  const [done] = useState(() =>
    [0, 1, 2, 3].map((i) => () => setAnswered((a) => Math.max(a, i + 1))),
  );
  useLiveEvents((e) => {
    if (e.type === "file.changed" || e.type === "index.rebuilt") g.reload();
  });
  return (
    <>
      <div className="row between" style={{ flexWrap: "wrap" }}>
        <p className="n" style={{ margin: 0, fontSize: 24 }}>
          {g.state !== "ready"
            ? "Governance"
            : g.data.conformance.passed
              ? "The org pack conforms."
              : "Some rules need a decision."}
        </p>
        <span className="hud">From the files and the last scan</span>
      </div>

      <div className="bento">
        <Panel title="Conformance" meta="org pack checks" span="span 6">
          <View of={g}>
            {(d) => {
              const { pass, fail, warn } = d.conformance.summary;
              const total = pass + fail;
              const pct = total ? Math.round((pass / total) * 100) : 0;
              const problems = d.conformance.results.filter((x) => x.status !== "pass");
              return (
                <div className="stack">
                  <div className="row">
                    <Ring
                      value={pass}
                      max={total}
                      size={72}
                      text={`${pct}%`}
                      color={fail ? "var(--amber)" : "var(--green)"}
                      label={`${pass} of ${total} conformance checks pass`}
                    />
                    <span style={{ fontSize: 12.5 }}>
                      {pass} of {total} checks pass
                      {warn ? `, ${plural(warn, "warning")}` : ""}.
                    </span>
                  </div>
                  {problems.length > 0 && (
                    <ul className="run-steps" style={{ fontSize: 12 }}>
                      {problems.slice(0, 6).map((x) => (
                        <li key={`${x.check}${x.file ?? ""}${x.message}`}>
                          <span className={`chip ${x.status === "fail" ? "blocking" : "warn"}`}>
                            {x.status.toUpperCase()}
                          </span>{" "}
                          {x.file ? `${x.file}: ` : ""}
                          {x.message}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            }}
          </View>
        </Panel>

        <Panel title="Rules and waivers" span="span 6">
          <View of={g}>
            {(d) => (
              <div className="stack" style={{ gap: 0 }}>
                <div className="list-row">
                  <span>Constitution rules</span>
                  <span className="row" style={{ gap: 6 }}>
                    <span className="n" style={{ fontSize: 18 }}>
                      {d.rules.constitution}
                    </span>
                    <span className="chip dim">LOCKED</span>
                  </span>
                </div>
                <div className="list-row">
                  <span>Org-pack rules</span>
                  <span className="n" style={{ fontSize: 18 }}>
                    {d.rules.org}
                  </span>
                </div>
                <div className="list-row">
                  <span>Team rules</span>
                  <span className="n" style={{ fontSize: 18 }}>
                    {d.rules.team}
                  </span>
                </div>
                <div className="list-row">
                  <span>Active waivers</span>
                  <span
                    className="n"
                    style={{ fontSize: 18, color: d.waivers.length ? "var(--amber)" : undefined }}
                  >
                    {d.waivers.length}
                  </span>
                </div>
                <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
                  Constitution rules can't be waived or loosened. {d.rules.inForce} rules are in
                  force; {d.rules.waivable} of them can be waived, each with a reason.
                </p>
                {d.rules.refused.map((x) => (
                  <p key={`${x.file}${x.rule ?? ""}`} className="run-note bad">
                    Refused {x.file}
                    {x.rule ? ` (${x.rule})` : ""}: {x.reason}
                  </p>
                ))}
              </div>
            )}
          </View>
        </Panel>

        <Panel title="How often rules are overridden" span="span 7">
          <View
            of={g}
            empty={(d) => d.overrides.rules.length === 0}
            emptyText="No critic findings yet, so nothing to measure."
          >
            {(d) => (
              <div className="stack">
                <table className="run-table">
                  <thead>
                    <tr>
                      <th>Rule</th>
                      <th>Findings</th>
                      <th>Dismissed</th>
                      <th>Waived</th>
                      <th>Overridden</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.overrides.rules.slice(0, 12).map((x) => (
                      <tr key={x.rule}>
                        <td className="mono" style={{ fontSize: 11.5 }}>
                          {x.rule}
                        </td>
                        <td>{x.total}</td>
                        <td>{x.dismissed}</td>
                        <td>{x.waived}</td>
                        <td style={{ minWidth: 110 }}>
                          <span style={{ fontSize: 11.5 }}>
                            {Math.round(x.overrideRate * 100)}%
                          </span>
                          <Bar
                            value={Math.round(x.overrideRate * 100)}
                            max={100}
                            color={x.overrideRate >= 0.5 ? "var(--amber)" : undefined}
                            label={`${x.rule} overridden`}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {d.overrides.suggestions.map((s) => (
                  <p key={s.rule} className="muted" style={{ margin: 0, fontSize: 12.5 }}>
                    {s.message}
                  </p>
                ))}
                <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                  Across {plural(d.overrides.changes, "change")}. A rule dismissed again and again
                  is a candidate for a checklist change, reviewed in a PR.
                </p>
              </div>
            )}
          </View>
        </Panel>

        <Panel title="Waivers" span="span 5">
          <View of={g} empty={(d) => d.waivers.length === 0} emptyText="No active waivers.">
            {(d) =>
              d.waivers.map((w) => (
                <div
                  key={`${w.change}${w.gate}${w.rule}`}
                  className="stack"
                  style={{ gap: 2, padding: "6px 0", borderBottom: "1px solid var(--rule)" }}
                >
                  <span style={{ fontSize: 12.5 }}>{w.summary}</span>
                  <span className="hud" style={{ fontSize: 9.5 }}>
                    {w.rule} · {w.change} · {w.gate}
                    {w.by ? ` · by ${w.by} ${day(w.at)}` : ""}
                  </span>
                  {w.reason && (
                    <span className="muted" style={{ fontSize: 12 }}>
                      Reason: {w.reason}
                    </span>
                  )}
                </div>
              ))
            }
          </View>
        </Panel>

        <CatalogCheck
          go={answered >= 0}
          onDone={done[0]!}
          title="Sensitive data"
          why="Columns tagged with a data classification, and so where tagged fields live."
          query="kind:column has:classification"
          emptyText="No columns are tagged yet. Tag sensitive fields as curated decisions so their flows show here."
          span="span 6"
        />
        <CatalogCheck
          go={answered >= 1}
          onDone={done[1]!}
          title="Authentication gaps"
          why="Calls with no OAuth2, mTLS or API key declared in code or config."
          query="kind:interface missing:auth"
          emptyText="Every call declares how it authenticates."
          span="span 6"
          warn
        />
        <CatalogCheck
          go={answered >= 2}
          onDone={done[2]!}
          title="Timeouts and retries"
          why="Timeout and retry settings, to compare a caller's patience with what it calls."
          query="kind:setting settingKind:timeout,retry"
          emptyText="No timeout or retry settings were found in code or config."
          span="span 6"
        />
        <CatalogCheck
          go={answered >= 3}
          onDone={done[3]!}
          title="Retiring"
          why="Records planned for retirement; check who still depends on them."
          query="status:planned-retire"
          emptyText="Nothing is planned for retirement."
          span="span 6"
        />

        <Panel title="Incident mode" span="span 12">
          <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
            Read-only blast radius from the last scan. Atticus never connects to live systems,
            consoles or monitoring. <a href="#/impact">Open the impact explorer</a>
          </p>
        </Panel>
      </div>
    </>
  );
}
