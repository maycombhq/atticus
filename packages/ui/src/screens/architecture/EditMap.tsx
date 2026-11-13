import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { Api } from "@maycombhq/core";
import { ApiError } from "../../api/client.js";
import { ShowInConsole } from "../../app/activity.js";
import { RunWithCopilot, useCopilotRuns, type StartAsk } from "../../app/copilot-runs.js";
import { followJob, JobFailed } from "../../app/job.js";
import { COPY } from "../../copy.js";
import { linkInterfaces, whyNot } from "./DeleteLink.js";
import {
  countsWords,
  keyOf,
  requestOf,
  rowWords,
  type Staged,
  type StagedDelete,
  type Unkeyed,
} from "./edit-map.js";

/**
 * Beta.28, Edit the map (the owner's ask of 2026-11-12): a toolbar toggle; while it is on, the
 * link panel stages a delete or a redirect of the arrow picked instead of saving it, Add a link
 * stages what Declare a link… writes, and the list beside the canvas holds the changes, each
 * removable. Apply my changes asks once, listing them, then POST /api/map/edits saves them all
 * and builds the catalog once, as one local job (its lines in the Console). Once applied, Re-read
 * the repos these touch starts Map › Trust's Copilot Read it again for exactly their caller repos,
 * as one run.
 */

const E = COPY.editMap;
const K = COPY.declare;

/** The toolbar's toggle: pressed while editing, and how many changes wait to be applied. */
export function EditMapToggle(p: { on: boolean; count: number; onToggle(): void }) {
  return (
    <button
      type="button"
      className={`btn viewer-btn arch-edit-toggle${p.on ? " primary" : ""}`}
      aria-pressed={p.on}
      aria-label={E.toggleOf(p.count)}
      title={E.toggleOf(p.count)}
      onClick={p.onToggle}
    >
      {E.toggle}
      {p.count > 0 && (
        <span className="chip arch-edit-count" aria-hidden="true">
          {p.count}
        </span>
      )}
    </button>
  );
}

// ------------------------------------------------------------------ the link panel, while editing

export type StageState =
  { state: "idle" } | { state: "reading" } | { state: "error"; text: string };

/** In the link panel's head while editing: stage a delete or a redirect, or say it is staged. */
export function StageLinkView(p: {
  from: string;
  to: string;
  staged?: Staged | undefined;
  now: StageState;
  onDelete(): void;
  onRedirect(): void;
  onUnstage(): void;
}) {
  const busy = p.now.state === "reading";
  return (
    <div className="li-delete">
      {p.staged ? (
        <>
          <p className="ev-say li-delete-ask" role="status" style={{ margin: 0 }}>
            {E.stage.staged(rowWords(p.staged))}
          </p>
          <button
            type="button"
            className="btn li-delete-open"
            aria-label={E.removeOf(rowWords(p.staged))}
            onClick={p.onUnstage}
          >
            {E.remove}
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            className="btn li-delete-open"
            aria-label={E.stage.deleteOf(p.from, p.to)}
            disabled={busy}
            onClick={p.onDelete}
          >
            {E.stage.delete}
          </button>
          <button
            type="button"
            className="btn li-delete-open"
            aria-label={E.stage.redirectOf(p.from, p.to)}
            disabled={busy}
            onClick={p.onRedirect}
          >
            {E.stage.redirect}
          </button>
        </>
      )}
      {busy && (
        <p className="ev-say li-delete-confirm" role="status" aria-busy="true">
          {E.stage.reading}
        </p>
      )}
      {p.now.state === "error" && (
        <p className="state error li-delete-confirm" role="alert">
          {E.stage.readFailed(p.now.text)}
        </p>
      )}
    </div>
  );
}

/** Stage this link: every Interface behind it read first (all of them, lineless ones too). */
export function StageLink(p: {
  link: Api.HierEdgeT;
  from: string;
  to: string;
  callsPath?: string;
  staged?: Staged | undefined;
  onStage(s: Unkeyed): void;
  onRedirect(d: StagedDelete): void;
  onUnstage(key: string): void;
}) {
  const [now, setNow] = useState<StageState>({ state: "idle" });
  const read = async (then: (d: StagedDelete) => void) => {
    if (p.link.count > (p.link.joins?.length ?? 0) && p.callsPath) setNow({ state: "reading" });
    try {
      const interfaces = await linkInterfaces(p.link, p.callsPath);
      setNow({ state: "idle" });
      then({
        link: p.link.id,
        fromBox: p.link.from,
        toBox: p.link.to,
        from: p.from,
        to: p.to,
        interfaces,
      });
    } catch (e) {
      setNow({ state: "error", text: whyNot(e) });
    }
  };
  return (
    <StageLinkView
      from={p.from}
      to={p.to}
      staged={p.staged}
      now={now}
      onDelete={() => void read((d) => p.onStage({ kind: "delete", delete: d }))}
      onRedirect={() => void read(p.onRedirect)}
      onUnstage={() => p.staged && p.onUnstage(p.staged.key)}
    />
  );
}

// ------------------------------------------------------------------ Add a link (and a redirect's)

/** An outside system the map draws, that a link can be declared from (Declare a link…'s). */
export interface FromChoice {
  box: string;
  system: string;
  label: string;
}
/** A box a staged add can be drawn to until the map is built. */
export interface ToChoice {
  box: string;
  label: string;
}

type AddKind = "publishes" | "listens" | "call";

/** The add the form says, or none when it lacks the topic or the route. */
export function addOf(system: string, kind: AddKind, value: string): Api.MapEditAddT | undefined {
  const v = value.trim();
  if (!system || !v) return undefined;
  return kind === "call"
    ? { kind: "call", system, route: v }
    : { kind: "topic", system, topic: v, side: kind };
}

export function AddLinkForm(p: {
  systems: readonly FromChoice[];
  targets: readonly ToChoice[];
  staged: readonly Staged[];
  /** The arrow a redirect takes away: the form says where it goes now. */
  redirect?: StagedDelete | undefined;
  onStage(s: Unkeyed): void;
  onCancel?(): void;
}) {
  const id = useId();
  const first = p.systems.find((s) => s.box === p.redirect?.fromBox) ?? p.systems[0];
  const [from, setFrom] = useState(first?.box ?? "");
  const [kind, setKind] = useState<AddKind>("call");
  const [value, setValue] = useState("");
  const [to, setTo] = useState(p.redirect?.toBox ?? "");
  const [error, setError] = useState<string | undefined>();
  const head = useRef<HTMLHeadingElement | null>(null);
  // A redirect's form takes the focus when it opens (WCAG 2.4.3).
  useEffect(() => {
    if (p.redirect) head.current?.focus();
  }, [p.redirect?.link]);
  const sys = p.systems.find((s) => s.box === from);
  const submit = () => {
    const add = sys ? addOf(sys.system, kind, value) : undefined;
    if (!add) return setError(E.add.empty);
    const ends = { fromBox: sys!.box, ...(to ? { toBox: to } : {}) };
    const next: Unkeyed = p.redirect
      ? { kind: "redirect", delete: p.redirect, add, ...ends }
      : { kind: "add", add, ...ends };
    // The same declaration already staged (alone, or in another arrow's redirect).
    if (
      p.staged.some(
        (x) =>
          x.kind !== "delete" &&
          keyOf({ kind: "add", add: x.add }) === keyOf({ kind: "add", add }) &&
          x.key !== keyOf(next),
      )
    )
      return setError(E.add.twice);
    setError(undefined);
    setValue("");
    p.onStage(next);
  };
  return (
    <section className="stack edit-map-add" aria-labelledby={`${id}-t`}>
      <h4 id={`${id}-t`} ref={head} tabIndex={-1} className="hud" style={{ margin: 0 }}>
        {p.redirect ? E.add.redirectTitle(p.redirect.from, p.redirect.to) : E.add.title}
      </h4>
      <p className="ev-say" style={{ margin: 0 }}>
        {p.redirect ? E.add.redirectIntro : E.add.intro}
      </p>
      {!p.systems.length ? (
        <p className="ev-say" role="status" style={{ margin: 0 }}>
          {E.add.fromNone}
        </p>
      ) : (
        <>
          <label htmlFor={`${id}-f`} className="hud">
            {E.add.from}
          </label>
          <select
            id={`${id}-f`}
            className="field"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          >
            {p.systems.map((s) => (
              <option key={s.box} value={s.box}>
                {s.label}
              </option>
            ))}
          </select>
          <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="hud">{E.add.kind}</legend>
            {(["call", "publishes", "listens"] as const).map((k) => (
              <label key={k} className="row" style={{ gap: 6 }}>
                <input
                  type="radio"
                  name={`${id}-k`}
                  checked={kind === k}
                  onChange={() => setKind(k)}
                />
                {K.kinds[k]}
              </label>
            ))}
          </fieldset>
          <label htmlFor={`${id}-v`} className="hud">
            {kind === "call" ? K.route : K.topic}
          </label>
          <input
            id={`${id}-v`}
            className="field"
            value={value}
            {...(error ? { "aria-invalid": true, "aria-describedby": `${id}-e` } : {})}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
          />
          <label htmlFor={`${id}-to`} className="hud">
            {E.add.to}
          </label>
          <select
            id={`${id}-to`}
            className="field"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          >
            <option value="">{E.add.toNone}</option>
            {p.targets
              .filter((t) => t.box !== from)
              .map((t) => (
                <option key={t.box} value={t.box}>
                  {t.label}
                </option>
              ))}
          </select>
          {error && (
            <p id={`${id}-e`} role="alert" className="state error" style={{ margin: 0 }}>
              {error}
            </p>
          )}
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="btn primary" onClick={submit}>
              {E.add.stage}
            </button>
            {p.onCancel && (
              <button type="button" className="btn" onClick={p.onCancel}>
                {E.add.cancel}
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ the list, and Apply

export type ApplyState =
  | { state: "idle" }
  | { state: "confirm" }
  | { state: "working" }
  /** The check refused: each change that can't be made, by its row; nothing was written. */
  | { state: "problems"; problems: { row: string; message: string }[] }
  /** The job failed: why, and each change's outcome when it says them. */
  | { state: "failed"; text: string; outcomes?: { row: string; state: string; message?: string }[] }
  /** Applied and built: how many, and the caller repos they touch. */
  | { state: "done"; n: number; callers: string[] };

/**
 * Apply my changes: POST /api/map/edits with the list, followed to its end. A 422's problems and
 * a failed job's outcomes are said by the rows of the list they are of.
 */
export async function applyStaged(
  list: readonly Staged[],
  follow: typeof followJob = followJob,
  onJob?: (id: string) => void,
): Promise<ApplyState> {
  const rows = list.map(rowWords);
  const row = (i: number) => rows[i] ?? String(i + 1);
  try {
    const r = await follow("/api/map/edits", requestOf(list), undefined, onJob);
    const callers = (r.result?.callers as string[] | undefined) ?? [];
    return { state: "done", n: list.length, callers: [...callers] };
  } catch (e) {
    if (e instanceof ApiError && e.problem.problems?.length)
      return {
        state: "problems",
        problems: e.problem.problems.map((x) => ({ row: row(x.edit), message: x.message })),
      };
    const edits = e instanceof JobFailed ? (e.result?.edits as Api.MapEditsResultT["edits"]) : [];
    return {
      state: "failed",
      text: whyNot(e),
      ...(edits?.length
        ? {
            outcomes: edits.map((x) => ({
              row: row(x.edit),
              state: E.outcome[x.state] ?? x.state,
              ...(x.message ? { message: x.message } : {}),
            })),
          }
        : {}),
    };
  }
}

/** What Re-read the repos these touch asks Copilot: one run of exactly those repos, read whole. */
export const reReadAsk = (callers: readonly string[]): StartAsk => ({
  kind: "repos",
  repos: [...callers],
  force: true,
});

/** After Apply: the existing Copilot Read it again, for the caller repos, as one run. */
export function ReRead({ callers }: { callers: readonly string[] }) {
  const c = useCopilotRuns();
  if (!callers.length)
    return (
      <p className="ev-say" style={{ margin: 0 }}>
        {E.reReadNone}
      </p>
    );
  return (
    <div className="stack" style={{ gap: 6 }}>
      <p className="ev-say" style={{ margin: 0 }}>
        {c?.allowed ? E.reReadWhy(callers.join(", ")) : E.reReadNoCopilot(callers.join(", "))}
      </p>
      <RunWithCopilot ask={reReadAsk(callers)} label={E.reRead} className="btn primary" />
    </div>
  );
}

/** The list beside the canvas and Apply, from their state, so tests can render each. */
export function EditMapView(p: {
  staged: readonly Staged[];
  apply: ApplyState;
  onRemove(key: string): void;
  onApply(): void;
  onConfirm(): void;
  onBack(): void;
  onAgain(): void;
  job?: string | undefined;
  /** Add a link (or the redirect's form), under the list. */
  add?: ReactNode;
}) {
  const id = useId();
  const a = p.apply;
  const yes = useRef<HTMLButtonElement | null>(null);
  const applyBtn = useRef<HTMLButtonElement | null>(null);
  // The confirm takes the focus on its yes; Go back gives it to Apply (WCAG 2.4.3).
  useEffect(() => {
    if (a.state === "confirm") yes.current?.focus();
  }, [a.state]);
  const n = p.staged.length;
  const busy = a.state === "working";
  return (
    <section className="stack edit-map" aria-labelledby={`${id}-t`}>
      <h3 id={`${id}-t`} className="h" style={{ margin: 0 }}>
        {E.title}
      </h3>
      {a.state === "done" ? (
        <div className="stack" style={{ gap: 8 }}>
          <p className="ev-say" role="status" style={{ margin: 0 }}>
            {E.done(a.n)}
          </p>
          <ReRead callers={a.callers} />
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="btn" onClick={p.onAgain}>
              {E.again}
            </button>
            <ShowInConsole id={p.job} />
          </div>
        </div>
      ) : (
        <>
          <p className="ev-say" style={{ margin: 0 }}>
            {E.intro}
          </p>
          {!n ? (
            <p className="ev-say" style={{ margin: 0 }}>
              {E.empty}
            </p>
          ) : (
            <>
              <p className="hud" aria-live="polite" style={{ margin: 0 }}>
                {countsWords(p.staged)}
              </p>
              <ul className="stack edit-map-list" aria-label={E.listLabel}>
                {p.staged.map((s) => (
                  <li key={s.key} className={`row edit-map-row k-${s.kind}`}>
                    <span className="edit-map-what">{rowWords(s)}</span>
                    <button
                      type="button"
                      className="btn"
                      aria-label={E.removeOf(rowWords(s))}
                      disabled={busy || a.state === "confirm"}
                      onClick={() => p.onRemove(s.key)}
                    >
                      {E.remove}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {a.state === "confirm" ? (
            <div
              className="stack edit-map-confirm"
              role="group"
              aria-labelledby={`${id}-q`}
              style={{ gap: 6 }}
            >
              <p id={`${id}-q`} className="li-delete-ask" style={{ margin: 0 }}>
                {E.confirm.title(n)}
              </p>
              <ol className="stack" style={{ margin: 0, paddingLeft: 18 }}>
                {p.staged.map((s) => (
                  <li key={s.key}>{rowWords(s)}</li>
                ))}
              </ol>
              <p className="ev-say" style={{ margin: 0 }}>
                {E.confirm.intro}
              </p>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <button type="button" className="btn primary" ref={yes} onClick={p.onConfirm}>
                  {E.confirm.yes}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    p.onBack();
                    applyBtn.current?.focus();
                  }}
                >
                  {E.confirm.back}
                </button>
              </div>
            </div>
          ) : (
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn primary"
                ref={applyBtn}
                disabled={!n || busy}
                aria-busy={busy}
                onClick={p.onApply}
              >
                {E.apply}
              </button>
              <ShowInConsole id={p.job} />
            </div>
          )}
          {busy && (
            <p className="ev-say" role="status" aria-busy="true" style={{ margin: 0 }}>
              {E.working}
            </p>
          )}
          {a.state === "problems" && (
            <div className="state error stack" role="alert" style={{ gap: 4 }}>
              <p style={{ margin: 0 }}>{E.problems}</p>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {a.problems.map((x, i) => (
                  <li key={i}>{E.problemOf(x.row, x.message)}</li>
                ))}
              </ul>
            </div>
          )}
          {a.state === "failed" && (
            <div className="state error stack" role="alert" style={{ gap: 4 }}>
              <p style={{ margin: 0 }}>{E.failed(a.text)}</p>
              {a.outcomes && (
                <>
                  <p style={{ margin: 0 }}>{E.outcomes}</p>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {a.outcomes.map((x, i) => (
                      <li key={i}>{E.outcomeOf(x.row, x.state, x.message)}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
          {!busy && a.state !== "confirm" && p.add}
        </>
      )}
    </section>
  );
}

/** The list and Apply, with Apply's state: `onApplied` once the catalog is built (read again). */
export function EditMap(p: {
  staged: readonly Staged[];
  onRemove(key: string): void;
  /** Applied: the list is emptied and the picture read again. */
  onApplied(): void;
  add?: ReactNode;
}) {
  const [apply, setApply] = useState<ApplyState>({ state: "idle" });
  const [job, setJob] = useState<string | undefined>();
  // A change staged after an Apply starts the next list: the list shows again.
  const count = p.staged.length;
  useEffect(() => {
    if (count > 0) setApply((a) => (a.state === "done" ? { state: "idle" } : a));
  }, [count]);
  return (
    <EditMapView
      staged={p.staged}
      apply={apply}
      job={job}
      {...(p.add ? { add: p.add } : {})}
      onRemove={(k) => {
        p.onRemove(k);
        if (apply.state !== "working") setApply({ state: "idle" });
      }}
      onApply={() => setApply({ state: "confirm" })}
      onBack={() => setApply({ state: "idle" })}
      onAgain={() => setApply({ state: "idle" })}
      onConfirm={() => {
        setApply({ state: "working" });
        void applyStaged(p.staged, followJob, setJob).then((s) => {
          setApply(s);
          if (s.state === "done") p.onApplied();
        });
      }}
    />
  );
}
