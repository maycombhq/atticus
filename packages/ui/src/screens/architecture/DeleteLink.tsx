import { useEffect, useId, useRef, useState } from "react";
import type { Api } from "@maycombhq/core";
import { api, ApiError, useApi, type Loaded } from "../../api/client.js";
import { ShowInConsole } from "../../app/activity.js";
import { followJob, JobFailed } from "../../app/job.js";
import { COPY } from "../../copy.js";

/**
 * Beta.28 (the owner's decision of 2026-11-12: "an arrow for an architect must be as simple as
 * clicking delete"): Delete this link on every link's panel, beside Close, for any link of
 * Interfaces, lined or lineless, derived or adopted. One click, a small confirm naming the link
 * and its calls, then POST /api/links/delete (C4 3.13.0): the person's curated suppress of each
 * Interface behind the link and the build, as one local job (its lines in the Console). Deleted
 * links lists them (GET /api/links/deleted), each with Bring back (POST /api/links/deleted/undo).
 */

const D = COPY.deleteLink;
const L = D.list;

/** Why a job or a call stopped, in its own words. */
export function whyNot(e: unknown): string {
  if (e instanceof JobFailed) return e.lines.join(" ") || e.message;
  if (e instanceof ApiError) return e.problem.detail ?? e.message;
  return e instanceof Error ? e.message : String(e);
}

export type DeleteState =
  | { state: "idle" }
  /** Every call on the link, read when the view lists fewer than it has. */
  | { state: "reading" }
  | { state: "confirm"; interfaces: readonly string[] }
  | { state: "working"; interfaces: readonly string[] }
  | { state: "error"; text: string; interfaces?: readonly string[] }
  | { state: "done" };

/**
 * The button and its confirm, from their state, so tests can render each. Laid out in the link
 * panel's head (`display: contents`): the button beside Close, the confirm under the head.
 */
export function DeleteLinkView(p: {
  from: string;
  to: string;
  /** How many calls the link has (all of them are deleted). */
  count: number;
  now: DeleteState;
  onOpen(): void;
  onCancel(): void;
  onConfirm(): void;
  job?: string | undefined;
  /** The opener and the confirm's Delete, for the focus (WCAG 2.4.3). */
  opener?: { current: HTMLButtonElement | null };
  yes?: { current: HTMLButtonElement | null };
}) {
  const id = useId();
  const s = p.now;
  const open = s.state !== "idle" && s.state !== "done";
  const n = "interfaces" in s && s.interfaces ? s.interfaces.length : p.count;
  return (
    <div className="li-delete">
      <button
        type="button"
        className="btn li-delete-open"
        aria-label={D.openOf(p.from, p.to)}
        aria-expanded={open}
        aria-controls={`${id}-c`}
        ref={p.opener}
        disabled={s.state === "working" || s.state === "reading"}
        onClick={p.onOpen}
      >
        {D.open}
      </button>
      {open && (
        <div
          id={`${id}-c`}
          className="li-delete-confirm stack"
          role="group"
          aria-labelledby={`${id}-q`}
        >
          {s.state === "reading" ? (
            <p className="ev-say" role="status" aria-busy="true" style={{ margin: 0 }}>
              {D.reading}
            </p>
          ) : (
            <>
              <p id={`${id}-q`} className="li-delete-ask" style={{ margin: 0 }}>
                {D.confirm(p.from, p.to, n)}
              </p>
              <p className="ev-say" style={{ margin: 0 }}>
                {D.intro}
              </p>
            </>
          )}
          {s.state === "working" && (
            <p className="ev-say" role="status" aria-busy="true" style={{ margin: 0 }}>
              {D.working}
            </p>
          )}
          {s.state === "error" && (
            <p className="state error" role="alert" style={{ margin: 0 }}>
              {s.interfaces ? D.failed(s.text) : D.readFailed(s.text)}
            </p>
          )}
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            {(s.state === "confirm" ||
              s.state === "working" ||
              (s.state === "error" && s.interfaces)) && (
              <button
                type="button"
                className="btn danger"
                ref={p.yes}
                disabled={s.state === "working"}
                aria-busy={s.state === "working"}
                onClick={p.onConfirm}
              >
                {D.yes}
              </button>
            )}
            <button
              type="button"
              className="btn"
              disabled={s.state === "working"}
              onClick={p.onCancel}
            >
              {D.no}
            </button>
            <ShowInConsole id={p.job} />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Every Interface behind a link: the view's joins, or (beta.24 review) every call merged into it
 * from GET /api/graph/edge-calls when the view lists fewer than it has. A lineless link's are
 * there too: an Interface needs no caller's line to be deleted.
 */
export async function linkInterfaces(
  link: Api.HierEdgeT,
  callsPath?: string,
  get: (path: string) => Promise<Api.GraphEdgeCallsViewT> = (path) => api(path),
): Promise<string[]> {
  const shown = (link.joins ?? []).map((j) => j.interface);
  if (link.count <= shown.length || !callsPath) return [...new Set(shown)];
  const all = await get(callsPath);
  return [...new Set(all.joins.map((j) => j.interface))];
}

/** Delete this link, with its state: every Interface on the link, then the job. */
export function DeleteLink(p: {
  link: Api.HierEdgeT;
  from: string;
  to: string;
  /** GET /api/graph/edge-calls for the link, when its view lists fewer calls than it has. */
  callsPath?: string;
  /** The link's decisions are written and the catalog built: the picture is read again. */
  onDeleted(d: { from: string; to: string; interfaces: readonly string[] }): void;
}) {
  const [now, setNow] = useState<DeleteState>({ state: "idle" });
  const [job, setJob] = useState<string | undefined>();
  const opener = useRef<HTMLButtonElement | null>(null);
  const yes = useRef<HTMLButtonElement | null>(null);
  const shown = (p.link.joins ?? []).map((j) => j.interface);
  // The confirm takes the focus once it can be answered; a Cancel gives it back to the opener.
  useEffect(() => {
    if (now.state === "confirm") yes.current?.focus();
  }, [now.state]);
  const open = async () => {
    if (p.link.count > shown.length && p.callsPath) setNow({ state: "reading" });
    try {
      setNow({ state: "confirm", interfaces: await linkInterfaces(p.link, p.callsPath) });
    } catch (e) {
      setNow({ state: "error", text: whyNot(e) });
    }
  };
  const confirm = async () => {
    if (!("interfaces" in now) || !now.interfaces) return;
    const interfaces = now.interfaces;
    setNow({ state: "working", interfaces });
    try {
      await followJob(
        "/api/links/delete",
        { interfaces, from: p.from, to: p.to },
        undefined,
        setJob,
      );
      setNow({ state: "done" });
      p.onDeleted({ from: p.from, to: p.to, interfaces });
    } catch (e) {
      setNow({ state: "error", text: whyNot(e), interfaces });
    }
  };
  return (
    <DeleteLinkView
      from={p.from}
      to={p.to}
      count={p.link.count}
      now={now}
      job={job}
      opener={opener}
      yes={yes}
      onOpen={() => void open()}
      onConfirm={() => void confirm()}
      onCancel={() => {
        setNow({ state: "idle" });
        opener.current?.focus();
      }}
    />
  );
}

/** A deleted link's Bring back, as it goes. */
export type BackState =
  | { state: "idle" }
  | { state: "working"; at: number }
  | { state: "done"; from: string; to: string }
  | { state: "error"; text: string };

/**
 * The links deleted on the canvas, each with Bring back, from their state, so tests can render
 * each. `only`: the Interfaces of one Delete (the panel just after it), else every link.
 */
export function DeletedLinksList(p: {
  of: Loaded<Api.DeletedLinksViewT>;
  only?: ReadonlySet<string> | undefined;
  back: BackState;
  onBack(link: Api.DeletedLinksViewT["links"][number], at: number): void;
  job?: string | undefined;
}) {
  const id = useId();
  const status =
    p.back.state === "done" ? (
      <p role="status" className="ev-say" style={{ margin: 0 }}>
        {L.backDone(p.back.from, p.back.to)}
      </p>
    ) : p.back.state === "error" ? (
      <p role="alert" className="state error" style={{ margin: 0 }}>
        {L.backFailed(p.back.text)}
      </p>
    ) : p.back.state === "working" ? (
      <p role="status" aria-busy="true" className="ev-say" style={{ margin: 0 }}>
        {L.backing}
      </p>
    ) : null;
  let body;
  if (p.of.state === "loading")
    body = (
      <p role="status" aria-busy="true" className="ev-say" style={{ margin: 0 }}>
        {L.loading}
      </p>
    );
  else if (p.of.state === "error")
    body = (
      <p role="alert" className="state error" style={{ margin: 0 }}>
        {L.failed(p.of.error)}
      </p>
    );
  else {
    const links = p.of.data.links.filter(
      (l) => !p.only || l.decisions.some((d) => p.only!.has(d.target)),
    );
    body = !links.length ? (
      p.back.state === "done" ? null : (
        <p className="ev-say" style={{ margin: 0 }}>
          {L.none}
        </p>
      )
    ) : (
      <ul className="stack" style={{ paddingLeft: 18, margin: 0 }}>
        {links.map((l, i) => (
          <li key={l.decisions[0]?.id ?? i}>
            {L.item(l.from, l.to, l.calls || l.decisions.length)}
            {l.by && <span className="hud"> · {L.by(l.by, l.at)}</span>}{" "}
            <button
              type="button"
              className="btn"
              aria-label={L.backOf(l.from, l.to)}
              disabled={p.back.state === "working"}
              aria-busy={p.back.state === "working" && p.back.at === i}
              onClick={() => p.onBack(l, i)}
            >
              {p.back.state === "working" && p.back.at === i ? L.backing : L.back}
            </button>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <section className="stack" aria-labelledby={`${id}-h`} style={{ gap: 6 }}>
      <h4 id={`${id}-h`} className="hud" style={{ margin: 0 }}>
        {L.title}
      </h4>
      {body}
      {status}
      <ShowInConsole id={p.job} />
    </section>
  );
}

/** Deleted links, read and brought back: `onBack` once a link is drawn again (read the picture). */
export function DeletedLinks(p: { only?: ReadonlySet<string>; onBack?(): void }) {
  const of = useApi<Api.DeletedLinksViewT>("/api/links/deleted");
  const [back, setBack] = useState<BackState>({ state: "idle" });
  const [job, setJob] = useState<string | undefined>();
  return (
    <DeletedLinksList
      of={of}
      only={p.only}
      back={back}
      job={job}
      onBack={(l, at) => {
        setBack({ state: "working", at });
        followJob(
          "/api/links/deleted/undo",
          { decisions: l.decisions.map((d) => d.id) },
          undefined,
          setJob,
        )
          .then(() => {
            setBack({ state: "done", from: l.from, to: l.to });
            p.onBack?.();
          })
          .catch((e: unknown) => setBack({ state: "error", text: whyNot(e) }))
          .finally(() => of.reload());
      }}
    />
  );
}
