import { useState } from "react";
import type { Api } from "@maycombhq/core";
import { api, useApi, useReloadOnFiles } from "../../api/client.js";
import { Panel, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { Note, useAction } from "../know/common.js";

/**
 * Set up › Repos (ADR 0123): each repo's branches. The default branch the catalog is read from
 * (and the remote's, when it says another), the commit the baseline was read from, the other
 * branches people work on, and those scanned beside the baseline. Scan a branch (the scan job
 * with `ref`), compare it with the baseline, and edit the branches (written to the manifest).
 */

const R = COPY.repos;

type Repo = Api.RepoBranchesViewT;

/** The branches as typed, one a line or comma-separated, without blanks or repeats. */
export function branchesOf(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,]/)
        .map((b) => b.trim())
        .filter(Boolean),
    ),
  ];
}

function Compare({ c }: { c: Api.BranchCompareT }) {
  return (
    <div className="stack" style={{ gap: 4 }} aria-live="polite">
      <p style={{ margin: 0 }}>
        {R.compared(c.branch, c.added.length, c.removed.length, c.changed.length)}
      </p>
      {c.added.length + c.removed.length + c.changed.length > 0 && (
        <ul className="mono" style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
          {c.added.map((x) => (
            <li key={`+${x}`}>+ {x}</li>
          ))}
          {c.removed.map((x) => (
            <li key={`-${x}`}>- {x}</li>
          ))}
          {c.changed.map((x) => (
            <li key={`~${x.record}`}>
              ~ {x.record} ({x.fields.join(", ")})
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function RepoRow({ r, onChanged }: { r: Repo; onChanged?: () => void }) {
  const [editing, setEditing] = useState(false);
  const [def, setDef] = useState(r.defaultBranch);
  const [branches, setBranches] = useState(r.branches.join("\n"));
  const [compare, setCompare] = useState<Api.BranchCompareT | undefined>();
  const act = useAction();
  const save = useAction();
  const differs = r.remoteDefault && r.remoteDefault !== r.defaultBranch;
  return (
    <article className="list-row" style={{ display: "block" }} aria-labelledby={`repo-${r.id}`}>
      <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}>
        <h3 id={`repo-${r.id}`} className="h" style={{ fontSize: 14, margin: 0 }}>
          {r.id}
        </h3>
        <span className="muted" style={{ fontSize: 12 }}>
          {R.typeOwner(r.type, r.owner)}
        </span>
      </div>
      <dl className="run-facts" style={{ margin: "8px 0" }}>
        <dt>{R.url}</dt>
        <dd className="mono" style={{ wordBreak: "break-all" }}>
          {r.url}
        </dd>
        <dt>{R.defaultBranch}</dt>
        <dd>
          <span className="mono">{r.defaultBranch}</span>
          {r.commit && <span className="muted">{` · ${R.atCommit(r.commit.slice(0, 7))}`}</span>}
          {differs && (
            <span className="chip warn" style={{ marginLeft: 6 }}>
              {R.remoteSays(r.remoteDefault!)}
            </span>
          )}
        </dd>
        <dt>{R.branches}</dt>
        <dd>{r.branches.length ? r.branches.join(", ") : R.noBranches}</dd>
      </dl>
      {r.scans.length > 0 && (
        <ul style={{ margin: "0 0 8px", paddingLeft: 18, fontSize: 12.5 }}>
          {r.scans.map((s) => (
            <li key={s.branch}>
              {R.scanned(s.branch, s.scannedAt.slice(0, 10), s.commit.slice(0, 7))}
            </li>
          ))}
        </ul>
      )}
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        {r.branches.map((b) => (
          <button
            key={`scan-${b}`}
            type="button"
            className="btn"
            disabled={act.busy}
            onClick={() =>
              void act.run(
                () => api("/api/scan", { method: "POST", body: { repos: [r.id], ref: b } }),
                R.scanStarted(b),
              )
            }
          >
            {R.scan(b)}
          </button>
        ))}
        {r.scans.map((s) => (
          <button
            key={`cmp-${s.branch}`}
            type="button"
            className="btn"
            disabled={act.busy}
            onClick={() =>
              void act.run(async () => {
                setCompare(
                  await api<Api.BranchCompareT>(
                    `/api/repos/compare?branch=${encodeURIComponent(s.branch)}`,
                  ),
                );
              }, R.comparedNow)
            }
          >
            {R.compare(s.branch, r.defaultBranch)}
          </button>
        ))}
        <button
          type="button"
          className="btn"
          aria-expanded={editing}
          onClick={() => setEditing(!editing)}
        >
          {R.edit}
        </button>
      </div>
      <Note note={act.note} />
      {compare && <Compare c={compare} />}
      {editing && (
        <form
          className="stack"
          style={{ marginTop: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            void save.run(async () => {
              const res = await api<{ note: string }>(`/api/repos/${r.id}/branches`, {
                method: "PUT",
                body: { defaultBranch: def, branches: branchesOf(branches) },
              });
              onChanged?.();
              return res;
            }, R.saved);
          }}
        >
          <label className="row" style={{ gap: 8 }}>
            <span style={{ minWidth: 140 }}>{R.defaultBranch}</span>
            <input
              id={`repo-${r.id}-default`}
              className="field mono"
              value={def}
              onChange={(e) => setDef(e.target.value)}
            />
          </label>
          <label className="stack" htmlFor={`repo-${r.id}-branches`}>
            <span>{R.branches}</span>
            <span className="muted">{R.branchesHint}</span>
          </label>
          <textarea
            id={`repo-${r.id}-branches`}
            className="field mono"
            rows={3}
            value={branches}
            onChange={(e) => setBranches(e.target.value)}
          />
          <div className="row" style={{ gap: 8 }}>
            <button type="submit" className="btn primary" disabled={save.busy}>
              {R.save}
            </button>
          </div>
          <Note note={save.note} />
        </form>
      )}
    </article>
  );
}

export function Repos() {
  const list = useApi<Api.RepoBranchesListT>("/api/repos/branches");
  useReloadOnFiles(list);
  return (
    <Panel title={R.title}>
      <p className="muted" style={{ margin: "0 0 8px", maxWidth: "70ch" }}>
        {R.intro}
      </p>
      <View of={list} empty={(d) => d.repos.length === 0} emptyText={R.empty}>
        {(d) => (
          <div className="stack" style={{ gap: 8 }}>
            {d.repos.map((r) => (
              <RepoRow key={r.id} r={r} onChanged={list.reload} />
            ))}
          </div>
        )}
      </View>
    </Panel>
  );
}
