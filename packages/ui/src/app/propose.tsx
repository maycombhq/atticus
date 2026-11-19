import { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import type { Api } from "@maycombhq/core";
import {
  api,
  ApiError,
  onWrote,
  useApi,
  useFileChanges,
  type Loaded,
  type LiveEvent,
} from "../api/client.js";
import { confirmed } from "../api/confirm.js";
import { COPY } from "../copy.js";
import { flash } from "./flash.js";
import { MANIFEST_REPOS_PATH } from "./repo-counts.js";
import { focusIfLost } from "./ui.js";
import { message, Note, useAction } from "../screens/know/common.js";
import { ShowInConsole } from "./activity.js";
import { followJob, JobFailed, nextAfter, undoAfter, type NextStep } from "./job.js";
import { JobFound, JobProgress, useJobRun, type JobHears } from "./job-progress.js";
import { SyncFirst } from "./sync-first.js";
import { CATALOG_BUILDS_HREF, ErrorWaysOn, InstallCopy } from "./ways-on.js";
import { curateListedEdits, RefusalView } from "../screens/setup/CatalogBuild.js";

const P = COPY.propose;

/**
 * A failed Apply whose build refused for what a person confirms (ADR 0195 point 4: a large
 * removal, a hand edit), as its job's result lists it; undefined for any other failure.
 */
export function buildRefusalOf(e: unknown): Api.BuildRefusalViewT | undefined {
  if (!(e instanceof JobFailed)) return undefined;
  const r = e.result?.refused as Api.BuildRefusalViewT | undefined;
  if (!r || !Array.isArray(r.reasons)) return undefined;
  return r.reasons.some((x) => x === "large-removals" || x === "hand-edits") ? r : undefined;
}

/**
 * Beta.28 (the owner's feedback of 2026-11-12, 22:29: the canvas's side panel is too cramped for
 * results): inside a narrow panel (the canvas's details), a step's result is one status line and
 * one primary button. Its whole output is the job's Console entry (the bottom panel), and a
 * refused build's removals and confirm are on Set up › Scans › Catalog builds, full width.
 */
export const ResultsInPanel = createContext(false);
export const useResultsInPanel = () => useContext(ResultsInPanel);

/** What a step printed: in full, or (in a narrow panel) folded under one line. */
export function stepLines(lines: readonly string[], folded: boolean) {
  const pre = (
    <pre className="mono" style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: 11.5 }}>
      {lines.join("\n")}
    </pre>
  );
  return folded ? (
    <details className="work-terminal">
      <summary>{COPY.panelResults.printed(lines.length)}</summary>
      {pre}
    </details>
  ) : (
    pre
  );
}

/** Where a refused build is reviewed and confirmed, full width (ways-on.tsx has it). */
export { CATALOG_BUILDS_HREF };

/**
 * Edit the map's refused build in a narrow panel: one line, and the page that lists and confirms
 * it (the changes are saved, so the build waits there). Not for a refused verify, which writes
 * nothing: that one is confirmed in place (ApplyRefused).
 */
export function RefusalLink({ refused }: { refused: Api.BuildRefusalViewT }) {
  const R = COPY.panelResults;
  // Beta.28.3: a catalog a newer Atticus built waits for nothing here: no page reviews or
  // confirms it, and the way on is to upgrade Atticus.
  if (refused.reasons.includes("newer-atticus"))
    return (
      <div className="stack" style={{ gap: 6 }}>
        <p className="ev-say" role="status" style={{ margin: 0 }}>
          {R.newerAtticus}
        </p>
        <InstallCopy />
      </div>
    );
  // Only a large removal waits for a confirm (an empty catalog over a full one has none).
  const n = refused.reasons.includes("large-removals")
    ? (refused.removals?.length ?? refused.allowRemovals ?? 0)
    : 0;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <p className="ev-say" role="status" style={{ margin: 0 }}>
        {n ? R.waitsRemovals(n) : R.waitsBuild}
      </p>
      <a className="btn primary" href={CATALOG_BUILDS_HREF}>
        {n ? R.reviewRemovals(n) : R.reviewBuild}
      </a>
    </div>
  );
}

/**
 * What a refused Apply says as it ends (its flash and its error). Beta.28.3: over a catalog a
 * newer Atticus built nothing waits for a confirm; it says to upgrade Atticus.
 */
export const applyWaitsWords = (repo: string, refused: Api.BuildRefusalViewT): string =>
  refused.reasons.includes("newer-atticus") ? P.applyNewer(repo) : P.applyWaits(repo);

/**
 * Beta.30: a build that refused for what no confirm goes on from (a newer Atticus's catalog, one
 * from before beta.27, unexplained removals, no record read), as an Apply's job lists it: shown
 * with its one way on, where before only the job's lines said it.
 */
export function otherRefusalOf(e: unknown): Api.BuildRefusalViewT | undefined {
  if (!(e instanceof JobFailed) || buildRefusalOf(e)) return undefined;
  const r = e.result?.refused as Api.BuildRefusalViewT | undefined;
  return r && Array.isArray(r.reasons) && r.reasons.length ? r : undefined;
}

/** Map › Trust with one repo's section shown (its rejected facts, Read it again). */
export const trustHref = (repo: string) => `#/trust?repo=${encodeURIComponent(repo)}`;
/** ADR 0202 point 4: Map › Trust opened at one repo's rejected facts, every one. */
export const rejectedHref = (repo: string) => `${trustHref(repo)}&rejected=1`;

/** Beta.30: an Apply that left rejected facts out links straight to them. */
export function LeftOutWay({ repo, n }: { repo: string; n: number }) {
  if (!n) return null;
  return (
    <div>
      <a className="btn primary" href={rejectedHref(repo)}>
        {COPY.waysOn.rejectedOnTrust(n)}
      </a>
    </div>
  );
}

/** The plan a refusal's confirm sends back with its count (the list it showed), when it has one. */
const planOf = (r: Api.BuildRefusalViewT) => (r.plan ? { plan: r.plan } : {});

/** Eighth UX walk: the app's work changed files that wait to be proposed; Home reads them again. */
const WORK_CHANGED = "atticus:work-changed";
const work = new EventTarget();
export const workChanged = () => void work.dispatchEvent(new Event(WORK_CHANGED));
/** Heard when what waits to be applied or proposed may have changed (an Apply ended, say). */
export const onWorkChanged = (f: () => void): (() => void) => {
  work.addEventListener(WORK_CHANGED, f);
  return () => work.removeEventListener(WORK_CHANGED, f);
};

// Review of beta.23: followJob lives in job.ts (SyncFirst follows the sync with it too).
export { followJob };
type Scope =
  | "answers"
  | "corrections"
  | "audit"
  | "org-pack"
  | "owner-answers"
  | "baseline"
  | "initiatives"
  | "outcomes"
  | "work"
  | "service-desk"
  | "upgrade";
export interface Plan {
  scope: Scope;
  files: { path: string; status: string; from?: string; proposed?: string }[];
  branch: string;
  title: string;
  /** API 2.69.0: the repos whose corrections are newer than their last Apply. */
  applyFirst?: string[];
}

/** Beta.28.1: how many rejected facts an Apply's job left out (verify's exit 3), or 0. */
function leftOutOf(result: Record<string, unknown> | undefined): number {
  const n = result?.leftOut;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : 0;
}

/** What Apply says once it wrote: how many facts it left out, when it left any. */
const appliedNote = (repo: string) => (leftOut: number | "stopped") =>
  leftOut === "stopped"
    ? P.applyStopped(repo)
    : leftOut
      ? P.appliedLeftOut(repo, leftOut)
      : P.applied(repo);

/**
 * ADR 0183: the steps after an answer, a correction or an audit, run from the app. Apply runs
 * `atticus verify <repo> --write`; Propose for review shows the files, the branch and the title,
 * and on the person's yes pushes exactly those and opens the PR. A person merges.
 */
export function ApplyAndPropose(p: {
  scope: Scope;
  repo?: string | undefined;
  /** Apply only (Home's pending list offers one Propose for everything). */
  noPropose?: boolean;
  /**
   * Beta.28.4: held while another Apply of the same list runs (the map's bar: one local step at
   * a time; the server's 409 is still the rule, and said, for a step started elsewhere).
   */
  disabled?: boolean;
  /** Beta.28.4: told as its Apply starts and as it ends, whatever page still shows it. */
  onStart?: () => void;
  onEnd?: () => void;
}) {
  const apply = useAction();
  const [applied, setApplied] = useState<string[]>();
  // Review of beta.23: no clone of the repo here: Sync the repos, not a command to type.
  const [next, setNext] = useState<NextStep | undefined>();
  // Every run the app starts shows in the Console: this one's entry, linked while it runs.
  const [jobId, setJobId] = useState<string | undefined>();
  // Beta.30: the job's step, its time so far and Stop, in this panel; its Done line stays.
  const job = useJobRun();
  // ADR 0195 point 4: the build Apply ran refused (a large removal, a hand edit): its listing,
  // confirmed here with its counts, as a scan's is on Scans.
  const [refused, setRefused] = useState<Api.BuildRefusalViewT | undefined>();
  // Beta.30: how many rejected facts the last Apply left out, for the link to them.
  const [leftOut, setLeftOut] = useState(0);
  // ADR 0202 point 3: the build an Undo would take back, as the failed Apply said it.
  const [undo, setUndo] = useState<ReturnType<typeof undoAfter>>({ known: false });
  const inPanel = useResultsInPanel();
  /**
   * Apply (`verify <repo> --write`), with the counts a confirm step gives; throws when it failed.
   * Beta.28.1: answers how many rejected facts it left out (it wrote the rest).
   */
  const applyWith = async (counts: {
    allowRemovals?: number;
    discardEdits?: number;
    /** The review of beta.27: the plan of the list the refusal showed, sent with its count. */
    plan?: string;
  }): Promise<number | "stopped"> => {
    setNext(undefined);
    setLeftOut(0);
    setUndo({ known: false });
    p.onStart?.();
    try {
      const r = await job.follow(`/api/facts/${encodeURIComponent(p.repo!)}/apply`, counts, {
        onJob: setJobId,
      });
      setRefused(undefined);
      setApplied(r.lines);
      const leftOut = leftOutOf(r.result);
      setLeftOut(leftOut);
      // A correction's Apply can take its panel away (the fact it was on goes):
      // what happened, and where to propose it, stays on the page.
      if (p.scope === "corrections")
        flash({
          text: leftOut ? P.appliedFlashLeftOut(p.repo!, leftOut) : P.appliedFlash(p.repo!),
          href: "#/home",
          link: P.toHome,
        });
      return leftOut;
    } catch (e) {
      // Round 41: a refusal to start (409: another local step runs) is the server's
      // own words, not verify's problems; nothing ran.
      if (e instanceof ApiError && e.problem.status === 409) {
        const said = P.notStarted(e.problem.detail ?? e.problem.title);
        if (p.scope === "corrections") flash({ text: said.slice(0, 400) });
        throw new Error(said, { cause: e });
      }
      // Beta.30: a person's Stop is no problem verify found: it ended before the catalog's write.
      if (e instanceof JobFailed && e.stopped) {
        setRefused(undefined);
        setApplied(undefined);
        if (p.scope === "corrections") flash({ text: P.applyStopped(p.repo!) });
        // What the person asked for: said as a status, not as an alert.
        return "stopped";
      }
      const waits = buildRefusalOf(e);
      setRefused(waits ?? otherRefusalOf(e));
      setApplied([(e as Error).message]);
      setNext(nextAfter(e));
      setUndo(undoAfter(e));
      // Fifth UX walk: a failed Apply can take its panel away too: say it stays.
      if (p.scope === "corrections")
        flash({
          text: (waits
            ? applyWaitsWords(p.repo!, waits)
            : `${P.applyFailed} ${(e as Error).message}`
          ).slice(0, 400),
        });
      throw new Error(waits ? applyWaitsWords(p.repo!, waits) : P.applyFailed, { cause: e });
    } finally {
      // What waits to be applied or proposed (Home's list, the map's bar) is read
      // again once the Apply has ended, not only when it started.
      p.onEnd?.();
      workChanged();
    }
  };
  return (
    <div className="stack" style={{ gap: 8 }}>
      {p.repo && (
        <div className="stack" style={{ gap: 4 }}>
          <div className="row" style={{ gap: 6 }}>
            <button
              type="button"
              className="btn primary"
              disabled={apply.busy || p.disabled === true}
              onClick={() => void apply.run(() => applyWith({}), appliedNote(p.repo!))}
            >
              {apply.busy ? P.applying : P.apply(p.repo)}
            </button>
            {(apply.busy || (inPanel && applied)) && <ShowInConsole id={jobId} />}
          </div>
          {/* Apply hears Stop until the catalog's write starts; after that it says it is too late. */}
          <JobProgress what={P.applyingTo(p.repo)} run={job.run} onStop={job.stop} />
          {/* ADR 0202 point 5: an Apply of this repo started before the page was loaded. */}
          <JobFound
            action="apply"
            repo={p.repo}
            what={P.applyingTo(p.repo)}
            skip={!!job.run}
            onEnd={workChanged}
          />
          <Note note={apply.note} />
          {applied && applied.length > 0 && stepLines(applied, inPanel)}
          <LeftOutWay repo={p.repo} n={leftOut} />
          {/* Beta.30: an Apply that failed (no refusal, no Sync to do first): the button above
              applies again; Undo and the support bundle's command are here. */}
          {job.run?.state === "failed" && !refused && !next && !apply.busy && (
            <ErrorWaysOn short undo={undo.undo} undoKnown={undo.known} onUndone={workChanged} />
          )}
          {next && <SyncFirst repos={next.repos} />}
          {refused &&
            applyRefused({
              refused,
              onAllowRemovals: (n) =>
                apply.run(
                  () => applyWith({ allowRemovals: n, ...planOf(refused) }),
                  appliedNote(p.repo!),
                ),
              onCurate: async (n, on) => {
                await curateListedEdits(refused, n, P.editsChanged, on);
                setRefused(undefined);
                setApplied([P.curatedApplyAgain(p.repo!)]);
                workChanged();
              },
              onDiscard: (n) =>
                apply.run(
                  () => applyWith({ discardEdits: n, ...planOf(refused) }),
                  appliedNote(p.repo!),
                ),
              onAgain: () => apply.run(() => applyWith({}), appliedNote(p.repo!)),
            })}
        </div>
      )}
      {!p.noPropose && <Propose scope={p.scope} />}
    </div>
  );
}

/**
 * A refused Apply (`verify <repo> --write`), confirmed where it was asked, in a narrow panel too:
 * a refused verify writes nothing, so Catalog builds has no build of it to confirm (the review of
 * beta.28). Make it curated is the supported way for a hand edit (ADR 0195 point 4), as on
 * Catalog builds; then Apply again builds with the edits kept.
 */
export function applyRefused(p: {
  refused: Api.BuildRefusalViewT;
  onAllowRemovals: (n: number) => Promise<void>;
  onCurate: (n: number, on?: JobHears) => Promise<void>;
  onDiscard: (n: number) => Promise<void>;
  /** Beta.30: Apply again, for a refusal nothing confirms. */
  onAgain?: () => Promise<void>;
}) {
  return (
    <RefusalView
      refused={p.refused}
      confirmLabel={P.confirmApply}
      {...(p.onAgain ? { onAgain: p.onAgain } : {})}
      onAllowRemovals={p.onAllowRemovals}
      onCurate={p.onCurate}
      onDiscard={p.onDiscard}
    />
  );
}

export function Propose({ scope, onDone }: { scope: Scope; onDone?: () => void }) {
  const [plan, setPlan] = useState<Plan>();
  const [off, setOff] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<string[]>();
  const look = useAction();
  const send = useAction();
  // Beta.30: the push's time so far in the panel. ADR 0202 point 2: its step, and Stop until
  // just before the push (the job says when a Stop can no longer take effect). A server that
  // doesn't say (older than 3.19.0) would push all the same: no Stop is offered against it.
  const job = useJobRun({ stopOnlyWhenSaid: true });
  const id = useId();
  // Eighth UX walk: Push and open the PR goes once it is done; its lines take the keyboard.
  const pushed = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (done) focusIfLost(pushed.current);
  }, [done]);
  if (done)
    return (
      <div className="stack" style={{ gap: 4 }}>
        <div ref={pushed} tabIndex={-1} role="status" className="stack" style={{ gap: 4 }}>
          {done.map((l) => (
            <p key={l} style={{ margin: 0 }}>
              {l}
            </p>
          ))}
        </div>
      </div>
    );
  if (!plan)
    return (
      <div className="stack" style={{ gap: 4 }}>
        <button
          type="button"
          className="btn"
          disabled={look.busy}
          onClick={() =>
            void look.run(async () => {
              const got = await api<Plan>(`/api/propose?scope=${scope}`);
              // Round 37: a file already in an open proposal starts unticked, and says where.
              setOff(new Set(got.files.filter((f) => f.proposed).map((f) => f.path)));
              setPlan(got);
            }, P.listed)
          }
        >
          {P.propose}
        </button>
        <Note note={look.note} />
      </div>
    );
  const files = plan.files.filter((f) => !off.has(f.path));
  return (
    <section className="stack" style={{ gap: 6 }} aria-labelledby={`${id}-t`}>
      <h5 id={`${id}-t`} className="hud">
        {P.title}
      </h5>
      {plan.files.length === 0 ? (
        <p className="work-say">{P.nothing}</p>
      ) : (
        <>
          <p className="work-say">{P.willCommit(plan.branch, plan.title)}</p>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {plan.files.map((f) => (
              <li key={f.path}>
                <label className="row" style={{ gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={!off.has(f.path)}
                    onChange={(e) => {
                      const n = new Set(off);
                      if (e.target.checked) n.delete(f.path);
                      else n.add(f.path);
                      setOff(n);
                    }}
                  />
                  <code className="mono">{f.path}</code>
                  <span className="muted">{P.status[f.status] ?? f.status}</span>
                  {f.proposed && <span className="muted">{P.inReview(f.proposed)}</span>}
                </label>
              </li>
            ))}
          </ul>
          <div className="row" style={{ gap: 6 }}>
            <button
              type="button"
              className="btn primary"
              disabled={send.busy || files.length === 0}
              onClick={() =>
                void send.run(
                  async () => {
                    // ADR 0186: this Yes is the person's confirmation to push and open the PR.
                    try {
                      const r = await job.follow("/api/propose", {
                        scope,
                        files: files.map((f) => f.path),
                        branch: plan.branch,
                        ...(await confirmed("propose", scope)),
                      });
                      setDone(r.lines);
                      onDone?.();
                      return undefined;
                    } catch (e) {
                      // A person's Stop before the push: what the job says it left, as a status.
                      // The list stays, so the same Yes proposes again from the same branch.
                      if (e instanceof JobFailed && e.stopped) return e.message;
                      throw e;
                    }
                  },
                  (stopped) => stopped ?? P.proposed,
                )
              }
            >
              {send.busy ? P.proposing : P.yes(files.length)}
            </button>
            <button type="button" className="btn" onClick={() => setPlan(undefined)}>
              {P.cancel}
            </button>
          </div>
          <JobProgress what={P.proposingSay} run={job.run} onStop={job.stop} />
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            {P.whoMerges}
          </p>
        </>
      )}
      <Note note={send.note} />
    </section>
  );
}

/** Review round 35: after a proposal or hand-off merges, the person's copy catches up. */
/**
 * App-only audit: the remote branch Bring in found this branch could follow (its words say
 * "follows no remote branch, and <remote>/<branch> is there"), or undefined.
 */
export const upstreamOffered = (text: string | undefined): string | undefined =>
  text ? /follows no remote branch, and (\S+) is there/.exec(text)?.[1] : undefined;

export function BringIn() {
  const act = useAction();
  const up = useAction();
  // App-only audit: the job runs for a while (a fetch); its Console entry shows it as it goes.
  const [jobId, setJobId] = useState<string | undefined>();
  // ADR 0202 point 2: its step, and Stop until the working tree is about to be changed; none
  // against a server that doesn't say it is stoppable (it would bring in all the same).
  const job = useJobRun({ stopOnlyWhenSaid: true });
  const offer = act.note && !act.note.ok ? upstreamOffered(act.note.text) : undefined;
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="row" style={{ gap: 6, alignItems: "center" }}>
        <button
          type="button"
          className="btn"
          disabled={act.busy}
          onClick={() =>
            void act.run(
              () =>
                job.follow("/api/propose/bring-in", {}, { onJob: setJobId }).then(
                  (r) => r.lines.join(" "),
                  (e: unknown) => {
                    // A person's Stop before anything was brought in: said as a status.
                    if (e instanceof JobFailed && e.stopped) return e.message;
                    throw e;
                  },
                ),
              (said) => said,
            )
          }
        >
          {act.busy ? P.bringingIn : P.bringIn}
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          {P.bringInWhy}
        </span>
      </div>
      {act.busy &&
        (job.run?.state === "running" ? (
          <>
            {/* ADR 0202 point 2: its step, the time so far, and Stop while it can take effect. */}
            <JobProgress what={P.bringingInSay} run={job.run} onStop={job.stop} />
            <ShowInConsole id={jobId} />
          </>
        ) : (
          <span
            role="status"
            className="row"
            style={{ gap: 6, alignItems: "center", fontSize: 12 }}
          >
            {P.bringingInSay} <ShowInConsole id={jobId} />
          </span>
        ))}
      <Note note={act.note} />
      {offer && (
        <div className="stack" style={{ gap: 4 }}>
          <span className="row" style={{ gap: 6, alignItems: "center" }}>
            <button
              type="button"
              className="btn"
              disabled={up.busy}
              onClick={() =>
                void up.run(
                  () => followJob("/api/propose/upstream", { upstream: offer }),
                  (r) => r.lines.join(" "),
                )
              }
            >
              {P.setUpstream(offer)}
            </button>
            <span className="muted" style={{ fontSize: 12 }}>
              {P.setUpstreamWhy}
            </span>
          </span>
          <Note note={up.note} />
        </div>
      )}
    </div>
  );
}

/**
 * Apply to every repo's map as it stands (review of beta.24, round 3): running, and once it
 * ended its lines, the Sync it asks for and what it said. A page that must keep it across its own
 * reloads (the map's bar, which reads again while the job writes) holds it and passes it in.
 */
export interface ApplyAllRun {
  running: boolean;
  jobId?: string;
  lines?: string[];
  /** Review of beta.23: a repo with no clone here: Sync the repos, not a command to type. */
  next?: NextStep;
  /** What it said: that it is working, that it applied every repo, or why it failed. */
  note?: { ok: boolean; text: string; working?: boolean };
}
export const APPLY_ALL_IDLE: ApplyAllRun = { running: false };

/** The repos a job's result names under `key` (API 3.16.0), or none. */
const reposOf = (result: Record<string, unknown> | undefined, key: string): string[] => {
  const x = result?.[key];
  return Array.isArray(x) ? x.filter((r): r is string => typeof r === "string") : [];
};

/**
 * The Apply for several repos as a job, each step said to `set`: true when it applied every repo
 * it was asked to. With `repos` (beta.28.4, the repos whose corrections wait) it applies those
 * and no other; without, every repo read so far (`atticus verify --all --write`). Pages that show
 * what waits are told it ended (`workChanged`), whatever it did.
 */
export async function runApplyAll(
  set: (s: ApplyAllRun | ((was: ApplyAllRun) => ApplyAllRun)) => void,
  repos?: readonly string[],
): Promise<boolean> {
  set({ running: true, note: { ok: true, text: COPY.app.working, working: true } });
  try {
    const r = await followJob(
      "/api/facts/apply-all",
      repos ? { repos: [...repos] } : {},
      undefined,
      (jobId) => set((was) => ({ ...was, jobId })),
      // Beta.28.4: how many repos are done, from the job's own count, while it runs.
      (p) => {
        if (p.total > 1)
          set((was) =>
            was.running
              ? {
                  ...was,
                  note: {
                    ok: true,
                    working: true,
                    text: p.stopping
                      ? COPY.appStep.stoppingRun(p.done, p.total)
                      : COPY.appStep.applyingRepo(p.done, p.total),
                  },
                }
              : was,
          );
      },
    );
    // The hunt of beta.28.1 (S2): repos that wrote with rejected facts left out are applied.
    const leftOut = leftOutOf(r.result);
    const left = r.result?.leftOutRepos;
    set({
      running: false,
      lines: r.lines,
      note: {
        ok: true,
        text:
          leftOut && typeof left === "number" && left > 0
            ? COPY.appStep.appliedAllLeftOut(leftOut, left)
            : repos
              ? COPY.appStep.appliedWaiting(repos.length)
              : COPY.appStep.appliedAll,
      },
    });
    return true;
  } catch (e) {
    const next = nextAfter(e);
    // Beta.28.4: applied some and not others: how many, and which it didn't, by name.
    const result = e instanceof JobFailed ? e.result : undefined;
    const applied = reposOf(result, "applied");
    const notApplied = reposOf(result, "notApplied");
    const text =
      // Round 41: a refusal to start (409: another local step runs) is the server's own words.
      e instanceof ApiError && e.problem.status === 409
        ? P.notStarted(e.problem.detail ?? e.problem.title)
        : // Beta.28.4: Stop ended it between two repos: what was applied whole, and the rest.
          result?.stopped === true && notApplied.length
          ? COPY.appStep.stoppedAfter(
              applied.length,
              applied.length + notApplied.length,
              notApplied.join(", "),
            )
          : applied.length && notApplied.length
            ? COPY.appStep.appliedSome(
                applied.length,
                applied.length + notApplied.length,
                notApplied.join(", "),
              )
            : message(e);
    // The review: facts left out in the repos it did apply are said beside what it didn't.
    const leftOut = leftOutOf(result);
    const left = result?.leftOutRepos;
    const said =
      applied.length && leftOut && typeof left === "number" && left > 0
        ? `${text} ${COPY.appStep.leftOutToo(leftOut, left)}`
        : text;
    set({
      running: false,
      lines: [message(e)],
      ...(next ? { next } : {}),
      note: { ok: false, text: said },
    });
    return false;
  } finally {
    workChanged();
  }
}

/** Map › Trust's read, as far as the count of repos read needs it. */
interface ReposRead {
  repos?: readonly { facts?: { present?: boolean } }[];
}
/** How many repos have a facts file: the repos `atticus verify --all` runs. */
export const reposRead = (t: ReposRead): number =>
  Array.isArray(t.repos) ? t.repos.filter((r) => r?.facts?.present === true).length : 0;
/** More repos than this, and the Apply for every repo read says what running them all means. */
export const MANY_REPOS = 5;

/** `atticus verify --all --write`, then Propose for review. */
export function ApplyAll({
  noPropose,
  onDone,
  onFailed,
  run,
  onRun,
  repos,
  disabled,
}: {
  /**
   * Beta.28.4: the repos to apply (those whose corrections wait): the button says how many, and
   * only they are sent. Left out, it is every repo read so far, and says so.
   */
  repos?: readonly string[];
  /** Beta.28.4: held while one repo's own Apply runs beside it. */
  disabled?: boolean;
  noPropose?: boolean;
  onDone?: () => void;
  /** Review of beta.24: it applied only some, or none: its errors are on show. */
  onFailed?: () => void;
  /**
   * Review of beta.24, round 3: the run as the page holds it, and `onRun` starts it there, so a
   * reload of the page while the job writes, or after, loses neither its lines nor its Sync.
   */
  run?: ApplyAllRun;
  onRun?: () => void;
}) {
  const [own, setOwn] = useState<ApplyAllRun>(APPLY_ALL_IDLE);
  const held = run ?? own;
  const inPanel = useResultsInPanel();
  // Beta.28.4 (the review): with no list it runs every repo read so far: how many that is, from
  // Map › Trust's read (the status bar's), so the button says it before the click. Not known
  // (loading, the read failed, none read): the words it always had.
  const trust = useApi<ReposRead>(repos ? undefined : MANIFEST_REPOS_PATH);
  const read = !repos && trust.state === "ready" ? reposRead(trust.data) : 0;
  const start =
    onRun ??
    (() =>
      void runApplyAll(setOwn, repos).then((ok) => {
        if (ok) onDone?.();
        else onFailed?.();
      }));
  // One repo left of a list (the others applied, this one didn't): its own Apply is the way on,
  // so no button here; what the run said stays.
  const offered = held.running || !repos || repos.length > 1;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 6, alignItems: "center" }}>
        {offered && (
          <button
            type="button"
            className="btn primary"
            disabled={held.running || disabled === true}
            onClick={start}
          >
            {held.running
              ? COPY.appStep.applyingAll
              : repos
                ? COPY.appStep.applyWaiting(repos.length)
                : read
                  ? COPY.appStep.applyAllRead(read)
                  : COPY.appStep.applyAll}
          </button>
        )}
        {(held.running || (inPanel && held.lines)) && <ShowInConsole id={held.jobId} />}
      </div>
      {read > MANY_REPOS && (
        <p className="work-say" style={{ margin: 0 }}>
          {COPY.appStep.applyAllMany(read)}
        </p>
      )}
      <Note note={held.note} />
      {held.lines && held.lines.length > 0 && stepLines(held.lines, inPanel)}
      {held.next && <SyncFirst repos={held.next.repos} />}
      {!noPropose && <Propose scope="work" />}
    </div>
  );
}

/**
 * Review of beta.24, round 3: a file event the map's bar reads again for: a corrections file, an
 * answered question Apply reads, or a repo's verify.yaml (an Apply the CLI ran). Any other file
 * leaves it as it is.
 */
export const touchesApplyFirst = (e: LiveEvent): boolean =>
  e.type === "file.changed" &&
  typeof e.path === "string" &&
  (/(?:^|[\\/])facts[\\/][^\\/]+\.(?:corrections\.jsonl|verify\.yaml)$/.test(e.path) ||
    /(?:^|[\\/])questions[\\/]q-[^\\/]+\.yaml$/.test(e.path));

/**
 * How long after the app's own write its file events may be that write heard back: the bar's
 * events within it are read once, when it ends.
 */
export const OWN_WRITE_ECHO_MS = 2000;

/**
 * The map's own bar: the repos whose corrections are newer than their last Apply (the server's
 * applyFirst), each with its own Apply and, when several wait, one Apply for those repos (beta.28.4:
 * never every repo read so far; one runs at a time), read again after
 * every write the app makes, so a line drawn or removed on the map shows here at once. Review of
 * beta.24: and on the server's file events, so a correction the CLI or an assistant writes shows
 * too. Round 3: only for the files it is about, once a burst, and (round 4) the events heard just
 * after the app's own write once, when that write's echo window ends; and Apply to every repo's map stays while it runs (the job's writes read the
 * bar again, and it may then name one repo or none) and, when it applied only some, with its
 * errors and Sync until dismissed or the next Apply. The bar holds the run in its own state, so
 * the bar reading its list again loses none (a reload of the page does: the job's Console entry
 * still has it).
 */
export function CorrectionsToApply() {
  const plan = useApi<Plan>("/api/propose?scope=work");
  const reload = plan.reload;
  const own = useRef(0);
  useEffect(() => {
    const now = () => {
      own.current = Date.now();
      reload();
    };
    work.addEventListener(WORK_CHANGED, now);
    const off = onWrote(now);
    return () => {
      work.removeEventListener(WORK_CHANGED, now);
      off();
    };
  }, [reload]);
  // Round 4: events heard within the window of the app's own write may be its echo or another
  // writer's change at the same time: they are coalesced, and the bar reads once when it ends.
  const later = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(later.current), []);
  useFileChanges((events) => {
    if (!events.some(touchesApplyFirst)) return;
    const left = own.current + OWN_WRITE_ECHO_MS - Date.now();
    if (left <= 0) return reload();
    if (later.current !== undefined) return;
    later.current = setTimeout(() => {
      later.current = undefined;
      reload();
    }, left);
  });
  const [run, setRun] = useState<ApplyAllRun>(APPLY_ALL_IDLE);
  const [applied, setApplied] = useState(false);
  // Beta.28.4: the repo whose own Apply runs from this bar; the other buttons wait for it.
  const [busy, setBusy] = useState<string | undefined>();
  // WCAG 2.4.3: Dismiss goes with the errors; the keyboard goes to the bar's Apply (or the bar),
  // and, round 4, when the bar went with them (no repo left to apply), to the page's main region,
  // never left on the page's body.
  const [dismissed, setDismissed] = useState(0);
  const bar = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!dismissed) return;
    const at = bar.current?.isConnected
      ? (bar.current.querySelector<HTMLElement>("button:not([disabled])") ?? bar.current)
      : typeof document === "undefined"
        ? null
        : document.getElementById("main");
    at?.focus();
  }, [dismissed]);
  const repos = plan.state === "ready" ? (plan.data.applyFirst ?? []) : [];
  const failed = !run.running && run.note?.ok === false;
  if (!repos.length && !applied && !run.running && !failed) return null;
  const all = repos.length > 1 || run.running || failed;
  const start = () => {
    setApplied(false);
    // Exactly the repos listed here now: never every repo read so far.
    void runApplyAll(setRun, repos).then((ok) => {
      if (!ok) return;
      setRun(APPLY_ALL_IDLE);
      setApplied(true);
    });
  };
  return (
    <section
      ref={bar}
      tabIndex={-1}
      className="panel stack box-bar"
      style={{ gap: 6, gridColumn: "1 / -1" }}
      aria-label={P.onMapLabel}
    >
      {repos.length > 0 && (
        <p className="work-say" style={{ margin: 0 }}>
          {P.onMap(repos.join(", "))}
        </p>
      )}
      {all && (
        <ApplyAll noPropose repos={repos} run={run} onRun={start} disabled={busy !== undefined} />
      )}
      {failed && (
        <div>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setRun(APPLY_ALL_IDLE);
              setDismissed((n) => n + 1);
            }}
          >
            {P.dismissErrors}
          </button>
        </div>
      )}
      {repos.length > 1 && (
        <p className="work-say" style={{ margin: 0 }}>
          {P.oneAtATime}
        </p>
      )}
      {/* Each waiting repo's own Apply, one list whatever their number, so a repo's result stays
          with its button while the list around it changes. */}
      {repos.length > 0 && (
        <ul
          className="stack"
          style={{ gap: 6, margin: 0, padding: 0, listStyle: "none" }}
          aria-label={P.onMapEach}
        >
          {repos.map((r) => (
            <li key={r}>
              <ApplyAndPropose
                scope="corrections"
                repo={r}
                noPropose
                disabled={run.running || (busy !== undefined && busy !== r)}
                onStart={() => setBusy(r)}
                onEnd={() => setBusy((was) => (was === r ? undefined : was))}
              />
            </li>
          ))}
        </ul>
      )}
      {applied && !repos.length && !failed && (
        <p role="status" className="work-say" style={{ margin: 0 }}>
          {P.onMapApplied} <a href="#/home">{P.toHome}</a>
        </p>
      )}
    </section>
  );
}

/**
 * UX re-walk: what the app's work changed and nobody has proposed yet (an answer, a correction,
 * an audit after the page that made it is gone), with Propose for review, where a person comes
 * back. Nothing shows when there is nothing to propose.
 */
/**
 * The repos whose corrections wait for Apply before their files go out (fourth UX walk): as the
 * server says (applyFirst), else every repo with a corrections file among the files to propose.
 */
export function applyFirstRepos(plan: Plan): string[] {
  return (
    plan.applyFirst ?? [
      ...new Set(
        plan.files
          .map((f) => /(?:^|\/)facts\/([^/]+)\.corrections\.jsonl$/.exec(f.path)?.[1])
          .filter((r): r is string => !!r),
      ),
    ]
  );
}

/** The files of the person's work not proposed for review yet. */
export const waitingFiles = (plan: Plan): number => plan.files.filter((f) => !f.proposed).length;

export function PendingProposals(
  p: {
    /** beta.26: Home's own load of the plan (its tile counts it too), so it is asked for once. */
    plan?: Loaded<Plan> & { reload: () => void };
    /** Beta.26 review: at most this many repos' Apply (Home's top few); the rest on the map. */
    max?: number;
  } = {},
) {
  const own = useApi<Plan>(p.plan ? undefined : "/api/propose?scope=work");
  const plan = p.plan ?? own;
  // Eighth UX walk: a page action that wrote files (Accept the catalog on Home) says so, and the
  // count is read again (it stayed 6 until a reload, then 7).
  const reload = plan.reload;
  useEffect(() => {
    work.addEventListener(WORK_CHANGED, reload);
    return () => work.removeEventListener(WORK_CHANGED, reload);
  }, [reload]);
  // Sixth UX walk: after Push, the lines about what waited go (the push's own lines stay), and
  // the list is read again for the next time.
  const [pushed, setPushed] = useState(false);
  const waiting = plan.state === "ready" ? waitingFiles(plan.data) : 0;
  if (waiting === 0 && !pushed) return null;
  // Fourth UX walk: a correction saved but not applied would go out without its map: each repo
  // with one gets Apply first. Sixth: only while its corrections are newer than its last Apply,
  // as the server says (applyFirst); a server that doesn't say goes by the corrections file.
  const repos = plan.state !== "ready" || pushed ? [] : applyFirstRepos(plan.data);
  return (
    <div className="stack" style={{ gap: 4 }}>
      {!pushed && (
        <p className="work-say" style={{ margin: 0 }}>
          {P.pending(waiting)}
        </p>
      )}
      {repos.length > 0 && (
        <>
          <p className="work-say" style={{ margin: 0 }}>
            {P.applyFirst}
          </p>
          {/* Several repos corrected (lines drawn on the map join two): one Apply for them all,
              and (beta.28.4) for no other repo. */}
          {repos.length > 1 && <ApplyAll noPropose repos={repos} />}
          {repos.slice(0, p.max ?? repos.length).map((r) => (
            <ApplyAndPropose key={r} scope="corrections" repo={r} noPropose />
          ))}
          {p.max !== undefined && repos.length > p.max && (
            <p className="work-say" style={{ margin: 0 }}>
              <a href="#/canvas">{COPY.commandCenter.home.more(repos.length - p.max)}</a>
            </p>
          )}
        </>
      )}
      <Propose
        scope="work"
        onDone={() => {
          setPushed(true);
          plan.reload();
        }}
      />
    </div>
  );
}
