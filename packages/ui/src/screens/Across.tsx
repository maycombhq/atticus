import { useState, type ReactNode } from "react";
import { useApi, useReloadOnFiles } from "../api/client.js";
import { ExternalLink, GlanceLink, Panel, View } from "../app/ui.js";
import { FilterBox, FilterEmpty, filteredWhat, matchesWords } from "../app/filter.js";
import { Table } from "./know/common.js";
import { NeedsAcross } from "./knowledge/NeedsAcross.js";
import { COPY } from "../copy.js";
import { isManualLink, MANUAL_STEPS_HREF } from "./know/task-pr.js";
import "./knowledge/knowledge.css";

const T = COPY.across;

/**
 * One list across every open change (ADR 0048): findings, tasks, stories, tests, service
 * requests, releases or needs (ADR 0105), with a filter. Each row links to its change.
 */

export const ACROSS = [
  { id: "findings", label: T.findings },
  { id: "tasks", label: T.tasks },
  { id: "stories", label: T.stories },
  { id: "tests", label: T.tests },
  { id: "requests", label: T.requests },
  { id: "releases", label: T.releases },
  { id: "needs", label: T.needs },
] as const;
export type AcrossId = (typeof ACROSS)[number]["id"];
/** The views the server lists as rows; needs come from each change's own needs call. */
type RowsId = Exclude<AcrossId, "needs">;

export interface AcrossRow {
  change: string;
  changeTitle: string;
  changeState: string;
  [field: string]: unknown;
}
interface Across {
  view: RowsId;
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

/**
 * A release row's hand-off: its PR's link and state. Seventh UX walk: a manual Git host's PR
 * isn't open until a person opens it, so it links to where that step waits, never manual://.
 */
/** Beta.27 review: a release row's next step; the step that comes first is on At a glance. */
export function nextCell(r: AcrossRow) {
  return (
    <>
      {s(r.nextStep)}
      {r.stepFirst === true && (
        <>
          {" "}
          <GlanceLink change={r.change} />
        </>
      )}
    </>
  );
}

export function handoffCell(h: { phase: string; pr: string; state: string } | undefined) {
  if (!h) return <span className="muted">{T.noneOpen}</span>;
  if (h.state === "open" && isManualLink(h.pr))
    return <a href={MANUAL_STEPS_HREF}>{T.handOffManual(h.phase)}</a>;
  return <ExternalLink href={h.pr}>{`${h.phase} · ${h.state}`}</ExternalLink>;
}

type Col = { label: string; cell: (r: AcrossRow) => ReactNode; mono?: boolean; width?: string };

const COLS: Record<RowsId, Col[]> = {
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
    { label: T.next, cell: (r) => nextCell(r) },
    {
      label: T.handOff,
      cell: (r) =>
        handoffCell(r.handoff as { phase: string; pr: string; state: string } | undefined),
    },
  ],
};

const EMPTY: Record<RowsId, string> = {
  findings: T.noFindingsOnAny,
  tasks: T.noTasksYetTasks,
  stories: T.noStoriesYetWrite,
  tests: T.noOpenChangesTo,
  requests: T.noServiceRequestsDrafted,
  releases: T.noOpenChanges,
};

/** Rows whose words contain every word of the filter, case aside. */
export function filterRows(rows: AcrossRow[], text: string): AcrossRow[] {
  return rows.filter((r) => matchesWords([JSON.stringify(r)], text));
}

export function AcrossPanel({ view }: { view: AcrossId }) {
  const data = useApi<Across>(view === "needs" ? undefined : `/api/across?view=${view}`);
  useReloadOnFiles(data);
  const [text, setText] = useState("");
  const label = ACROSS.find((a) => a.id === view)!.label;
  return (
    <Panel title={T.acrossChanges2(label)} span="span 9" rows="span 3">
      <nav aria-label={T.acrossChanges} className="kn-tabs">
        {ACROSS.map((a) => (
          <a
            key={a.id}
            href={`#/changes?across=${a.id}`}
            aria-current={a.id === view ? "page" : undefined}
            className={`btn ${a.id === view ? "on" : ""}`}
          >
            {a.label}
          </a>
        ))}
      </nav>
      <div className="kn-tools">
        <FilterBox id="across-filter" value={text} onChange={setText} />
      </div>
      {view === "needs" ? (
        <NeedsAcross text={text} onClear={() => setText("")} />
      ) : (
        <AcrossRows data={data} view={view} text={text} label={label} onClear={() => setText("")} />
      )}
    </Panel>
  );
}

function AcrossRows(p: {
  data: ReturnType<typeof useApi<Across>>;
  view: RowsId;
  text: string;
  label: string;
  onClear: () => void;
}) {
  const { data, view, text, label } = p;
  return (
    <>
      <View of={data} empty={(d) => d.rows.length === 0} emptyText={EMPTY[view]}>
        {(d) => {
          const rows = filterRows(d.rows, text);
          return (
            <div className="stack" style={{ gap: 8 }}>
              <p className="kn-count" role="status">
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
                <FilterEmpty
                  what={filteredWhat({ text })}
                  onClear={p.onClear}
                  focus="across-filter"
                />
              )}
            </div>
          );
        }}
      </View>
    </>
  );
}
