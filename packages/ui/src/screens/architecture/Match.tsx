import { useEffect, useRef, useState } from "react";
import type { Api } from "@maycombhq/core";
import { api, ApiError, useLiveEvents } from "../../api/client.js";
import { COPY } from "../../copy.js";
import { CopyButton } from "../run/shared.js";

/**
 * ADR 0178, part 2: Match with Copilot. One session reads the repo's loose call sites and
 * proposes which of the other box's APIs each reaches, naming the lines; the answer comes back
 * checked, as proposals the person ticks (they become picks in the Connect table, previewed and
 * confirmed like any pairing). Where copilot-acp isn't allowed, the brief is written for Copilot
 * Chat and the answer is read back from its file. Copilot proposes; a person decides.
 */

const M = COPY.match;
const POLL_MS = 3000;

const errorOf = (e: unknown) =>
  e instanceof ApiError
    ? (e.problem.detail ?? e.message)
    : e instanceof Error
      ? e.message
      : String(e);

export type MatchIo = {
  get: () => Promise<Api.MatchLinksViewT>;
  post: () => Promise<Api.MatchLinksViewT>;
};

export function MatchWithCopilot(p: {
  from: string;
  box: Api.LinkBoxT;
  toName: string;
  calls: Api.LinkCandidatesViewT["calls"];
  apis: Api.LinkCandidatesViewT["apis"];
  /** Ticks the proposals in the table (picked and ticked), for Preview and Confirm. */
  onTake: (proposals: Api.MatchProposalT[]) => void;
  io?: MatchIo;
}) {
  const q = `from=${encodeURIComponent(p.from)}&${p.box.system ? `system=${encodeURIComponent(p.box.system)}` : `to=${encodeURIComponent(p.box.repo ?? "")}`}`;
  const io: MatchIo = p.io ?? {
    get: () => api<Api.MatchLinksViewT>(`/api/links/match?${q}`, { quiet: true }),
    post: () =>
      api<Api.MatchLinksViewT>("/api/links/match", {
        method: "POST",
        body: { from: p.from, to: p.box },
      }),
  };
  const [m, setM] = useState<Api.MatchLinksViewT | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [taken, setTaken] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const look = async () => {
    try {
      const v = await io.get();
      if (alive.current) setM(v);
      return v;
    } catch (e) {
      if (alive.current) setError(errorOf(e));
      return undefined;
    }
  };
  // Where it stands when the panel opens: an earlier answer is shown again.
  useEffect(() => {
    void look();
  }, [p.from, p.box.repo, p.box.system]);
  // While a session runs, look every few seconds; the job's done event looks at once.
  useEffect(() => {
    if (m?.state !== "running") return;
    const t = setInterval(() => void look(), POLL_MS);
    return () => clearInterval(t);
  }, [m?.state]);
  useLiveEvents((e) => {
    if (e.type === "job.done" && m?.jobId === e.jobId) void look();
  });
  const start = async () => {
    setBusy(true);
    setError(undefined);
    setTaken(false);
    try {
      const v = await io.post();
      if (alive.current) setM(v);
    } catch (e) {
      if (alive.current) setError(errorOf(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const label = (fact: string) => {
    const c = p.calls.find((x) => x.fact === fact);
    return c ? `${c.method ?? ""} ${c.path}`.trim() : fact;
  };
  const apiLabel = (id: string) => {
    const a = p.apis.find((x) => x.id === id);
    return a ? `${a.method ?? ""} ${a.path}`.trim() : id;
  };
  const state = m?.state ?? "idle";
  const proposals = m?.proposals ?? [];
  return (
    <div className="stack match-panel" style={{ gap: 6 }}>
      <p className="ev-say">{M.intro}</p>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button
          type="button"
          className="btn"
          disabled={busy || state === "running"}
          aria-busy={busy || state === "running"}
          onClick={() => void start()}
        >
          {state === "running" ? M.running : state === "done" ? M.again : M.start}
        </button>
        {(state === "handoff" || state === "failed") && (
          <button type="button" className="btn" disabled={busy} onClick={() => void look()}>
            {M.readAnswer}
          </button>
        )}
      </div>
      {state === "running" && (
        <p role="status" aria-live="polite" className="ev-say">
          {M.runningSay(p.from, p.toName)}
        </p>
      )}
      {state === "handoff" && m?.brief && (
        <div className="stack" role="status" style={{ gap: 4 }}>
          <p className="ev-say">{M.handoff(m.brief)}</p>
          <div className="row" style={{ gap: 6 }}>
            <code className="mono">{m.brief}</code>
            <CopyButton text={m.brief} label={`${M.copy}: ${m.brief}`} />
          </div>
          {m.answer && <p className="hud">{M.answerAt(m.answer)}</p>}
        </div>
      )}
      {(error || (state === "failed" && m?.error)) && (
        <p role="alert" className="state error">
          {error ?? m?.error}
        </p>
      )}
      {state === "done" && (
        <div className="stack" style={{ gap: 6 }}>
          <p className="ev-say" role="status">
            {M.done(proposals.length, m?.none.length ?? 0, m?.rejected.length ?? 0)}
          </p>
          {proposals.length > 0 && (
            <>
              <ul className="stack" style={{ gap: 4, margin: 0, paddingLeft: 18 }}>
                {proposals.map((x) => (
                  <li key={x.call}>
                    <code className="mono">{label(x.call)}</code> →{" "}
                    <code className="mono">{apiLabel(x.api)}</code>
                    {x.why ? <span className="muted"> · {x.why}</span> : null}
                    {x.lines.length > 0 && <div className="hud">{x.lines.join(", ")}</div>}
                  </li>
                ))}
              </ul>
              <div className="row" style={{ gap: 8 }}>
                <button
                  type="button"
                  className="btn"
                  disabled={taken}
                  onClick={() => {
                    p.onTake(proposals);
                    setTaken(true);
                  }}
                >
                  {taken ? M.taken : M.take(proposals.length)}
                </button>
              </div>
            </>
          )}
          {(m?.none.length ?? 0) > 0 && (
            <details>
              <summary className="hud">{M.noneTitle(m!.none.length)}</summary>
              <ul className="stack" style={{ gap: 2, margin: 0, paddingLeft: 18 }}>
                {m!.none.map((n) => (
                  <li key={n.call}>
                    <code className="mono">{label(n.call)}</code>
                    {n.why ? <span className="muted"> · {n.why}</span> : null}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {(m?.rejected.length ?? 0) > 0 && (
            <details>
              <summary className="hud">{M.rejectedTitle(m!.rejected.length)}</summary>
              <ul className="stack" style={{ gap: 2, margin: 0, paddingLeft: 18 }}>
                {m!.rejected.map((r, i) => (
                  <li key={i} className="muted">
                    {r}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
