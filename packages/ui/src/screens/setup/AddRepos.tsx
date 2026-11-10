import { useState } from "react";
import type { Api } from "@maycombhq/core";
import { api } from "../../api/client.js";
import { Panel } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { Note, useAction } from "../know/common.js";
import { EditPreview, type FileEdit } from "./EditPreview.js";

/**
 * ADR 0190: Set up › Repos › Add repos. Paste clone URLs (one a line, ~40 at once) or discover a
 * folder of clones (repos discover's code on the server). The list shows each normalised URL and
 * the id it gets, a clash given `-2` and why, and what the manifest lists already; the person
 * ticks what goes in, may say what each is, previews the manifest's lines, writes them, and
 * proposes them for review.
 */

const S = COPY.setup;
type Plan = Api.ReposPlanViewT;
type Row = Api.PlannedRepoViewT & { add: boolean; about: string };

/** The repos to send: those ticked, with their ids as edited and what each is, if said. */
export function reposToAdd(rows: readonly Row[]) {
  return rows
    .filter((r) => r.add && r.id.trim())
    .map((r) => ({
      id: r.id.trim(),
      url: r.url,
      type: r.type,
      ...(r.defaultBranch ? { defaultBranch: r.defaultBranch } : {}),
      ...(r.about.trim() ? { description: r.about.trim() } : {}),
    }));
}

export function PlanTable({
  plan,
  rows,
  setRows,
}: {
  plan: Plan;
  rows: Row[];
  setRows: (r: Row[]) => void;
}) {
  const set = (i: number, patch: Partial<Row>) =>
    setRows(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  return (
    <div className="stack" style={{ gap: 6 }}>
      {rows.length === 0 ? (
        <p className="state">{S.nothingNew}</p>
      ) : (
        <table className="run-table">
          <caption className="hud" style={{ textAlign: "left" }}>
            {S.toAdd(rows.filter((r) => r.add).length)}
          </caption>
          <thead>
            <tr>
              <th scope="col">{S.colAdd}</th>
              <th scope="col">{S.colId}</th>
              <th scope="col">{S.colUrl}</th>
              <th scope="col">{S.colType}</th>
              <th scope="col">{S.colAbout}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.url}>
                <td>
                  <input
                    type="checkbox"
                    checked={r.add}
                    aria-label={S.addFor(r.id)}
                    onChange={(e) => set(i, { add: e.target.checked })}
                  />
                </td>
                <td>
                  <input
                    className="field mono"
                    value={r.id}
                    aria-label={`${S.colId}: ${r.url}`}
                    onChange={(e) => set(i, { id: e.target.value })}
                    style={{ minWidth: 140 }}
                  />
                  {r.renamed && (
                    <div className="muted" style={{ fontSize: 11.5 }}>
                      {S.renamed(r.renamed.from, r.renamed.why)}
                    </div>
                  )}
                </td>
                <td className="mono" style={{ wordBreak: "break-all", fontSize: 12 }}>
                  {r.url}
                  {r.given && (
                    <div className="muted" style={{ fontSize: 11.5 }}>
                      {S.normalised(r.given)}
                    </div>
                  )}
                </td>
                <td className="mono">{r.type}</td>
                <td>
                  <input
                    className="field"
                    value={r.about}
                    maxLength={300}
                    aria-label={S.aboutFor(r.id)}
                    onChange={(e) => set(i, { about: e.target.value })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {plan.listed.map((l) => (
        <p key={l.url} className="muted" style={{ margin: 0, fontSize: 12 }}>
          {S.listed(l.url, l.id)}
        </p>
      ))}
      {plan.refused.map((x) => (
        <p key={x.given} className="run-note bad">
          {S.refused(x.given, x.why)}
        </p>
      ))}
      {plan.skipped.length > 0 && (
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          {S.skipped(plan.skipped.length)}
        </p>
      )}
    </div>
  );
}

export function AddRepos({ onAdded }: { onAdded?: () => void }) {
  const [mode, setMode] = useState<"paste" | "folder">("paste");
  const [urls, setUrls] = useState("");
  const [dir, setDir] = useState("");
  const [plan, setPlan] = useState<Plan>();
  const [rows, setRows] = useState<Row[]>([]);
  const [platform, setPlatform] = useState<string | undefined>();
  // The org pack's platforms, once a read has said them (the picker shows with several).
  const [platforms, setPlatforms] = useState<string[]>([]);
  // A new list starts the preview again (a written one keeps its Propose until then).
  const [round, setRound] = useState(0);
  const read = useAction();
  const given = mode === "paste" ? urls.trim() : dir.trim();
  const picked = reposToAdd(rows);
  const body = (preview: boolean) => ({
    repos: picked,
    ...(platform ? { platform } : {}),
    ...(preview ? { preview: true } : {}),
  });
  return (
    <Panel title={S.reposTitle}>
      <div className="stack" style={{ gap: 8 }}>
        <p className="muted" style={{ margin: 0, maxWidth: "70ch" }}>
          {S.reposIntro}
        </p>
        <fieldset className="row" style={{ gap: 12, border: 0, padding: 0, margin: 0 }}>
          <legend className="sr">{S.modeLabel}</legend>
          {(["paste", "folder"] as const).map((m) => (
            <label key={m} className="row" style={{ gap: 6 }}>
              <input
                type="radio"
                name="add-repos-mode"
                checked={mode === m}
                onChange={() => setMode(m)}
              />
              {m === "paste" ? S.pasteMode : S.folderMode}
            </label>
          ))}
        </fieldset>
        <form
          className="stack"
          style={{ gap: 6 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!given) return;
            void read.run(
              async () => {
                const p = await api<Plan>("/api/setup/repos/plan", {
                  method: "POST",
                  // A folder's repos are read for the platform chosen (discover's ids are that
                  // manifest's); with several and none chosen, the platforms come back first.
                  body:
                    mode === "paste"
                      ? { urls }
                      : { dir: dir.trim(), ...(platform ? { platform } : {}) },
                });
                setPlan(p);
                setPlatforms(p.platforms);
                // With several platforms, none is picked for the person.
                setPlatform(
                  p.platform ?? platform ?? (mode === "paste" ? p.platforms[0] : undefined),
                );
                setRows(p.repos.map((r) => ({ ...r, add: true, about: "" })));
                setRound(round + 1);
                return p;
              },
              (p) =>
                mode === "folder" && !p.platform && p.platforms.length > 1
                  ? S.choosePlatform(p.platforms.length)
                  : S.toAdd(p.repos.length),
            );
          }}
        >
          {mode === "paste" ? (
            <>
              <label htmlFor="add-repos-urls">{S.urls}</label>
              <textarea
                id="add-repos-urls"
                className="field mono"
                rows={6}
                value={urls}
                aria-describedby="add-repos-urls-hint"
                onChange={(e) => setUrls(e.target.value)}
              />
              <span id="add-repos-urls-hint" className="muted" style={{ fontSize: 12 }}>
                {S.urlsHint}
              </span>
            </>
          ) : (
            <>
              <label htmlFor="add-repos-dir">{S.dir}</label>
              <input
                id="add-repos-dir"
                className="field mono"
                value={dir}
                aria-describedby="add-repos-dir-hint"
                onChange={(e) => setDir(e.target.value)}
              />
              <span id="add-repos-dir-hint" className="muted" style={{ fontSize: 12 }}>
                {S.dirHint}
              </span>
            </>
          )}
          {platforms.length > 1 && (
            <div className="stack" style={{ gap: 4 }}>
              <label htmlFor="add-repos-platform">{S.platformLabel}</label>
              <select
                id="add-repos-platform"
                className="field"
                value={platform ?? ""}
                aria-describedby={
                  mode === "folder" && !platform ? "add-repos-platform-hint" : undefined
                }
                onChange={(e) => setPlatform(e.target.value || undefined)}
              >
                <option value="">{S.platformNone}</option>
                {platforms.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
              {mode === "folder" && !platform && (
                <span id="add-repos-platform-hint" className="state">
                  {S.choosePlatform(platforms.length)}
                </span>
              )}
            </div>
          )}
          <div className="row">
            <button type="submit" className="btn" disabled={read.busy || !given}>
              {read.busy ? S.reading : S.read}
            </button>
          </div>
          <Note note={read.note} />
        </form>
        {plan && (
          <>
            <PlanTable plan={plan} rows={rows} setRows={setRows} />
            {rows.length > 0 && (
              <EditPreview
                key={round}
                disabled={picked.length === 0}
                preview={() =>
                  api<FileEdit>("/api/setup/repos", { method: "POST", body: body(true) })
                }
                write={() =>
                  api<FileEdit>("/api/setup/repos", { method: "POST", body: body(false) })
                }
                onWritten={() => onAdded?.()}
              />
            )}
            {rows.length > 0 && picked.length === 0 && (
              <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                {S.noneTicked}
              </p>
            )}
          </>
        )}
      </div>
    </Panel>
  );
}
