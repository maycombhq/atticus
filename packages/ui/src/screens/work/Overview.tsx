import type { Api } from "@maycombhq/core";
import { NewChange } from "./NewChange.js";
import { useApi, useReloadOnFiles, type Loaded } from "../../api/client.js";
import { Panel, Ring, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { Table } from "../know/common.js";
import { trustChip } from "../map/Trust.js";
import { isMapQuestion, type QuestionListView } from "../Questions.js";
import {
  changeStep,
  dashboardStep,
  inFlight,
  onboardingProgress,
  reposOnboarded,
  STAGE_SCREEN,
  stageOf,
  type ChangeRow,
  type OnboardingData,
} from "./next.js";
import { Command, Problems, RunNextPanel } from "./RunNext.js";
import { hasAction, StepAction } from "./step-action.js";

const T = COPY.dashboardExtra;

/**
 * Home's overview: what was the Overview (plan 4.5), merged into Home by the product owner on
 * 2026-10-24. The one step to run next; what is onboarded, read and trusted; the changes in
 * flight, each with the stage it is at and its command; the slash commands. Read from the
 * onboarding view (ADR 0084), /api/trust, /api/changes and /api/questions, which Home loads once
 * for all its panels; it runs nothing.
 */

const W = COPY.work;
const R = COPY.runNext;

export function CoverageView({ v }: { v: OnboardingData }) {
  const p = onboardingProgress(v);
  const max = Math.max(p.listed, 1);
  const rings: [number, string][] = [
    [p.cloned, W.reposCloned],
    [p.scanned, W.reposScanned],
  ];
  return (
    <div className="stack">
      <Problems list={v.problems} />
      <p style={{ margin: 0 }}>
        <span className="n" style={{ fontSize: 22 }}>
          {p.listed}
        </span>{" "}
        {W.reposListed} ·{" "}
        <span className="n" style={{ fontSize: 22 }}>
          {p.records}
        </span>{" "}
        {W.records}
      </p>
      <div className="row" style={{ gap: 18, flexWrap: "wrap" }}>
        {rings.map(([n, label]) => (
          <div key={label} className="stack" style={{ alignItems: "center", gap: 4 }}>
            <Ring value={n} max={max} label={T.of(n, p.listed, label)} text={`${n}/${p.listed}`} />
            <span className="muted" style={{ fontSize: 11.5 }}>
              {label}
            </span>
          </div>
        ))}
      </div>
      <a href="#/onboarding">{W.openOnboarding}</a>
    </div>
  );
}

export function InFlight({ changes }: { changes: ChangeRow[] }) {
  const rows = changes.filter(inFlight);
  if (rows.length === 0)
    return (
      <div className="stack" style={{ gap: 6 }}>
        <div className="state">{W.noChanges}</div>
        <NewChange />
      </div>
    );
  return (
    <Table
      caption={W.inFlight}
      rows={rows}
      rowKey={(c) => c.id}
      cols={[
        {
          label: W.changeCol,
          cell: (c) => (
            <>
              <code className="mono">{c.id}</code>
              <br />
              <span className="muted">{c.title}</span>
            </>
          ),
        },
        {
          label: W.stateCol,
          cell: (c) =>
            c.openFindings?.blocking ? (
              <>
                {c.state} <span className="chip blocking">{COPY.commandCenter.blocked}</span>
              </>
            ) : (
              c.state
            ),
        },
        {
          label: W.stageCol,
          cell: (c) => {
            const stage = stageOf(c.state);
            const s = STAGE_SCREEN[stage];
            return s ? (
              <a href={`#/${s.id}?change=${encodeURIComponent(c.id)}`}>{s.label}</a>
            ) : (
              W.stage[stage]
            );
          },
        },
        {
          label: W.commandCol,
          cell: (c) => <InFlightAction c={c} />,
        },
      ]}
    />
  );
}

/**
 * Eighth UX walk: a change's Run cell is its step's in-app action (the Task board, Raise
 * hand-off, Release), or its At a glance where the app has no control for the step; the command
 * stays copyable under "Or in a terminal".
 */
export function InFlightAction({ c }: { c: ChangeRow }) {
  const own = changeStep(c);
  const step = {
    ...own,
    change: own.change ?? c.id,
    // A change on its way to release is worked on Release.
    ...(stageOf(c.state) === "release" && !own.kind ? { kind: "release" as const } : {}),
  };
  return (
    <div className="stack" style={{ gap: 4 }}>
      {hasAction(step) ? (
        <StepAction {...step} />
      ) : (
        <p style={{ margin: 0 }}>
          <a href={`#/cockpit?change=${encodeURIComponent(c.id)}`}>{R.openGlance}</a>
        </p>
      )}
      <details className="work-terminal">
        <summary>{R.orTerminal}</summary>
        <Command text={step.command} label={R.copy} noRun />
      </details>
    </div>
  );
}

export function SlashCommands() {
  return (
    <div className="stack">
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        {W.slashIntro}
      </p>
      <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
        {R.commands.map((c) => (
          <li key={c.name}>
            <code className="mono">
              {c.name} {c.args}
            </code>{" "}
            {c.what} <span className="muted">({W.slashWhere[c.where]})</span>
          </li>
        ))}
      </ul>
      <p className="work-say">{R.install}</p>
      <Command text="atticus assistant-files" label={R.copy} />
      <p className="work-say">{R.plugin}</p>
      <Command text="/plugin marketplace add maycombhq/atticus" label={R.copy} />
      <Command text="/plugin install atticus@maycombhq" label={R.copy} />
    </div>
  );
}

type All = { onboarding: OnboardingData; changes: ChangeRow[]; questions: QuestionListView };

/** All three loads as one: Run next needs every one of them. */
export function together(
  onboarding: Loaded<OnboardingData>,
  changes: Loaded<ChangeRow[]>,
  questions: Loaded<QuestionListView>,
): Loaded<All> {
  for (const l of [onboarding, changes, questions]) if (l.state === "error") return l;
  if (onboarding.state !== "ready" || changes.state !== "ready" || questions.state !== "ready")
    return { state: "loading" };
  return {
    state: "ready",
    data: { onboarding: onboarding.data, changes: changes.data, questions: questions.data },
  };
}

/** Run next on Home: the one step, onboarding first, then a change, then starting one. */
export function HomeNext(p: {
  onboarding: Loaded<OnboardingData>;
  changes: Loaded<ChangeRow[]>;
  questions: Loaded<QuestionListView>;
  /** Map › Trust: each repo's read step, the Atticus 2 way (ADR 0124). */
  trust?: Loaded<Api.TrustViewT>;
}) {
  const trust = p.trust?.state === "ready" ? p.trust.data : undefined;
  // Seventh UX walk: the change in flight's own next step, from its cockpit (its state and gate),
  // not the stage its state names: Home said "at the feature stage" while its PR waited.
  const all = together(p.onboarding, p.changes, p.questions);
  // Only once onboarding is done (the repos read and verified) is the change's step the one shown.
  const first =
    all.state === "ready" && reposOnboarded(all.data.onboarding, trust)
      ? all.data.changes.find(inFlight)?.id
      : undefined;
  const cockpit = useApi<Api.ChangeCockpitT>(
    first ? `/api/changes/${encodeURIComponent(first)}/cockpit` : undefined,
  );
  useReloadOnFiles(cockpit);
  // Its cockpit read, the step is the change's own; one that can't be read leaves the stage's.
  const of: Loaded<All> = first && cockpit.state === "loading" ? { state: "loading" } : all;
  return (
    <View of={of}>
      {(d) => (
        <RunNextPanel
          step={dashboardStep(
            d.onboarding,
            // Eighth UX walk: the map's questions; a change's own are its step's.
            d.questions.questions.filter(isMapQuestion).length,
            d.changes,
            trust,
            cockpit.state === "ready" ? cockpit.data : undefined,
          )}
        />
      )}
    </View>
  );
}

/** How far to trust each repo's map, in a line: the count, the repos not trusted, Map › Trust. */
export function TrustSummary({ v }: { v: Api.TrustViewT }) {
  const TR = COPY.trust;
  const not = v.repos.filter((r) => r.state !== "trusted");
  return (
    <div className="stack" style={{ gap: 6 }}>
      <Problems list={v.problems} />
      <p style={{ margin: 0 }}>{TR.summary(v.repos.length - not.length, v.repos.length)}</p>
      {not.length === 0 ? (
        <p className="work-say" style={{ margin: 0 }}>
          {W.allTrusted}
        </p>
      ) : (
        <ul aria-label={W.notTrusted} style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
          {not.slice(0, 5).map((r) => (
            <li key={r.repo}>
              <span className="mono">{r.repo}</span>{" "}
              <span className={`chip ${trustChip(r.state)}`}>{TR.states[r.state]}</span>
            </li>
          ))}
        </ul>
      )}
      <a href="#/trust">{W.openTrust}</a>
    </div>
  );
}

/** The estate (read and trusted) beside the changes in flight, each at its stage. */
export function HomeEstate(p: {
  onboarding: Loaded<OnboardingData>;
  trust: Loaded<Api.TrustViewT>;
  changes: Loaded<ChangeRow[]>;
}) {
  return (
    <div className="bento">
      <Panel title={W.estate} span="span 5">
        <div className="stack" style={{ gap: 14 }}>
          <View of={p.onboarding}>{(v) => <CoverageView v={v} />}</View>
          <View
            of={p.trust}
            empty={(v) => v.repos.length === 0 && v.problems.length === 0}
            emptyText={W.trustNone}
          >
            {(v) => <TrustSummary v={v} />}
          </View>
        </div>
      </Panel>
      <Panel
        title={W.inFlight}
        span="span 7"
        meta={
          p.changes.state === "ready" ? String(p.changes.data.filter(inFlight).length) : undefined
        }
      >
        <View of={p.changes}>{(c) => <InFlight changes={c} />}</View>
      </Panel>
    </div>
  );
}
