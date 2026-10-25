import type { Api } from "@maycombhq/core";
import { useApi, useLiveEvents, type Loaded } from "../../api/client.js";
import { Panel, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { Table } from "../know/common.js";
import type { QuestionListView } from "../Questions.js";
import { onboardingProgress, onboardingStep, type OnboardingData } from "./next.js";
import { Command, Problems, RunNext } from "./RunNext.js";

/**
 * Onboarding (plan 4.5): the organisation's repos from the manifest, the knowledge sources,
 * and the commands to run in order. A person picks repos by editing the manifest file; the
 * page shows the file and the commands, and never runs them.
 */

const W = COPY.work;

function Chip({ done }: { done: boolean }) {
  return <span className={`chip ${done ? "done" : "dim"}`}>{done ? W.done : W.todo}</span>;
}

export function OnboardingSteps({
  v,
  openQuestions,
}: {
  v: OnboardingData;
  openQuestions: number;
}) {
  const p = onboardingProgress(v);
  const first = v.repos[0]?.id ?? "<repo>";
  // ADR 0124: a repo is read by the assistant; the first the catalog holds nothing of yet.
  const unread = v.repos.find((r) => r.lastScan === null)?.id ?? first;
  const scanned = p.listed > 0 && p.scanned === p.listed;
  return (
    <ol className="work-steps">
      <li>
        <p>
          <Chip done={p.listed > 0} /> {v.manifests.length ? W.stepPick : W.stepPickNone}
        </p>
        {v.manifests.map((m) => (
          <p key={m.path}>
            <code className="mono">{m.path}</code>
          </p>
        ))}
        <Command text="atticus repos discover <folder>" label={COPY.runNext.copy} />
      </li>
      <li>
        <p>
          <Chip done={p.listed > 0 && p.cloned === p.listed} /> {W.stepSync}
        </p>
        <Command text="atticus workspace sync" label={COPY.runNext.copy} />
      </li>
      <li>
        <p>
          <Chip done={scanned} /> {W.stepRead}
        </p>
        <Command text={`atticus map ${unread}`} label={COPY.runNext.copy} />
        <p className="work-say">{COPY.runNext.slash}</p>
        <Command text={`/atticus-map ${unread}`} label={COPY.runNext.copySlash} />
      </li>
      <li>
        <p>
          <Chip done={scanned} /> {W.stepWrite}
        </p>
        <Command text={`atticus verify ${unread} --write`} label={COPY.runNext.copy} />
      </li>
      <li>
        <p>
          <Chip done={scanned && openQuestions === 0} /> {W.stepAnswer}{" "}
          <a href="#/questions">{W.stepAnswerLink}</a>
        </p>
      </li>
      <li>
        <p>
          {W.stepTrust} <a href="#/trust">{W.openTrust}</a>
        </p>
      </li>
    </ol>
  );
}

export function RepoTable({ v }: { v: OnboardingData }) {
  if (v.repos.length === 0) return <div className="state">{W.noRepos}</div>;
  return (
    <Table
      caption={W.repos}
      rows={v.repos}
      rowKey={(r) => r.id}
      cols={[
        { label: W.repoCol, cell: (r) => r.id, mono: true },
        { label: W.typeCol, cell: (r) => r.type, mono: true },
        {
          label: W.matchCol,
          cell: (r) => (
            <>
              <span className="muted" style={{ fontSize: 11.5 }}>
                {W.matchHint}
              </span>
              <Command text={`atticus repo-type detect ${r.id}`} label={COPY.runNext.copy} />
            </>
          ),
        },
        {
          label: W.cloneCol,
          cell: (r) => (
            <span className={`chip ${r.cloned ? "done" : "dim"}`}>
              {r.cloned ? W.cloned : W.notCloned}
            </span>
          ),
        },
        {
          label: W.settingsCol,
          cell: (r) =>
            r.scanSettings.present ? (
              <code className="mono">{r.scanSettings.path}</code>
            ) : (
              <span className="muted">{W.settingsMissing}</span>
            ),
        },
        {
          label: W.lastScanCol,
          cell: (r) =>
            r.lastScan ? (
              <span>
                {W.recordCount(r.lastScan.records)}
                {r.lastScan.commit ? ` ${W.atCommit(r.lastScan.commit)}` : ""}
                <br />
                <span className="muted" style={{ fontSize: 11.5 }}>
                  {Object.entries(r.lastScan.kinds)
                    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                    .map(([k, n]) => `${k} ${n}`)
                    .join(", ")}
                </span>
              </span>
            ) : (
              <span className="muted">{W.notScanned}</span>
            ),
        },
      ]}
    />
  );
}

export function SourcesView({ v }: { v: OnboardingData }) {
  const s = v.sources;
  if (!s.present) return <div className="state">{W.sourcesMissing(s.path)}</div>;
  return (
    <div className="stack">
      <p style={{ margin: 0 }}>
        {W.sourcesFile}: <code className="mono">{s.path}</code>
      </p>
      {s.wikis.length === 0 && s.absorbed.length === 0 && (
        <div className="state">{W.sourcesNone(s.path)}</div>
      )}
      {s.wikis.length > 0 && (
        <Table
          caption={W.sources}
          rows={s.wikis}
          rowKey={(w) => w.id}
          cols={[
            { label: W.wikiCol, cell: (w) => w.id, mono: true },
            { label: W.kindCol, cell: (w) => w.type },
            { label: W.whereCol, cell: (w) => w.location, mono: true },
            { label: W.spacesCol, cell: (w) => w.spaces.join(", ") },
            { label: W.ownerCol, cell: (w) => w.owner ?? "" },
          ]}
        />
      )}
      {s.absorbed.length > 0 && (
        <Table
          caption={W.absorbedTitle}
          rows={s.absorbed}
          rowKey={(a) => a.id}
          cols={[
            { label: W.absorbedTitle, cell: (a) => a.id, mono: true },
            { label: W.kindCol, cell: (a) => `${a.format} · ${a.mode}` },
            { label: W.whereCol, cell: (a) => a.url, mono: true },
          ]}
        />
      )}
      {s.wikis.length > 0 && (
        <>
          <p className="work-say">{W.syncSources}</p>
          <Command text="atticus sources sync" label={COPY.runNext.copy} />
        </>
      )}
    </div>
  );
}

/** The page from loaded data, so tests can render every state. */
export function OnboardingPage({
  of,
  questions,
  trust,
}: {
  of: Loaded<OnboardingData>;
  questions: Loaded<QuestionListView>;
  /** Map › Trust (GET /api/trust): each repo's step, the Atticus 2 way (ADR 0124). */
  trust?: Loaded<Api.TrustViewT>;
}) {
  const open = questions.state === "ready" ? questions.data.questions.length : 0;
  return (
    <>
      <p className="muted" style={{ margin: "0 0 12px", fontSize: 12.5, lineHeight: 1.55 }}>
        {W.onbIntro}
      </p>
      <RunNext
        of={of}
        step={(v) => onboardingStep(v, open, trust?.state === "ready" ? trust.data : undefined)}
      />
      <div className="bento">
        <Panel title={W.steps} span="span 5">
          <View of={of}>{(v) => <OnboardingSteps v={v} openQuestions={open} />}</View>
        </Panel>
        <Panel title={W.sources} span="span 7">
          <View of={of}>{(v) => <SourcesView v={v} />}</View>
        </Panel>
        <Panel title={W.repos} span="1 / -1">
          <View of={of}>
            {(v) => (
              <div className="stack">
                <Problems list={v.problems} />
                <RepoTable v={v} />
              </div>
            )}
          </View>
        </Panel>
      </div>
    </>
  );
}

export function Onboarding() {
  const of = useApi<OnboardingData>("/api/onboarding");
  const questions = useApi<QuestionListView>("/api/questions?state=open");
  const trust = useApi<Api.TrustViewT>("/api/trust");
  // Files change as commands run in a terminal: read them again.
  useLiveEvents((e) => {
    if (e.type === "file.changed") {
      of.reload();
      questions.reload();
      trust.reload();
    }
  });
  return <OnboardingPage of={of} questions={questions} trust={trust} />;
}
