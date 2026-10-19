import { useState, type ReactNode } from "react";
import { useApi } from "../api/client.js";
import { Panel, View } from "../app/ui.js";
import { Table } from "./know/common.js";

/**
 * One list across every open change (ADR 0048): findings, tasks, stories, tests, service
 * requests or releases, with a filter. Each row links to its change.
 */

export const ACROSS = [
  { id: "findings", label: "Findings" },
  { id: "tasks", label: "Tasks" },
  { id: "stories", label: "Stories" },
  { id: "tests", label: "Tests" },
  { id: "requests", label: "Requests" },
  { id: "releases", label: "Releases" },
] as const;
export type AcrossId = (typeof ACROSS)[number]["id"];

export interface AcrossRow {
  change: string;
  changeTitle: string;
  changeState: string;
  [field: string]: unknown;
}
interface Across {
  view: AcrossId;
  changes: number;
  rows: AcrossRow[];
}

const s = (v: unknown) => (v === undefined || v === null ? "" : String(v));
const changeCell = (r: AcrossRow) => (
  <a href={`#/changes/${r.change}`} className="mono">
    {r.change}
  </a>
);
const chip = (text: string, kind = "") => (
  <span className={`chip ${kind}`}>{text.toUpperCase()}</span>
);

type Col = { label: string; cell: (r: AcrossRow) => ReactNode; mono?: boolean; width?: string };

const COLS: Record<AcrossId, Col[]> = {
  findings: [
    { label: "Change", cell: changeCell, width: "18%" },
    {
      label: "Severity",
      cell: (r) => chip(s(r.severity), r.severity === "blocking" ? "blocking" : ""),
    },
    { label: "Finding", cell: (r) => s(r.summary) },
    { label: "Where", cell: (r) => `${s(r.gate)} · ${s(r.artifact)}`, mono: true },
    { label: "State", cell: (r) => s(r.state) },
  ],
  tasks: [
    { label: "Change", cell: changeCell, width: "18%" },
    { label: "Task", cell: (r) => s(r.id), mono: true },
    { label: "Repo", cell: (r) => s(r.repo), mono: true },
    { label: "What", cell: (r) => s(r.description) },
    { label: "Done", cell: (r) => (r.done ? chip("done", "done") : chip("open")) },
  ],
  stories: [
    { label: "Change", cell: changeCell, width: "18%" },
    { label: "Story", cell: (r) => s(r.id), mono: true },
    { label: "Title", cell: (r) => s(r.title) },
    { label: "Repos", cell: (r) => (r.repos as string[]).join(", "), mono: true },
    {
      label: "Written",
      cell: (r) =>
        r.written ? `${s(r.criteria)} criteria` : <span className="muted">not yet</span>,
    },
  ],
  tests: [
    { label: "Change", cell: changeCell, width: "18%" },
    { label: "Requirements tested", cell: (r) => `${s(r.tested)} of ${s(r.rows)}` },
    {
      label: "Gaps",
      cell: (r) => (r.gaps ? chip(`${s(r.gaps)} gaps`, "warn") : chip("none", "done")),
    },
    { label: "First gaps", cell: (r) => (r.topGaps as string[]).join("; ") },
  ],
  requests: [
    { label: "Change", cell: changeCell, width: "18%" },
    { label: "Request", cell: (r) => s(r.heading) },
    { label: "For", cell: (r) => s(r.record), mono: true },
    {
      label: "State",
      cell: (r) =>
        chip(s(r.state), r.state === "filed" ? "done" : r.state === "to-file" ? "warn" : ""),
    },
    {
      label: "Missing",
      cell: (r) =>
        (r.missing as string[]).length ? (r.missing as string[]).join(", ") : "nothing",
    },
  ],
  releases: [
    { label: "Change", cell: changeCell, width: "18%" },
    { label: "State", cell: (r) => chip(r.changeState, r.atRelease ? "done" : "") },
    { label: "Risk", cell: (r) => s(r.risk) },
    { label: "Next", cell: (r) => s(r.nextStep) },
    {
      label: "Hand-off",
      cell: (r) => {
        const h = r.handoff as { phase: string; pr: string; state: string } | undefined;
        return h ? (
          <a href={h.pr}>{`${h.phase} · ${h.state}`}</a>
        ) : (
          <span className="muted">none open</span>
        );
      },
    },
  ],
};

const EMPTY: Record<AcrossId, string> = {
  findings: "No findings on any open change. Run the critic on a change to review it.",
  tasks: "No tasks yet: tasks come with a change's plan.",
  stories: "No stories yet: write them on a change's Breakdown.",
  tests: "No open changes to trace.",
  requests: "No service requests drafted on any open change.",
  releases: "No open changes.",
};

/** Rows whose words contain every word of the filter, case aside. */
export function filterRows(rows: AcrossRow[], text: string): AcrossRow[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return rows;
  return rows.filter((r) => {
    const hay = JSON.stringify(r).toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export function AcrossPanel({ view }: { view: AcrossId }) {
  const data = useApi<Across>(`/api/across?view=${view}`);
  const [text, setText] = useState("");
  const label = ACROSS.find((a) => a.id === view)!.label;
  return (
    <Panel title={`${label} across changes`} span="span 9" rows="span 3">
      <nav
        aria-label="Across changes"
        className="row"
        style={{ gap: 6, flexWrap: "wrap", marginBottom: 10 }}
      >
        {ACROSS.map((a) => (
          <a
            key={a.id}
            href={`#/changes?across=${a.id}`}
            aria-current={a.id === view ? "page" : undefined}
            className={`btn ${a.id === view ? "primary" : ""}`}
          >
            {a.label}
          </a>
        ))}
      </nav>
      <div className="stack" style={{ gap: 4, marginBottom: 10 }}>
        <label htmlFor="across-filter" className="hud" style={{ fontSize: 10 }}>
          Filter
        </label>
        <input
          id="across-filter"
          className="field"
          value={text}
          placeholder="Words to match, for example forge-ledger open"
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      <View of={data} empty={(d) => d.rows.length === 0} emptyText={EMPTY[view]}>
        {(d) => {
          const rows = filterRows(d.rows, text);
          return (
            <div className="stack" style={{ gap: 8 }}>
              <p className="muted" role="status" style={{ margin: 0, fontSize: 12 }}>
                {rows.length} of {d.rows.length} across {d.changes} open change
                {d.changes === 1 ? "" : "s"}
              </p>
              {rows.length ? (
                <Table
                  rows={rows}
                  cols={COLS[view]}
                  rowKey={(r) => `${r.change}|${s(r.id ?? r.heading ?? "")}|${rows.indexOf(r)}`}
                  caption={`${label} across open changes`}
                />
              ) : (
                <p className="muted" style={{ margin: 0 }}>
                  Nothing matches “{text}”.
                </p>
              )}
            </div>
          );
        }}
      </View>
    </Panel>
  );
}
