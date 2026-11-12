import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Api } from "@maycombhq/core";
import { api, ApiError, useApi, useReloadOnFiles, type Loaded } from "../../api/client.js";
import { ShowInConsole } from "../../app/activity.js";
import { followJob, JobFailed } from "../../app/job.js";
import { Panel, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { Command } from "../work/RunNext.js";
import "../map/crosscheck.css";

/**
 * Set up › Scans › Catalog builds (ADR 0195 points 4 and 7, ticket CS3): where each repo's records
 * come from, what the next build would do, and the confirm steps: a refused build's removals
 * (listed, confirmed with their count), its hand edits (made curated, or discarded with their
 * count), undo of the last five builds (the files listed first) and prune (the files listed
 * first). Every step is the CLI's own command, run as a local job whose lines are in the Console;
 * nothing changes until it is confirmed, and it confirms exactly the list shown.
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
            {busy ? B.building : p.confirm}
          </button>
        </div>
      </div>
    </div>
  );
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
            <td data-label={B.removalCol.why}>{r.explainedBy.join("; ")}</td>
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
            {B.upgradeTodo}
          </p>
          <Command text="atticus upgrade" label={COPY.runNext.copy} noRun />
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

/** The page from its loaded views and its steps, so tests can render every state. */
export function CatalogBuildsPage(p: {
  build: Loaded<Api.CatalogBuildViewT> & { reload?: () => void };
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
      <Panel title={B.lastTitle} span="1 / -1">
        <View of={p.build} empty={(v) => !v.last} emptyText={B.lastNone}>
          {(v) => {
            const l = v.last!;
            return (
              <div className="stack" style={{ gap: 6 }}>
                <p className="mono" style={{ margin: 0 }}>
                  {B.lastLine(l.command, when(l.at))}
                </p>
                <p className="hud" style={{ margin: 0 }}>
                  {B.lastCounts(l.added.length, l.changed.length, l.removed.length)}
                  {l.slots.length ? ` · ${B.lastSlots(l.slots.length)}` : ""}
                </p>
                {l.removed.length > 0 && (
                  <details>
                    <summary>{B.lastRemoved(l.removed.length)}</summary>
                    <RemovalsTable removals={l.removed} />
                  </details>
                )}
              </div>
            );
          }}
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
  useReloadOnFiles(build, undo, prune);
  const [job, setJob] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const reload = () => {
    build.reload();
    undo.reload();
    prune.reload();
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
      undo={undo}
      prune={prune}
      run={run}
      plan={(n) => api<Api.CatalogUndoViewT>(`/api/build/undo?n=${n}`)}
      job={job}
      note={note}
    />
  );
}
