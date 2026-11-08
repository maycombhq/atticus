import { useId, useState } from "react";
import type { Api } from "@maycombhq/core";
import { api, ApiError, useApi, type Loaded } from "../../api/client.js";
import { RunWithCopilot } from "../../app/copilot-runs.js";
import { COPY } from "../../copy.js";
import { AiChip } from "../../app/decisions.js";
import { CopyButton } from "../run/shared.js";
import { Diff } from "./Owner.js";

/**
 * G3 (ADR 0174): declare a link the code can't show, a box's corrections with Undo, and Add to
 * the picture. Each writes a file for review after the person's yes, preview first; nothing here
 * is a fact.
 */

const D = COPY.declare;
const K = COPY.corrections;
const A = COPY.addBox;

const errorOf = (e: unknown) =>
  e instanceof ApiError
    ? (e.problem.detail ?? e.message)
    : e instanceof Error
      ? e.message
      : String(e);

function Cmds({ r, label }: { r: Api.FileChangeResultT; label: string }) {
  return (
    <div className="stack" role="status">
      <p className="ev-say">{label}</p>
      {[r.verify, r.commit].filter(Boolean).map((c) => (
        <div key={c} className="row" style={{ gap: 6 }}>
          <code className="mono">{c}</code>
          <CopyButton text={c} label={`${D.copy}: ${c}`} />
        </div>
      ))}
    </div>
  );
}

/** A request built from the form, or none when it lacks the topic or the route. */
export function declareBody(
  system: string,
  kind: "publishes" | "listens" | "call",
  value: string,
): Api.DeclareLinkRequestT | undefined {
  const v = value.trim();
  if (!v) return undefined;
  return kind === "call"
    ? { kind: "call", system, route: v }
    : { kind: "topic", system, topic: v, side: kind };
}

export function DeclarePanel(p: {
  system: string;
  label: string;
  onClose(): void;
  post?: (body: Api.DeclareLinkRequestT) => Promise<Api.FileChangeResultT>;
}) {
  const id = useId();
  const [kind, setKind] = useState<"publishes" | "listens" | "call">("publishes");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState<"preview" | "write" | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [preview, setPreview] = useState<Api.FileChangeResultT | undefined>();
  const [written, setWritten] = useState<Api.FileChangeResultT | undefined>();
  const post =
    p.post ??
    ((body: Api.DeclareLinkRequestT) =>
      api<Api.FileChangeResultT>("/api/declared-links", { method: "POST", body }));
  // What the form says now: Write it writes only what was previewed, nothing changed since.
  const asked = JSON.stringify(declareBody(p.system, kind, value) ?? null);
  const [previewed, setPreviewed] = useState<string | undefined>();
  const send = async (mode: "preview" | "write") => {
    const b = declareBody(p.system, kind, value);
    if (!b) {
      setError(D.empty);
      return;
    }
    setBusy(mode);
    setError(undefined);
    try {
      const r = await post({ ...b, ...(mode === "preview" ? { preview: true } : {}) });
      if (mode === "preview") {
        setPreview(r);
        // The form as it was sent, not as it is when the answer comes.
        setPreviewed(JSON.stringify(b));
      } else {
        setWritten(r);
        setPreview(undefined);
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
          {D.title(p.label)}
        </h4>
        <button type="button" className="btn" onClick={p.onClose}>
          {D.close}
        </button>
      </div>
      <p className="ev-say">{D.intro}</p>
      <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="hud">{D.kind}</legend>
        {(["publishes", "listens", "call"] as const).map((k) => (
          <label key={k} className="row" style={{ gap: 6 }}>
            <input
              type="radio"
              name={`${id}-k`}
              checked={kind === k}
              onChange={() => {
                setKind(k);
                setPreview(undefined);
              }}
            />
            {D.kinds[k]}
          </label>
        ))}
      </fieldset>
      <label htmlFor={`${id}-v`} className="hud">
        {kind === "call" ? D.route : D.topic}
      </label>
      <input
        id={`${id}-v`}
        className="field"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setPreview(undefined);
        }}
      />
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
          {busy === "preview" ? D.previewing : D.preview}
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={!!busy || !preview || previewed !== asked}
          onClick={() => void send("write")}
        >
          {busy === "write" ? D.writing : D.confirm}
        </button>
      </div>
      {preview && previewed === asked && <Diff r={preview} />}
      {written && <Cmds r={written} label={D.written} />}
    </section>
  );
}

/** A box's corrections (a repo's) or declarations (a system's), each with Undo. */
export function BoxCorrections(p: { box: Api.LinkBoxT }) {
  const [open, setOpen] = useState(false);
  const path = p.box.repo
    ? `/api/boxes/corrections?repo=${encodeURIComponent(p.box.repo)}`
    : `/api/boxes/corrections?system=${encodeURIComponent(p.box.system!)}`;
  const v = useApi<Api.BoxCorrectionsT>(open ? path : undefined);
  return (
    <div className="stack">
      <h4 className="hud">{K.title}</h4>
      {!open ? (
        <button type="button" className="btn" onClick={() => setOpen(true)}>
          {K.show}
        </button>
      ) : (
        <CorrectionsList of={v} />
      )}
    </div>
  );
}

export function CorrectionsList(p: {
  of: Loaded<Api.BoxCorrectionsT> & { reload?: () => void };
  undo?: (
    u: Api.BoxCorrectionsT["items"][number]["undo"],
  ) => Promise<Api.FileChangeResultT | { verify: string; commit: string }>;
}) {
  const [busy, setBusy] = useState<number | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<{ verify: string; commit: string } | undefined>();
  const undo =
    p.undo ??
    ((u: Api.BoxCorrectionsT["items"][number]["undo"]) =>
      "line" in u
        ? api<{ verify: string; commit: string }>(
            `/api/facts/${encodeURIComponent(u.repo)}/corrections/undo`,
            { method: "POST", body: { line: u.line } },
          )
        : api<Api.FileChangeResultT>("/api/declared-links/undo", { method: "POST", body: u }));
  if (p.of.state === "loading")
    return (
      <p role="status" aria-busy="true" className="ev-say">
        {K.loading}
      </p>
    );
  if (p.of.state === "error")
    return (
      <p role="alert" className="state error">
        {K.failed(p.of.error)}
      </p>
    );
  const items = p.of.data.items;
  return (
    <div className="stack">
      {!items.length && <p className="ev-say">{K.none}</p>}
      {items.length > 0 && (
        <ul className="stack" style={{ paddingLeft: 18, margin: 0 }}>
          {items.map((x, i) => (
            <li key={`${x.file}:${i}`}>
              <span className="chip dim">{K.kinds[x.kind]}</span> {x.says}
              {/* ADR 0181: a pairing the AI decided is the AI's, with its run, never a person's. */}
              {x.ai && (
                <>
                  {" "}
                  <AiChip run={x.ai.run} />
                </>
              )}
              {x.by && <span className="hud"> · {K.by(x.by, x.at ?? "")}</span>}{" "}
              <button
                type="button"
                className="btn"
                disabled={busy !== undefined}
                aria-busy={busy === i}
                onClick={() => {
                  setBusy(i);
                  setError(undefined);
                  undo(x.undo)
                    .then((r) => {
                      setDone({ verify: r.verify, commit: r.commit });
                      p.of.reload?.();
                    })
                    .catch((e: unknown) => setError(errorOf(e)))
                    .finally(() => setBusy(undefined));
                }}
              >
                {busy === i ? K.undoing : K.undo}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="state error">
          {error}
        </p>
      )}
      {done && (
        <div className="stack" role="status">
          <p className="ev-say">{K.undone}</p>
          {[done.verify, done.commit].map((c) => (
            <div key={c} className="row" style={{ gap: 6 }}>
              <code className="mono">{c}</code>
              <CopyButton text={c} label={`${D.copy}: ${c}`} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Add to the picture: read a repo not read yet, or add a vendor or team system for review. */
export function AddBoxPanel(p: { onClose(): void }) {
  const v = useApi<Api.AddableViewT>("/api/boxes/addable");
  return <AddBoxForm of={v} onClose={p.onClose} />;
}

export function AddBoxForm(p: {
  of: Loaded<Api.AddableViewT>;
  onClose(): void;
  post?: (b: Api.AddSystemRequestT) => Promise<Api.FileChangeResultT>;
}) {
  const id = useId();
  const [sid, setSid] = useState("");
  const [name, setName] = useState("");
  const [boundary, setBoundary] = useState<"vendor" | "internal">("vendor");
  const [owner, setOwner] = useState("");
  const [busy, setBusy] = useState<"preview" | "write" | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [preview, setPreview] = useState<Api.FileChangeResultT | undefined>();
  const [written, setWritten] = useState<Api.FileChangeResultT | undefined>();
  const post =
    p.post ??
    ((b: Api.AddSystemRequestT) =>
      api<Api.FileChangeResultT>("/api/boxes", { method: "POST", body: b }));
  // What the form says now: Write it writes only what was previewed, nothing changed since.
  const body = {
    id: sid.trim(),
    name: name.trim(),
    boundary,
    ...(owner && boundary === "internal" ? { owner } : {}),
  };
  const asked = JSON.stringify(body);
  const [previewed, setPreviewed] = useState<string | undefined>();
  const send = async (mode: "preview" | "write") => {
    setBusy(mode);
    setError(undefined);
    try {
      const r = await post({ ...body, ...(mode === "preview" ? { preview: true } : {}) });
      if (mode === "preview") {
        setPreview(r);
        setPreviewed(JSON.stringify(body));
      } else {
        setWritten(r);
        setPreview(undefined);
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
          {A.title}
        </h4>
        <button type="button" className="btn" onClick={p.onClose}>
          {A.close}
        </button>
      </div>
      {p.of.state === "loading" && (
        <p role="status" aria-busy="true" className="ev-say">
          {A.loading}
        </p>
      )}
      {p.of.state === "error" && (
        <p role="alert" className="state error">
          {A.failed(p.of.error)}
        </p>
      )}
      {p.of.state === "ready" && (
        <>
          {(() => {
            const unread = p.of.data.repos.filter((r) => !r.read);
            return unread.length ? (
              <>
                <p className="ev-say">{A.notRead}</p>
                <ul className="stack" style={{ paddingLeft: 18, margin: 0 }}>
                  {unread.map((r) => (
                    <li key={r.id} className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                      <span className="mono">{r.name}</span>
                      <RunWithCopilot
                        ask={{ kind: "repos", repos: [r.id] }}
                        label={COPY.copilotRuns.start.repos(r.id)}
                      />
                      <code className="mono">{A.readCommand(r.id)}</code>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="ev-say">{A.allRead}</p>
            );
          })()}
          <h5 className="hud">{A.newSystem}</h5>
          <label htmlFor={`${id}-id`} className="hud">
            {A.id}
          </label>
          <input
            id={`${id}-id`}
            className="field"
            value={sid}
            onChange={(e) => setSid(e.target.value)}
          />
          <label htmlFor={`${id}-n`} className="hud">
            {A.name}
          </label>
          <input
            id={`${id}-n`}
            className="field"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <label htmlFor={`${id}-b`} className="hud">
            {A.boundary}
          </label>
          <select
            id={`${id}-b`}
            className="field"
            value={boundary}
            onChange={(e) => setBoundary(e.target.value as "vendor" | "internal")}
          >
            {(["vendor", "internal"] as const).map((b) => (
              <option key={b} value={b}>
                {A.boundaries[b]}
              </option>
            ))}
          </select>
          {boundary === "internal" && (
            <>
              <label htmlFor={`${id}-o`} className="hud">
                {A.owner}
              </label>
              <select
                id={`${id}-o`}
                className="field"
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
              >
                <option value="">{A.noOwner}</option>
                {p.of.data.teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </>
          )}
          {error && (
            <p role="alert" className="state error">
              {error}
            </p>
          )}
          <div className="row" style={{ gap: 8 }}>
            <button
              type="button"
              className="btn"
              disabled={!!busy || !sid.trim() || !name.trim()}
              aria-busy={busy === "preview"}
              onClick={() => void send("preview")}
            >
              {busy === "preview" ? A.previewing : A.preview}
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={!!busy || !preview || previewed !== asked}
              onClick={() => void send("write")}
            >
              {busy === "write" ? A.writing : A.confirm}
            </button>
          </div>
          {preview && previewed === asked && <Diff r={preview} />}
          {written && <Cmds r={written} label={A.written} />}
        </>
      )}
    </section>
  );
}
