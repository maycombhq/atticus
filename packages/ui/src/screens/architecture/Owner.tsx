import { useEffect, useId, useState } from "react";
import type { Api } from "@maycombhq/core";
import { api, ApiError, useApi, type Loaded } from "../../api/client.js";
import { COPY } from "../../copy.js";
import { CopyButton } from "../run/shared.js";

/**
 * G2 (ADR 0174): a repo's owner and system, set from its box. Pick a team (or add one, for
 * review) and a system; Preview shows the lines that change in each file; Write it writes them.
 */

const O = COPY.owner;
const ADD = "\u0000add";

const errorOf = (e: unknown) =>
  e instanceof ApiError
    ? (e.problem.detail ?? e.message)
    : e instanceof Error
      ? e.message
      : String(e);

export function OwnerPanel(p: { repo: string; onClose(): void }) {
  const v = useApi<Api.RepoOwnerViewT>(`/api/repos/${encodeURIComponent(p.repo)}/owner`);
  return <OwnerForm repo={p.repo} view={v} onClose={p.onClose} />;
}

/** The form from the view as loaded (tests render each state). */
export function OwnerForm(p: {
  repo: string;
  view: Loaded<Api.RepoOwnerViewT> & { reload?: () => void };
  onClose(): void;
  put?: (body: Api.SetRepoOwnerRequestT) => Promise<Api.SetRepoOwnerResultT>;
}) {
  const id = useId();
  const v = p.view.state === "ready" ? p.view.data : undefined;
  const [owner, setOwner] = useState("");
  const [system, setSystem] = useState("");
  const [teamId, setTeamId] = useState("");
  const [teamName, setTeamName] = useState("");
  const [busy, setBusy] = useState<"preview" | "write" | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [preview, setPreview] = useState<Api.SetRepoOwnerResultT | undefined>();
  const [written, setWritten] = useState<Api.SetRepoOwnerResultT | undefined>();
  useEffect(() => {
    if (!v) return;
    setOwner(v.owner);
    setSystem(v.system ?? "");
  }, [v]);
  const put =
    p.put ??
    ((body: Api.SetRepoOwnerRequestT) =>
      api<Api.SetRepoOwnerResultT>(`/api/repos/${encodeURIComponent(p.repo)}/owner`, {
        method: "PUT",
        body,
      }));
  const body = (): Api.SetRepoOwnerRequestT | undefined => {
    if (!v) return undefined;
    const b: Api.SetRepoOwnerRequestT = {};
    if (owner === ADD) {
      if (teamId.trim() && teamName.trim())
        b.addTeam = { id: teamId.trim(), name: teamName.trim() };
    } else if (owner && owner !== v.owner) b.owner = owner;
    if (system && system !== (v.system ?? "")) b.system = system;
    return b.owner || b.system || b.addTeam ? b : undefined;
  };
  // What the form says now: Write it writes only what was previewed, nothing changed since.
  const asked = JSON.stringify(body() ?? null);
  const [previewed, setPreviewed] = useState<string | undefined>();
  const send = async (mode: "preview" | "write") => {
    const b = body();
    if (!b) {
      setError(O.nothing);
      setPreview(undefined);
      return;
    }
    setBusy(mode);
    setError(undefined);
    try {
      const r = await put({ ...b, ...(mode === "preview" ? { preview: true } : {}) });
      if (mode === "preview") {
        setPreview(r);
        // The form as it was sent, not as it is when the answer comes.
        setPreviewed(JSON.stringify(b));
      } else {
        setWritten(r);
        setPreview(undefined);
        p.view.reload?.();
      }
    } catch (e) {
      setError(errorOf(e));
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <section className="stack connect-panel" aria-labelledby={`${id}-t`}>
      <div className="row between">
        <h4 id={`${id}-t`} className="h" style={{ fontSize: 14, margin: 0 }}>
          {O.title(p.repo)}
        </h4>
        <button type="button" className="btn" onClick={p.onClose}>
          {O.close}
        </button>
      </div>
      {p.view.state === "loading" && (
        <p role="status" aria-busy="true" className="ev-say">
          {O.loading}
        </p>
      )}
      {p.view.state === "error" && (
        <p role="alert" className="state error">
          {O.failed(p.view.error)}
        </p>
      )}
      {v && (
        <>
          <p className="ev-say">{O.intro(v.file)}</p>
          <label htmlFor={`${id}-o`} className="hud">
            {O.owner}
          </label>
          <select
            id={`${id}-o`}
            className="field"
            value={owner}
            onChange={(e) => {
              setOwner(e.target.value);
              setPreview(undefined);
            }}
          >
            {!v.teams.some((t) => t.id === v.owner) && <option value={v.owner}>{v.owner}</option>}
            {v.teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name === t.id ? t.id : `${t.name} (${t.id})`}
              </option>
            ))}
            <option value={ADD}>{O.addTeam}</option>
          </select>
          {owner === ADD && (
            <div className="stack">
              <label htmlFor={`${id}-ti`} className="hud">
                {O.teamId}
              </label>
              <input
                id={`${id}-ti`}
                className="field"
                value={teamId}
                onChange={(e) => setTeamId(e.target.value)}
              />
              <label htmlFor={`${id}-tn`} className="hud">
                {O.teamName}
              </label>
              <input
                id={`${id}-tn`}
                className="field"
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
              />
              <p className="ev-say">{O.teamNote}</p>
            </div>
          )}
          <label htmlFor={`${id}-s`} className="hud">
            {O.system}
          </label>
          <select
            id={`${id}-s`}
            className="field"
            value={system}
            onChange={(e) => {
              setSystem(e.target.value);
              setPreview(undefined);
            }}
          >
            {!v.system && <option value="">{O.noSystem}</option>}
            {v.system && !v.systems.some((s) => s.id === v.system) && (
              <option value={v.system}>{v.system}</option>
            )}
            {v.systems.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name === s.id ? s.id : `${s.name} (${s.id})`}
              </option>
            ))}
          </select>
          {error && (
            <p role="alert" className="state error">
              {error}
            </p>
          )}
          <div className="row" style={{ gap: 8 }}>
            <button
              type="button"
              className="btn"
              disabled={!!busy}
              aria-busy={busy === "preview"}
              onClick={() => void send("preview")}
            >
              {busy === "preview" ? O.previewing : O.preview}
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={!!busy || !preview || previewed !== asked}
              aria-busy={busy === "write"}
              onClick={() => void send("write")}
            >
              {busy === "write" ? O.writing : O.confirm}
            </button>
          </div>
          {preview && previewed === asked && <Diff r={preview} />}
          {written && (
            <div className="stack" role="status">
              <p className="ev-say">{O.written}</p>
              {[written.verify, written.commit].map((c) => (
                <div key={c} className="row" style={{ gap: 6 }}>
                  <code className="mono">{c}</code>
                  <CopyButton text={c} label={`${O.copy}: ${c}`} />
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** The lines each file would change: `-` was, `+` now. */
export function Diff({ r }: { r: Api.SetRepoOwnerResultT }) {
  return (
    <div className="stack">
      {r.files.map((f) => (
        <figure key={f.file} style={{ margin: 0 }}>
          <figcaption className="hud">{O.diffOf(f.file)}</figcaption>
          <pre className="mono" style={{ whiteSpace: "pre-wrap", margin: 0 }}>
            <code>
              {f.changes
                .flatMap((c) => [
                  ...(c.was !== undefined ? [`- ${c.was}`] : []),
                  ...(c.now !== undefined ? [`+ ${c.now}`] : []),
                ])
                .join("\n")}
            </code>
          </pre>
        </figure>
      ))}
    </div>
  );
}
