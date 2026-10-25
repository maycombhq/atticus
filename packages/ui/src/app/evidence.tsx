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
import { api, useLiveEvents, type Loaded } from "../api/client.js";
import { COPY } from "../copy.js";
import { Command } from "../screens/work/RunNext.js";
import { message } from "../screens/run/shared.js";
import { escapeCloses } from "./ui.js";
import {
  evidenceGaps,
  hitsAt,
  questionsAt,
  splitAt,
  type FactCite,
  type FactsView,
  type GapKind,
  type Hit,
} from "./evidence-model.js";
import "./evidence.css";

/**
 * The Map with its evidence (ADR 0124 addendum D-app, F3). Wherever the Map shows something a
 * fact backs (a box or link on the estate canvas, a flow's step, a contract), its citation is a
 * button: hovering or focusing it shows the file, the line and the quote the reader kept, who
 * made the fact and who checked it; a gap is marked with a shape and words, never colour alone.
 * Pressing it opens the facts on that line, with Correct this: mark a fact wrong or put its
 * claim right. The app writes the correction to the repo's corrections file through the local
 * API and shows the git command and `atticus verify`, which applies it; it runs neither.
 */

const E = COPY.evidence;

export * from "./evidence-model.js";

// ------------------------------------------------------------------ the repos' facts, shared

export interface Evidence {
  /** The repo's facts: undefined until something needs them. */
  of(repo: string): Loaded<FactsView> | undefined;
  need(repo: string): void;
  reload(repo: string): void;
}

export const EvidenceContext = createContext<Evidence | undefined>(undefined);
export const useEvidence = () => useContext(EvidenceContext);

/** Loads each repo's facts once, when a citation first needs them; reads again when facts/ changes. */
export function EvidenceProvider({ children }: { children: ReactNode }) {
  const [views, setViews] = useState<Map<string, Loaded<FactsView>>>(new Map());
  const asked = useRef(new Set<string>());
  const load = useCallback((repo: string) => {
    asked.current.add(repo);
    setViews((m) => {
      if (m.get(repo)?.state === "ready") return m;
      return new Map(m).set(repo, { state: "loading" });
    });
    api<FactsView>(`/api/facts/${encodeURIComponent(repo)}`).then(
      (data) => setViews((m) => new Map(m).set(repo, { state: "ready", data })),
      (e: unknown) => setViews((m) => new Map(m).set(repo, { state: "error", error: message(e) })),
    );
  }, []);
  useLiveEvents((e) => {
    if (e.type === "file.changed" && typeof e.path === "string" && /(^|\/)facts\//.test(e.path))
      for (const r of asked.current) load(r);
  });
  const value = useMemo<Evidence>(
    () => ({
      of: (repo) => views.get(repo),
      need: (repo) => {
        if (!asked.current.has(repo)) load(repo);
      },
      reload: load,
    }),
    [views, load],
  );
  return <EvidenceContext.Provider value={value}>{children}</EvidenceContext.Provider>;
}

/** A fixed set of repos' facts, for tests and pages that already hold them. */
export function staticEvidence(views: Record<string, Loaded<FactsView>>): Evidence {
  return { of: (r) => views[r], need: () => undefined, reload: () => undefined };
}

// ------------------------------------------------------------------ marks and citations

const SHAPE: Record<GapKind, string> = { unverified: "△", question: "?", corrected: "✎" };

/** A gap as a shape and its words: visible, and spoken, never colour alone (WCAG 1.4.1). */
export function GapMarks({ gaps, short = false }: { gaps: readonly GapKind[]; short?: boolean }) {
  if (!gaps.length) return null;
  return (
    <span className="ev-gaps">
      {gaps.map((g) => (
        <span key={g} className={`ev-gap ev-${g}`}>
          <span aria-hidden="true">{SHAPE[g]}</span> {short ? E.short[g] : E.gaps[g]}
        </span>
      ))}
    </span>
  );
}

function FactLine({ hit }: { hit: Hit }) {
  const f = hit.fact;
  return (
    <span className="ev-fact">
      <code className="mono">{hit.step ?? f.label}</code>{" "}
      <span className="muted">
        {E.by[f.by] ?? f.by} · {E.verified[f.verified] ?? f.verified}
      </span>
      {f.correction && (
        <span className="ev-corr"> · {E.correction(f.correction.action, f.correction.by)}</span>
      )}
    </span>
  );
}

/** What the tooltip says: the place, the quote, each fact on the line and the gaps. */
export function CitationTip(p: {
  repo?: string | undefined;
  at: string;
  of: Loaded<FactsView> | undefined;
}) {
  const place = splitAt(p.at);
  const v = p.of?.state === "ready" ? p.of.data : undefined;
  const hits = v && place ? hitsAt(v, place.file, place.line) : [];
  const quote = hits.find((h) => h.spot.quote)?.spot.quote;
  return (
    <>
      <span className="ev-place mono">
        {p.repo ? `${p.repo} · ` : ""}
        {p.at}
      </span>
      {p.of?.state === "loading" && <span className="ev-say">{E.loading}</span>}
      {v && !v.present && p.repo && <span className="ev-say">{E.noFacts(p.repo)}</span>}
      {v && v.present && (
        <>
          <span className="ev-say">{E.quote}</span>
          {quote ? (
            <code className="ev-quote mono">{quote}</code>
          ) : (
            <span className="ev-say">{E.noQuote}</span>
          )}
          {hits.map((h) => (
            <FactLine key={`${h.fact.id}:${h.step ?? ""}`} hit={h} />
          ))}
        </>
      )}
      {v && place && <GapMarks gaps={evidenceGaps(v, [place])} />}
    </>
  );
}

/**
 * A citation: file and line on a button. Hover or focus shows the tooltip (it stays while the
 * pointer is over it, and Escape hides it, WCAG 1.4.13); pressing it opens the facts on the line
 * with Correct this. Without the repo's facts it is the file and line, as before.
 */
export function Citation({ repo, at }: { repo?: string | undefined; at: string }) {
  const ev = useEvidence();
  useEffect(() => {
    if (repo) ev?.need(repo);
  }, [repo, ev]);
  const of = repo ? ev?.of(repo) : undefined;
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const tip = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const place = splitAt(at);
  const v = of?.state === "ready" ? of.data : undefined;
  const gaps = v && place ? evidenceGaps(v, [place]) : [];
  const short = at.split("/").pop()!;
  return (
    <span
      className={`ev-wrap${open ? " open" : ""}${hidden ? " quiet" : ""}`}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !open) setHidden(true);
      }}
      onMouseLeave={() => setHidden(false)}
      onBlur={() => setHidden(false)}
    >
      <button
        ref={btn}
        type="button"
        className={`ev-cite${gaps.length ? " gappy" : ""}`}
        aria-describedby={tip}
        aria-expanded={open}
        aria-label={repo ? E.citeOf(at, repo) : E.cite(at)}
        onClick={() => setOpen((o) => !o)}
      >
        <code className="mono">{short}</code>
        {gaps.length > 0 && <GapMarks gaps={gaps} short />}
      </button>
      <span role="tooltip" id={tip} className="ev-tip">
        <CitationTip repo={repo} at={at} of={of} />
      </span>
      {open && (
        <CitationDetails
          repo={repo}
          at={at}
          of={of}
          onClose={() => {
            setOpen(false);
            btn.current?.focus();
          }}
        />
      )}
    </span>
  );
}

/** The facts on the line, each with Correct this; the open questions with a link to answer. */
export function CitationDetails(p: {
  repo?: string | undefined;
  at: string;
  of: Loaded<FactsView> | undefined;
  onClose: () => void;
}) {
  const place = splitAt(p.at);
  const v = p.of?.state === "ready" ? p.of.data : undefined;
  const hits = v && place ? hitsAt(v, place.file, place.line) : [];
  const qs = v && place ? questionsAt(v, place.file, place.line) : [];
  const [fixing, setFixing] = useState<string | undefined>();
  const facts = [...new Map(hits.map((h) => [h.fact.id, h.fact])).values()];
  return (
    <div
      className="ev-details"
      role="group"
      aria-label={E.cite(p.at)}
      onKeyDown={escapeCloses(p.onClose)}
    >
      <CitationTip repo={p.repo} at={p.at} of={p.of} />
      {qs.length > 0 && (
        <ul className="ev-list">
          {qs.map((q) => (
            <li key={q.id}>
              {q.question} <a href={`#/questions/${q.id}`}>{E.openQuestion}</a>
            </li>
          ))}
        </ul>
      )}
      {p.repo && facts.length > 0 && (
        <ul className="ev-list">
          {facts.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                className="btn"
                aria-label={E.correctFact(f.label)}
                aria-expanded={fixing === f.id}
                onClick={() => setFixing(fixing === f.id ? undefined : f.id)}
              >
                {E.correct}
              </button>{" "}
              <code className="mono">{f.label}</code>
              {fixing === f.id && (
                <CorrectFact repo={p.repo!} fact={f} onClose={() => setFixing(undefined)} />
              )}
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="btn" onClick={p.onClose}>
        {E.close}
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ correcting a fact

export type Saving =
  | { state: "idle" }
  | { state: "working" }
  | { state: "done"; result: Api.FactCorrectionResultT }
  | { state: "error"; text: string };

export interface CorrectionDraft {
  action: "wrong" | "edit";
  reason: string;
  set: Record<string, string>;
  line: string;
}

/** The request for a draft, or what is missing in words. */
export function correctionBody(
  fact: FactCite,
  d: CorrectionDraft,
): { body: Record<string, unknown> } | { error: string } {
  const reason = d.reason.trim();
  if (d.action === "wrong") {
    if (!reason) return { error: E.needReason };
    return { body: { fact: fact.id, action: "wrong", reason } };
  }
  const set = Object.fromEntries(
    Object.entries(d.set).filter(([k, v]) => (fact.claim[k] ?? "") !== v.trim()),
  );
  const line = Number(d.line);
  const moved = Number.isInteger(line) && line > 0 && line !== fact.cite.line;
  if (!Object.keys(set).length && !moved) return { error: E.nothingChanged };
  return {
    body: {
      fact: fact.id,
      action: "edit",
      ...(Object.keys(set).length ? { set } : {}),
      ...(moved ? { line } : {}),
      ...(reason ? { reason } : {}),
    },
  };
}

/** The correction form from its state, so tests can render each one. */
export function CorrectFactForm(p: {
  repo: string;
  fact: FactCite;
  saving?: Saving;
  onSave?: (body: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [d, setD] = useState<CorrectionDraft>({
    action: "wrong",
    reason: "",
    set: { ...p.fact.claim },
    line: String(p.fact.cite.line),
  });
  const [problem, setProblem] = useState<string | undefined>();
  const saving = p.saving ?? { state: "idle" };
  const busy = saving.state === "working";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const b = correctionBody(p.fact, d);
    if ("error" in b) return setProblem(b.error);
    setProblem(undefined);
    p.onSave?.(b.body);
  };
  return (
    <form
      className="ev-correct stack"
      onSubmit={submit}
      onKeyDown={escapeCloses(p.onClose)}
      aria-labelledby={`${id}-t`}
    >
      <h3 id={`${id}-t`} className="h" style={{ fontSize: 14 }}>
        {E.correctTitle(p.fact.label)}
      </h3>
      <p className="ev-say">{E.correctIntro}</p>
      <fieldset className="ev-choice">
        <legend className="sr">{E.correctTitle(p.fact.label)}</legend>
        {(["wrong", "edit"] as const).map((a) => (
          <label key={a} className="row" style={{ gap: 6 }}>
            <input
              type="radio"
              name={`${id}-action`}
              value={a}
              checked={d.action === a}
              onChange={() => setD({ ...d, action: a })}
            />
            {a === "wrong" ? E.wrong : E.edit}
          </label>
        ))}
      </fieldset>
      {d.action === "edit" && (
        <div className="ev-fields">
          {Object.keys(p.fact.claim).map((k) => (
            <label key={k} className="stack" style={{ gap: 2 }}>
              <span className="hud">{k}</span>
              <input
                value={d.set[k] ?? ""}
                onChange={(e) => setD({ ...d, set: { ...d.set, [k]: e.target.value } })}
              />
            </label>
          ))}
          <label className="stack" style={{ gap: 2 }}>
            <span className="hud">{E.line}</span>
            <input
              type="number"
              min={1}
              value={d.line}
              onChange={(e) => setD({ ...d, line: e.target.value })}
            />
          </label>
        </div>
      )}
      <label className="stack" style={{ gap: 2 }}>
        <span className="hud">{d.action === "wrong" ? E.reason : E.reasonOptional}</span>
        <textarea
          rows={2}
          value={d.reason}
          onChange={(e) => setD({ ...d, reason: e.target.value })}
        />
      </label>
      <div className="row" style={{ gap: 6 }}>
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? E.saving : E.save}
        </button>
        <button type="button" className="btn" onClick={p.onClose}>
          {E.close}
        </button>
      </div>
      {problem && (
        <p role="alert" className="state error" style={{ margin: 0 }}>
          {problem}
        </p>
      )}
      {saving.state === "working" && (
        <p role="status" aria-busy="true" className="ev-say">
          {E.saving}
        </p>
      )}
      {saving.state === "error" && (
        <p role="alert" className="state error" style={{ margin: 0 }}>
          {saving.text}
        </p>
      )}
      {saving.state === "done" && (
        <div role="status">
          <p className="ev-say">{E.saved(saving.result.file)}</p>
          <Command text={saving.result.commit} label={E.copyCommit} />
          <Command text={saving.result.verify} label={E.copyVerify} />
        </div>
      )}
    </form>
  );
}

/** Correct a fact: the form, its POST, and the repo's facts read again after. */
export function CorrectFact(p: { repo: string; fact: FactCite; onClose: () => void }) {
  const ev = useEvidence();
  const [saving, setSaving] = useState<Saving>({ state: "idle" });
  const onSave = (body: Record<string, unknown>) => {
    setSaving({ state: "working" });
    api<Api.FactCorrectionResultT>(`/api/facts/${encodeURIComponent(p.repo)}/corrections`, {
      method: "POST",
      body,
    }).then(
      (result) => {
        setSaving({ state: "done", result });
        ev?.reload(p.repo);
      },
      (e: unknown) => setSaving({ state: "error", text: message(e) }),
    );
  };
  return (
    <CorrectFactForm
      repo={p.repo}
      fact={p.fact}
      saving={saving}
      onSave={onSave}
      onClose={p.onClose}
    />
  );
}
