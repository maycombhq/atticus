import type { ReactNode } from "react";
import type { Loaded } from "../../api/client.js";
import { isOffline } from "../../api/client.js";
import { waitingByChange, type InboxItem, type WaitingSection } from "../../app/inbox.js";
import { View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { HomeChangeRow, HomeChangeWaits } from "../HomeRoles.js";
import { NewChange } from "../work/NewChange.js";
import { stageOf } from "../work/next.js";
import "./home.css";

/**
 * beta.26: Home's short panels. Each shows the top few of what it is about, with See all to the
 * page that lists every one; each loads, fails and is empty on its own, so one part not loading
 * never blanks the page.
 */

const T = COPY.commandCenter;
const H = T.home;
const W = COPY.work;

/** A panel of Home: a small sentence-case heading, a muted line beside it, then its rows. */
export function HomePanel(p: { id: string; title: string; meta?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel hm-panel" aria-labelledby={p.id}>
      <div className="hm-panel-head">
        <h2 id={p.id} className="hm-label">
          {p.title}
        </h2>
        {p.meta !== undefined && p.meta !== null && <span className="hm-meta">{p.meta}</span>}
      </div>
      {p.children}
    </section>
  );
}

/** A loaded list's state in a panel: rows, or a skeleton, or why it didn't load. */
const why = (e: string | undefined) => (!e || isOffline(e) ? COPY.app.offlineShort : e);

// ------------------------------------------------------------------ Needs a person, top few

export interface TopRow {
  key: string;
  kind: WaitingSection["kind"];
  /** The section's name: "Questions · forge-ledger", "Open needs". */
  title: string;
  /** The change it belongs to, by title; none for what belongs to no change. */
  change?: string;
  count: number;
  blocking: boolean;
  href: string;
}

/** Where a section's row goes: the page where its kind is worked on. */
function sectionHref(s: WaitingSection): string {
  const first = s.items[0]?.href;
  switch (s.kind) {
    case "question":
      // Owner questions open their tab; a repo's questions open the Questions page.
      return first?.startsWith("#/questions?kind=owner") ? first : "#/questions";
    case "need":
      return "#/changes?across=needs";
    case "step":
      return "#/todo";
    case "triage":
      return "#/intake";
    case "knowledge":
      return "#/knowledge";
    default:
      return first ?? "#/changes?across=findings";
  }
}

const SECTION: Record<WaitingSection["kind"], (s: WaitingSection) => string> = {
  need: () => T.sectionNeeds,
  finding: () => T.sectionFindings,
  step: () => T.sectionSteps,
  question: (s) => T.sectionQuestions(s.repo),
  triage: () => T.sectionTriage,
  knowledge: () => T.sectionKnowledge,
};

/**
 * What needs a person, as Home's top rows: each change's (or no change's) sections, one row per
 * section with its count (the questions one per repo), what blocks first, then the most waiting.
 */
export function topWaiting(
  items: InboxItem[],
  changes: { id: string; title: string; state?: string }[],
): { rows: TopRow[]; total: number } {
  const w = waitingByChange(items, changes, "");
  const rows = w.groups.flatMap((g) =>
    g.sections.map((s): TopRow => ({
      key: `${g.change ?? ""}|${s.kind}|${s.repo ?? ""}`,
      kind: s.kind,
      title: SECTION[s.kind](s),
      ...(g.change ? { change: g.title } : {}),
      count: s.items.length,
      blocking: s.items.some((x) => x.blocking),
      href: sectionHref(s),
    })),
  );
  rows.sort((a, b) => Number(b.blocking) - Number(a.blocking) || b.count - a.count);
  return { rows, total: w.total };
}

/** Most rows a Home panel shows before See all. */
export const TOP = 5;

/** The top rows of what needs a person, or its loading, error or empty state. */
export function NeedsTop(p: {
  items: InboxItem[];
  changes: { id: string; title: string; state?: string }[];
  state: "loading" | "error" | "ready";
  error?: string | undefined;
  partial?: string[];
}) {
  if (p.state === "loading")
    return (
      <div className="stack" aria-busy="true" style={{ gap: 6 }}>
        <span className="sr">{COPY.app.loading}</span>
        <div className="skeleton" style={{ width: "85%" }} />
        <div className="skeleton" style={{ width: "70%" }} />
        <div className="skeleton" style={{ width: "60%" }} />
      </div>
    );
  if (p.state === "error")
    return (
      <div className="state error" role="alert">
        {T.couldntLoadWhatNeeds(why(p.error))}
      </div>
    );
  const { rows } = topWaiting(p.items, p.changes);
  const partial = p.partial?.length ? (
    <div className="state error" role="alert">
      {T.partlyLoaded(p.partial)}
    </div>
  ) : null;
  if (rows.length === 0)
    return (
      <>
        {partial}
        <p className="hm-quiet-line">{T.nothingNeedsAPerson}</p>
      </>
    );
  const more = rows.length - TOP;
  return (
    <>
      {partial}
      <ul className="hm-list">
        {rows.slice(0, TOP).map((r) => (
          <li key={r.key}>
            <span className="hm-row-main">
              <a className="hm-row-title" href={r.href}>
                {r.title}
              </a>
              <span className="hm-row-sub">
                {r.change ? H.inChange(r.change) : T.noChangeGroup}
              </span>
            </span>
            <span className="hm-row-end">
              {r.blocking && <span className="chip blocking">{T.blocked}</span>}
              <span className={`chip ${r.blocking ? "blocking" : "dim"}`}>
                {T.groupCount(r.count)}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {more > 0 && <p className="hm-quiet-line">{H.needsMore(more)}</p>}
    </>
  );
}

// ------------------------------------------------------------------ the changes

export interface HomeChange {
  id: string;
  title: string;
  state: string;
  openFindings?: { blocking: number };
}

/** Most changes the changes panel lists under the current change's gates. */
export const TOP_CHANGES = 4;

/**
 * The person's changes (when a change names them), else the changes in flight: the current
 * change's gate pipeline first (the person's first change, else the first in flight), then the
 * top four, each in one line with its stage and whom it waits on; See all opens All changes, and
 * the map is one link away.
 */
export function HomeChanges(p: {
  changes: Loaded<HomeChange[]> & { reload?: () => void };
  /** The changes in flight (Home's own list of them). */
  inFlight: HomeChange[];
  /** The changes whose owners name the person; undefined when no change names a role for them. */
  yours: readonly string[] | undefined;
  me: string | undefined;
}) {
  const mine = p.yours ? p.inFlight.filter((c) => p.yours!.includes(c.id)) : p.inFlight;
  const focus = mine[0] ?? p.inFlight[0];
  const row = (c: HomeChange) => {
    const props = {
      c: { ...c, blocked: !!c.openFindings?.blocking },
      stage: W.stage[stageOf(c.state)],
      me: p.me,
    };
    // Whom it waits on is read for the person's own changes (its cockpit), as before.
    return p.yours ? (
      <HomeChangeWaits key={c.id} {...props} />
    ) : (
      <HomeChangeRow key={c.id} {...props} />
    );
  };
  const more = p.inFlight.length - Math.min(mine.length, TOP_CHANGES);
  const foot = (
    <div className="hm-foot">
      <a href="#/changes">{H.seeAllChanges}</a>
      {more > 0 && <span className="hm-meta">{H.changesMore(more)}</span>}
      <a href="#/canvas">{H.mapSub}</a>
    </div>
  );
  return (
    <View of={p.changes}>
      {() =>
        p.inFlight.length === 0 ? (
          <>
            <div className="hm-empty">
              <p className="hm-quiet-line">{W.noChanges}</p>
              <NewChange />
            </div>
            {foot}
          </>
        ) : (
          <>
            {focus && (
              <div className="hm-focus">
                <p className="hm-gate-change">
                  <a href={`#/changes/${encodeURIComponent(focus.id)}`}>{focus.title}</a>
                </p>
                <GateStrip state={focus.state} label={H.gatesOf(focus.title)} />
              </div>
            )}
            {mine.length === 0 ? (
              <p className="hm-quiet-line">{COPY.roleWork.home.noneYours}</p>
            ) : (
              <ul className="hm-list">{mine.slice(0, TOP_CHANGES).map(row)}</ul>
            )}
            {foot}
          </>
        )
      }
    </View>
  );
}

// ------------------------------------------------------------------ the gates

const PHASES = ["define", "design", "plan", "build", "qa", "release-ready"] as const;
const PHASE_LABEL: Record<string, string> = {
  define: T.define,
  design: T.design,
  plan: T.plan,
  build: T.build,
  qa: "QA",
  "release-ready": T.release,
};

/** The change's gates in a row: each done, the current one, those to come. */
export function GateStrip({ state, label }: { state: string; label?: string }) {
  const at = PHASES.indexOf(state as (typeof PHASES)[number]);
  return (
    <ol className="hm-gates" {...(label ? { "aria-label": label } : {})}>
      {PHASES.map((ph, i) => {
        const was = i < at ? "done" : i === at ? "now" : "todo";
        return (
          <li key={ph} className={`hm-gate ${was}`} aria-current={i === at ? "step" : undefined}>
            <span className="hm-gate-dot" aria-hidden="true">
              {i < at ? "✓" : i === at ? i + 1 : ""}
            </span>
            <span className="hm-gate-name">
              {PHASE_LABEL[ph]}
              <span className="sr">
                {" "}
                ({i === at ? T.currentPhase(PHASE_LABEL[ph] ?? "") : i < at ? T.done2 : T.toCome})
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
