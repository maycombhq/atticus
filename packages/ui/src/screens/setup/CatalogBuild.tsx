import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Api } from "@maycombhq/core";
import { api, ApiError, useApi, useReloadOnFiles, type Loaded } from "../../api/client.js";
import { ShowInConsole } from "../../app/activity.js";
import { UpgradeOffer } from "../../app/upgrade.js";
import { followJob, JobFailed } from "../../app/job.js";
import { Panel, View } from "../../app/ui.js";
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

type Refusal = Api.BuildRefusalViewT;
type Removal = Api.BuildRemovalT;

const short = (c?: string) => (c && /^[0-9a-f]{8,}$/.test(c) ? c.slice(0, 7) : (c ?? ""));
const when = (iso: string) => iso.replace("T", " ").replace(/\.\d+Z$|Z$/, " UTC");

/** Why a job or a call stopped, in its own words. */
export function whyStopped(e: unknown): string {
  if (e instanceof JobFailed) return e.lines.join(" ") || e.message;
  if (e instanceof ApiError) return e.problem.detail ?? e.message;
  return e instanceof Error ? e.message : String(e);
}

/**
 * A step that changes files, asked first in a dialog that lists exactly what it changes. With
 * `count`, the person types the count shown to confirm (ADR 0195 point 4: a confirmation names
 * the count it was shown). Esc and Cancel close it; Tab stays inside; the focus goes back.
 */
export function ConfirmDialog(p: {
  title: string;
  intro: string;
  children: ReactNode;
  confirm: string;
  /** The confirm button's words while it runs (default: Building…). */
  working?: string;
  /** The count to type, for removals and discards. */
  count?: number;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const yes = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const introId = useId();
  const countId = useId();
  useEffect(() => {
    if (typeof document === "undefined") return;
    const before = document.activeElement as HTMLElement | null;
    (input.current ?? yes.current)?.focus();
    return () => {
      if (before?.isConnected) before.focus();
    };
  }, []);
  const ok = p.count === undefined || typed.trim() === String(p.count);
  const go = async () => {
    if (!ok) {
      setError(B.countWrong(p.count!));
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await p.onConfirm();
    } catch (e) {
      setError(B.failed(whyStopped(e)));
      setBusy(false);
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !busy) {
      e.preventDefault();
      e.stopPropagation();
      p.onClose();
    }
    if (e.key === "Tab" && box.current) {
      const f = [
        ...box.current.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), [tabindex='0']",
        ),
      ];
      if (!f.length) return;
      const a = f[0]!;
      const z = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === a) {
        e.preventDefault();
        z.focus();
      } else if (!e.shiftKey && document.activeElement === z) {
        e.preventDefault();
        a.focus();
      }
    }
  };
  return (
    <div className="run-dialog-back">
      <div
        ref={box}
        className="run-dialog panel cb-dialog cb"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={introId}
        onKeyDown={onKey}
      >
        <h2 id={titleId} className="h" style={{ marginTop: 0, fontSize: 16 }}>
          {p.title}
        </h2>
        <p id={introId}>{p.intro}</p>
        <div tabIndex={0} className="stack cb-dialog-list" style={{ gap: 6 }} aria-label={p.title}>
          {p.children}
        </div>
        {p.count !== undefined && (
          <div className="stack" style={{ gap: 4, marginTop: 10 }}>
            <label htmlFor={countId}>{B.typeCount(p.count)}</label>
            <input
              id={countId}
              ref={input}
              className="field cb-count"
              style={{ width: "10em", maxWidth: "100%" }}
              inputMode="numeric"
              autoComplete="off"
              value={typed}
              aria-describedby={`${countId}-hint`}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void go();
              }}
            />
            <span id={`${countId}-hint`} className="work-say">
              {B.countHint}
            </span>
          </div>
        )}
        {error && (
          <p className="state error" role="alert">
            {error}
          </p>
        )}
        <div className="row" style={{ gap: 8, justifyContent: "flex-end", marginTop: 10 }}>
          <button type="button" className="btn" onClick={p.onClose} disabled={busy}>
            {B.cancel}
          </button>
          <button
            ref={yes}
            type="button"
            className="btn primary"
            disabled={busy || !ok}
            aria-busy={busy}
            onClick={() => void go()}
          >
            {busy ? (p.working ?? B.building) : p.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}

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
            <th scope="row" className="mono" style={{ fontWeight: "normal" }}>
              {r.kind}/{r.id}
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

/**
 * A refused build and its ways on (point 4): the reasons in words, then for large removals the
 * list and a confirm with the count, for hand edits Make them curated and Discard with the count;
 * an unexplained removal can't be confirmed (it is a bug, and the list is its report).
 */
export function RefusalView(p: {
  refused: Refusal;
  onAllowRemovals: (n: number) => Promise<void>;
  onCurate?: (n: number) => Promise<void>;
  onDiscard?: (n: number) => Promise<void>;
  /** The words of a step's button that confirms the removals (a scan's: Scan again…). */
  confirmLabel?: (n: number) => string;
  /** On Catalog builds, where the upgrade's own step is below; elsewhere, a link to it. */
  upgradeHere?: boolean;
}) {
  const r = p.refused;
  const [dialog, setDialog] = useState<"removals" | "discard" | undefined>();
  const [curating, setCurating] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const removals = r.removals ?? [];
  const edits = r.edits ?? [];
  const nEdits = r.discardEdits ?? edits.length;
  const n = (reason: string) =>
    reason === "large-removals" || reason === "unexplained-removals"
      ? reason === "large-removals"
        ? (r.allowRemovals ?? removals.length)
        : (r.unexplained?.length ?? 0)
      : reason === "hand-edits" || reason === "not-upgraded"
        ? nEdits
        : 0;
  return (
    <div className="stack" style={{ gap: 10 }} role="group" aria-label={B.refusedTitle}>
      <p className="state" role="note" style={{ margin: 0 }}>
        <strong>{B.refusedTitle}</strong>
      </p>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {r.reasons.map((x) => (
          <li key={x}>{B.reason[x]?.(n(x)) ?? x}</li>
        ))}
      </ul>
      {r.unexplained && r.unexplained.length > 0 && <RemovalsTable removals={r.unexplained} />}
      {r.reasons.includes("large-removals") && (
        <div>
          <button type="button" className="btn primary" onClick={() => setDialog("removals")}>
            {B.reviewRemovals(r.allowRemovals ?? removals.length)}
          </button>
        </div>
      )}
      {r.reasons.includes("hand-edits") && (
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
                className="btn primary"
                disabled={curating}
                aria-busy={curating}
                aria-describedby="cb-curate-hint"
                onClick={() => {
                  setCurating(true);
                  setError(undefined);
                  p.onCurate!(edits.length)
                    .catch((e: unknown) => setError(B.failed(whyStopped(e))))
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
        </section>
      )}
      {r.reasons.includes("not-upgraded") && (
        <div className="stack" style={{ gap: 4 }}>
          <p className="work-say" style={{ margin: 0 }}>
            {p.upgradeHere ? (
              B.upgradeTodo
            ) : (
              <>
                {B.upgradeElsewhere} <a href="#/catalog-builds">{B.upgradeOn}</a>
              </>
            )}
          </p>
          <Command text="atticus upgrade --yes" label={COPY.runNext.copy} noRun />
        </div>
      )}
      {error && (
        <p className="state error" role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      )}
      <details className="work-terminal">
        <summary>{B.inTerminal}</summary>
        <Command text={r.command} label={COPY.runNext.copy} noRun />
      </details>
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
  onUndo: (n: number, files: number) => Promise<void>;
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
        <ConfirmDialog
          title={B.undoPlanTitle(asking.n)}
          intro={B.undoPlanIntro(asking.takesBack.map((t) => `${t.n} (${t.command})`).join(", "))}
          confirm={B.confirmUndo(asking.files.length)}
          onConfirm={async () => {
            await p.onUndo(asking.n, asking.files.length);
            setAsking(undefined);
          }}
          onClose={() => setAsking(undefined)}
        >
          <ul className="cb-list mono" aria-label={B.undoPlanCaption}>
            {asking.files.map((f) => (
              <li key={f.path}>
                {f.to === "absent" ? B.remove : B.restore} {f.path}
              </li>
            ))}
          </ul>
        </ConfirmDialog>
      )}
    </Panel>
  );
}

/** Prune: the slot files no build reads, and Remove these, listed first. */
export function PrunePanel(p: {
  of: Loaded<Api.CatalogPruneViewT> & { reload?: () => void };
  onPrune: (count: number) => Promise<void>;
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
                  await p.onPrune(v.files.length);
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
        <ul style={{ margin: 0, paddingLeft: 18 }} aria-label={B.refusedTitle}>
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
  run: (path: string, body: Record<string, unknown>) => Promise<void>;
  plan: (n: number) => Promise<Api.CatalogUndoViewT>;
  job?: string | undefined;
  note?: string | undefined;
}) {
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | undefined>();
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
                  onAllowRemovals={(n) => p.run("/api/build", { allowRemovals: n })}
                  onCurate={(n) => p.run("/api/build/edits/curate", { count: n })}
                  onDiscard={(n) => p.run("/api/build", { discardEdits: n })}
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
                      onClick={() => {
                        setBuilding(true);
                        setError(undefined);
                        p.run("/api/build", {})
                          .catch((e: unknown) => setError(B.failed(whyStopped(e))))
                          .finally(() => setBuilding(false));
                      }}
                    >
                      {building ? B.building : B.build}
                    </button>
                  </div>
                </div>
              )}
              {error && (
                <p className="state error" role="alert" style={{ margin: 0 }}>
                  {error}
                </p>
              )}
              {v.orphaned.map((o) => (
                <p key={o.repo} className="work-say" style={{ margin: 0 }}>
                  {B.orphaned(o.repo, o.why)}
                </p>
              ))}
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
        onUndo={(n, files) => p.run("/api/build/undo", { n, files })}
      />
      <PrunePanel of={p.prune} onPrune={(count) => p.run("/api/build/prune", { count })} />
    </div>
  );
}

/** Set up › Catalog builds. */
export function CatalogBuilds() {
  const build = useApi<Api.CatalogBuildViewT>("/api/build");
  const undo = useApi<Api.CatalogUndoViewT>("/api/build/undo");
  const prune = useApi<Api.CatalogPruneViewT>("/api/build/prune");
  const waits = build.state === "ready" && build.data.upgrade === true;
  const upgrade = useApi<Api.CatalogUpgradeViewT>(waits ? "/api/build/upgrade" : undefined);
  useReloadOnFiles(build, undo, prune, upgrade);
  const [job, setJob] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const reload = () => {
    build.reload();
    undo.reload();
    prune.reload();
    if (waits) upgrade.reload();
  };
  const run = async (path: string, body: Record<string, unknown>) => {
    setNote(undefined);
    try {
      await followJob(path, body, undefined, setJob);
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
