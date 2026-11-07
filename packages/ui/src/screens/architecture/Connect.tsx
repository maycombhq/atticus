import { useEffect, useId, useMemo, useState } from "react";
import type { Api } from "@maycombhq/core";
import { api, ApiError, useApi, type Loaded } from "../../api/client.js";
import { CorrectionNextPanel } from "../../app/correction-next.js";
import { CopyButton } from "../run/shared.js";
import { COPY } from "../../copy.js";
import { MatchWithCopilot, type MatchIo } from "./Match.js";

/**
 * G1 (ADR 0174): connect two boxes call by call. From a repo's box, pick the other box (by
 * keyboard, from a list; a drag on the canvas opens the same panel with it picked), then pair
 * each loose call with an API, the likeliest one picked already. Preview says what the next
 * verify --write changes; nothing is written until the person confirms; each written line can be
 * undone.
 */

const C = COPY.connect;

export interface BoxChoice {
  label: string;
  box: Api.LinkBoxT;
}

const key = (b: Api.LinkBoxT) => (b.repo ? `repo:${b.repo}` : `system:${b.system}`);
const candidatesPath = (from: string, b: Api.LinkBoxT) =>
  `/api/links/candidates?from=${encodeURIComponent(from)}&${
    b.repo ? `to=${encodeURIComponent(b.repo)}` : `system=${encodeURIComponent(b.system!)}`
  }`;
const errorOf = (e: unknown) =>
  e instanceof ApiError
    ? (e.problem.detail ?? e.message)
    : e instanceof Error
      ? e.message
      : String(e);

/** The pairs to write: each ticked call with the API picked for it. */
export function pairsOf(
  picked: Readonly<Record<string, string>>,
  ticked: ReadonlySet<string>,
): { call: string; api: string }[] {
  return [...ticked]
    .filter((c) => picked[c])
    .sort()
    .map((call) => ({ call, api: picked[call]! }));
}

/** The likeliest API of each call, picked, and the calls with one ticked. */
export function initialPicks(v: Api.LinkCandidatesViewT): {
  picked: Record<string, string>;
  ticked: Set<string>;
} {
  const picked: Record<string, string> = {};
  const ticked = new Set<string>();
  for (const c of v.calls) {
    if (c.status === "paired") continue;
    if (c.suggestion) {
      picked[c.fact] = c.suggestion.api;
      // Only the confident ones start ticked: the rest a person looks at (Tick all suggested).
      if (c.confident) ticked.add(c.fact);
    }
  }
  return { picked, ticked };
}

export function ConnectPanel(p: {
  from: string;
  boxes: BoxChoice[];
  initial?: Api.LinkBoxT;
  onClose(): void;
}) {
  const id = useId();
  const [to, setTo] = useState<string>(p.initial ? key(p.initial) : "");
  const box = p.boxes.find((b) => key(b.box) === to)?.box;
  const cands = useApi<Api.LinkCandidatesViewT>(box ? candidatesPath(p.from, box) : undefined);
  return (
    <section className="stack connect-panel" aria-labelledby={`${id}-t`}>
      <div className="row between">
        <h4 id={`${id}-t`} className="h" style={{ fontSize: 14, margin: 0 }}>
          {C.title(p.from)}
        </h4>
        <button type="button" className="btn" onClick={p.onClose}>
          {C.close}
        </button>
      </div>
      <p className="ev-say">{C.intro}</p>
      <label htmlFor={`${id}-to`} className="hud">
        {C.pickBox}
      </label>
      <select id={`${id}-to`} className="field" value={to} onChange={(e) => setTo(e.target.value)}>
        <option value="">{C.pickBoxNone}</option>
        {p.boxes.map((b) => (
          <option key={key(b.box)} value={key(b.box)}>
            {b.label}
          </option>
        ))}
      </select>
      {box && <Pairing key={to} from={p.from} box={box} cands={cands} />}
    </section>
  );
}

/** The pairing table and its actions, from the candidates as loaded (tests render each state). */
export function Pairing(p: {
  from: string;
  box: Api.LinkBoxT;
  cands: Loaded<Api.LinkCandidatesViewT> & { reload?: () => void };
  /** Tests pass their own; the app calls the local API. */
  post?: (body: Api.ConnectLinksRequestT) => Promise<Api.ConnectLinksResultT>;
  match?: MatchIo;
}) {
  const v = p.cands.state === "ready" ? p.cands.data : undefined;
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [rule, setRule] = useState(false);
  const [busy, setBusy] = useState<"preview" | "write" | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [preview, setPreview] = useState<Api.ConnectLinksResultT | undefined>();
  const [written, setWritten] = useState<Api.ConnectLinksResultT | undefined>();
  const [undone, setUndone] = useState(false);
  useEffect(() => {
    if (!v) return;
    const i = initialPicks(v);
    setPicked(i.picked);
    setTicked(i.ticked);
  }, [v]);
  const loose = useMemo(() => v?.calls.filter((c) => c.status !== "paired") ?? [], [v]);
  const [find, setFind] = useState("");
  const tally = useMemo(
    () => ({
      confident: loose.filter((c) => c.confident).length,
      suggested: loose.filter((c) => c.suggestion).length,
      none: loose.filter((c) => !c.suggestion).length,
    }),
    [loose],
  );
  const tick = (which: "confident" | "suggested" | "none") =>
    setTicked(
      which === "none"
        ? new Set()
        : new Set(
            loose
              .filter((c) => c.suggestion && (which === "suggested" || c.confident))
              .map((c) => c.fact),
          ),
    );
  const pairs = pairsOf(picked, ticked);
  const post =
    p.post ??
    ((body: Api.ConnectLinksRequestT) =>
      api<Api.ConnectLinksResultT>("/api/links/connect", { method: "POST", body }));
  // What the person picked now: Confirm writes only what was previewed, nothing changed since.
  const asked = JSON.stringify({ pairs, rule: !!rule });
  const [previewed, setPreviewed] = useState<string | undefined>();
  const [undoing, setUndoing] = useState(false);
  const send = async (mode: "preview" | "write") => {
    if (!pairs.length && !rule) {
      setError(C.nothingPicked);
      return;
    }
    setBusy(mode);
    setError(undefined);
    const sentAsked = asked;
    try {
      const r = await post({
        from: p.from,
        to: p.box,
        pairs,
        ...(rule ? { rule: true } : {}),
        ...(mode === "preview" ? { preview: true } : {}),
      });
      if (mode === "preview") {
        setPreview(r);
        // The picks as they were sent, not as they are when the answer comes.
        setPreviewed(sentAsked);
      } else {
        setWritten(r);
        setPreview(undefined);
        p.cands.reload?.();
      }
    } catch (e) {
      setError(errorOf(e));
    } finally {
      setBusy(undefined);
    }
  };
  const undo = async () => {
    if (!written || undoing) return;
    setUndoing(true);
    setError(undefined);
    let left = written.lines;
    try {
      for (const line of written.lines) {
        await api(`/api/facts/${encodeURIComponent(p.from)}/corrections/undo`, {
          method: "POST",
          body: { line },
        });
        // Each line undone is off the list, so trying again undoes only the rest.
        left = left.filter((l) => l !== line);
      }
      setUndone(true);
      setWritten(undefined);
      p.cands.reload?.();
    } catch (e) {
      setWritten({ ...written, lines: left });
      setError(errorOf(e));
    } finally {
      setUndoing(false);
    }
  };

  if (p.cands.state === "loading")
    return (
      <p role="status" aria-busy="true" className="ev-say">
        {C.loading}
      </p>
    );
  if (p.cands.state === "error")
    return (
      <p role="alert" className="state error">
        {C.failed(p.cands.error)}
      </p>
    );
  const d = p.cands.data;
  return (
    <div className="stack">
      {d.noCalls && (
        <div className="stack">
          <p className="ev-say">
            {d.noCalls.why === "unverified" ? C.unverifiedCalls(d.from) : C.noCalls(d.from)}
          </p>
          <Cmd text={d.noCalls.command} />
        </div>
      )}
      {d.noApis && (
        <div className="stack">
          <p className="ev-say">{C.noApis[d.noApis.why]!(d.toName)}</p>
          <Cmd text={d.noApis.command} />
        </div>
      )}
      {!d.noCalls && !loose.length && <p className="ev-say">{C.noLoose}</p>}
      {loose.length > 0 && d.apis.length > 0 && (
        <>
          <p className="ev-say">{C.tally(tally.confident, tally.suggested, tally.none)}</p>
          <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {tally.confident > 0 && (
              <button type="button" className="btn" onClick={() => tick("confident")}>
                {C.tickConfident(tally.confident)}
              </button>
            )}
            {tally.suggested > 0 && (
              <button type="button" className="btn" onClick={() => tick("suggested")}>
                {C.tickSuggested(tally.suggested)}
              </button>
            )}
            {ticked.size > 0 && (
              <button type="button" className="btn" onClick={() => tick("none")}>
                {C.untickAll}
              </button>
            )}
            {d.apis.length > 20 && (
              <>
                <label htmlFor="connect-find" className="sr">
                  {C.findApi}
                </label>
                <input
                  id="connect-find"
                  className="field"
                  type="search"
                  placeholder={C.findApi}
                  value={find}
                  onChange={(e) => setFind(e.target.value)}
                  style={{ minWidth: 240 }}
                />
              </>
            )}
          </div>
        </>
      )}
      {loose.length > 0 && d.apis.length > 0 && (
        <table className="run-table">
          <caption className="hud" style={{ textAlign: "left" }}>
            {C.caption(d.from, d.toName)}
          </caption>
          <thead>
            <tr>
              <th scope="col">{C.col.pick}</th>
              <th scope="col">{C.col.call}</th>
              <th scope="col">{C.col.status}</th>
              <th scope="col">{C.col.api}</th>
            </tr>
          </thead>
          <tbody>
            {loose.map((c) => {
              const label = `${c.method ?? ""} ${c.path}`.trim();
              return (
                <tr key={c.fact}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`${C.col.pick}: ${label}`}
                      checked={ticked.has(c.fact)}
                      onChange={(e) =>
                        setTicked((t) => {
                          const n = new Set(t);
                          if (e.target.checked) n.add(c.fact);
                          else n.delete(c.fact);
                          return n;
                        })
                      }
                    />
                  </td>
                  <th scope="row" style={{ fontWeight: "normal" }}>
                    <code className="mono">{label}</code>
                    <div className="hud">{c.at}</div>
                  </th>
                  <td>
                    {C.status[c.status]}
                    {c.why ? ` (${C.leftWhy[c.why] ?? c.why})` : ""}
                  </td>
                  <td>
                    <select
                      className="field"
                      aria-label={`${C.col.api}: ${label}`}
                      value={picked[c.fact] ?? ""}
                      onChange={(e) => {
                        const api0 = e.target.value;
                        setPicked((x) => ({ ...x, [c.fact]: api0 }));
                        if (api0) setTicked((t) => new Set(t).add(c.fact));
                      }}
                    >
                      <option value="">{C.pickApi}</option>
                      {/* The likely ones first; then every API, narrowed by the search box. */}
                      {c.suggestions?.length ? (
                        <optgroup label={C.likely}>
                          {c.suggestions.map((s) => {
                            const a = d.apis.find((x) => x.id === s.api);
                            return a ? (
                              <option key={a.id} value={a.id}>
                                {`${a.method ?? ""} ${a.path}`.trim()} · {C.why[s.why] ?? s.why}
                              </option>
                            ) : null;
                          })}
                        </optgroup>
                      ) : null}
                      <optgroup label={C.allApis}>
                        {d.apis
                          .filter((a) => {
                            const q = find.trim().toLowerCase();
                            if (!q) return true;
                            const text =
                              `${a.method ?? ""} ${a.path} ${a.words ?? ""}`.toLowerCase();
                            return (
                              q.split(/\s+/).every((w) => text.includes(w)) ||
                              a.id === picked[c.fact]
                            );
                          })
                          .map((a) => (
                            <option key={a.id} value={a.id}>
                              {`${a.method ?? ""} ${a.path}`.trim()}
                            </option>
                          ))}
                      </optgroup>
                    </select>
                    {c.suggestion && picked[c.fact] === c.suggestion.api && (
                      <div className="hud">{C.suggested(C.why[c.suggestion.why]!)}</div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {loose.length > 0 && d.apis.length > 0 && (
        <MatchWithCopilot
          from={p.from}
          box={p.box}
          toName={d.toName}
          calls={loose}
          apis={d.apis}
          {...(p.match ? { io: p.match } : {})}
          onTake={(ps) => {
            setPicked((x) => ({ ...x, ...Object.fromEntries(ps.map((q) => [q.call, q.api])) }));
            setTicked((t) => new Set([...t, ...ps.map((q) => q.call)]));
            setPreview(undefined);
          }}
        />
      )}
      {d.rule && (
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" checked={rule} onChange={(e) => setRule(e.target.checked)} />
          {C.rule(d.rule.calls)}
        </label>
      )}
      {error && (
        <p role="alert" className="state error">
          {error}
        </p>
      )}
      {(loose.length > 0 || d.rule) && (
        <div className="row" style={{ gap: 8 }}>
          <button
            type="button"
            className="btn"
            onClick={() => void send("preview")}
            disabled={!!busy}
            aria-busy={busy === "preview"}
          >
            {busy === "preview" ? C.previewing : C.preview}
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => void send("write")}
            disabled={!!busy || !preview || previewed !== asked}
            aria-busy={busy === "write"}
          >
            {busy === "write" ? C.writing : C.confirm(pairs.length, rule)}
          </button>
        </div>
      )}
      {preview && previewed === asked && (
        <CorrectionNextPanel
          file={preview.file}
          line={preview.lines.join("\n+ ")}
          preview={
            preview.preview
              ? { state: "ready", data: preview.preview as Api.VerifyPreviewViewT }
              : { state: "loading" }
          }
        />
      )}
      {written && (
        <div className="stack" role="status">
          <p className="ev-say" role="status">
            {C.written(written.lines.length, written.file)}
          </p>
          {written.rule && <p className="ev-say">{C.ruleWritten(written.rule.question)}</p>}
          <Cmd text={written.verify} />
          <Cmd text={written.commit} />
          {written.lines.length > 0 && (
            <button
              type="button"
              className="btn"
              onClick={() => void undo()}
              disabled={undoing}
              aria-busy={undoing}
            >
              {C.undo}
            </button>
          )}
          {written.lines.length > 0 && <MakeRule repo={p.from} line={written.lines[0]!} />}
        </div>
      )}
      {undone && (
        <p role="status" className="ev-say">
          {C.undone}
        </p>
      )}
    </div>
  );
}

/** G4 (ADR 0176): the pairing as a draft reading rule for every repo of this repo's type. */
function MakeRule({ repo, line }: { repo: string; line: string }) {
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<Api.RuleFromPairingResultT | undefined>();
  const [error, setError] = useState<string | undefined>();
  if (made)
    return (
      <div className="stack" role="status">
        <p className="ev-say">{C.ruleMade(made.file)}</p>
        <Cmd text={made.activate} />
      </div>
    );
  return (
    <>
      <button
        type="button"
        className="btn"
        disabled={busy}
        aria-busy={busy}
        onClick={() => {
          setBusy(true);
          setError(undefined);
          api<Api.RuleFromPairingResultT>("/api/reading-rules/from-pairing", {
            method: "POST",
            body: { repo, line },
          })
            .then(setMade, (e: unknown) => setError(errorOf(e)))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? C.makingRule : C.makeRule}
      </button>
      {error && (
        <p role="alert" className="state error">
          {error}
        </p>
      )}
    </>
  );
}

function Cmd({ text }: { text: string }) {
  return (
    <div className="row" style={{ gap: 6 }}>
      <code className="mono">{text}</code>
      <CopyButton text={text} label={`${C.copy}: ${text}`} />
    </div>
  );
}
