import { useId, useState } from "react";
import { api } from "../api/client.js";
import { COPY } from "../copy.js";
import { Note, useAction } from "../screens/know/common.js";

const P = COPY.propose;

/**
 * Windows review: Apply, Propose and Bring in run as server jobs (an editor panel waits 30 s for
 * one answer). Starts one and follows it to the end: its lines, or an error with them.
 */
export async function followJob(
  path: string,
  body: unknown,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<{ code: number; lines: string[] }> {
  const { jobId } = await api<{ jobId: string }>(path, { method: "POST", body });
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
  | "outcomes";
interface Plan {
  scope: Scope;
  files: { path: string; status: string; from?: string }[];
  branch: string;
  title: string;
}

/**
 * ADR 0183: the steps after an answer, a correction or an audit, run from the app. Apply runs
 * `atticus verify <repo> --write`; Propose for review shows the files, the branch and the title,
 * and on the person's yes pushes exactly those and opens the PR. A person merges.
 */
export function ApplyAndPropose(p: { scope: Scope; repo?: string | undefined }) {
  const apply = useAction();
  const [applied, setApplied] = useState<string[]>();
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
                    );
                    setApplied(r.lines);
                  } catch (e) {
                    setApplied([(e as Error).message]);
                    throw new Error(P.applyFailed, { cause: e });
                  }
                }, P.applied(p.repo!))
              }
            >
              {apply.busy ? P.applying : P.apply(p.repo)}
            </button>
          </div>
          <Note note={apply.note} />
          {applied && applied.length > 0 && (
            <pre className="mono" style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: 11.5 }}>
              {applied.join("\n")}
            </pre>
          )}
        </div>
      )}
      <Propose scope={p.scope} />
    </div>
  );
}

export function Propose({ scope }: { scope: Scope }) {
  const [plan, setPlan] = useState<Plan>();
  const [off, setOff] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<string[]>();
  const look = useAction();
  const send = useAction();
  const id = useId();
  if (done)
    return (
      <div className="stack" style={{ gap: 4 }}>
        <div role="status" className="stack" style={{ gap: 4 }}>
          {done.map((l) => (
            <p key={l} style={{ margin: 0 }}>
              {l}
            </p>
          ))}
        </div>
        <BringIn />
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
              setPlan(await api<Plan>(`/api/propose?scope=${scope}`));
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
                  const r = await followJob("/api/propose", {
                    scope,
                    files: files.map((f) => f.path),
                    branch: plan.branch,
                  });
                  setDone(r.lines);
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
export function BringIn() {
  const act = useAction();
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="row" style={{ gap: 6, alignItems: "center" }}>
        <button
          type="button"
          className="btn"
          disabled={act.busy}
          onClick={() =>
            void act.run(
              () => followJob("/api/propose/bring-in", {}),
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
      <Note note={act.note} />
    </div>
  );
}
