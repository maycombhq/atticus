import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type { Api } from "@maycombhq/core";
import { api, ApiError, useApi, useLiveEvents, type Loaded } from "../api/client.js";
import { COPY } from "../copy.js";
import { flash } from "./flash.js";
import { CopyButton } from "../screens/run/shared.js";
import { runsHref } from "../screens/runs/Runs.js";

/**
 * ADR 0181 parts 1 to 3 in the app: AI decides first, as itself; a person corrects one, and the
 * correction spreads; every batch is one Undo away. The "Detected by AI" chip (words and a shape,
 * never colour alone, with the run linked to the Runs page), the three-way counts, Correct with
 * Apply to similar (previewed before saving; the person's click is the approval), Make this a
 * reading rule, Undo of a batch and Home's pause note. The decisions come from GET /api/decisions,
 * loaded once for the app when a page first needs them.
 */

const D = COPY.decisions;

type View = Api.DecisionsViewT;
export type Decision = Api.AiDecisionItemT;

const errorOf = (e: unknown) =>
  e instanceof ApiError
    ? (e.problem.detail ?? e.message)
    : e instanceof Error
      ? e.message
      : String(e);

/** An answer's or a line's `by` that is the AI's (`{ kind: ai, runtime, run }`), never a person. */
export const isAiBy = (by: unknown): by is { kind: "ai"; runtime: string; run: string } =>
  typeof by === "object" && by !== null && (by as { kind?: unknown }).kind === "ai";

// ------------------------------------------------------------------ the decisions, shared

export interface Decisions {
  /** GET /api/decisions: undefined until something needs it. */
  view: Loaded<View> | undefined;
  need(): void;
  reload(): void;
}

export const DecisionsContext = createContext<Decisions | undefined>(undefined);

/** Loads the AI's decisions once, when a chip or a page first needs them; again on a file change. */
export function DecisionsProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<Loaded<View> | undefined>();
  const asked = useRef(false);
  const load = useCallback(() => {
    asked.current = true;
    setView((v) => (v?.state === "ready" ? v : { state: "loading" }));
    api<View>("/api/decisions").then(
      (data) => setView({ state: "ready", data }),
      (e: unknown) => setView({ state: "error", error: errorOf(e) }),
    );
  }, []);
  useLiveEvents((e) => {
    if (asked.current && e.type === "file.changed") load();
  });
  const value = useMemo<Decisions>(
    () => ({
      view,
      need: () => {
        if (!asked.current) load();
      },
      reload: load,
    }),
    [view, load],
  );
  return <DecisionsContext.Provider value={value}>{children}</DecisionsContext.Provider>;
}

/** A fixed view, for tests and pages that already hold it. */
export function staticDecisions(data: View): Decisions {
  return { view: { state: "ready", data }, need: () => undefined, reload: () => undefined };
}

/** The decisions as loaded (asking for them), or undefined outside a provider. */
export function useDecisions(): Decisions | undefined {
  const d = useContext(DecisionsContext);
  useEffect(() => d?.need(), [d]);
  return d;
}

const itemsOf = (v: View | undefined): Decision[] =>
  v ? [...v.links.items, ...v.questions.items] : [];

/** The AI's standing decision on an item (`link:<repo>:<call>` or a question's id). */
export function decisionOf(v: View | undefined, item: string | undefined): Decision | undefined {
  return item ? itemsOf(v).find((d) => d.item === item) : undefined;
}

/** The AI's pairing of the call on a line of a repo (`file:line`), if the AI made it. */
export function linkDecisionAt(
  v: View | undefined,
  repo: string | undefined,
  at: string,
): Decision | undefined {
  return v?.links.items.find(
    (d) => d.repo === repo && d.call && `${d.call.file}:${d.call.line}` === at,
  );
}

export const readyView = (d: Decisions | undefined): View | undefined =>
  d?.view?.state === "ready" ? d.view.data : undefined;

// ------------------------------------------------------------------ the chip and the counts

/** "Detected by AI": a shape and words, a spoken why, and the run linked to the Runs page. */
export function AiChip(p: {
  run?: string | undefined;
  /** Inside a link or a button: the chip alone (no link in a link). */
  inLink?: boolean;
}) {
  return (
    <span className="row ai-mark" style={{ gap: 6, flexWrap: "wrap", display: "inline-flex" }}>
      <span className="chip ai">
        <span aria-hidden="true">◆ </span>
        {D.chip}
      </span>
      <span className="sr">{D.chipWhy}</span>
      {p.run && !p.inLink && (
        <a href={runsHref({ run: p.run })} aria-label={D.openRun(p.run)} className="hud">
          {D.run(p.run)}
        </a>
      )}
    </span>
  );
}

/** How links or questions were settled: from code, by a person, by AI (and open ones). */
export function SplitCounts(p: { counts: Api.DecisionCountsT; what: string }) {
  return (
    <p className="work-say" role="group" aria-label={D.counts.label(p.what)} style={{ margin: 0 }}>
      <span className="hud">{p.what}: </span>
      {D.counts.line(p.counts)}
    </p>
  );
}

/**
 * The chip for an item the AI decided, with Correct when it is a standing decision: looks the item
 * up in the app's decisions. Renders nothing for an item no AI decided.
 */
export function AiMark(p: {
  item?: string | undefined;
  /** Known AI run when the item isn't (or not yet) in the decisions. */
  run?: string | undefined;
  /** Shown even when the item isn't found (the page knows it is the AI's). */
  ai?: boolean;
  inLink?: boolean;
  /** Correct opened and closed: a page keeps the item shown while its result is read. */
  onOpen?: (d: Decision) => void;
  onClose?: () => void;
  /** A correction saved: the page reads what it shows again (the canvas, ADR 0181). */
  onDone?: (r: Api.CorrectDecisionResultT) => void;
}) {
  const ds = useDecisions();
  const live = decisionOf(readyView(ds), p.item);
  // The decision as it was when Correct opened: once saved it is the person's and leaves the
  // decisions, but the form and its result stay until the person closes them.
  const [open, setOpen] = useState<Decision | undefined>();
  const d = live ?? open;
  if (!d && !p.ai && !p.run) return null;
  return (
    <span className="stack" style={{ gap: 6, display: "inline-flex" }}>
      <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        <AiChip run={d?.run ?? p.run} {...(p.inLink ? { inLink: true } : {})} />
        {live && !p.inLink && !open && (
          <button
            type="button"
            className="btn"
            aria-label={D.correctOf(live.what)}
            onClick={() => {
              setOpen(live);
              p.onOpen?.(live);
            }}
          >
            {D.correct}
          </button>
        )}
      </span>
      {open && (
        <CorrectDecision
          d={open}
          onClose={() => {
            setOpen(undefined);
            p.onClose?.();
          }}
          onDone={(r) => {
            // A word that outlives the panel, should the page redraw without the item.
            flash({ text: D.savedFlash(r.answer, r.counts), href: "#/decisions", link: D.title });
            ds?.reload();
            p.onDone?.(r);
          }}
        />
      )}
    </span>
  );
}

// ------------------------------------------------------------------ Correct

export interface CorrectForm {
  pick?: "option" | "api" | "none" | undefined;
  /** A question's option, from 1. */
  option?: number | undefined;
  repo: string;
  api: string;
  similar: boolean;
  /** The rule the person changed it to; absent: the derived one. */
  match?: string | undefined;
}

/** The POST /api/decisions/correct body for a correction, or what is missing, in words. */
export function correctBody(
  d: Decision,
  f: CorrectForm,
  preview: boolean,
): { body: Api.CorrectDecisionRequestT } | { error: string } {
  const tail = {
    similar: f.similar,
    ...(f.similar && f.match?.trim() ? { match: f.match.trim() } : {}),
    ...(preview ? { preview: true } : {}),
  };
  if (f.pick === "none") return { body: { item: d.item, none: true, ...tail } };
  if (d.kind === "question") {
    if (f.pick !== "option" || !f.option) return { error: D.needPick };
    return { body: { item: d.item, option: f.option, ...tail } };
  }
  if (f.pick !== "api") return { error: D.needPick };
  if (!f.api.trim() || !f.repo.trim()) return { error: D.needApi };
  return { body: { item: d.item, api: f.api.trim(), repo: f.repo.trim(), ...tail } };
}

const candidatesPath = (from: string, repo: string) =>
  `/api/links/candidates?from=${encodeURIComponent(from)}&to=${encodeURIComponent(repo)}`;

/**
 * Correct one decision: the right option, API (with its repo) or none of these; Apply to similar
 * (on); Preview shows the rule and what it spreads to; Save writes it as the person's word.
 */
export function CorrectDecision(p: {
  d: Decision;
  /** Tests pass their own; the app calls the local API. */
  post?: (b: Api.CorrectDecisionRequestT) => Promise<Api.CorrectDecisionResultT>;
  /** A pairing: the other repo's APIs, when the caller holds them (tests). */
  apis?: Loaded<Api.LinkCandidatesViewT>;
  onDone?: (r: Api.CorrectDecisionResultT) => void;
  onClose: () => void;
}) {
  const { d } = p;
  const id = useId();
  const [f, setF] = useState<CorrectForm>({
    // A pairing's usual correction is another API: its fields start open, the AI's repo in them.
    ...(d.kind === "link" ? { pick: "api" as const } : {}),
    repo: d.to?.repo ?? "",
    api: "",
    similar: true,
  });
  const set = (x: Partial<CorrectForm>) => setF((o) => ({ ...o, ...x }));
  const [busy, setBusy] = useState<"preview" | "save" | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [preview, setPreview] = useState<{ r: Api.CorrectDecisionResultT; asked: string }>();
  const [saved, setSaved] = useState<Api.CorrectDecisionResultT | undefined>();
  const done = useRef<HTMLDivElement | null>(null);
  const loaded = useApi<Api.LinkCandidatesViewT>(
    p.apis || d.kind !== "link" || f.pick !== "api" || !f.repo.trim()
      ? undefined
      : candidatesPath(d.repo, f.repo.trim()),
  );
  const apis = p.apis ?? (f.pick === "api" && f.repo.trim() ? loaded : undefined);
  // Focus moves to the result once saved, so a screen reader hears it and the keyboard is there.
  useEffect(() => {
    if (saved) done.current?.focus();
  }, [saved]);
  const post =
    p.post ??
    ((b: Api.CorrectDecisionRequestT) =>
      api<Api.CorrectDecisionResultT>("/api/decisions/correct", { method: "POST", body: b }));
  const sent = correctBody(d, f, false);
  const asked = "body" in sent ? JSON.stringify(sent.body) : "";
  const fresh = !!preview && preview.asked === asked;
  const send = async (mode: "preview" | "save") => {
    const b = correctBody(d, f, mode === "preview");
    if ("error" in b) {
      setError(b.error);
      return;
    }
    if (mode === "save" && !fresh) {
      setError(D.previewFirst);
      return;
    }
    setBusy(mode);
    setError(undefined);
    const was = asked;
    try {
      const r = await post(b.body);
      if (mode === "preview") setPreview({ r, asked: was });
      else {
        setSaved(r);
        p.onDone?.(r);
      }
    } catch (e) {
      setError(errorOf(e));
    } finally {
      setBusy(undefined);
    }
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send("preview");
  };
  if (saved)
    return (
      <div className="stack" role="status" tabIndex={-1} ref={done} style={{ gap: 6 }}>
        <SpreadView r={saved} saved />
        {saved.makeRule && <MakeReadingRule m={saved.makeRule} />}
        <div className="row" style={{ gap: 6 }}>
          <button type="button" className="btn" onClick={p.onClose}>
            {D.cancel}
          </button>
        </div>
      </div>
    );
  const rule = preview?.r.rule;
  return (
    <form className="stack" onSubmit={onSubmit} aria-labelledby={`${id}-t`} style={{ gap: 8 }}>
      <h4 id={`${id}-t`} className="h" style={{ fontSize: 13, margin: 0 }}>
        {D.formTitle(d.what)}
      </h4>
      <fieldset className="stack" style={{ gap: 4, border: 0, padding: 0, margin: 0 }}>
        <legend className="hud">{d.kind === "question" ? D.pickOption : D.pickLink}</legend>
        {d.kind === "question" &&
          (d.question?.options ?? []).map((label, n) => (
            <label key={label} className="row" style={{ gap: 6 }}>
              <input
                type="radio"
                name={`${id}-pick`}
                value={String(n + 1)}
                checked={f.pick === "option" && f.option === n + 1}
                onChange={() => set({ pick: "option", option: n + 1 })}
              />
              {label}
            </label>
          ))}
        {d.kind === "link" && (
          <label className="row" style={{ gap: 6 }}>
            <input
              type="radio"
              name={`${id}-pick`}
              value="api"
              checked={f.pick === "api"}
              onChange={() => set({ pick: "api" })}
            />
            {D.linkApi}
          </label>
        )}
        {d.kind === "link" && f.pick === "api" && (
          <div className="stack" style={{ gap: 4, paddingLeft: 22 }}>
            <label htmlFor={`${id}-repo`} className="hud">
              {D.repoLabel}
            </label>
            <input
              id={`${id}-repo`}
              className="field"
              value={f.repo}
              onChange={(e) => set({ repo: e.target.value, api: "" })}
            />
            {apis?.state === "ready" ? (
              <>
                <label htmlFor={`${id}-api`} className="hud">
                  {D.apiLabel}
                </label>
                <select
                  id={`${id}-api`}
                  className="field"
                  value={f.api}
                  onChange={(e) => set({ api: e.target.value })}
                >
                  <option value="">{D.apiPick}</option>
                  {apis.data.apis.map((a) => (
                    <option key={a.id} value={a.id}>
                      {`${a.method ?? ""} ${a.path}`.trim()}
                    </option>
                  ))}
                </select>
              </>
            ) : apis?.state === "loading" ? (
              <p className="ev-say" role="status" aria-busy="true">
                {D.apisLoading}
              </p>
            ) : (
              <>
                {apis?.state === "error" && (
                  <p className="state error" role="alert">
                    {D.apisFailed(apis.error)}
                  </p>
                )}
                <label htmlFor={`${id}-api`} className="hud">
                  {D.apiIdLabel}
                </label>
                <input
                  id={`${id}-api`}
                  className="field mono"
                  value={f.api}
                  onChange={(e) => set({ api: e.target.value })}
                />
              </>
            )}
          </div>
        )}
        <label className="row" style={{ gap: 6 }}>
          <input
            type="radio"
            name={`${id}-pick`}
            value="none"
            checked={f.pick === "none"}
            onChange={() => set({ pick: "none" })}
          />
          {d.kind === "question" ? D.noneOption : D.noneLink}
        </label>
      </fieldset>
      <label className="row" style={{ gap: 6 }}>
        <input
          type="checkbox"
          checked={f.similar}
          onChange={(e) => set({ similar: e.target.checked })}
          aria-describedby={`${id}-sim`}
        />
        {D.similar}
      </label>
      <p id={`${id}-sim`} className="muted" style={{ margin: 0, fontSize: 12 }}>
        {D.similarHint}
      </p>
      {f.similar && (rule || f.match !== undefined) && (
        <div className="stack" style={{ gap: 4 }}>
          <label htmlFor={`${id}-match`} className="hud">
            {D.matchLabel}
          </label>
          <input
            id={`${id}-match`}
            className="field mono"
            value={f.match ?? rule?.match ?? ""}
            onChange={(e) => set({ match: e.target.value })}
            aria-describedby={`${id}-match-hint`}
          />
          <span id={`${id}-match-hint`} className="muted" style={{ fontSize: 12 }}>
            {D.matchHint}
          </span>
        </div>
      )}
      {error && (
        <p role="alert" className="state error" style={{ margin: 0 }}>
          {error}
        </p>
      )}
      {preview && !fresh && (
        <p role="status" className="ev-say" style={{ margin: 0 }}>
          {D.changedSince}
        </p>
      )}
      {preview && fresh && (
        <div className="stack" role="status" style={{ gap: 6 }}>
          <SpreadView r={preview.r} />
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            {D.approval}
          </p>
        </div>
      )}
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button type="submit" className="btn" disabled={!!busy} aria-busy={busy === "preview"}>
          {busy === "preview" ? D.previewing : D.preview}
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={!!busy || !fresh}
          aria-busy={busy === "save"}
          onClick={() => void send("save")}
        >
          {busy === "save" ? D.saving : D.save}
        </button>
        <button type="button" className="btn" onClick={p.onClose}>
          {D.cancel}
        </button>
      </div>
    </form>
  );
}

function Cmd({ text }: { text: string }) {
  return (
    <div className="row" style={{ gap: 6 }}>
      <code className="mono">{text}</code>
      <CopyButton text={text} label={D.copy(text)} />
    </div>
  );
}

/** What a correction does (previewed) or did (saved): the answer, the rule, each item re-checked. */
export function SpreadView({ r, saved }: { r: Api.CorrectDecisionResultT; saved?: boolean }) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      <p className="hud" style={{ margin: 0 }}>
        {saved ? D.whatSpread : D.previewTitle}
      </p>
      <p style={{ margin: 0 }}>{saved ? D.saved(r.answer) : D.yourAnswer(r.answer)}</p>
      {saved && r.batch && (
        <p className="ev-say" style={{ margin: 0 }}>
          {D.savedBatch(r.batch)}
        </p>
      )}
      {r.rule ? (
        <p className="ev-say" style={{ margin: 0 }}>
          {D.rule(r.rule.kind, r.rule.match, r.rule.derived)}
        </p>
      ) : (
        r.noRule && (
          <p className="ev-say" style={{ margin: 0 }}>
            {D.noRule(r.noRule)}
          </p>
        )
      )}
      {r.spread.length === 0 ? (
        <p className="ev-say" style={{ margin: 0 }}>
          {D.spreadNone}
        </p>
      ) : (
        <>
          <p style={{ margin: 0 }}>
            {D.spreadTitle(r.spread.length)} · {D.spreadCounts(r.counts)}
          </p>
          <table className="run-table">
            <caption className="sr">{D.spreadCaption}</caption>
            <thead>
              <tr>
                <th scope="col">{D.col.item}</th>
                <th scope="col">{D.col.change}</th>
                <th scope="col">{D.col.was}</th>
                <th scope="col">{D.col.now}</th>
              </tr>
            </thead>
            <tbody>
              {r.spread.map((s) => (
                <tr key={s.item}>
                  <th scope="row" style={{ fontWeight: "normal" }}>
                    {s.what}
                    <div className="hud mono">{s.repo}</div>
                  </th>
                  <td>
                    <strong>{D.change[s.change] ?? s.change}</strong>
                    <div className="muted">{D.changeWhy[s.change] ?? ""}</div>
                  </td>
                  <td>{s.was ?? D.nothing}</td>
                  <td>{s.now ?? D.nothing}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {saved && r.verify.length > 0 && (
        <>
          <p className="ev-say" style={{ margin: 0 }}>
            {D.verify}
          </p>
          {r.verify.map((c) => (
            <Cmd key={c} text={c} />
          ))}
        </>
      )}
      {saved && r.commit && (
        <>
          <p className="ev-say" style={{ margin: 0 }}>
            {D.commit}
          </p>
          <Cmd text={r.commit} />
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Make this a reading rule

type Made =
  | { state: "idle" }
  | { state: "making" }
  | { state: "made"; made: Api.RuleFromPairingResultT }
  | { state: "error"; error: string };
type MakeRuleOffer = NonNullable<Api.CorrectDecisionResultT["makeRule"]>;

/** The offer, from its state (tests render each). */
export function MakeReadingRuleView(p: { m: MakeRuleOffer; state: Made; onMake: () => void }) {
  const { m, state } = p;
  if (state.state === "made")
    return (
      <div className="stack" role="status" style={{ gap: 4 }}>
        <p className="ev-say" style={{ margin: 0 }}>
          {D.ruleMade(state.made.file)}
        </p>
        <Cmd text={state.made.activate} />
      </div>
    );
  return (
    <div className="stack" style={{ gap: 4 }}>
      <p className="ev-say" style={{ margin: 0 }}>
        {D.makeRuleOffer(m.corrections, m.shape)}
      </p>
      {m.line ? (
        <div className="row" style={{ gap: 6 }}>
          <button
            type="button"
            className="btn"
            disabled={state.state === "making"}
            aria-busy={state.state === "making"}
            onClick={p.onMake}
          >
            {state.state === "making" ? D.makingRule : D.makeRule}
          </button>
        </div>
      ) : (
        m.command && (
          <>
            <p className="ev-say" style={{ margin: 0 }}>
              {D.ruleCommand}
            </p>
            <Cmd text={m.command} />
          </>
        )
      )}
      {state.state === "error" && (
        <p role="alert" className="state error" style={{ margin: 0 }}>
          {state.error}
        </p>
      )}
    </div>
  );
}

/** Make this a reading rule: POST /api/reading-rules/from-pairing with the person's pairing line. */
export function MakeReadingRule(p: {
  m: MakeRuleOffer;
  post?: (b: { repo: string; line: string }) => Promise<Api.RuleFromPairingResultT>;
}) {
  const [state, setState] = useState<Made>({ state: "idle" });
  const post =
    p.post ??
    ((b: { repo: string; line: string }) =>
      api<Api.RuleFromPairingResultT>("/api/reading-rules/from-pairing", {
        method: "POST",
        body: b,
      }));
  const make = () => {
    if (!p.m.line) return;
    setState({ state: "making" });
    post({ repo: p.m.repo, line: p.m.line }).then(
      (made) => setState({ state: "made", made }),
      (e: unknown) => setState({ state: "error", error: errorOf(e) }),
    );
  };
  return <MakeReadingRuleView m={p.m} state={state} onMake={make} />;
}

// ------------------------------------------------------------------ Undo a batch

/** What Undo did: removed, put back, and what it left because it changed since. */
export function UndoResultView({ r }: { r: Api.UndoBatchResultT }) {
  return (
    <div className="stack" role="status" style={{ gap: 4 }}>
      <p className="ev-say" style={{ margin: 0 }}>
        {D.undoneResult(r.batch, r.removed, r.restored)}
      </p>
      {r.skipped.length > 0 && (
        <>
          <p className="ev-say" style={{ margin: 0 }}>
            {D.skipped}
          </p>
          <ul style={{ margin: 0 }}>
            {r.skipped.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </>
      )}
      {r.verify.length > 0 && (
        <>
          <p className="ev-say" style={{ margin: 0 }}>
            {D.verify}
          </p>
          {r.verify.map((c) => (
            <Cmd key={c} text={c} />
          ))}
        </>
      )}
      {r.commit && (
        <>
          <p className="ev-say" style={{ margin: 0 }}>
            {D.commit}
          </p>
          <Cmd text={r.commit} />
        </>
      )}
    </div>
  );
}

/** Undo one batch: asks first (what it removes and puts back), then says what it did. */
export function UndoBatch(p: {
  b: Api.DecisionBatchViewT;
  post?: (id: string) => Promise<Api.UndoBatchResultT>;
  onDone?: (r: Api.UndoBatchResultT) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<Api.UndoBatchResultT | undefined>();
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  // The question takes the focus: Enter undoes, Tab reaches Keep it.
  useEffect(() => {
    if (asking) confirmRef.current?.focus();
  }, [asking]);
  const post =
    p.post ??
    ((id: string) =>
      api<Api.UndoBatchResultT>(`/api/decisions/batches/${encodeURIComponent(id)}/undo`, {
        method: "POST",
      }));
  const undo = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await post(p.b.id);
      setDone(r);
      setAsking(false);
      p.onDone?.(r);
    } catch (e) {
      setError(D.undoFailed(errorOf(e)));
    } finally {
      setBusy(false);
    }
  };
  if (done) return <UndoResultView r={done} />;
  return (
    <div className="stack" style={{ gap: 4 }}>
      {!asking ? (
        <div>
          <button
            type="button"
            className="btn"
            aria-label={D.undoOf(p.b.id)}
            onClick={() => setAsking(true)}
          >
            {D.undo}
          </button>
        </div>
      ) : (
        <div className="stack" role="group" aria-label={D.undoOf(p.b.id)} style={{ gap: 4 }}>
          <p className="ev-say" style={{ margin: 0 }}>
            {D.confirmUndo(p.b.id, p.b.applied)}
          </p>
          <div className="row" style={{ gap: 6 }}>
            <button
              type="button"
              className="btn primary"
              ref={confirmRef}
              disabled={busy}
              aria-busy={busy}
              onClick={() => void undo()}
            >
              {busy ? D.undoing : D.confirmYes}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setAsking(false)}>
              {D.confirmNo}
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="state error" style={{ margin: 0 }}>
          {error}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ the pause

/** Home and Decided by AI: when deciding is paused back to propose, why, with the audit's page. */
export function DecidePaused({ decide }: { decide: Api.DecisionsViewT["decide"] }) {
  if (!decide.paused) return null;
  return (
    <div className="state" role="note" aria-label={D.pausedTitle}>
      <p style={{ margin: 0 }}>
        <span aria-hidden="true">⏸ </span>
        <strong>{D.pausedTitle}</strong>
      </p>
      <p style={{ margin: "4px 0 0" }}>{D.pausedWhy(decide.paused.why)}</p>
      <a href="#/trust">{D.pausedLink}</a>
    </div>
  );
}
