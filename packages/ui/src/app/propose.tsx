import { useEffect, useId, useRef, useState } from "react";
import { api, ApiError, onWrote, useApi } from "../api/client.js";
import { confirmed } from "../api/confirm.js";
import { COPY } from "../copy.js";
import { flash } from "./flash.js";
import { focusIfLost } from "./ui.js";
import { Note, useAction } from "../screens/know/common.js";
import { ShowInConsole } from "./activity.js";

const P = COPY.propose;

/** Eighth UX walk: the app's work changed files that wait to be proposed; Home reads them again. */
const WORK_CHANGED = "atticus:work-changed";
const work = new EventTarget();
export const workChanged = () => void work.dispatchEvent(new Event(WORK_CHANGED));

/**
 * Windows review: Apply, Propose and Bring in run as server jobs (an editor panel waits 30 s for
 * one answer). Starts one and follows it to the end: its lines, or an error with them.
 */
export async function followJob(
  path: string,
  body: unknown,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  /** App-only audit: hears the job's id at once, so the page can link its Console entry. */
  onJob?: (jobId: string) => void,
): Promise<{ code: number; lines: string[] }> {
  const { jobId } = await api<{ jobId: string }>(path, { method: "POST", body });
  onJob?.(jobId);
  for (;;) {
    const j = await api<{
      state: string;
      errors: string[];
      result?: { code?: number; lines?: string[] };
    }>(`/api/jobs/${encodeURIComponent(jobId)}`, { quiet: true });
    if (j.state !== "running" && j.state !== "queued") {
      const lines = j.result?.lines ?? j.errors;
      const code = j.result?.code ?? (j.state === "done" ? 0 : 1);
      if (j.state !== "done" || code !== 0) throw new Error(lines.join(" ") || j.state);
      return { code, lines };
    }
    await wait(700);
  }
}
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
  | "service-desk";
interface Plan {
  scope: Scope;
  files: { path: string; status: string; from?: string; proposed?: string }[];
  branch: string;
  title: string;
  /** API 2.69.0: the repos whose corrections are newer than their last Apply. */
  applyFirst?: string[];
}

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
}) {
  const apply = useAction();
  const [applied, setApplied] = useState<string[]>();
  // Every run the app starts shows in the Console: this one's entry, linked while it runs.
  const [jobId, setJobId] = useState<string | undefined>();
  return (
    <div className="stack" style={{ gap: 8 }}>
      {p.repo && (
        <div className="stack" style={{ gap: 4 }}>
          <div className="row" style={{ gap: 6 }}>
            <button
              type="button"
              className="btn primary"
              disabled={apply.busy}
              onClick={() =>
                void apply.run(async () => {
                  try {
                    const r = await followJob(
                      `/api/facts/${encodeURIComponent(p.repo!)}/apply`,
                      {},
                      undefined,
                      setJobId,
                    );
                    setApplied(r.lines);
                    // A correction's Apply can take its panel away (the fact it was on goes):
                    // what happened, and where to propose it, stays on the page.
                    if (p.scope === "corrections")
                      flash({ text: P.appliedFlash(p.repo!), href: "#/home", link: P.toHome });
                  } catch (e) {
                    // Round 41: a refusal to start (409: another local step runs) is the server's
                    // own words, not verify's problems; nothing ran.
                    if (e instanceof ApiError && e.problem.status === 409) {
                      const said = P.notStarted(e.problem.detail ?? e.problem.title);
                      if (p.scope === "corrections") flash({ text: said.slice(0, 400) });
                      throw new Error(said, { cause: e });
                    }
                    setApplied([(e as Error).message]);
                    // Fifth UX walk: a failed Apply can take its panel away too: say it stays.
                    if (p.scope === "corrections")
                      flash({ text: `${P.applyFailed} ${(e as Error).message}`.slice(0, 400) });
                    throw new Error(P.applyFailed, { cause: e });
                  }
                }, P.applied(p.repo!))
              }
            >
              {apply.busy ? P.applying : P.apply(p.repo)}
            </button>
            {apply.busy && <ShowInConsole id={jobId} />}
          </div>
          <Note note={apply.note} />
          {applied && applied.length > 0 && (
            <pre className="mono" style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: 11.5 }}>
              {applied.join("\n")}
            </pre>
          )}
        </div>
      )}
      {!p.noPropose && <Propose scope={p.scope} />}
    </div>
  );
}

export function Propose({ scope, onDone }: { scope: Scope; onDone?: () => void }) {
  const [plan, setPlan] = useState<Plan>();
  const [off, setOff] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<string[]>();
  const look = useAction();
  const send = useAction();
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
                void send.run(async () => {
                  // ADR 0186: this Yes is the person's confirmation to push and open the PR.
                  const r = await followJob("/api/propose", {
                    scope,
                    files: files.map((f) => f.path),
                    branch: plan.branch,
                    ...(await confirmed("propose", scope)),
                  });
                  setDone(r.lines);
                  onDone?.();
                }, P.proposed)
              }
            >
              {send.busy ? P.proposing : P.yes(files.length)}
            </button>
            <button type="button" className="btn" onClick={() => setPlan(undefined)}>
              {P.cancel}
            </button>
          </div>
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
              () => followJob("/api/propose/bring-in", {}, undefined, setJobId),
              (r) => r.lines.join(" "),
            )
          }
        >
          {act.busy ? P.bringingIn : P.bringIn}
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          {P.bringInWhy}
        </span>
      </div>
      {act.busy && (
        <span role="status" className="row" style={{ gap: 6, alignItems: "center", fontSize: 12 }}>
          {P.bringingInSay} <ShowInConsole id={jobId} />
        </span>
      )}
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

/** `atticus verify --all --write`, then Propose for review. */
export function ApplyAll({ noPropose, onDone }: { noPropose?: boolean; onDone?: () => void }) {
  const act = useAction();
  const [lines, setLines] = useState<string[]>();
  const [jobId, setJobId] = useState<string | undefined>();
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 6, alignItems: "center" }}>
        <button
          type="button"
          className="btn primary"
          disabled={act.busy}
          onClick={() =>
            void act.run(async () => {
              try {
                const r = await followJob("/api/facts/apply-all", {}, undefined, setJobId);
                setLines(r.lines);
              } catch (e) {
                setLines([(e as Error).message]);
                throw e;
              } finally {
                workChanged();
              }
              onDone?.();
            }, COPY.appStep.appliedAll)
          }
        >
          {act.busy ? COPY.appStep.applyingAll : COPY.appStep.applyAll}
        </button>
        {act.busy && <ShowInConsole id={jobId} />}
      </div>
      <Note note={act.note} />
      {lines && lines.length > 0 && (
        <pre className="mono" style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: 11.5 }}>
          {lines.join("\n")}
        </pre>
      )}
      {!noPropose && <Propose scope="work" />}
    </div>
  );
}

/**
 * The map's own bar: the repos whose corrections are newer than their last Apply (the server's
 * applyFirst), with one Apply for them all (each repo's own when only one), read again after
 * every write the app makes, so a line drawn or removed on the map shows here at once.
 */
export function CorrectionsToApply() {
  const plan = useApi<Plan>("/api/propose?scope=work");
  const reload = plan.reload;
  useEffect(() => {
    work.addEventListener(WORK_CHANGED, reload);
    const off = onWrote(reload);
    return () => {
      work.removeEventListener(WORK_CHANGED, reload);
      off();
    };
  }, [reload]);
  const [applied, setApplied] = useState(false);
  const repos = plan.state === "ready" ? (plan.data.applyFirst ?? []) : [];
  if (!repos.length && !applied) return null;
  return (
    <section
      className="panel stack"
      style={{ gap: 6, gridColumn: "1 / -1" }}
      aria-label={COPY.appStep.applyAll}
    >
      {repos.length > 0 && (
        <p className="work-say" style={{ margin: 0 }}>
          {P.onMap(repos.join(", "))}
        </p>
      )}
      {repos.length > 1 && <ApplyAll noPropose onDone={() => setApplied(true)} />}
      {repos.length === 1 && <ApplyAndPropose scope="corrections" repo={repos[0]} noPropose />}
      {applied && !repos.length && (
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
export function PendingProposals() {
  const plan = useApi<Plan>("/api/propose?scope=work");
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
  const waiting = plan.state === "ready" ? plan.data.files.filter((f) => !f.proposed).length : 0;
  if (waiting === 0 && !pushed) return null;
  // Fourth UX walk: a correction saved but not applied would go out without its map: each repo
  // with one gets Apply first. Sixth: only while its corrections are newer than its last Apply,
  // as the server says (applyFirst); a server that doesn't say goes by the corrections file.
  const repos =
    plan.state !== "ready" || pushed
      ? []
      : (plan.data.applyFirst ?? [
          ...new Set(
            plan.data.files
              .map((f) => /(?:^|\/)facts\/([^/]+)\.corrections\.jsonl$/.exec(f.path)?.[1])
              .filter((r): r is string => !!r),
          ),
        ]);
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
          {/* Several repos corrected (lines drawn on the map join two): one Apply for them all. */}
          {repos.length > 1 && <ApplyAll noPropose />}
          {repos.map((r) => (
            <ApplyAndPropose key={r} scope="corrections" repo={r} noPropose />
          ))}
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
