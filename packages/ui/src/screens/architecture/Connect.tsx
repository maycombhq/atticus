import { useEffect, useId, useMemo, useState } from "react";
import type { Api } from "@maycombhq/core";
import { api, ApiError, useApi, type Loaded } from "../../api/client.js";
import { CorrectionNextPanel } from "../../app/correction-next.js";
import { CopyButton } from "../run/shared.js";
import { appStep, WrittenNext } from "../../app/app-step.js";
import { Command } from "../work/RunNext.js";
import { COPY } from "../../copy.js";
import { MatchWithCopilot, type MatchIo } from "./Match.js";
import { AiMark, readyView, useDecisions } from "../../app/decisions.js";
import { usePopupFocus } from "./popup.js";

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

/** Where calls with an arrow go now, in words: `forge-ledger (3), forge-risk (1)`. */
export function linkedWords(calls: readonly { joins?: string }[]): string {
  const n = new Map<string, number>();
  for (const c of calls) if (c.joins) n.set(c.joins, (n.get(c.joins) ?? 0) + 1);
  return [...n]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([box, k]) => C.linkedTo(box, k))
    .join(", ");
}

/** The likeliest API of each call, picked, and the calls with one ticked. */
export function initialPicks(v: Api.LinkCandidatesViewT): {
  picked: Record<string, string>;
  ticked: Set<string>;
} {
  const picked: Record<string, string> = {};
  const ticked = new Set<string>();
  for (const c of v.calls) {
    // A call with an arrow already is moved only when the person picks it (field report 4).
    if (c.status === "paired" || c.status === "joined") continue;
    if (c.suggestion) {
      picked[c.fact] = c.suggestion.api;
      // Only the confident ones start ticked: the rest a person looks at (Tick all suggested).
      if (c.confident) ticked.add(c.fact);
    }
  }
  return { picked, ticked };
}

/**
 * The boxes Connect to… lists: the views' boxes, and the box a line was dropped on when the
 * views loaded don't hold it (review round 2, beta.23: a repo inside a system box on the estate
 * view), so the drop always opens with it picked.
 */
export function boxesWith(boxes: readonly BoxChoice[], initial?: BoxChoice): BoxChoice[] {
  if (!initial || boxes.some((b) => key(b.box) === key(initial.box))) return [...boxes];
  return [...boxes, initial].sort((x, y) => (x.label < y.label ? -1 : 1));
}

export function ConnectPanel(p: {
  from: string;
  boxes: BoxChoice[];
  /** The box a line was dropped on, picked when the panel opens. */
  initial?: BoxChoice;
  onClose(): void;
}) {
  const id = useId();
  const [to, setTo] = useState<string>(p.initial ? key(p.initial.box) : "");
  const boxes = boxesWith(p.boxes, p.initial);
  const box = boxes.find((b) => key(b.box) === to)?.box;
  const cands = useApi<Api.LinkCandidatesViewT>(box ? candidatesPath(p.from, box) : undefined);
  const head = usePopupFocus<HTMLHeadingElement>();
  const toLabel = boxes.find((b) => key(b.box) === to)?.label;
  return (
    <section className="stack connect-panel" aria-labelledby={`${id}-t`}>
      <div className="box-pop-head">
        <h4 id={`${id}-t`} ref={head} tabIndex={-1} className="h box-pop-title">
          {C.title(p.from)}
        </h4>
        <button type="button" className="btn" onClick={p.onClose}>
          {C.close}
        </button>
      </div>
      {/* The two ends of the line, named: the repo it starts from and the box picked. */}
      <p className="box-ends">
        <span className="sr">{C.ends(p.from, toLabel ?? C.pickBoxNone)}</span>
        <span aria-hidden="true" className="chip mono">
          {p.from}
        </span>
        <span aria-hidden="true">→</span>
        <span aria-hidden="true" className={`chip mono ${toLabel ? "" : "dim"}`}>
          {toLabel ?? C.pickBoxNone}
        </span>
      </p>
      <p className="ev-say">{C.intro}</p>
      <label htmlFor={`${id}-to`} className="hud">
        {C.pickBox}
      </label>
      <select id={`${id}-to`} className="field" value={to} onChange={(e) => setTo(e.target.value)}>
        <option value="">{C.pickBoxNone}</option>
        {boxes.map((b) => (
          <option key={key(b.box)} value={key(b.box)}>
            {b.label}
          </option>
        ))}
      </select>
      {box && <AiPairedBetween from={p.from} box={box} />}
      {box && <Pairing key={to} from={p.from} box={box} cands={cands} />}
    </section>
  );
}

/**
 * ADR 0181: what the AI already paired from this repo to the picked box, each with its chip, run
 * and Correct; nothing when it paired none.
 */
export function AiPairedBetween(p: { from: string; box: Api.LinkBoxT }) {
  const v = readyView(useDecisions());
  const items = (v?.links.items ?? []).filter(
    (d) => d.repo === p.from && !!p.box.repo && d.to?.repo === p.box.repo,
  );
  if (!items.length) return null;
  return (
    <details className="stack">
      <summary className="hud">{COPY.decisions.betweenTitle(items.length)}</summary>
      <ul className="stack" style={{ gap: 8, margin: 0, paddingLeft: 18 }}>
        {items.map((d) => (
          <li key={d.item} className="stack" style={{ gap: 4 }}>
            <span>{d.what}</span>
            <AiMark item={d.item} run={d.run} />
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * What Undo did, in words. Review round 2 (beta.23): it removes the pair lines only; when the
 * rule for all was written too, its answer to the target question stays, said with where to
 * take it back.
 */
export function undoneWords(w: Pick<Api.ConnectLinksResultT, "rule">): string {
  return w.rule ? C.undoneRuleStays(w.rule.question, w.rule.target) : C.undone;
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
  const [undone, setUndone] = useState<Api.ConnectLinksResultT | undefined>();
  useEffect(() => {
    if (!v) return;
    const i = initialPicks(v);
    setPicked(i.picked);
    setTicked(i.ticked);
  }, [v]);
  const loose = useMemo(
    () => v?.calls.filter((c) => c.status !== "paired" && c.status !== "joined") ?? [],
    [v],
  );
  // Beta.28.1 (field report 4): the calls with an arrow already, to move to this box.
  const movable = useMemo(() => v?.calls.filter((c) => c.status === "joined") ?? [], [v]);
  const [find, setFind] = useState("");
  const callsId = useId();
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
        setUndone(undefined);
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
      setUndone(written);
      setWritten(undefined);
      p.cands.reload?.();
    } catch (e) {
      setWritten({ ...written, lines: left });
      setError(errorOf(e));
    } finally {
      setUndoing(false);
    }
  };

  /** One call's row: the call, where it is, what it is now, and the API to pair it with. */
  const row = (c: Api.LinkCandidatesViewT["calls"][number]) => {
    const d = v!;
    const label = `${c.method ?? ""} ${c.path}`.trim();
    return (
      <li key={c.fact} className="box-call">
        <label className="box-call-head" title={`${label}\n${c.at}`}>
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
          <span className="box-call-what">
            <span className="box-path">
              {c.method && <span className="box-method">{c.method}</span>}
              <code className="mono">{c.path}</code>
            </span>
            <span className="box-at mono">{c.at}</span>
          </span>
          <span className="chip dim box-now">
            <span className="sr">{C.col.status}: </span>
            {C.status[c.status]}
          </span>
        </label>
        {c.status === "undrawn" && c.joins ? (
          <span className="box-why">{C.undrawnWhy(c.joins)}</span>
        ) : c.status === "outside" && c.joins && c.joins !== p.box.system ? (
          <span className="box-why">{C.outsideWhy(c.joins)}</span>
        ) : c.status === "joined" && c.joins ? (
          <span className="box-why">{C.joinsNow(c.joins)}</span>
        ) : (
          c.why && <span className="box-why">{C.leftWhy[c.why] ?? c.why}</span>
        )}
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
                const text = `${a.method ?? ""} ${a.path} ${a.words ?? ""}`.toLowerCase();
                return q.split(/\s+/).every((w) => text.includes(w)) || a.id === picked[c.fact];
              })
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {`${a.method ?? ""} ${a.path}`.trim()}
                </option>
              ))}
          </optgroup>
        </select>
        {c.suggestion && picked[c.fact] === c.suggestion.api && (
          <span className="box-why">{C.suggested(C.why[c.suggestion.why]!)}</span>
        )}
      </li>
    );
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
      {!d.noCalls && !loose.length && movable.length > 0 && (
        <p className="ev-say">{C.noLoose(linkedWords(movable))}</p>
      )}
      {!d.noCalls && !loose.length && !movable.length && d.calls.length > 0 && (
        <p className="ev-say">{C.allPaired(d.toName)}</p>
      )}
      {loose.length > 0 && d.apis.length > 0 && (
        <>
          <p className="ev-say">{C.tally(tally.confident, tally.suggested, tally.none)}</p>
          <div className="box-btns">
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
                  style={{ flex: "1 1 100%", minWidth: 0 }}
                />
              </>
            )}
          </div>
        </>
      )}
      {loose.length > 0 && d.apis.length > 0 && (
        // One row per loose call, stacked to fit the details panel: the call (method and path in
        // mono, cut to one line, whole on hover or while its row has focus), where it is, what
        // it is now, and the API to pair it with across the row's width.
        <div className="stack" style={{ gap: 6 }}>
          <p id={`${callsId}-c`} className="hud box-sub">
            {C.caption(d.from, d.toName)}
          </p>
          <ul className="box-calls" aria-labelledby={`${callsId}-c`}>
            {loose.map(row)}
          </ul>
        </div>
      )}
      {movable.length > 0 && d.apis.length > 0 && (
        <details className="stack" open={!loose.length}>
          <summary className="hud">{C.moveTitle(movable.length)}</summary>
          <p id={`${callsId}-m`} className="hud box-sub">
            {C.moveCaption(d.from, d.toName)}
          </p>
          <ul className="box-calls" aria-labelledby={`${callsId}-m`}>
            {movable.map(row)}
          </ul>
        </details>
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
        <label className="box-check">
          <input type="checkbox" checked={rule} onChange={(e) => setRule(e.target.checked)} />
          {C.rule(d.rule.calls)}
        </label>
      )}
      {error && (
        <p role="alert" className="state error">
          {error}
        </p>
      )}
      {(loose.length > 0 || movable.length > 0 || d.rule) && (
        <div className="box-foot">
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
        <div className="stack">
          {written.rule && <p className="ev-say">{C.ruleWritten(written.rule.question)}</p>}
          {/* ADR 0188: Apply moves the arrow, then Propose for review. */}
          <WrittenNext
            said={C.written(written.lines.length, written.file)}
            verify={written.verify}
            commit={written.commit}
          />
          {written.lines.length > 0 && (
            <div className="box-btns">
              <button
                type="button"
                className="btn"
                onClick={() => void undo()}
                disabled={undoing}
                aria-busy={undoing}
              >
                {C.undo}
              </button>
              <MakeRule repo={p.from} line={written.lines[0]!} />
            </div>
          )}
        </div>
      )}
      {undone && (
        <p role="status" className="ev-say">
          {undoneWords(undone)}
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
  // ADR 0188: a step the app takes (verify, the read of a repo) is its button first.
  if (appStep(text)) return <Command text={text} label={C.copy} scope="corrections" />;
  return (
    <div className="row" style={{ gap: 6 }}>
      <code className="mono">{text}</code>
      <CopyButton text={text} label={`${C.copy}: ${text}`} />
    </div>
  );
}
