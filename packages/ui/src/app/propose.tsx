import { useId, useState } from "react";
import { api } from "../api/client.js";
import { COPY } from "../copy.js";
import { Note, useAction } from "../screens/know/common.js";

const P = COPY.propose;
type Scope = "answers" | "corrections" | "audit" | "org-pack";
interface Plan {
  scope: Scope;
  files: { path: string; status: string }[];
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
                  const r = await api<{ code?: number; lines: string[] }>(
                    `/api/facts/${encodeURIComponent(p.repo!)}/apply`,
                    { method: "POST", body: {} },
                  );
                  setApplied(r.lines);
                  if (r.code) throw new Error(P.applyFailed);
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
      <div role="status" className="stack" style={{ gap: 4 }}>
        {done.map((l) => (
          <p key={l} style={{ margin: 0 }}>
            {l}
          </p>
        ))}
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
                  const r = await api<{ lines: string[] }>("/api/propose", {
                    method: "POST",
                    body: { scope, files: files.map((f) => f.path) },
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
