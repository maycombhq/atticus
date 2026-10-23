import { useState, type ReactNode } from "react";
import { useApi } from "../api/client.js";
import { ExternalLink, Panel, View } from "../app/ui.js";
import { Table } from "./know/common.js";
import { COPY } from "../copy.js";

const T = COPY.across;

/**
 * One list across every open change (ADR 0048): findings, tasks, stories, tests, service
 * requests or releases, with a filter. Each row links to its change.
 */

export const ACROSS = [
  { id: "findings", label: T.findings },
  { id: "tasks", label: T.tasks },
  { id: "stories", label: T.stories },
  { id: "tests", label: T.tests },
  { id: "requests", label: T.requests },
  { id: "releases", label: T.releases },
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
    { label: T.change, cell: changeCell, width: "18%" },
    {
      label: T.severity,
      cell: (r) => chip(s(r.severity), r.severity === "blocking" ? "blocking" : ""),
    },
    { label: T.finding, cell: (r) => s(r.summary) },
    { label: T.where, cell: (r) => `${s(r.gate)} · ${s(r.artifact)}`, mono: true },
    { label: T.state, cell: (r) => s(r.state) },
  ],
  tasks: [
    { label: T.change, cell: changeCell, width: "18%" },
    { label: T.task, cell: (r) => s(r.id), mono: true },
    { label: T.repo, cell: (r) => s(r.repo), mono: true },
    { label: T.what, cell: (r) => s(r.description) },
    { label: T.done, cell: (r) => (r.done ? chip("done", "done") : chip("open")) },
  ],
  stories: [
    { label: T.change, cell: changeCell, width: "18%" },
    { label: T.story, cell: (r) => s(r.id), mono: true },
    { label: T.title, cell: (r) => s(r.title) },
    { label: T.repos, cell: (r) => (r.repos as string[]).join(", "), mono: true },
    {
      label: T.written,
      cell: (r) =>
        r.written ? `${s(r.criteria)} criteria` : <span className="muted">{T.notYet}</span>,
    },
  ],
  tests: [
    { label: T.change, cell: changeCell, width: "18%" },
    { label: T.requirementsTested, cell: (r) => `${s(r.tested)} of ${s(r.rows)}` },
    {
      label: T.gaps,
      cell: (r) => (r.gaps ? chip(`${s(r.gaps)} gaps`, "warn") : chip("none", "done")),
    },
    { label: T.firstGaps, cell: (r) => (r.topGaps as string[]).join("; ") },
  ],
  requests: [
    { label: T.change, cell: changeCell, width: "18%" },
    { label: T.request, cell: (r) => s(r.heading) },
    { label: T.for, cell: (r) => s(r.record), mono: true },
    {
      label: T.state,
      cell: (r) =>
        chip(s(r.state), r.state === "filed" ? "done" : r.state === "to-file" ? "warn" : ""),
    },
    {
      label: T.missing,
      cell: (r) =>
        (r.missing as string[]).length ? (r.missing as string[]).join(", ") : "nothing",
    },
  ],
  releases: [
    { label: T.change, cell: changeCell, width: "18%" },
    { label: T.state, cell: (r) => chip(r.changeState, r.atRelease ? "done" : "") },
    { label: T.risk, cell: (r) => s(r.risk) },
    { label: T.next, cell: (r) => s(r.nextStep) },
    {
      label: T.handOff,
      cell: (r) => {
        const h = r.handoff as { phase: string; pr: string; state: string } | undefined;
        return h ? (
          <ExternalLink href={h.pr}>{`${h.phase} · ${h.state}`}</ExternalLink>
        ) : (
          <span className="muted">{T.noneOpen}</span>
        );
      },
    },
  ],
};

const EMPTY: Record<AcrossId, string> = {
  findings: T.noFindingsOnAny,
  tasks: T.noTasksYetTasks,
  stories: T.noStoriesYetWrite,
  tests: T.noOpenChangesTo,
  requests: T.noServiceRequestsDrafted,
  releases: T.noOpenChanges,
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
    <Panel title={T.acrossChanges2(label)} span="span 9" rows="span 3">
      <nav
        aria-label={T.acrossChanges}
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
          {T.filter}
        </label>
        <input
          id="across-filter"
          className="field"
          value={text}
          placeholder={T.wordsToMatchFor}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      <View of={data} empty={(d) => d.rows.length === 0} emptyText={EMPTY[view]}>
        {(d) => {
          const rows = filterRows(d.rows, text);
          return (
            <div className="stack" style={{ gap: 8 }}>
              <p className="muted" role="status" style={{ margin: 0, fontSize: 12 }}>
                {T.ofAcrossOpenChange(
                  rows.length,
                  d.rows.length,
                  d.changes,
                  d.changes === 1 ? "" : "s",
                )}
              </p>
              {rows.length ? (
                <Table
                  rows={rows}
                  cols={COLS[view]}
                  rowKey={(r) => `${r.change}|${s(r.id ?? r.heading ?? "")}|${rows.indexOf(r)}`}
                  caption={T.acrossOpenChanges(label)}
                />
              ) : (
                <p className="muted" style={{ margin: 0 }}>
                  {T.nothingMatches(text)}
                </p>
              )}
            </div>
          );
        }}
      </View>
    </Panel>
  );
}
