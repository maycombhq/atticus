import { useState, type ReactNode } from "react";
import { api, useApi, useLiveEvents, type Loaded } from "../../api/client.js";
import { changeOf } from "../../app/screens.js";
import { Panel, View } from "../../app/ui.js";
import {
  ExportEvidence,
  NotesPanel,
  OutcomesPanel,
  PlanPanels,
  SecurityPanel,
} from "./ReleaseViews.js";
import { Note, plural, useAction } from "./shared.js";
import { COPY } from "../../copy.js";
import { isManualLink, ManualHandoff, MANUAL_STEPS_HREF } from "../know/task-pr.js";

const T = COPY.release;

/**
 * A repo's release PR: its number and state, linked on the Git host. Ninth UX walk: a manual Git
 * host's placeholder (manual://) isn't a PR yet: it showed "#103 DRAFT" before anyone opened it;
 * it waits on a person, a step on Home.
 */
export function ReleasePrCell({ pr }: { pr: NonNullable<RepoRow["pr"]> }) {
  if (pr.url && isManualLink(pr.url))
    return (
      <span>
        {T.prToOpen} <a href={MANUAL_STEPS_HREF}>{COPY.phase.manualSteps}</a>
      </span>
    );
  return pr.url && /^https?:/.test(pr.url) ? (
    <a href={pr.url} target="_blank" rel="noreferrer">
      {T.prState(pr.number, pr.state)}
    </a>
  ) : (
    <>{T.prState(pr.number, pr.state)}</>
  );
}

interface ReleaseItem {
  id: string;
  title: string;
  type: string;
  state: string;
  atRelease: boolean;
}
interface Reason {
  code: string;
  message: string;
}
interface Request {
  heading: string;
  requestType: string;
  record: string;
  leadTimeDays?: number;
  state: "to-file" | "waiting" | "filed";
  number?: string;
  missing: string[];
}
interface RepoRow {
  id: string;
  branch: string;
  pr?: { number: number; state: string; url?: string };
  build: { status: string; sha?: string };
}
interface ReleaseDetail {
  change: {
    id: string;
    title: string;
    type: string;
    state: string;
    owners: Record<string, string[]>;
  };
  status: {
    state: string;
    phase?: string;
    nextStep: string;
    risk: { level: string; score: number };
    blockers: Reason[];
    reasons: Reason[];
  };
  /** The release hand-off PR: merging it is the go (ADR 0073). */
  handoff?: { state: string; pr: string; approvals: { by: string }[] };
  openFindings: { blocking: number; gap: number; risk: number; idea: number };
  requests: { total: number; filed: number; toFile: number; list: Request[] };
  repos: RepoRow[];
  rollout?: { heading: string; text: string };
  conflicts: { with: string; overlap: Record<string, string[]> }[];
  archive: { pass: boolean; blockers: Reason[]; notes: string[] };
  evidence: { path: string; bytes: number }[];
}

/** ADR 0184: the states the release PRs may be raised in (packages/changes RELEASE_PR_STATES). */
const RELEASE_PR_STATES = ["qa", "release-ready", "released", "post-release-review"];
const LIVE_PR = new Set(["open", "draft", "merged"]);

const STATE_LABEL: Record<string, string> = {
  "release-ready": T.atGoNoGo,
  released: T.releasedChipWord,
  "post-release-review": T.postReleaseReview,
};

function List({ list, current }: { list: Loaded<ReleaseItem[]>; current?: string }) {
  return (
    <Panel title={T.changes} span="span 3" rows="span 3">
      <View of={list} empty={(l) => l.length === 0} emptyText={T.noChangesInFlight}>
        {(l) => (
          <nav aria-label={T.changes} className="stack" style={{ gap: 2 }}>
            {l.map((c) => (
              <a
                key={c.id}
                href={`#/release/${c.id}`}
                aria-current={c.id === current ? "page" : undefined}
                className="list-row"
                style={{
                  textDecoration: "none",
                  padding: "8px 6px",
                  borderRadius: 6,
                  background: c.id === current ? "var(--picked)" : undefined,
                }}
              >
                <span className="stack" style={{ gap: 2, minWidth: 0 }}>
                  <span className="mono" style={{ fontSize: 12 }}>
                    {c.id}
                  </span>
                  <span className="muted" style={{ fontSize: 11.5 }}>
                    {c.title}
                  </span>
                </span>
                <span className={`chip ${c.atRelease ? "warn" : "dim"}`}>
                  {STATE_LABEL[c.state] ?? c.state.toUpperCase()}
                </span>
              </a>
            ))}
          </nav>
        )}
      </View>
    </Panel>
  );
}

function Gate(p: { label: string; value: string; ok: boolean; warn?: boolean; detail: ReactNode }) {
  return (
    <li aria-label={`${p.label}: ${p.value}`}>
      <span className="hud" style={{ fontSize: 10 }}>
        {p.label}
      </span>
      <span
        className={`chip ${p.ok ? "done" : p.warn ? "warn" : "blocking"}`}
        style={{ alignSelf: "flex-start" }}
      >
        {p.value}
      </span>
      <span className="muted" style={{ fontSize: 11.5 }}>
        {p.detail}
      </span>
    </li>
  );
}

/**
 * The go / no-go gate: its PR's state and what merging it means. Seventh UX walk: on a manual
 * Git host the PR isn't open until a person opens it, so it waits on them, said as the change
 * page says it; never "OPEN" with its manual:// link.
 */
export function goNoGoGate(r: {
  change: Pick<ReleaseDetail["change"], "state">;
  handoff?: ReleaseDetail["handoff"];
}): { value: string; ok: boolean; warn: boolean; detail: ReactNode } {
  const h = r.handoff;
  const approvers = h?.approvals.map((a) => a.by) ?? [];
  if (h && h.state === "open" && isManualLink(h.pr))
    return {
      value: T.waitsOnYouChip,
      ok: false,
      warn: true,
      detail: <ManualHandoff phase="release" />,
    };
  return {
    value: h
      ? h.state === "merged"
        ? T.mergedChip
        : approvers.length
          ? T.approvedNotMerged
          : h.state.toUpperCase()
      : r.change.state === "release-ready"
        ? T.notRaised
        : T.laterChip,
    ok: h?.state === "merged",
    warn: !h,
    detail: h
      ? T.mergingIsTheGo(h.pr, approvers.length ? T.approvedBy(approvers.join(", ")) : "")
      : T.goNoGoIs,
  };
}

export function Detail({ id }: { id: string }) {
  const d = useApi<ReleaseDetail>(`/api/release/${id}`);
  const act = useAction();
  // the generated views reload with the screen when a file changes
  const [tick, setTick] = useState(0);
  useLiveEvents((e) => {
    if (e.type !== "file.changed") return;
    d.reload();
    setTick((t) => t + 1);
  });
  const post = (path: string, body: unknown, ok: string) =>
    void act.run(() => api(path, { method: "POST", body }).then(() => d.reload()), ok);

  return (
    <>
      <Panel
        title={d.state === "ready" ? `${d.data.change.id} · ${d.data.change.title}` : id}
        span="span 9"
        kind="hero"
      >
        <View of={d}>
          {(r) => {
            const blockingFindings = r.openFindings.blocking + r.openFindings.gap;
            return (
              <div className="stack" style={{ gap: 12 }}>
                <p style={{ margin: 0, fontSize: 14 }}>
                  <span className="hud" style={{ marginRight: 8 }}>
                    {T.next}
                  </span>
                  {r.status.nextStep}
                </p>
                <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                  <span className="chip dim">{T.type(r.change.type.toUpperCase())}</span>
                  <span
                    className={`chip ${r.status.risk.level === "high" ? "blocking" : r.status.risk.level === "medium" ? "warn" : ""}`}
                  >
                    {T.risk(r.status.risk.level.toUpperCase())}
                  </span>
                  <span className="chip">
                    {(STATE_LABEL[r.change.state] ?? r.change.state).toUpperCase()}
                  </span>
                </div>
                <ul className="run-gates" aria-label={T.gatesToGoLive}>
                  <Gate
                    label={T.requests}
                    value={
                      r.requests.total === 0
                        ? T.noneNeeded
                        : r.requests.toFile
                          ? T.notFiledChip(r.requests.toFile)
                          : T.filedChip(r.requests.filed)
                    }
                    ok={r.requests.toFile === 0}
                    detail={
                      r.requests.total === 0
                        ? T.snowMdListsNo
                        : T.ofFiled(r.requests.filed, r.requests.total)
                    }
                  />
                  <Gate
                    label={T.findings}
                    value={blockingFindings ? T.openFindingsChip(blockingFindings) : T.clearChip}
                    ok={blockingFindings === 0}
                    detail={T.blocking(
                      r.openFindings.blocking,
                      plural(r.openFindings.gap, T.knowledgeGap),
                    )}
                  />
                  <Gate label={T.goNoGoPr} {...goNoGoGate(r)} />
                  <Gate
                    label={T.archiveGate}
                    value={r.archive.pass ? T.openChip : T.blockersChip(r.archive.blockers.length)}
                    ok={r.archive.pass}
                    warn={!r.archive.pass && r.change.state !== "released"}
                    detail={T.opensOnceReleasedMerged}
                  />
                </ul>
                <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                  {T.aPersonApprovesEvery}
                </p>
                <div className="row" style={{ flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="btn"
                    disabled={
                      act.busy ||
                      !RELEASE_PR_STATES.includes(r.change.state) ||
                      !r.repos.some((x) => !x.pr || !LIVE_PR.has(x.pr.state))
                    }
                    title={
                      RELEASE_PR_STATES.includes(r.change.state)
                        ? T.raisesReleasePrs
                        : T.releasePrsNotYet
                    }
                    onClick={() => post(`/api/changes/${id}/release-prs`, {}, T.releasePrsRaised)}
                  >
                    {T.raiseReleasePrs}
                  </button>
                  <button
                    type="button"
                    className="btn primary"
                    disabled={
                      act.busy ||
                      r.change.state !== "release-ready" ||
                      (!!r.handoff && r.handoff.state === "open")
                    }
                    title={r.change.state !== "release-ready" ? T.theChangeReachesGo : undefined}
                    onClick={() =>
                      void act.run(
                        () =>
                          api<{ handoff?: { pr?: string } }>(`/api/changes/${id}/handoff`, {
                            method: "POST",
                            body: {},
                          }).then((x) => {
                            d.reload();
                            return x;
                          }),
                        // Seventh UX walk: a manual Git host's PR is a step for the person.
                        (x) =>
                          isManualLink((x as { handoff?: { pr?: string } }).handoff?.pr)
                            ? T.goNoGoManual
                            : T.goNoGoPr2,
                      )
                    }
                  >
                    {T.askForGoNo}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={act.busy || (!r.handoff && !r.repos.some((x) => x.pr))}
                    title={T.readsThePrMerges}
                    onClick={() => post(`/api/changes/${id}/sync`, {}, T.syncedWithTheGit)}
                  >
                    {T.syncAndMergeWhen}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={
                      act.busy || !["released", "post-release-review"].includes(r.change.state)
                    }
                    title={T.archivesTheChangeAnd}
                    onClick={() => post(`/api/release/${id}/archive`, {}, T.archivedItsReposWere)}
                  >
                    {T.archive}
                  </button>
                </div>
                <Note note={act.note} />
              </div>
            );
          }}
        </View>
      </Panel>

      <Panel title={T.releasePrs} span="span 6">
        <View of={d} empty={(r) => r.repos.length === 0} emptyText={T.noCodeRepos}>
          {(r) => (
            <div className="stack">
              <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                {T.releasePrsIntro}
              </p>
              <table className="run-table">
                <caption className="sr">{T.releasePrsCaption}</caption>
                <thead>
                  <tr>
                    <th scope="col">{T.releasePrCol.repo}</th>
                    <th scope="col">{T.releasePrCol.branch}</th>
                    <th scope="col">{T.releasePrCol.pr}</th>
                    <th scope="col">{T.releasePrCol.build}</th>
                  </tr>
                </thead>
                <tbody>
                  {r.repos.map((x) => (
                    <tr key={x.id}>
                      <td className="mono">{x.id}</td>
                      <td className="mono">{x.branch}</td>
                      <td>
                        {x.pr ? (
                          <ReleasePrCell pr={x.pr} />
                        ) : (
                          <span className="muted">{T.notRaisedYet}</span>
                        )}
                      </td>
                      <td>{x.build.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </View>
      </Panel>

      <PlanPanels id={id} tick={tick} />

      <Panel title={T.whatStopsIt} span="span 6">
        <View
          of={d}
          empty={(r) => r.status.blockers.length + r.status.reasons.length === 0}
          emptyText={T.nothingStopsThisChange}
        >
          {(r) => (
            <ul className="run-steps">
              {[...r.status.blockers, ...r.status.reasons]
                .filter((x, i, a) => a.findIndex((y) => y.message === x.message) === i)
                .map((x) => (
                  <li key={x.message}>{x.message}</li>
                ))}
            </ul>
          )}
        </View>
      </Panel>

      <Panel title={T.archiveGate} span="span 6">
        <View of={d}>
          {(r) =>
            r.archive.pass ? (
              <p className="run-note ok">{T.theChangeMayBe}</p>
            ) : (
              <div className="stack">
                <ul className="run-steps">
                  {r.archive.blockers.map((b) => (
                    <li key={b.message}>{b.message}</li>
                  ))}
                </ul>
                {r.archive.notes.map((n) => (
                  <p key={n} className="muted" style={{ margin: 0, fontSize: 12 }}>
                    {n}
                  </p>
                ))}
              </div>
            )
          }
        </View>
      </Panel>

      <Panel title={T.conflictsWithOtherChanges} span="span 6">
        <View of={d} empty={(r) => r.conflicts.length === 0} emptyText={T.noOtherOpenChange}>
          {(r) =>
            r.conflicts.map((c) => (
              <div key={c.with} className="list-row" style={{ alignItems: "flex-start" }}>
                <span className="stack" style={{ gap: 2 }}>
                  <a href={`#/release/${c.with}`} className="mono">
                    {c.with}
                  </a>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {T.alsoTouchesAgreeAn(
                      Object.entries(c.overlap)
                        .filter(([, v]) => v.length)
                        .map(([k, v]) => `${k} ${v.join(", ")}`)
                        .join("; "),
                    )}
                  </span>
                </span>
                <span className="chip warn">{T.overlap}</span>
              </div>
            ))
          }
        </View>
      </Panel>

      <Panel
        title={T.evidencePack}
        meta={d.state === "ready" ? plural(d.data.evidence.length, T.fileWord) : undefined}
        span="span 6"
      >
        <View of={d} empty={(r) => r.evidence.length === 0} emptyText={T.theChangeFolderIs}>
          {(r) => (
            <div className="stack">
              <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                {T.forTheApprovalBoard}
              </p>
              <ExportEvidence id={id} />
              <ul
                tabIndex={0}
                aria-label={T.evidenceFiles}
                style={{
                  listStyle: "none",
                  margin: 0,
                  padding: 0,
                  maxHeight: 220,
                  overflow: "auto",
                }}
              >
                {r.evidence.map((f) => (
                  <li key={f.path} className="list-row" style={{ padding: "4px 0" }}>
                    <span className="mono" style={{ fontSize: 11.5 }}>
                      {f.path}
                    </span>
                    <span className="hud" style={{ fontSize: 9.5 }}>
                      {f.bytes < 1024 ? T.bytes(f.bytes) : T.kb(Math.round(f.bytes / 1024))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </View>
      </Panel>

      <SecurityPanel id={id} tick={tick} />
      <NotesPanel id={id} tick={tick} />
      <OutcomesPanel id={id} tick={tick} />
    </>
  );
}

export function Release({ hash }: { hash: string }) {
  // #/release/<id>, or #/release?change=<id> from a change's tabs.
  const id = hash.replace(/^#\/?release\/?/, "").split("?")[0] || changeOf(hash) || undefined;
  const list = useApi<ReleaseItem[]>("/api/release");
  const current = id ?? (list.state === "ready" ? list.data[0]?.id : undefined);
  return (
    <div className="bento">
      <List list={list} current={current} />
      {current ? (
        <Detail key={current} id={current} />
      ) : (
        <Panel title={T.noChangeSelected} span="span 9">
          <p className="muted" style={{ margin: 0 }}>
            {T.pickAChangeOn}
          </p>
        </Panel>
      )}
    </div>
  );
}
