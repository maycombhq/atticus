import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { Api } from "@maycombhq/core";
import { ApiError, useApi } from "../../api/client.js";
import { ShowInConsole } from "../../app/activity.js";
import { RunWithCopilot, useCopilotRuns, type StartAsk } from "../../app/copilot-runs.js";
import { followJob, JobFailed } from "../../app/job.js";
import { RefusalLink } from "../../app/propose.js";
import { COPY } from "../../copy.js";
import { linkJoins, whyNot } from "./DeleteLink.js";
import { MapIcon } from "./MapBar.js";
import {
  addKeys,
  countsWords,
  keyOf,
  requestOf,
  rowWords,
  type AddLink,
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
      {/* An icon in the map's one row of controls (the bar keeps one row); its name in words. */}
      <MapIcon d="edit" />
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
  /** The repo the arrow's calls are made in, when it starts in a repo's box. */
  fromRepo?: string | undefined;
  callsPath?: string;
  staged?: Staged | undefined;
  onStage(s: Unkeyed): void;
  onRedirect(d: StagedDelete): void;
  onUnstage(key: string): void;
  /** The other arrows these Interfaces draw (a topic's other side). */
  alsoOf?: (interfaces: readonly string[]) => string[];
}) {
  const [now, setNow] = useState<StageState>({ state: "idle" });
  const read = async (then: (d: StagedDelete) => void) => {
    if (p.link.count > (p.link.joins?.length ?? 0) && p.callsPath) setNow({ state: "reading" });
    try {
      const joins = await linkJoins(p.link, p.callsPath);
      const interfaces = [...new Set(joins.map((j) => j.interface))];
      setNow({ state: "idle" });
      // Its callers' lines and shapes from every call read, not the view's first 20.
      const d = stagedDeleteOf(
        { ...p.link, joins: [...joins] },
        p.from,
        p.to,
        interfaces,
        p.fromRepo,
      );
      const also = p.alsoOf?.(interfaces) ?? [];
      then(also.length ? { ...d, also } : d);
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

/**
 * The arrow a delete or a redirect takes away, with what a redirect from a repo needs: the repo
 * its calls are made in, their lines there (none for a lineless arrow) and their method and path.
 */
export function stagedDeleteOf(
  link: Api.HierEdgeT,
  from: string,
  to: string,
  interfaces: readonly string[],
  fromRepo?: string,
): StagedDelete {
  const joins = link.joins ?? [];
  const lines = [
    ...new Set(
      joins.flatMap((j) =>
        j.caller.filter((c) => !fromRepo || !c.repo || c.repo === fromRepo).map((c) => c.at),
      ),
    ),
  ];
  return {
    link: link.id,
    fromBox: link.from,
    toBox: link.to,
    from,
    to,
    interfaces,
    ...(fromRepo ? { fromRepo } : {}),
    callerLines: lines,
    shapes: joins.map((j) => ({
      ...(j.method ? { method: j.method } : {}),
      ...(j.path ? { path: j.path } : {}),
    })),
  };
}

// ------------------------------------------------------------------ Add a link (and a redirect's)

/**
 * A box a link can be added from: a system's (Declare a link…'s), or a repo's or a component's
 * of one (Connect to…'s pairing).
 */
export interface FromChoice {
  box: string;
  label: string;
  system?: string;
  repo?: string;
}
/** A box a link can go to: drawn to until the map is built; `link` is it for Connect to…. */
export interface ToChoice {
  box: string;
  label: string;
  link?: Api.LinkBoxT;
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

/** One of the repo's calls in the pairing form, and the API picked for it ("" for none). */
export interface PairRow {
  call: string;
  label: string;
  at: string;
  api: string;
}

const normal = (path?: string) => (path ?? "").replace(/\{[^}]*\}/g, "{}").replace(/\/+$/, "");

/** An add's rows: the repo's calls that join nothing yet (Connect to…'s), its suggestion picked. */
export function pairRowsForAdd(c: Api.LinkCandidatesViewT): PairRow[] {
  return c.calls
    .filter((x) => x.status !== "paired")
    .map((x) => ({
      call: x.fact,
      label: `${x.method ? `${x.method} ` : ""}${x.path}`,
      at: x.at,
      api: x.confident && x.suggestion ? x.suggestion.api : "",
    }));
}

/**
 * A redirect's rows: every call of the repo, those the arrow is picked (by their lines; for a
 * lineless arrow, by its method and path, for the person to check), each with the new box's API
 * when it has only one, or the one of the same method and path.
 */
export function pairRowsForRedirect(
  facts: Api.RepoFactsViewT,
  d: StagedDelete,
  apis: readonly Api.LinkCandidatesViewT["apis"][number][],
): { rows: PairRow[]; lineless: boolean; ambiguous: boolean } {
  const lineless = !d.callerLines?.length;
  const lines = new Set(d.callerLines ?? []);
  const calls = facts.facts.filter((f) => f.kind === "call");
  const shapeOf = (method?: string, path?: string) =>
    `${(method ?? "").toUpperCase()} ${normal(path)}`;
  // A lineless arrow's calls by method and path: picked only where exactly one call of the repo
  // has that shape (the review of beta.28); with two or more, none, and the form says so.
  const byShape = new Map<string, string[]>();
  for (const f of calls) {
    const k = shapeOf(f.claim.method, f.claim.path);
    byShape.set(k, [...(byShape.get(k) ?? []), f.id]);
  }
  const shapes = [...new Set((d.shapes ?? []).map((x) => shapeOf(x.method, x.path)))];
  const sure = new Set(
    shapes.flatMap((k) => (byShape.get(k)?.length === 1 ? byShape.get(k)! : [])),
  );
  const ambiguous = lineless && shapes.some((k) => (byShape.get(k)?.length ?? 0) > 1);
  const rows = calls.map((f) => {
    const at = `${f.cite.file}:${f.cite.line}`;
    const method = (f.claim.method ?? "").toUpperCase();
    const picked = lineless ? sure.has(f.id) : lines.has(at);
    const same = apis.filter(
      (a) => (a.method ?? "").toUpperCase() === method && normal(a.path) === normal(f.claim.path),
    );
    const api = !picked
      ? ""
      : apis.length === 1
        ? apis[0]!.id
        : same.length === 1
          ? same[0]!.id
          : "";
    return { call: f.id, label: f.label, at, api, picked };
  });
  // The arrow's calls first.
  rows.sort((a, b) => Number(b.picked) - Number(a.picked));
  return {
    rows: rows.map(({ picked: _picked, ...r }) => r),
    lineless,
    ambiguous,
  };
}

/**
 * The calls picked that already draw another arrow (not loose for Connect to…, and not this
 * arrow's own): pairing one moves that arrow too, which the form says.
 */
export function drawsAnother(
  rows: readonly PairRow[],
  loose: ReadonlySet<string>,
  d?: StagedDelete,
): PairRow[] {
  const own = new Set(d?.callerLines ?? []);
  return rows.filter((r) => r.api && !loose.has(r.call) && !own.has(r.at));
}

/** The pairing the rows say, or none when no call has an API picked. */
export function pairOf(
  from: string,
  to: Api.LinkBoxT,
  rows: readonly PairRow[],
): Api.MapEditPairT | undefined {
  const pairs = rows.filter((r) => r.api).map((r) => ({ call: r.call, api: r.api }));
  return pairs.length ? { from, to: { ...to }, pairs } : undefined;
}

/** The rows of a pairing, each call with a select of the box's APIs, from their state. */
export function PairRowsView(p: {
  caption: string;
  rows: readonly PairRow[];
  apis: readonly Api.LinkCandidatesViewT["apis"][number][];
  onPick(call: string, api: string): void;
}) {
  const id = useId();
  return (
    <fieldset className="stack edit-map-pairs" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="hud">{p.caption}</legend>
      {p.rows.map((r, i) => (
        <div key={r.call} className="stack" style={{ gap: 2 }}>
          <label htmlFor={`${id}-${i}`} className="edit-map-call">
            <span className="mono">{r.label}</span> <span className="hud">{r.at}</span>
          </label>
          <select
            id={`${id}-${i}`}
            className="field"
            aria-label={E.add.callApi(r.label)}
            value={r.api}
            onChange={(e) => p.onPick(r.call, e.target.value)}
          >
            <option value="">{E.add.notPaired}</option>
            {p.apis.map((a) => (
              <option key={a.id} value={a.id}>
                {`${a.method ? `${a.method} ` : ""}${a.path}`}
              </option>
            ))}
          </select>
        </div>
      ))}
    </fieldset>
  );
}

const candidatesPath = (from: string, to: Api.LinkBoxT) =>
  `/api/links/candidates?from=${encodeURIComponent(from)}&${
    to.repo ? `to=${encodeURIComponent(to.repo)}` : `system=${encodeURIComponent(to.system!)}`
  }`;

/** A repo's pairing with the box picked: its calls and the box's APIs read, then the rows. */
function PairFields(p: {
  from: string;
  fromLabel: string;
  to: ToChoice;
  redirect?: StagedDelete | undefined;
  onPairs(rows: PairRow[], apis: number): void;
  rows: readonly PairRow[];
}) {
  const link = p.to.link!;
  const cands = useApi<Api.LinkCandidatesViewT>(candidatesPath(p.from, link));
  const facts = useApi<Api.RepoFactsViewT>(
    p.redirect ? `/api/facts/${encodeURIComponent(p.from)}` : undefined,
  );
  const ready = cands.state === "ready" && (!p.redirect || facts.state === "ready");
  const made = ready
    ? p.redirect && facts.state === "ready" && cands.state === "ready"
      ? pairRowsForRedirect(facts.data, p.redirect, cands.data.apis)
      : cands.state === "ready"
        ? { rows: pairRowsForAdd(cands.data), lineless: false }
        : undefined
    : undefined;
  const key = ready ? `${p.from}>${p.to.box}` : "";
  const onPairs = useRef(p.onPairs);
  onPairs.current = p.onPairs;
  useEffect(() => {
    if (made && cands.state === "ready") onPairs.current(made.rows, cands.data.apis.length);
    // The rows start once, when both reads are in, for this pair of boxes.
  }, [key]);
  const factsState = p.redirect ? facts.state : "ready";
  if (cands.state === "loading" || factsState === "loading")
    return (
      <p className="ev-say" role="status" aria-busy="true" style={{ margin: 0 }}>
        {E.add.loading}
      </p>
    );
  if (cands.state === "error" || factsState === "error")
    return (
      <p className="state error" role="alert" style={{ margin: 0 }}>
        {E.add.failed(
          cands.state === "error" ? cands.error : facts.state === "error" ? facts.error : "",
        )}
      </p>
    );
  if (!made || cands.state !== "ready") return null;
  if (!cands.data.apis.length)
    return (
      <p className="ev-say" role="status" style={{ margin: 0 }}>
        {E.add.noApis(cands.data.toName)}
      </p>
    );
  if (!p.rows.length)
    return (
      <p className="ev-say" role="status" style={{ margin: 0 }}>
        {E.add.noCalls(p.fromLabel)}
      </p>
    );
  return (
    <>
      {made.lineless && (
        <p className="ev-say" role="note" style={{ margin: 0 }}>
          {"ambiguous" in made && made.ambiguous
            ? E.add.linelessAmbiguous(p.fromLabel)
            : E.add.lineless(p.fromLabel)}
        </p>
      )}
      {(() => {
        const loose = new Set(
          cands.data.calls.filter((x) => x.status !== "paired").map((x) => x.fact),
        );
        const moved = drawsAnother(p.rows, loose, p.redirect);
        return moved.length ? (
          <p className="ev-say" role="note" style={{ margin: 0 }}>
            {E.add.drawsAnother(moved.map((r) => r.label).join(", "))}
          </p>
        ) : null;
      })()}
      <PairRowsView
        caption={p.redirect ? E.add.redirectCalls(p.fromLabel) : E.add.calls(p.fromLabel)}
        rows={p.rows}
        apis={cands.data.apis}
        onPick={(call, api) =>
          p.onPairs(
            p.rows.map((r) => (r.call === call ? { ...r, api } : r)),
            cands.data.apis.length,
          )
        }
      />
    </>
  );
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
  // A redirect starts where the arrow's calls are: its repo's box, else its own box.
  const choices = p.redirect
    ? p.systems.filter((s) =>
        p.redirect!.fromRepo ? s.repo === p.redirect!.fromRepo : s.box === p.redirect!.fromBox,
      )
    : p.systems;
  const first = choices.find((s) => s.box === p.redirect?.fromBox) ?? choices[0];
  const [from, setFrom] = useState(first?.box ?? "");
  const [kind, setKind] = useState<AddKind>("call");
  const [value, setValue] = useState("");
  const [to, setTo] = useState(p.redirect && !p.redirect.fromRepo ? p.redirect.toBox : "");
  const [rows, setRows] = useState<PairRow[]>([]);
  const [error, setError] = useState<string | undefined>();
  const head = useRef<HTMLHeadingElement | null>(null);
  // A redirect's form takes the focus when it opens (WCAG 2.4.3).
  useEffect(() => {
    if (p.redirect) head.current?.focus();
  }, [p.redirect?.link]);
  const src = choices.find((s) => s.box === from);
  const target = p.targets.find((t) => t.box === to);
  const pairing = !!src?.repo;
  const submit = () => {
    if (!src) return setError(E.add.empty);
    let link: AddLink;
    if (src.repo) {
      if (!target?.link) return setError(E.add.toPickNone);
      const pair = pairOf(src.repo, target.link, rows);
      if (!pair) return setError(E.add.pickOne);
      link = { by: "pair", pair, from: src.label, to: target.label };
    } else {
      const add = addOf(src.system!, kind, value);
      if (!add) return setError(E.add.empty);
      link = { by: "declare", add };
    }
    const ends = { fromBox: src.box, ...(to ? { toBox: to } : {}) };
    const next: Unkeyed = p.redirect
      ? { kind: "redirect", delete: p.redirect, link, ...ends }
      : { kind: "add", link, ...ends };
    // The same link already staged (alone, or in another arrow's redirect).
    const mine = new Set(addKeys(link));
    if (
      p.staged.some(
        (x) =>
          x.kind !== "delete" && x.key !== keyOf(next) && addKeys(x.link).some((k) => mine.has(k)),
      )
    )
      return setError(E.add.twice);
    setError(undefined);
    setValue("");
    p.onStage(next);
  };
  const targets = p.targets.filter(
    (t) => t.box !== from && (!pairing || (t.link && t.link.repo !== src?.repo)),
  );
  return (
    <section className="stack edit-map-add" aria-labelledby={`${id}-t`}>
      <h4 id={`${id}-t`} ref={head} tabIndex={-1} className="hud" style={{ margin: 0 }}>
        {p.redirect ? E.add.redirectTitle(p.redirect.from, p.redirect.to) : E.add.title}
      </h4>
      <p className="ev-say" style={{ margin: 0 }}>
        {p.redirect ? E.add.redirectIntro : pairing ? E.add.pairIntro : E.add.intro}
      </p>
      {!choices.length ? (
        <p className="ev-say" role="status" style={{ margin: 0 }}>
          {p.redirect ? E.add.redirectNoRepo : E.add.fromNone}
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
            onChange={(e) => {
              setFrom(e.target.value);
              setRows([]);
            }}
          >
            {choices.map((s) => (
              <option key={s.box} value={s.box}>
                {s.label}
              </option>
            ))}
          </select>
          {pairing ? (
            <>
              <label htmlFor={`${id}-to`} className="hud">
                {E.add.toPick}
              </label>
              <select
                id={`${id}-to`}
                className="field"
                value={to}
                onChange={(e) => {
                  setTo(e.target.value);
                  setRows([]);
                }}
              >
                <option value="">{E.add.toPickNone}</option>
                {targets.map((t) => (
                  <option key={t.box} value={t.box}>
                    {t.label}
                  </option>
                ))}
              </select>
              {target?.link && src?.repo && (
                <PairFields
                  key={`${src.repo}>${target.box}`}
                  from={src.repo}
                  fromLabel={src.label}
                  to={target}
                  redirect={p.redirect}
                  rows={rows}
                  onPairs={(r) => setRows(r)}
                />
              )}
            </>
          ) : (
            <>
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
                {targets.map((t) => (
                  <option key={t.box} value={t.box}>
                    {t.label}
                  </option>
                ))}
              </select>
            </>
          )}
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
  /** The check refused: each change that can't be made, by its place; nothing was written. */
  | { state: "problems"; problems: { edit: number; message: string }[] }
  /** The job failed: each change's outcome by its place, when it says them; nothing built. */
  | {
      state: "failed";
      text: string;
      outcomes?: { edit: number; state: string; message?: string }[];
    }
  /** Saved, but the build waits for a person (a large removal, a hand edit): its listing. */
  | { state: "saved"; n: number; refused?: Api.BuildRefusalViewT }
  /** Applied and built: how many, the caller repos they touch, and the repos new links wait on. */
  | { state: "done"; n: number; callers: string[]; waitsOn: string[] };

/**
 * Apply my changes: POST /api/map/edits with the list, followed to its end. A 422's problems and
 * a failed job's outcomes are said by the places of the list they are of; changes saved whose
 * build waits for a person are `saved`, with the build's listing.
 */
export async function applyStaged(
  list: readonly Staged[],
  follow: typeof followJob = followJob,
  onJob?: (id: string) => void,
): Promise<ApplyState> {
  try {
    const r = await follow("/api/map/edits", requestOf(list), undefined, onJob);
    const callers = (r.result?.callers as string[] | undefined) ?? [];
    const waitsOn = (r.result?.waitsOn as string[] | undefined) ?? [];
    return { state: "done", n: list.length, callers: [...callers], waitsOn: [...waitsOn] };
  } catch (e) {
    if (e instanceof ApiError && e.problem.problems?.length)
      return {
        state: "problems",
        problems: e.problem.problems.map((x) => ({ edit: x.edit, message: x.message })),
      };
    const result = e instanceof JobFailed ? e.result : undefined;
    const edits = (result?.edits as Api.MapEditsResultT["edits"] | undefined) ?? [];
    if (edits.length && edits.every((x) => x.state === "saved") && result?.built === false) {
      const refused = result.refused as Api.BuildRefusalViewT | undefined;
      return { state: "saved", n: list.length, ...(refused ? { refused } : {}) };
    }
    return {
      state: "failed",
      text: whyNot(e),
      ...(edits.length
        ? {
            outcomes: edits.map((x) => ({
              edit: x.edit,
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

/**
 * After Apply, in the panel (the owner's feedback of 2026-11-12, 22:29): one status line and one
 * primary button, the existing Copilot Read it again for the caller repos as one run. The whole
 * output is the job's Console entry.
 */
export function AppliedView(p: {
  n: number;
  callers: readonly string[];
  waitsOn: readonly string[];
  job?: string | undefined;
}) {
  const c = useCopilotRuns();
  const said = [
    p.waitsOn.length ? E.doneWaits(p.n, p.waitsOn.join(", ")) : E.done(p.n),
    !p.callers.length
      ? E.reReadNone
      : c?.allowed
        ? E.reReadWhy(p.callers.join(", "))
        : E.reReadNoCopilot(p.callers.join(", ")),
  ].join(" ");
  return (
    <div className="stack" style={{ gap: 6 }}>
      <p className="ev-say" role="status" style={{ margin: 0 }}>
        {said}
      </p>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        {p.callers.length > 0 && (
          <RunWithCopilot ask={reReadAsk(p.callers)} label={E.reRead} className="btn primary" />
        )}
        <ShowInConsole id={p.job} />
      </div>
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
  job?: string | undefined;
  /** Add a link (or the redirect's form), under the list. */
  add?: ReactNode;
}) {
  const id = useId();
  const a = p.apply;
  const yes = useRef<HTMLButtonElement | null>(null);
  const applyBtn = useRef<HTMLButtonElement | null>(null);
  const head = useRef<HTMLHeadingElement | null>(null);
  // WCAG 2.4.3: the confirm takes the focus on its yes; Go back gives it to Apply once it is
  // drawn again; after the yes, and when the job ends, the heading has it (its status follows).
  const was = useRef(a.state);
  useEffect(() => {
    const before = was.current;
    was.current = a.state;
    if (a.state === "confirm") yes.current?.focus();
    else if (before === "confirm" && a.state === "idle") applyBtn.current?.focus();
    else if (before === "confirm" || before === "working") head.current?.focus();
  }, [a.state]);
  const n = p.staged.length;
  const busy = a.state === "working";
  // What the check or the job said of each change, on its own row (not stacked under the list).
  const said = new Map<number, string>();
  if (a.state === "problems") for (const x of a.problems) said.set(x.edit, x.message);
  if (a.state === "failed")
    for (const x of a.outcomes ?? [])
      said.set(x.edit, x.message ? `${x.state}, ${x.message}` : x.state);
  return (
    <section className="stack edit-map" aria-labelledby={`${id}-t`}>
      <h3 id={`${id}-t`} ref={head} tabIndex={-1} className="h" style={{ margin: 0 }}>
        {E.title}
      </h3>
      {a.state === "done" ? (
        <AppliedView n={a.n} callers={a.callers} waitsOn={a.waitsOn} job={p.job} />
      ) : a.state === "saved" && !n ? (
        <div className="stack" style={{ gap: 6 }}>
          {a.refused ? (
            <RefusalLink refused={a.refused} />
          ) : (
            <p className="ev-say" role="status" style={{ margin: 0 }}>
              {COPY.panelResults.waitsBuild}
            </p>
          )}
          <ShowInConsole id={p.job} />
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
                {p.staged.map((s, i) => (
                  <li key={s.key} className={`stack edit-map-row k-${s.kind}`}>
                    <div className="row edit-map-line">
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
                    </div>
                    {said.has(i) && <span className="edit-map-why state error">{said.get(i)}</span>}
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
                <button type="button" className="btn" onClick={p.onBack}>
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
          {a.state === "saved" &&
            (a.refused ? (
              <RefusalLink refused={a.refused} />
            ) : (
              <p className="ev-say" role="status" style={{ margin: 0 }}>
                {COPY.panelResults.waitsBuild}
              </p>
            ))}
          {a.state === "problems" && (
            <p className="state error" role="alert" style={{ margin: 0 }}>
              {E.problemsLine(a.problems.length)}
            </p>
          )}
          {a.state === "failed" && (
            <p className="state error" role="alert" style={{ margin: 0 }}>
              {a.outcomes ? E.failedLine : E.failed(a.text)}
            </p>
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
  /**
   * Saved (built, or the build waiting on Catalog builds): the keys of the changes it saved, to
   * take off the list (a change staged meanwhile stays), and the picture is read again.
   */
  onApplied(keys: ReadonlySet<string>): void;
  add?: ReactNode;
}) {
  const [apply, setApply] = useState<ApplyState>({ state: "idle" });
  const [job, setJob] = useState<string | undefined>();
  // A change staged after an Apply starts the next list: the list shows again.
  const count = p.staged.length;
  useEffect(() => {
    if (count > 0)
      setApply((a) => (a.state === "done" || a.state === "saved" ? { state: "idle" } : a));
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
      onConfirm={() => {
        setApply({ state: "working" });
        const keys = new Set(p.staged.map((x) => x.key));
        void applyStaged(p.staged, followJob, setJob).then((s) => {
          setApply(s);
          if (s.state === "done" || s.state === "saved") p.onApplied(keys);
        });
      }}
    />
  );
}
