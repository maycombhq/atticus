import { useApi, useLiveEvents, type Loaded } from "../../api/client.js";
import { Panel, Ring, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { Table } from "../know/common.js";
import type { QuestionListView } from "../Questions.js";
import {
  changeStep,
  dashboardStep,
  inFlight,
  onboardingProgress,
  STAGE_SCREEN,
  stageOf,
  type ChangeRow,
  type OnboardingData,
} from "./next.js";
import { Command, Problems, RunNextPanel } from "./RunNext.js";

const T = COPY.dashboardExtra;

/**
 * The Dashboard (plan 4.5): what is onboarded and scanned, the changes in flight and their
 * stage, the open questions, and the one command to run next. Read from the onboarding view
 * (ADR 0084), /api/changes and /api/questions; it runs nothing.
 */

const W = COPY.work;
const R = COPY.runNext;

export function CoverageView({ v }: { v: OnboardingData }) {
  const p = onboardingProgress(v);
  const max = Math.max(p.listed, 1);
  const rings: [number, string][] = [
    [p.cloned, W.reposCloned],
    [p.settings, W.reposSettings],
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
  if (rows.length === 0) return <div className="state">{W.noChanges}</div>;
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
        { label: W.stateCol, cell: (c) => c.state },
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
          cell: (c) => <Command text={changeStep(c).command} label={R.copy} />,
        },
      ]}
    />
  );
}

export function OpenQuestions({ list }: { list: QuestionListView }) {
  const qs = list.questions;
  if (qs.length === 0) return <div className="state">{W.noQuestions}</div>;
  return (
    <div className="stack">
      <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
        {qs.slice(0, 5).map((q) => (
          <li key={q.id}>
            <a href={`#/questions/${q.id}`}>{q.question}</a>{" "}
            <span className="muted mono" style={{ fontSize: 11 }}>
              {q.repo}
            </span>
          </li>
        ))}
      </ul>
      <a href="#/questions">{W.allQuestions(qs.length)}</a>
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

export function DashboardPage(p: {
  onboarding: Loaded<OnboardingData>;
  changes: Loaded<ChangeRow[]>;
  questions: Loaded<QuestionListView>;
}) {
  const all = together(p.onboarding, p.changes, p.questions);
  return (
    <>
      <p className="muted" style={{ margin: "0 0 12px", fontSize: 12.5, lineHeight: 1.55 }}>
        {W.dashIntro}
      </p>
      <View of={all}>
        {(d) => (
          <RunNextPanel
            step={dashboardStep(d.onboarding, d.questions.questions.length, d.changes)}
          />
        )}
      </View>
      <div className="bento">
        <Panel title={W.coverage} span="span 5">
          <View of={p.onboarding}>{(v) => <CoverageView v={v} />}</View>
        </Panel>
        <Panel title={W.openQuestions} span="span 7">
          <View of={p.questions}>{(l) => <OpenQuestions list={l} />}</View>
        </Panel>
        <Panel title={W.inFlight} span="1 / -1">
          <View of={p.changes}>{(c) => <InFlight changes={c} />}</View>
        </Panel>
        <Panel title={W.slashTitle} span="1 / -1">
          <SlashCommands />
        </Panel>
      </div>
    </>
  );
}

export function Dashboard() {
  const onboarding = useApi<OnboardingData>("/api/onboarding");
  const changes = useApi<ChangeRow[]>("/api/changes");
  const questions = useApi<QuestionListView>("/api/questions?state=open");
  useLiveEvents((e) => {
    if (e.type === "file.changed") {
      onboarding.reload();
      changes.reload();
      questions.reload();
    }
  });
  return <DashboardPage onboarding={onboarding} changes={changes} questions={questions} />;
}
