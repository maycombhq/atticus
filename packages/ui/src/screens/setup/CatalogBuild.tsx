import { useEffect, useRef, useState } from "react";
import type { Api } from "@maycombhq/core";
import { api, useApi, useReloadOnFiles, type Loaded } from "../../api/client.js";
import { ShowInConsole } from "../../app/activity.js";
import { UpgradeOffer } from "../../app/upgrade.js";
import { followJob, JobFailed, undoAfter } from "../../app/job.js";
import { JobFound, JobProgress, useJobRun, type JobHears } from "../../app/job-progress.js";
import {
  ErrorWaysOn,
  CATALOG_BUILDS_HREF,
  InstallCopy,
  panelAsked,
  refusalWay,
  showIfHere,
  showOnPage,
  SupportBundle,
  UPGRADE_HREF,
} from "../../app/ways-on.js";

export { panelAsked };
import { Panel, panelId, View } from "../../app/ui.js";
import { ConfirmDialog, netRenames, UndoConfirm, whyStopped } from "../../app/confirm-dialog.js";
import { COPY } from "../../copy.js";
import { Command } from "../work/RunNext.js";
import "../map/crosscheck.css";

/**
 * Set up › Scans › Catalog builds (ADR 0195 points 4 and 7, ticket CS3): where each repo's records
 * come from, what the next build would do, and the confirm steps: a refused build's removals
 * (listed, confirmed with their count), its hand edits (made curated, or discarded with their
 * count), the upgrade to source slots for a catalog from before beta.27 (every file it writes,
 * the copy it keeps and the first build's changes listed; the changes, when there are any,
 * accepted with their count, then the files confirmed with theirs),
 * undo of the last five builds (the files listed first) and prune (the files listed first); and
 * the last build's own report, whichever command built, a terminal's refusals included. Every
 * step is the CLI's own command, run as a local job whose lines are in the Console; nothing
 * changes until it is confirmed, and it confirms exactly the list shown.
 */

const B = COPY.catalogBuild;
export { ConfirmDialog, netRenames, UndoConfirm, whyStopped };

type Refusal = Api.BuildRefusalViewT;
type Removal = Api.BuildRemovalT;

const short = (c?: string) => (c && /^[0-9a-f]{8,}$/.test(c) ? c.slice(0, 7) : (c ?? ""));
const when = (iso: string) => iso.replace("T", " ").replace(/\.\d+Z$|Z$/, " UTC");

/** A person's Stop ended the job: no failure to say (its progress line says it stopped). */
const stoppedByPerson = (e: unknown): boolean => e instanceof JobFailed && e.stopped;

/**
 * What explains a removal, in words: each input other than a slot by what it is (an answer named
 * as such, the owner's decision of 2026-11-11), then the build's other reasons.
 */
export function whyWords(r: Removal): string[] {
  const inputs = r.inputs ?? [];
  return [
    ...inputs.map((i) => (B.input[i.what] ?? B.input.other!)(i.path)),
    ...r.explainedBy.filter((w) => !inputs.length || !/^an input changed \(/.test(w)),
  ];
}

/** The removals a build lists, each with its repos and what explains it. */
/**
 * A record id that breaks at its separators (`.`, `-`, `/`, `_`) and nowhere else (the review):
 * a long id wraps in a narrow panel at a word's end, not inside one.
 */
export function Breakable({ text }: { text: string }) {
  const parts = text.split(/(?<=[./_-])/);
  return (
    <>
      {parts.map((x, i) => (
        <span key={i}>
          {x}
          {i < parts.length - 1 && <wbr />}
        </span>
      ))}
    </>
  );
}

export function RemovalsTable({ removals }: { removals: readonly Removal[] }) {
  return (
    <table className="cb-table">
      <caption className="sr">{B.removalsCaption}</caption>
      <thead>
        <tr>
          <th scope="col">{B.removalCol.record}</th>
          <th scope="col">{B.removalCol.repos}</th>
          <th scope="col">{B.removalCol.why}</th>
        </tr>
      </thead>
      <tbody>
        {removals.map((r) => (
          <tr key={r.path}>
            <th scope="row" className="mono cb-id" style={{ fontWeight: "normal" }}>
              <Breakable text={`${r.kind}/${r.id}`} />
            </th>
            <td data-label={B.removalCol.repos}>
              {r.repos.length ? r.repos.join(", ") : B.noRepo}
            </td>
            <td data-label={B.removalCol.why}>{whyWords(r).join("; ")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const W = COPY.waysOn;

/** The panels of Catalog builds a link elsewhere opens the page at (`?at=`), by their headings. */
export const UPGRADE_PANEL = panelId(B.upgradeTitle);
export const UNDO_PANEL = panelId(B.undoTitle);
/**
 * The panel the page's address names is shown once the page has loaded (`ready`: before that
 * the panels above it are still growing, and would push it away again), and again whenever the
 * address comes to name one: on arrival and on a link followed on the page, in either layout
 * (both hand the page its address). Reading the page's data again never moves the person.
 */
export function useShowPanel(hash: string, ready: boolean): void {
  const shown = useRef<string | undefined>(undefined);
  useEffect(() => {
    const at = panelAsked(hash);
    if (!at) shown.current = undefined;
    else if (ready && shown.current !== hash && showOnPage(at)) shown.current = hash;
  }, [hash, ready]);
}

/**
 * Make it curated (point 4, the supported way) from a refusal shown elsewhere (a scan's, an
 * Apply's): the hand edits as GET /api/build lists them now, confirmed by its plan, made curated
 * and built in one job, as Catalog builds does. Throws, writing nothing, when they aren't the
 * edits the refusal listed any more.
 */
export async function curateListedEdits(
  refused: Refusal,
  n: number,
  /** What to say when the edits changed (a scan's: scan again; an Apply's: Apply again). */
  changed: string = B.editsChanged,
  /** Beta.30: hears the job's id and each step, for the panel that started it. */
  on?: JobHears,
): Promise<void> {
  const now = await api<Api.CatalogBuildViewT>("/api/build");
  const listed = (r: Refusal | undefined) =>
    (r?.edits ?? []).map((e) => `${e.how} ${e.path}`).join("\n");
  if (listed(now.pending.refused) !== listed(refused)) throw new Error(changed);
  await followJob(
    "/api/build/edits/curate",
    { count: n, plan: now.pending.plan },
    undefined,
    on?.onJob,
    on?.onProgress,
  );
}

/**
 * A refused build and its ways on (point 4): the reasons in words, then for large removals the
 * list and a confirm with the count, for hand edits Make them curated and Discard with the count;
 * an unexplained removal can't be confirmed (it is a bug, and the list is its report).
 */
export function RefusalView(p: {
  refused: Refusal;
  onAllowRemovals: (n: number) => Promise<void>;
  /** `on` (beta.30): tell it the job's id and steps, and the wait shows them here. */
  onCurate?: (n: number, on?: JobHears) => Promise<void>;
  onDiscard?: (n: number) => Promise<void>;
  /** The words of a step's button that confirms the removals (a scan's: Scan again…). */
  confirmLabel?: (n: number) => string;
  /** On Catalog builds, where the upgrade's own step is below; elsewhere, a link to it. */
  upgradeHere?: boolean;
  /**
   * Beta.30: the step that refused, run again as it was (the build, the Apply), for a refusal
   * nothing confirms. Without it, the way on is the page that builds.
   */
  onAgain?: () => Promise<void>;
}) {
  const r = p.refused;
  const [dialog, setDialog] = useState<"removals" | "discard" | undefined>();
  const [curating, setCurating] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // Beta.30: the curate's job (the decisions written, then the build), step by step.
  const job = useJobRun();
  const removals = r.removals ?? [];
  const edits = r.edits ?? [];
  const nEdits = r.discardEdits ?? edits.length;
  // API 3.19.0 (ADR 0124 addendum E-ids): a not-upgraded refusal is a catalog from before the
  // slots unless it says it waits only for the loose ends' step (`renames`, no `beforeSlots`).
  const beforeSlots = r.beforeSlots === true || r.renames === undefined;
  const n = (reason: string) =>
    reason === "large-removals" || reason === "unexplained-removals"
      ? reason === "large-removals"
        ? (r.allowRemovals ?? removals.length)
        : (r.unexplained?.length ?? 0)
      : reason === "hand-edits" || (reason === "not-upgraded" && beforeSlots)
        ? nEdits
        : 0;
  // Beta.28.3: a newer Atticus's catalog under its own heading (nothing there to confirm).
  const title = B.refusalTitle(r.reasons);
  // Beta.30: one primary button, the first of these the refusal has; any other is plain.
  const has = (x: Refusal["reasons"][number]) => r.reasons.includes(x);
  const unread = has("empty") || has("nothing-read");
  const first = refusalWay(r.reasons);
  const btn = (way: typeof first) => (way === first ? "btn primary" : "btn");
  const [again, setAgain] = useState(false);
  return (
    <div className="stack" style={{ gap: 10 }} role="group" aria-label={title}>
      <p className="state" role="note" style={{ margin: 0 }}>
        <strong>{title}</strong>
      </p>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {r.reasons.map((x) => (
          <li key={x}>
            {x === "hand-edits" && r.unreadableManifest
              ? B.unreadableManifest(nEdits)
              : (B.reason[x]?.(n(x)) ?? x)}
          </li>
        ))}
      </ul>
      {r.unexplained && r.unexplained.length > 0 && <RemovalsTable removals={r.unexplained} />}
      {has("newer-atticus") && (
        <div className="stack" style={{ gap: 4 }}>
          <p className="work-say" style={{ margin: 0 }}>
            {B.way.newer}
          </p>
          <InstallCopy />
        </div>
      )}
      {has("unexplained-removals") && (
        <div className="stack" style={{ gap: 6 }}>
          <p className="work-say" style={{ margin: 0 }}>
            {B.way.unexplained}
          </p>
          <div>
            {p.onAgain ? (
              <button
                type="button"
                className={btn("again")}
                disabled={again}
                aria-busy={again}
                onClick={() => {
                  setAgain(true);
                  setError(undefined);
                  p.onAgain!()
                    .catch((e: unknown) => setError(B.failed(whyStopped(e))))
                    .finally(() => setAgain(false));
                }}
              >
                {again ? B.building : W.buildAgain}
              </button>
            ) : (
              <a className={btn("again")} href={CATALOG_BUILDS_HREF}>
                {W.buildAgainOn}
              </a>
            )}
          </div>
          <SupportBundle />
        </div>
      )}
      {unread && (
        <div className="stack" style={{ gap: 4 }}>
          <p className="work-say" style={{ margin: 0 }}>
            {B.way.read}
          </p>
          <div>
            <a className={btn("read")} href="#/trust">
              {W.readOnTrust}
            </a>
          </div>
        </div>
      )}
      {r.reasons.includes("large-removals") && (
        <div>
          <button type="button" className={btn("removals")} onClick={() => setDialog("removals")}>
            {B.reviewRemovals(r.allowRemovals ?? removals.length)}
          </button>
        </div>
      )}
      {r.reasons.includes("hand-edits") && r.unreadableManifest && (
        <section className="stack" style={{ gap: 6 }} aria-labelledby="cb-edits">
          <h3 id="cb-edits" className="hud" style={{ margin: 0 }}>
            {B.editsTitle}
          </h3>
          <p className="work-say" style={{ margin: 0 }}>
            {B.unreadableIntro}
          </p>
          {p.onDiscard && (
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <button type="button" className={btn("edits")} onClick={() => setDialog("discard")}>
                {B.buildAgain(nEdits)}
              </button>
            </div>
          )}
        </section>
      )}
      {r.reasons.includes("hand-edits") && !r.unreadableManifest && (
        <section className="stack" style={{ gap: 6 }} aria-labelledby="cb-edits">
          <h3 id="cb-edits" className="hud" style={{ margin: 0 }}>
            {B.editsTitle}
          </h3>
          <p className="work-say" style={{ margin: 0 }}>
            {B.editsIntro}
          </p>
          <ul className="cb-list mono" aria-label={B.editsCaption}>
            {edits.map((e) => (
              <li key={e.path}>
                {B.how[e.how] ?? e.how}: {e.path}
              </li>
            ))}
          </ul>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            {p.onCurate && (
              <button
                type="button"
                className={btn("edits")}
                disabled={curating}
                aria-busy={curating}
                aria-describedby="cb-curate-hint"
                onClick={() => {
                  setCurating(true);
                  setError(undefined);
                  job
                    .watch((on) => p.onCurate!(edits.length, on))
                    // A person's Stop is said by the job's own line, not as a failure.
                    .catch((e: unknown) => stoppedByPerson(e) || setError(B.failed(whyStopped(e))))
                    .finally(() => setCurating(false));
                }}
              >
                {curating ? B.curating : B.curate(edits.length)}
              </button>
            )}
            {p.onDiscard && (
              <button type="button" className="btn" onClick={() => setDialog("discard")}>
                {B.discard(nEdits)}
              </button>
            )}
          </div>
          <p id="cb-curate-hint" className="work-say" style={{ margin: 0 }}>
            {B.curateHint}
          </p>
          <JobProgress what={B.curating} run={job.run} onStop={job.stop} />
        </section>
      )}
      {r.reasons.includes("not-upgraded") && (
        <div className="stack" style={{ gap: 4 }}>
          {!p.upgradeHere && (
            <p className="work-say" style={{ margin: 0 }}>
              {B.way.upgrade}
            </p>
          )}
          <div>
            {p.upgradeHere ? (
              <button
                type="button"
                className={btn("upgrade")}
                onClick={() => showOnPage(UPGRADE_PANEL)}
              >
                {W.upgradeBelow}
              </button>
            ) : (
              <a className={btn("upgrade")} href={UPGRADE_HREF} onClick={showIfHere(UPGRADE_HREF)}>
                {W.upgradeOnBuilds}
              </a>
            )}
          </div>
          <p className="work-say" style={{ margin: 0 }}>
            {p.upgradeHere ? B.upgradeTodo : B.inTerminalSay}
          </p>
          {/* The final review of b30/unresolved-ids (I1): --yes adopts the slots only. */}
          <Command
            text={beforeSlots ? "atticus upgrade --yes" : "atticus upgrade"}
            label={COPY.runNext.copy}
            noRun
          />
        </div>
      )}
      {error && (
        <p className="state error" role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      )}
      {/* A newer Atticus's catalog: its command is the install above, shown once. */}
      {!has("newer-atticus") && (
        <details className="work-terminal">
          <summary>{B.inTerminal}</summary>
          <Command text={r.command} label={COPY.runNext.copy} noRun />
        </details>
      )}
      {dialog === "removals" && (
        <ConfirmDialog
          title={B.removalsTitle(r.allowRemovals ?? removals.length)}
          intro={B.removalsIntro}
          confirm={(p.confirmLabel ?? B.confirmRemove)(r.allowRemovals ?? removals.length)}
          count={r.allowRemovals ?? removals.length}
          onConfirm={async () => {
            await p.onAllowRemovals(r.allowRemovals ?? removals.length);
            setDialog(undefined);
          }}
          onClose={() => setDialog(undefined)}
        >
          <RemovalsTable removals={removals} />
        </ConfirmDialog>
      )}
      {dialog === "discard" && p.onDiscard && (
        <ConfirmDialog
          title={B.discardTitle(nEdits)}
          intro={B.discardIntro}
          confirm={B.confirmDiscard(nEdits)}
          count={nEdits}
          onConfirm={async () => {
            await p.onDiscard!(nEdits);
            setDialog(undefined);
          }}
          onClose={() => setDialog(undefined)}
        >
          <ul className="cb-list mono">
            {edits.map((e) => (
              <li key={e.path}>
                {B.how[e.how] ?? e.how}: {e.path}
              </li>
            ))}
          </ul>
        </ConfirmDialog>
      )}
    </div>
  );
}

/** Undo: the builds kept, newest first (1 the latest), each one Undo away (its files listed first). */
export function UndoPanel(p: {
  of: Loaded<Api.CatalogUndoViewT> & { reload?: () => void };
  plan: (n: number) => Promise<Api.CatalogUndoViewT>;
  onUndo: (n: number, files: number, plan: string) => Promise<void>;
}) {
  const [asking, setAsking] = useState<Api.CatalogUndoViewT["plan"] | undefined>();
  const [error, setError] = useState<string | undefined>();
  return (
    <Panel title={B.undoTitle} span="1 / -1">
      <p className="work-why" style={{ marginTop: 0 }}>
        {B.undoIntro} {B.undoLatest}
      </p>
      <View of={p.of} empty={(v) => v.copies.length === 0} emptyText={B.undoNone}>
        {(v) => (
          <table className="cb-table">
            <caption className="sr">{B.undoCaption}</caption>
            <thead>
              <tr>
                <th scope="col" style={{ width: "4.5em" }}>
                  {B.undoCol.n}
                </th>
                <th scope="col">{B.undoCol.command}</th>
                <th scope="col">{B.undoCol.at}</th>
                <th scope="col" style={{ width: "4.5em" }}>
                  {B.undoCol.files}
                </th>
                <th scope="col">{B.undoCol.act}</th>
              </tr>
            </thead>
            <tbody>
              {v.copies.map((c) => (
                <tr key={c.n}>
                  <th scope="row">{c.n}</th>
                  <td data-label={B.undoCol.command} className="mono">
                    {c.command}
                  </td>
                  <td data-label={B.undoCol.at}>{when(c.at)}</td>
                  <td data-label={B.undoCol.files}>{c.files}</td>
                  <td>
                    <button
                      type="button"
                      className="btn"
                      aria-label={B.undoToOf(c.n)}
                      onClick={() => {
                        setError(undefined);
                        p.plan(c.n).then(
                          (x) => (x.plan ? setAsking(x.plan) : setError(x.problem)),
                          (e: unknown) => setError(whyStopped(e)),
                        );
                      }}
                    >
                      {B.undoTo}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </View>
      {error && (
        <p className="state error" role="alert">
          {error}
        </p>
      )}
      {asking && (
        <UndoConfirm
          plan={asking}
          onConfirm={async () => {
            await p.onUndo(asking.n, asking.files.length, asking.hash);
            setAsking(undefined);
          }}
          onClose={() => setAsking(undefined)}
        />
      )}
    </Panel>
  );
}

/** Prune: the slot files no build reads, and Remove these, listed first. */
export function PrunePanel(p: {
  of: Loaded<Api.CatalogPruneViewT> & { reload?: () => void };
  onPrune: (count: number, plan: string) => Promise<void>;
}) {
  const [asking, setAsking] = useState(false);
  return (
    <Panel title={B.pruneTitle} span="1 / -1">
      <p className="work-why" style={{ marginTop: 0 }}>
        {B.pruneIntro}
      </p>
      <View of={p.of} empty={(v) => v.files.length === 0} emptyText={B.pruneNone}>
        {(v) => (
          <div className="stack" style={{ gap: 8 }}>
            <ul className="cb-list mono" aria-label={B.pruneCaption}>
              {v.files.map((f) => (
                <li key={f.path}>
                  {f.path} <span className="work-say">({f.why})</span>
                </li>
              ))}
            </ul>
            <div>
              <button type="button" className="btn" onClick={() => setAsking(true)}>
                {B.pruneReview(v.files.length)}
              </button>
            </div>
            {asking && (
              <ConfirmDialog
                title={B.pruneConfirmTitle(v.files.length)}
                intro={B.pruneConfirmIntro}
                confirm={B.confirmPrune(v.files.length)}
                onConfirm={async () => {
                  await p.onPrune(v.files.length, v.plan);
                  setAsking(false);
                }}
                onClose={() => setAsking(false)}
              >
                <ul className="cb-list mono">
                  {v.files.map((f) => (
                    <li key={f.path}>{f.path}</li>
                  ))}
                </ul>
              </ConfirmDialog>
            )}
          </div>
        )}
      </View>
    </Panel>
  );
}

/**
 * The latest build's own report (CS2's build-report.json, whichever command built, in the app or
 * a terminal): what it did or refused, its counts, each removal with why, and the commands that
 * go on after a refusal.
 */
export function LastBuild({ last: l }: { last: Api.BuildReportViewT }) {
  const refused = l.outcome === "refused";
  const r = l.refused;
  // A long list scrolls: it takes the focus, so it scrolls from the keyboard too.
  const files = (xs: readonly { path: string; kind: string; id: string }[], label: string) => (
    <ul className="cb-list mono" tabIndex={0} aria-label={label}>
      {xs.map((f) => (
        <li key={f.path}>
          {f.kind}/{f.id}
        </li>
      ))}
    </ul>
  );
  const count = (x: string) =>
    !r
      ? 0
      : x === "large-removals"
        ? (r.allowRemovals ?? 0)
        : x === "unexplained-removals"
          ? (r.unexplained?.length ?? 0)
          : // API 3.19.0: a build that waits only for the loose ends' step counts no file.
            x === "not-upgraded" && r.renames !== undefined && !r.beforeSlots
            ? 0
            : (r.discardEdits ?? r.edits?.length ?? 0);
  return (
    <div className="stack" style={{ gap: 6 }}>
      <p style={{ margin: 0 }}>
        <span
          className={`chip ${refused || l.outcome === "stopped" ? "warn" : l.outcome === "written" ? "done" : "dim"}`}
        >
          {B.outcome[l.outcome] ?? l.outcome}
        </span>{" "}
        <span className="mono">{B.lastLine(l.command, when(l.at))}</span>
      </p>
      <p className="hud" style={{ margin: 0 }}>
        {refused
          ? B.lastWouldCounts(l.counts.added, l.counts.changed, l.counts.removed)
          : B.lastCounts(l.counts.added, l.counts.changed, l.counts.removed)}
        {l.slots.length ? ` · ${B.lastSlots(l.slots.length)}` : ""}
      </p>
      {l.stopped !== undefined && (
        <p className="state error" role="note" style={{ margin: 0 }}>
          {B.lastStopped(l.stopped)}
        </p>
      )}
      {r && (
        <ul style={{ margin: 0, paddingLeft: 18 }} aria-label={B.refusalTitle(r.reasons)}>
          {r.reasons.map((x) => (
            <li key={x}>{B.reason[x]?.(count(x)) ?? x}</li>
          ))}
        </ul>
      )}
      {r?.unread && r.unread.length > 0 && (
        <div className="stack" style={{ gap: 4 }}>
          <p className="work-say" style={{ margin: 0 }}>
            {B.lastUnread}
          </p>
          <ul className="cb-list">
            {r.unread.map((u) => (
              <li key={u.repo}>
                <span className="mono">{u.repo}</span>: {u.why}
              </li>
            ))}
          </ul>
        </div>
      )}
      {r?.edits && r.edits.length > 0 && (
        <ul className="cb-list mono" aria-label={B.editsCaption}>
          {r.edits.map((e) => (
            <li key={e.path}>
              {B.how[e.how] ?? e.how}: {e.path}
            </li>
          ))}
        </ul>
      )}
      {l.removed.length > 0 && (
        <details open={refused}>
          <summary>
            {refused ? B.lastWouldRemove(l.removed.length) : B.lastRemoved(l.removed.length)}
          </summary>
          <RemovalsTable removals={l.removed} />
        </details>
      )}
      {!refused && l.added.length > 0 && (
        <details>
          <summary>{B.lastAdded(l.added.length)}</summary>
          {files(l.added, B.lastAdded(l.added.length))}
        </details>
      )}
      {!refused && l.changed.length > 0 && (
        <details>
          <summary>{B.lastChanged(l.changed.length)}</summary>
          {files(l.changed, B.lastChanged(l.changed.length))}
        </details>
      )}
      {l.discarded && l.discarded.length > 0 && (
        <p className="work-say" style={{ margin: 0 }}>
          {B.lastDiscarded(l.discarded.length)}
        </p>
      )}
      {l.run.length > 0 && (
        <div className="stack" style={{ gap: 4 }}>
          <p className="work-say" style={{ margin: 0 }}>
            {B.lastRun}
          </p>
          {l.run.map((c) => (
            <Command key={c} text={c} label={COPY.runNext.copy} noRun />
          ))}
        </div>
      )}
    </div>
  );
}

/** The record files the upgrade's first build gives differently, each with how. */
export function UpgradeChangesList(p: { changes: Api.CatalogUpgradeViewT["changes"] }) {
  return (
    <ul className="cb-list mono" aria-label={B.upgradeChangesCaption}>
      {p.changes.map((c) => (
        <li key={c.path}>{B.upgradeChange(B.upgradeHow[c.how] ?? c.how, c.path)}</li>
      ))}
    </ul>
  );
}

/**
 * The upgrade to source slots (ADR 0195 point 6) as a confirm step: each slot it writes and the
 * records it adopts, the copy kept in generated-before-upgrade/, what the first build would change
 * (nothing; else each file, accepted with their count first, as `atticus upgrade --yes
 * --accept-changes <n>` does), then every file it writes, confirmed with their count.
 */
export function UpgradePanel(p: {
  of: Loaded<Api.CatalogUpgradeViewT> & { reload?: () => void };
  /** `acceptChanges`: the count of the first build's changes the person accepted, when any. */
  onUpgrade: (count: number, plan: string, acceptChanges?: number) => Promise<void>;
  /** The count of changes already accepted (the accept step's own state; tests render it). */
  accepted?: number;
}) {
  const [asking, setAsking] = useState(false);
  const [accepting, setAccepting] = useState(false);
  // The first build's changes the person accepted with their count, for the listing's plan:
  // a new listing (another plan) asks again.
  const [accepted, setAccepted] = useState<{ n: number; plan?: string } | undefined>(
    p.accepted !== undefined ? { n: p.accepted } : undefined,
  );
  const isAccepted = (v: Api.CatalogUpgradeViewT) =>
    v.acceptChanges > 0 &&
    accepted?.n === v.acceptChanges &&
    (accepted.plan === undefined || accepted.plan === v.plan);
  return (
    <Panel title={B.upgradeTitle} span="1 / -1">
      <p className="work-why" style={{ marginTop: 0 }}>
        {B.upgradeIntro}
      </p>
      <View of={p.of} empty={(v) => !v.pending} emptyText={B.upgradeNone}>
        {(v) => (
          <div className="stack" style={{ gap: 8 }}>
            <p style={{ margin: 0 }}>{B.upgradeRecords(v.records, v.write.length)}</p>
            <table className="cb-table">
              <caption className="sr">{B.upgradeSlotsCaption}</caption>
              <thead>
                <tr>
                  <th scope="col">{B.upgradeSlotCol.path}</th>
                  <th scope="col">{B.upgradeSlotCol.repo}</th>
                  <th scope="col" style={{ width: "6em" }}>
                    {B.upgradeSlotCol.records}
                  </th>
                </tr>
              </thead>
              <tbody>
                {v.write.map((w) => (
                  <tr key={w.path}>
                    <th scope="row" className="mono" style={{ fontWeight: "normal" }}>
                      {w.path}
                    </th>
                    <td data-label={B.upgradeSlotCol.repo}>{w.repo ?? B.upgradeJoins}</td>
                    <td data-label={B.upgradeSlotCol.records}>{w.records}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p style={{ margin: 0 }}>{B.upgradeCopy(v.copy.dir, v.copy.files)}</p>
            {v.acceptChanges === 0 ? (
              <p className="state" style={{ margin: 0 }}>
                {B.upgradeFirstBuild}
              </p>
            ) : (
              <div className="state" role="note">
                <p style={{ margin: 0 }}>{B.upgradeDiffers(v.acceptChanges)}</p>
                <UpgradeChangesList changes={v.changes} />
                {isAccepted(v) ? (
                  <p className="work-say" style={{ margin: "6px 0 0" }}>
                    {B.upgradeAccepted(v.acceptChanges)}
                  </p>
                ) : (
                  v.others.length === 0 && (
                    <div style={{ marginTop: 6 }}>
                      <button
                        type="button"
                        className="btn primary"
                        onClick={() => setAccepting(true)}
                      >
                        {B.upgradeAccept(v.acceptChanges)}
                      </button>
                    </div>
                  )
                )}
              </div>
            )}
            {v.verifiable.length > 0 && (
              <p className="work-say" style={{ margin: 0 }}>
                {B.upgradeVerifiable(v.verifiable.join(", "))}
              </p>
            )}
            {v.others.length > 0 && (
              <div className="state" role="note">
                <p style={{ margin: 0 }}>{B.upgradeOthers}</p>
                {/* Home's own offer: `atticus upgrade` without --yes, which runs them and only
                    shows this step; its job's file.changed reloads this list. */}
                <UpgradeOffer />
              </div>
            )}
            {(v.applies || isAccepted(v)) && v.others.length === 0 && (
              <div>
                <button type="button" className="btn primary" onClick={() => setAsking(true)}>
                  {B.upgradeReview(v.writes.length)}
                </button>
              </div>
            )}
            <details className="work-terminal">
              <summary>{B.inTerminal}</summary>
              <Command text={v.run} label={COPY.runNext.copy} noRun />
            </details>
            {accepting && (
              <ConfirmDialog
                title={B.upgradeAcceptTitle(v.acceptChanges)}
                intro={B.upgradeAcceptIntro}
                confirm={B.confirmAccept(v.acceptChanges)}
                count={v.acceptChanges}
                onConfirm={async () => {
                  // Nothing is written yet: the files' confirm follows, and sends this count.
                  setAccepted({ n: v.acceptChanges, plan: v.plan });
                  setAccepting(false);
                }}
                onClose={() => setAccepting(false)}
              >
                <UpgradeChangesList changes={v.changes} />
              </ConfirmDialog>
            )}
            {asking && (
              <ConfirmDialog
                title={B.upgradeConfirmTitle(v.writes.length)}
                intro={
                  v.acceptChanges
                    ? B.upgradeConfirmIntroChanges(v.acceptChanges)
                    : B.upgradeConfirmIntro
                }
                confirm={B.confirmUpgrade(v.writes.length)}
                count={v.writes.length}
                onConfirm={async () => {
                  await p.onUpgrade(
                    v.writes.length,
                    v.plan,
                    v.acceptChanges ? v.acceptChanges : undefined,
                  );
                  setAsking(false);
                }}
                onClose={() => setAsking(false)}
              >
                <ul className="cb-list mono" aria-label={B.upgradeFilesCaption}>
                  {v.writes.map((w) => (
                    <li key={w.path}>
                      {w.path}{" "}
                      <span className="work-say">
                        ({B.upgradeWhat[w.what] ?? w.what}, {B.upgradeBytes(w.bytes)})
                      </span>
                    </li>
                  ))}
                </ul>
              </ConfirmDialog>
            )}
          </div>
        )}
      </View>
    </Panel>
  );
}

/** The page from its loaded views and its steps, so tests can render every state. */
export function CatalogBuildsPage(p: {
  build: Loaded<Api.CatalogBuildViewT> & { reload?: () => void };
  /** The upgrade's dry run, loaded when the build says the catalog isn't upgraded. */
  upgrade?: (Loaded<Api.CatalogUpgradeViewT> & { reload?: () => void }) | undefined;
  undo: Loaded<Api.CatalogUndoViewT> & { reload?: () => void };
  prune: Loaded<Api.CatalogPruneViewT> & { reload?: () => void };
  /** Runs a step's route as a local job, to its end. */
  run: (path: string, body: Record<string, unknown>, on?: JobHears) => Promise<void>;
  plan: (n: number) => Promise<Api.CatalogUndoViewT>;
  job?: string | undefined;
  note?: string | undefined;
}) {
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // ADR 0202 point 3: the build an Undo would take back, as the failed build said it.
  const [undo, setUndo] = useState<ReturnType<typeof undoAfter>>({ known: false });
  // Beta.30: Build now's job, step by step, and how it ended.
  const job = useJobRun();
  // Build now and, after a failure, Build again: one build, which holds the button while it runs.
  const buildNow = (plan: string) => {
    setBuilding(true);
    setError(undefined);
    setUndo({ known: false });
    job
      .watch((on) => p.run("/api/build", { plan }, on))
      .catch((e: unknown) => {
        if (stoppedByPerson(e)) return;
        setUndo(undoAfter(e));
        setError(B.failed(whyStopped(e)));
      })
      .finally(() => setBuilding(false));
  };
  return (
    <div className="bento cb">
      <Panel title={B.title} span="1 / -1">
        <p className="work-why" style={{ marginTop: 0 }}>
          {B.intro}
        </p>
        <p className="work-say" style={{ margin: 0 }}>
          <a href="#/crosscheck">{COPY.crossCheck.title}</a>
        </p>
        <div role="status" className="stack" style={{ gap: 4, marginTop: 6 }}>
          {p.note && <span>{p.note}</span>}
        </div>
        <ShowInConsole id={p.job} />
      </Panel>
      <Panel title={B.pendingTitle} span="1 / -1">
        <View of={p.build}>
          {(v) => (
            <div className="stack" style={{ gap: 10 }}>
              {v.pending.refused ? (
                <RefusalView
                  refused={v.pending.refused}
                  upgradeHere
                  onAllowRemovals={(n) =>
                    p.run("/api/build", { allowRemovals: n, plan: v.pending.plan })
                  }
                  onCurate={(n, on) =>
                    p.run("/api/build/edits/curate", { count: n, plan: v.pending.plan }, on)
                  }
                  onDiscard={(n) => p.run("/api/build", { discardEdits: n, plan: v.pending.plan })}
                  onAgain={() => p.run("/api/build", { plan: v.pending.plan })}
                />
              ) : v.pending.upToDate ? (
                <p className="state" style={{ margin: 0 }}>
                  {B.upToDate}
                </p>
              ) : (
                <div className="stack" style={{ gap: 6 }}>
                  <p style={{ margin: 0 }}>
                    {v.pending.removals.length
                      ? B.wouldWrite(v.pending.removals.length)
                      : B.wouldWriteNothing}
                  </p>
                  {v.pending.removals.length > 0 && <RemovalsTable removals={v.pending.removals} />}
                  <div>
                    <button
                      type="button"
                      className="btn primary"
                      disabled={building}
                      aria-busy={building}
                      onClick={() => buildNow(v.pending.plan)}
                    >
                      {building ? B.building : B.build}
                    </button>
                  </div>
                </div>
              )}
              {/* Build now's step, time and Stop (heard until the write), then how it ended. */}
              <JobProgress what={B.building} run={job.run} onStop={job.stop} />
              {/* ADR 0202 point 5: a build started before the page was loaded. */}
              <JobFound action="build" what={B.building} skip={!!job.run} onEnd={p.build.reload} />
              {error && (
                <>
                  <p className="state error" role="alert" style={{ margin: 0 }}>
                    {error}
                  </p>
                  {/* Build again (as Build now ran it), Undo in one click, the bundle. */}
                  <ErrorWaysOn
                    short
                    onAgain={() => buildNow(v.pending.plan)}
                    undo={undo.undo}
                    undoKnown={undo.known}
                    onUndone={p.build.reload}
                  />
                </>
              )}
              {v.orphaned.map((o) => (
                <p key={o.repo} className="work-say" style={{ margin: 0 }}>
                  {B.orphaned(o.repo, o.why)}
                </p>
              ))}
              {(v.warnings ?? []).length > 0 && (
                <div className="state" role="note">
                  <p style={{ margin: 0 }}>{B.warnings}</p>
                  <ul style={{ margin: 0 }}>
                    {v.warnings!.map((w, i) => (
                      <li key={`${i}:${w}`}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
              {v.problems.length > 0 && (
                <div className="state error" role="note">
                  <p style={{ margin: 0 }}>{B.problems}</p>
                  <ul style={{ margin: 0 }}>
                    {v.problems.map((x, i) => (
                      <li key={`${i}:${x.file}`}>
                        <span className="mono">{x.file}</span>: {x.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </View>
      </Panel>
      <Panel title={B.sourcesTitle} span="1 / -1">
        <View of={p.build} empty={(v) => v.sources.length === 0} emptyText={B.noSources}>
          {(v) => (
            <table className="cb-table">
              <caption className="sr">{B.sourcesCaption}</caption>
              <thead>
                <tr>
                  <th scope="col">{B.col.repo}</th>
                  <th scope="col">{B.col.source}</th>
                  <th scope="col">{B.col.commit}</th>
                  <th scope="col">{B.col.note}</th>
                </tr>
              </thead>
              <tbody>
                {v.sources.map((s) => (
                  <tr key={s.repo}>
                    <th scope="row" className="mono" style={{ fontWeight: "normal" }}>
                      {s.repo}
                    </th>
                    <td data-label={B.col.source}>
                      <span
                        className={`chip ${s.source === "facts" ? "done" : s.source === "none" ? "dim" : "warn"}`}
                      >
                        {B.source[s.source] ?? s.source}
                      </span>
                    </td>
                    <td data-label={B.col.commit} className="mono">
                      {short(s.commit)}
                    </td>
                    <td data-label={B.col.note}>
                      {s.source === "legacy" ? COPY.crossCheck.state.legacy : (s.problem ?? "")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </View>
      </Panel>
      {p.upgrade && (
        <UpgradePanel
          of={p.upgrade}
          onUpgrade={(count, plan, acceptChanges) =>
            p.run("/api/build/upgrade", {
              count,
              plan,
              ...(acceptChanges ? { acceptChanges } : {}),
            })
          }
        />
      )}
      <Panel title={B.lastTitle} span="1 / -1">
        <p className="work-why" style={{ marginTop: 0 }}>
          {B.lastIntro}
        </p>
        <View of={p.build} empty={(v) => !v.last} emptyText={B.lastNone}>
          {(v) => <LastBuild last={v.last!} />}
        </View>
      </Panel>
      <UndoPanel
        of={p.undo}
        plan={p.plan}
        onUndo={(n, files, plan) => p.run("/api/build/undo", { n, files, plan })}
      />
      <PrunePanel
        of={p.prune}
        onPrune={(count, plan) => p.run("/api/build/prune", { count, plan })}
      />
    </div>
  );
}

/** Set up › Catalog builds. */
export function CatalogBuilds({ hash }: { hash: string }) {
  const build = useApi<Api.CatalogBuildViewT>("/api/build");
  const undo = useApi<Api.CatalogUndoViewT>("/api/build/undo");
  const prune = useApi<Api.CatalogPruneViewT>("/api/build/prune");
  const waits = build.state === "ready" && build.data.upgrade === true;
  const upgrade = useApi<Api.CatalogUpgradeViewT>(waits ? "/api/build/upgrade" : undefined);
  useReloadOnFiles(build, undo, prune, upgrade);
  // Beta.30: a link from a refusal or an error names the panel it is about (`?at=undo`).
  const loaded = (v: { state: string }) => v.state !== "loading";
  useShowPanel(hash, loaded(build) && loaded(undo) && (!waits || loaded(upgrade)));
  const [job, setJob] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const reload = () => {
    build.reload();
    undo.reload();
    prune.reload();
    if (waits) upgrade.reload();
  };
  const run = async (path: string, body: Record<string, unknown>, on?: JobHears) => {
    setNote(undefined);
    try {
      await followJob(
        path,
        body,
        undefined,
        (id) => {
          setJob(id);
          on?.onJob(id);
        },
        on?.onProgress,
      );
      setNote(B.done);
    } finally {
      reload();
    }
  };
  return (
    <CatalogBuildsPage
      build={build}
      upgrade={waits ? upgrade : undefined}
      undo={undo}
      prune={prune}
      run={run}
      plan={(n) => api<Api.CatalogUndoViewT>(`/api/build/undo?n=${n}`)}
      job={job}
      note={note}
    />
  );
}
