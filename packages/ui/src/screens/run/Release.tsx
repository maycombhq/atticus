import { useState } from "react";
import { api, useApi, useLiveEvents, type Loaded } from "../../api/client.js";
import { Panel, View } from "../../app/ui.js";
import {
  ExportEvidence,
  NotesPanel,
  OutcomesPanel,
  PlanPanels,
  SecurityPanel,
} from "./ReleaseViews.js";
import { Note, plural, useAction } from "./shared.js";

interface ReleaseItem {
  id: string;
  title: string;
  type: string;
  state: string;
  atRelease: boolean;
}
interface Reason {
  code: string;
  message: string;
}
interface Request {
  heading: string;
  requestType: string;
  record: string;
  leadTimeDays?: number;
  state: "to-file" | "waiting" | "filed";
  number?: string;
  missing: string[];
}
interface RepoRow {
  id: string;
  branch: string;
  pr?: { number: number; state: string; url?: string };
  build: { status: string; sha?: string };
}
interface ReleaseDetail {
  change: {
    id: string;
    title: string;
    type: string;
    state: string;
    owners: Record<string, string[]>;
  };
  status: {
    state: string;
    phase?: string;
    nextStep: string;
    risk: { level: string; score: number };
    required: { roles: string[]; min: number; label: string }[];
    blockers: Reason[];
    reasons: Reason[];
  };
  releaseApprovers?: { roles: string[]; min: number };
  handoff?: { state: string; pr: string; approvals: { by: string; roles: string[] }[] };
  openFindings: { blocking: number; gap: number; risk: number; idea: number };
  requests: { total: number; filed: number; toFile: number; list: Request[] };
  repos: RepoRow[];
  rollout?: { heading: string; text: string };
  conflicts: { with: string; overlap: Record<string, string[]> }[];
  archive: { pass: boolean; blockers: Reason[]; notes: string[] };
  evidence: { path: string; bytes: number }[];
}

const STATE_LABEL: Record<string, string> = {
  "release-ready": "AT GO / NO-GO",
  released: "RELEASED",
  "post-release-review": "POST-RELEASE REVIEW",
};

function List({ list, current }: { list: Loaded<ReleaseItem[]>; current?: string }) {
  return (
    <Panel title="Changes" span="span 3" rows="span 3">
      <View of={list} empty={(l) => l.length === 0} emptyText="No changes in flight.">
        {(l) => (
          <nav aria-label="Changes" className="stack" style={{ gap: 2 }}>
            {l.map((c) => (
              <a
                key={c.id}
                href={`#/release/${c.id}`}
                aria-current={c.id === current ? "page" : undefined}
                className="list-row"
                style={{
                  textDecoration: "none",
                  padding: "8px 6px",
                  borderRadius: 6,
                  background: c.id === current ? "rgba(46,230,246,0.08)" : undefined,
                }}
              >
                <span className="stack" style={{ gap: 2, minWidth: 0 }}>
                  <span className="mono" style={{ fontSize: 12 }}>
                    {c.id}
                  </span>
                  <span className="muted" style={{ fontSize: 11.5 }}>
                    {c.title}
                  </span>
                </span>
                <span className={`chip ${c.atRelease ? "warn" : "dim"}`}>
                  {STATE_LABEL[c.state] ?? c.state.toUpperCase()}
                </span>
              </a>
            ))}
          </nav>
        )}
      </View>
    </Panel>
  );
}

function Gate(p: { label: string; value: string; ok: boolean; warn?: boolean; detail: string }) {
  return (
    <li aria-label={`${p.label}: ${p.value}`}>
      <span className="hud" style={{ fontSize: 10 }}>
        {p.label}
      </span>
      <span
        className={`chip ${p.ok ? "done" : p.warn ? "warn" : "blocking"}`}
        style={{ alignSelf: "flex-start" }}
      >
        {p.value}
      </span>
      <span className="muted" style={{ fontSize: 11.5 }}>
        {p.detail}
      </span>
    </li>
  );
}

function Detail({ id }: { id: string }) {
  const d = useApi<ReleaseDetail>(`/api/release/${id}`);
  const act = useAction();
  // the generated views reload with the screen when a file changes
  const [tick, setTick] = useState(0);
  useLiveEvents((e) => {
    if (e.type !== "file.changed") return;
    d.reload();
    setTick((t) => t + 1);
  });
  const post = (path: string, body: unknown, ok: string) =>
    void act.run(() => api(path, { method: "POST", body }).then(() => d.reload()), ok);

  return (
    <>
      <Panel
        title={d.state === "ready" ? `${d.data.change.id} · ${d.data.change.title}` : id}
        span="span 9"
        kind="hero"
      >
        <View of={d}>
          {(r) => {
            const blockingFindings = r.openFindings.blocking + r.openFindings.gap;
            const approvals = r.handoff?.approvals.length ?? 0;
            const min = r.releaseApprovers?.min ?? 1;
            return (
              <div className="stack" style={{ gap: 12 }}>
                <p style={{ margin: 0, fontSize: 14 }}>
                  <span className="hud" style={{ marginRight: 8 }}>
                    Next
                  </span>
                  {r.status.nextStep}
                </p>
                <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                  <span className="chip dim">TYPE {r.change.type.toUpperCase()}</span>
                  <span
                    className={`chip ${r.status.risk.level === "high" ? "blocking" : r.status.risk.level === "medium" ? "warn" : ""}`}
                  >
                    RISK {r.status.risk.level.toUpperCase()}
                  </span>
                  <span className="chip">
                    {(STATE_LABEL[r.change.state] ?? r.change.state).toUpperCase()}
                  </span>
                </div>
                <ul className="run-gates" aria-label="Gates to go-live">
                  <Gate
                    label="Requests"
                    value={
                      r.requests.total === 0
                        ? "NONE NEEDED"
                        : r.requests.toFile
                          ? `${r.requests.toFile} NOT FILED`
                          : `${r.requests.filed} FILED`
                    }
                    ok={r.requests.toFile === 0}
                    detail={
                      r.requests.total === 0
                        ? "snow.md lists no service-desk request."
                        : `${r.requests.filed} of ${r.requests.total} filed.`
                    }
                  />
                  <Gate
                    label="Findings"
                    value={blockingFindings ? `${blockingFindings} OPEN` : "CLEAR"}
                    ok={blockingFindings === 0}
                    detail={`${r.openFindings.blocking} blocking, ${plural(r.openFindings.gap, "knowledge gap")}.`}
                  />
                  <Gate
                    label="Approvals"
                    value={
                      r.handoff
                        ? `${approvals} OF ${min}`
                        : r.change.state === "release-ready"
                          ? "NOT RAISED"
                          : "LATER"
                    }
                    ok={approvals >= min}
                    warn={!r.handoff}
                    detail={
                      r.releaseApprovers
                        ? `Go / no-go needs ${min} of: ${r.releaseApprovers.roles.join(", ")}.`
                        : "No release gate in gates.yaml."
                    }
                  />
                  <Gate
                    label="Archive gate"
                    value={r.archive.pass ? "OPEN" : `${r.archive.blockers.length} BLOCKERS`}
                    ok={r.archive.pass}
                    warn={!r.archive.pass && r.change.state !== "released"}
                    detail="Opens once released, merged, built and the catalog matches."
                  />
                </ul>
                <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                  A person approves every gate. The approver of go / no-go can't be someone who
                  wrote the plan or its tests.
                </p>
                <div className="row" style={{ flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="btn primary"
                    disabled={
                      act.busy ||
                      r.change.state !== "release-ready" ||
                      (!!r.handoff && r.handoff.state === "open")
                    }
                    title={
                      r.change.state !== "release-ready"
                        ? "The change reaches go / no-go after QA"
                        : undefined
                    }
                    onClick={() =>
                      post(
                        `/api/changes/${id}/handoff`,
                        {},
                        "Go / no-go PR opened. The release approvers can decide now.",
                      )
                    }
                  >
                    Ask for go / no-go
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={act.busy || !r.handoff}
                    onClick={() => post(`/api/changes/${id}/sync`, {}, "Synced with the Git host.")}
                  >
                    Sync approvals
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={
                      act.busy || !["released", "post-release-review"].includes(r.change.state)
                    }
                    title="Archives the change and rescans its repos"
                    onClick={() =>
                      post(`/api/release/${id}/archive`, {}, "Archived. Its repos were rescanned.")
                    }
                  >
                    Archive
                  </button>
                </div>
                <Note note={act.note} />
              </div>
            );
          }}
        </View>
      </Panel>

      <PlanPanels id={id} tick={tick} />

      <Panel title="What stops it" span="span 6">
        <View
          of={d}
          empty={(r) => r.status.blockers.length + r.status.reasons.length === 0}
          emptyText="Nothing stops this change right now."
        >
          {(r) => (
            <ul className="run-steps">
              {[...r.status.blockers, ...r.status.reasons]
                .filter((x, i, a) => a.findIndex((y) => y.message === x.message) === i)
                .map((x) => (
                  <li key={x.message}>{x.message}</li>
                ))}
            </ul>
          )}
        </View>
      </Panel>

      <Panel title="Archive gate" span="span 6">
        <View of={d}>
          {(r) =>
            r.archive.pass ? (
              <p className="run-note ok">The change may be archived.</p>
            ) : (
              <div className="stack">
                <ul className="run-steps">
                  {r.archive.blockers.map((b) => (
                    <li key={b.message}>{b.message}</li>
                  ))}
                </ul>
                {r.archive.notes.map((n) => (
                  <p key={n} className="muted" style={{ margin: 0, fontSize: 12 }}>
                    {n}
                  </p>
                ))}
              </div>
            )
          }
        </View>
      </Panel>

      <Panel title="Conflicts with other changes" span="span 6">
        <View
          of={d}
          empty={(r) => r.conflicts.length === 0}
          emptyText="No other open change touches the same things."
        >
          {(r) =>
            r.conflicts.map((c) => (
              <div key={c.with} className="list-row" style={{ alignItems: "flex-start" }}>
                <span className="stack" style={{ gap: 2 }}>
                  <a href={`#/release/${c.with}`} className="mono">
                    {c.with}
                  </a>
                  <span className="muted" style={{ fontSize: 12 }}>
                    Also touches{" "}
                    {Object.entries(c.overlap)
                      .filter(([, v]) => v.length)
                      .map(([k, v]) => `${k} ${v.join(", ")}`)
                      .join("; ")}
                    . Agree an order before release.
                  </span>
                </span>
                <span className="chip warn">OVERLAP</span>
              </div>
            ))
          }
        </View>
      </Panel>

      <Panel
        title="Evidence pack"
        meta={d.state === "ready" ? plural(d.data.evidence.length, "file") : undefined}
        span="span 6"
      >
        <View of={d} empty={(r) => r.evidence.length === 0} emptyText="The change folder is empty.">
          {(r) => (
            <div className="stack">
              <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                For the approval board or an audit: one Markdown document generated from the change
                folder (summary, every file with its sha-256, critic rounds and waivers, approvals,
                trace, requests and steps, drift and AI runs), each item with its source.
              </p>
              <ExportEvidence id={id} />
              <ul
                style={{
                  listStyle: "none",
                  margin: 0,
                  padding: 0,
                  maxHeight: 220,
                  overflow: "auto",
                }}
              >
                {r.evidence.map((f) => (
                  <li key={f.path} className="list-row" style={{ padding: "4px 0" }}>
                    <span className="mono" style={{ fontSize: 11.5 }}>
                      {f.path}
                    </span>
                    <span className="hud" style={{ fontSize: 9.5 }}>
                      {f.bytes < 1024 ? `${f.bytes} B` : `${Math.round(f.bytes / 1024)} KB`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </View>
      </Panel>

      <SecurityPanel id={id} tick={tick} />
      <NotesPanel id={id} tick={tick} />
      <OutcomesPanel id={id} tick={tick} />
    </>
  );
}

export function Release({ hash }: { hash: string }) {
  const id = hash.replace(/^#\/?release\/?/, "").split("?")[0] || undefined;
  const list = useApi<ReleaseItem[]>("/api/release");
  const current = id ?? (list.state === "ready" ? list.data[0]?.id : undefined);
  return (
    <div className="bento">
      <List list={list} current={current} />
      {current ? (
        <Detail key={current} id={current} />
      ) : (
        <Panel title="No change selected" span="span 9">
          <p className="muted" style={{ margin: 0 }}>
            Pick a change on the left. Changes reach go / no-go after QA.
          </p>
        </Panel>
      )}
    </div>
  );
}
