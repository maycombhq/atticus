import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { Api } from "@maycombhq/core";
import { api, useApi, useReloadOnFiles, type Loaded } from "../../api/client.js";
import { escapeCloses, focusIfLost, Panel, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { message } from "../know/common.js";
import { Propose } from "../../app/propose.js";
import { runsHref } from "../runs/Runs.js";
import { Command, PrepareFirst } from "./RunNext.js";
import "./work.css";

/**
 * ADR 0181 (stage drafts): AI decides first, a person corrects, and the AI corrects the rest
 * like it. On Feature design, Architecture, Stories and Tasks: each stage draft with who wrote it
 * last ("Drafted by AI", with the run, until a person saves it: "Edited by <who> on <date>"),
 * and Correct on the draft and on each of its items (a target flow's step, a story's or a
 * proposal's section, a task). A correction, for the item or every similar one, waits for the
 * stage's next run, which reads it as the person's word; the page offers that run (Prepare first)
 * and shows what each run did with the corrections. The app runs no git: the corrections file
 * goes with the stage's hand-off (ninth UX walk), Propose offers it outside one, and the git
 * command stays under "Or in a terminal".
 */

const D = COPY.stageDrafts;

type Drafts = Api.StageDraftsViewT;
type DraftFile = Api.DraftFileViewT;
type Correction = Api.CorrectionViewT;

/** What is being corrected: a file, and an item in it (none: the whole file). */
interface Target {
  file: string;
  item?: string;
  label: string;
  like?: string;
}

export interface CorrectInput {
  file: string;
  item?: string;
  text: string;
  similar: boolean;
  like?: string;
}

export interface StageDraftsHandlers {
  onCorrect?: (c: CorrectInput) => Promise<Api.CorrectionResultT>;
  onRemove?: (c: Correction) => Promise<void>;
}

const day = (at: string | undefined) => (at ? at.slice(0, 10) : "");
const key = (t: { file: string; item?: string | undefined }) => `${t.file}#${t.item ?? ""}`;

/** Who wrote a draft last, as a chip and a line. */
export function DraftedChip({ d }: { d: NonNullable<DraftFile["drafted"]> }) {
  if (d.by === "ai")
    return (
      <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        <span className="chip ai">{D.draftedByAi}</span>
        {d.run && (
          <a href={runsHref({ run: d.run })} aria-label={D.openRun(d.run)}>
            {D.draftedByAiRun(d.run)}
          </a>
        )}
        <span className="sr">{D.draftedByAiWhy(d.stage ?? "")}</span>
      </span>
    );
  return (
    <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
      <span className="chip done">{d.who ? D.editedBy(d.who, day(d.at)) : D.editedByPerson}</span>
      {!d.who && <span className="muted">{D.editedOutside}</span>}
    </span>
  );
}

/** The correction form: what to say instead, Apply to similar (on), and what similar items name. */
export function CorrectForm(p: {
  target: Target;
  onSave: (c: CorrectInput) => Promise<Api.CorrectionResultT>;
  onClose: (saved?: Api.CorrectionResultT) => void;
}) {
  const id = useId();
  const box = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [similar, setSimilar] = useState(true);
  const [like, setLike] = useState(p.target.like ?? "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  useEffect(() => {
    box.current?.focus();
  }, []);
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) {
      setProblem(D.needText);
      box.current?.focus();
      return;
    }
    setProblem(undefined);
    setBusy(true);
    p.onSave({
      file: p.target.file,
      ...(p.target.item ? { item: p.target.item } : {}),
      text: text.trim(),
      similar,
      ...(similar && like.trim() ? { like: like.trim() } : {}),
    })
      .then((r) => p.onClose(r))
      .catch((x: unknown) => {
        setProblem(message(x));
        setBusy(false);
      });
  };
  return (
    <form
      className="stack stage-correct"
      aria-labelledby={`${id}-h`}
      onSubmit={save}
      onKeyDown={escapeCloses(() => p.onClose())}
      style={{ gap: 6, margin: "6px 0 10px" }}
    >
      <p id={`${id}-h`} className="work-say" style={{ margin: 0, fontWeight: 600 }}>
        {D.formTitle(p.target.label)}
      </p>
      <label htmlFor={`${id}-text`}>{D.textLabel}</label>
      <p id={`${id}-hint`} className="work-why" style={{ margin: 0 }}>
        {D.textHint}
      </p>
      <textarea
        ref={box}
        id={`${id}-text`}
        value={text}
        rows={3}
        aria-describedby={`${id}-hint${problem ? ` ${id}-problem` : ""}`}
        aria-invalid={problem ? true : undefined}
        onChange={(e) => setText(e.target.value)}
        style={{
          width: "100%",
          background: "var(--box)",
          color: "var(--text)",
          border: "1px solid var(--line-2)",
          borderRadius: 8,
          padding: 8,
        }}
      />
      <label className="row" style={{ gap: 6 }}>
        <input
          type="checkbox"
          checked={similar}
          aria-describedby={`${id}-similar`}
          onChange={(e) => setSimilar(e.target.checked)}
        />
        {D.similar}
      </label>
      <p id={`${id}-similar`} className="work-why" style={{ margin: 0 }}>
        {D.similarHint}
      </p>
      {similar && (
        <>
          <label htmlFor={`${id}-like`}>{D.likeLabel}</label>
          <input
            id={`${id}-like`}
            value={like}
            aria-describedby={`${id}-like-hint`}
            onChange={(e) => setLike(e.target.value)}
            className="run-select"
          />
          <p id={`${id}-like-hint`} className="work-why" style={{ margin: 0 }}>
            {D.likeHint}
          </p>
        </>
      )}
      {problem && (
        <p id={`${id}-problem`} role="alert" className="state error" style={{ margin: 0 }}>
          {problem}
        </p>
      )}
      {busy && (
        <p role="status" aria-busy="true" className="work-say" style={{ margin: 0 }}>
          {D.saving}
        </p>
      )}
      <div className="row">
        <button type="submit" className="btn primary" disabled={busy}>
          {D.save}
        </button>
        <button type="button" className="btn" onClick={() => p.onClose()}>
          {D.cancel}
        </button>
      </div>
    </form>
  );
}

/** One correction: where, the person's words, and what the runs did with it. */
function CorrectionRow(p: { c: Correction; onRemove?: (c: Correction) => void; busy?: boolean }) {
  const c = p.c;
  return (
    <li>
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        <span
          className={`chip ${c.state === "applied" ? "done" : c.state === "read" ? "warn" : ""}`}
        >
          {D.state[c.state] ?? c.state}
        </span>
        <code className="mono">{c.file}</code>
        {c.item && <span>{c.label}</span>}
        <span className="muted">
          {D.scope[c.scope] ?? c.scope}
          {c.like ? `, ${D.likeOf(c.like)}` : ""}
        </span>
      </div>
      <p className="work-say" style={{ margin: "4px 0" }}>
        “{c.text}” <span className="muted">({D.by(c.by, day(c.at))})</span>
        {c.run && c.state !== "waiting" && (
          <>
            {" "}
            <a href={runsHref({ run: c.run })} aria-label={D.openRun(c.run)}>
              {D.appliedIn(c.run)}
            </a>
          </>
        )}
      </p>
      {c.state === "read" && (
        <p className="work-why" style={{ margin: "0 0 4px" }}>
          {D.readNotApplied}
        </p>
      )}
      {c.touched && c.touched.length > 0 && (
        <>
          <p className="work-why" style={{ margin: 0 }}>
            {D.touched(c.touched.length)}
          </p>
          <ul className="stage-comments">
            {c.touched.map((t) => (
              <li key={t}>
                <code className="mono">{t}</code>
              </li>
            ))}
          </ul>
        </>
      )}
      {c.state === "waiting" && p.onRemove && (
        <button
          type="button"
          className="btn"
          disabled={p.busy}
          aria-label={D.removeFor(c.label)}
          onClick={() => p.onRemove?.(c)}
        >
          {D.remove}
        </button>
      )}
    </li>
  );
}

/** One draft: its file, who wrote it last, Correct, and its items with Correct each. */
function DraftRow(p: {
  f: DraftFile;
  open: Target | undefined;
  correctable: boolean;
  onOpen: (t: Target, from: HTMLButtonElement) => void;
  form: (t: Target) => ReactNode;
}) {
  const f = p.f;
  const whole: Target = { file: f.file, label: f.file };
  const isOpen = (t: Target) => !!p.open && key(p.open) === key(t);
  return (
    <li className="stage-draft">
      <div className="row between" style={{ gap: 8, flexWrap: "wrap" }}>
        <code className="mono">{f.path}</code>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {f.drafted && <DraftedChip d={f.drafted} />}
          {p.correctable && (
            <button
              type="button"
              className="btn"
              aria-label={D.correctFile(f.file)}
              aria-expanded={isOpen(whole)}
              onClick={(e) => p.onOpen(whole, e.currentTarget)}
            >
              {D.correct}
            </button>
          )}
        </div>
      </div>
      {isOpen(whole) && p.form(whole)}
      {f.items.length > 0 && p.correctable && (
        <details>
          <summary>{D.items(f.file)}</summary>
          <ul className="stage-comments">
            {f.items.map((i) => {
              const t: Target = {
                file: f.file,
                item: i.id,
                label: i.label,
                ...(i.like?.[0] ? { like: i.like[0] } : {}),
              };
              return (
                <li key={i.id}>
                  <div className="row between" style={{ gap: 8 }}>
                    <span>{i.label}</span>
                    <button
                      type="button"
                      className="btn"
                      aria-label={D.correctItem(i.label)}
                      aria-expanded={isOpen(t)}
                      onClick={(e) => p.onOpen(t, e.currentTarget)}
                    >
                      {D.correct}
                    </button>
                  </div>
                  {isOpen(t) && p.form(t)}
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </li>
  );
}

/**
 * Ninth UX walk: what a saved correction says. Not "commit the corrections file" with git: the
 * file goes with the stage's hand-off; outside one, Propose for review; the command is folded.
 */
export function CorrectionSaved(p: { text: string; files?: string[]; commit?: string }) {
  return (
    <>
      <p className="work-say" style={{ margin: 0 }}>
        {p.text}
      </p>
      {p.commit && (
        <>
          <p className="work-why" style={{ margin: "4px 0" }}>
            {D.ridesHandoff(p.files?.join(", ") || D.correctionsFile)}
          </p>
          <p className="work-why" style={{ margin: "4px 0" }}>
            {D.outsideHandoff}
          </p>
          <Propose scope="work" />
          <details className="work-terminal">
            <summary>{COPY.runNext.orTerminal}</summary>
            <Command text={p.commit} label={D.copyCommit} noRun />
          </details>
        </>
      )}
    </>
  );
}

/** The panel from loaded data, so tests can render every state. */
export function StageDraftsView(p: { of: Loaded<Drafts> } & StageDraftsHandlers) {
  const [open, setOpen] = useState<Target | undefined>();
  const [said, setSaid] = useState<
    { text: string; files?: string[]; commit?: string; n: number } | undefined
  >();
  const [busy, setBusy] = useState(false);
  const from = useRef<HTMLButtonElement | null>(null);
  const status = useRef<HTMLDivElement>(null);
  // After a save or a take-back the keyboard comes to what was said (the form or row went).
  useEffect(() => {
    if (said) focusIfLost(status.current);
  }, [said]);
  const close = (r?: Api.CorrectionResultT) => {
    const back = from.current;
    setOpen(undefined);
    if (r)
      setSaid((s) => ({
        text: D.saved(r.correction.label),
        files: r.files,
        commit: r.commit,
        n: (s?.n ?? 0) + 1,
      }));
    // Cancel puts the keyboard back on the Correct that opened the form.
    else setTimeout(() => back?.focus(), 0);
  };
  const remove = (c: Correction) => {
    if (!p.onRemove) return;
    setBusy(true);
    p.onRemove(c)
      .then(() => setSaid((s) => ({ text: D.removed, n: (s?.n ?? 0) + 1 })))
      .catch((x: unknown) => setSaid((s) => ({ text: message(x), n: (s?.n ?? 0) + 1 })))
      .finally(() => setBusy(false));
  };
  return (
    <Panel title={D.title} span="1 / -1">
      <p className="work-why" style={{ marginTop: 0 }}>
        {D.intro}
      </p>
      <View
        of={p.of}
        empty={(d) => d.files.length === 0 && d.corrections.length === 0}
        emptyContent={<div className="state">{D.none}</div>}
      >
        {(d) => {
          const waiting = d.corrections.filter((c) => c.state === "waiting");
          const read = d.corrections.filter((c) => c.state !== "waiting");
          return (
            <div className="stack" style={{ gap: 10 }}>
              {d.problems.map((x) => (
                <p key={x.file} role="alert" className="state error" style={{ margin: 0 }}>
                  <code className="mono">{x.file}</code>: {x.message}
                </p>
              ))}
              <ul className="stage-drafts" aria-label={D.title}>
                {d.files.map((f) => (
                  <DraftRow
                    key={f.file}
                    f={f}
                    open={open}
                    correctable={!!p.onCorrect}
                    onOpen={(t, b) => {
                      from.current = b;
                      setOpen(t);
                    }}
                    form={(t) => <CorrectForm target={t} onSave={p.onCorrect!} onClose={close} />}
                  />
                ))}
              </ul>
              <div ref={status} tabIndex={-1} role="status">
                {said && (
                  <CorrectionSaved
                    text={said.text}
                    {...(said.files ? { files: said.files } : {})}
                    {...(said.commit ? { commit: said.commit } : {})}
                  />
                )}
              </div>
              <section aria-label={D.waitingTitle}>
                <h3 className="h" style={{ fontSize: 14, margin: "4px 0" }}>
                  {D.waitingTitle}
                </h3>
                {waiting.length === 0 ? (
                  <p className="work-say" style={{ margin: 0 }}>
                    {D.waitingNone}
                  </p>
                ) : (
                  <>
                    <ul className="stage-comments">
                      {waiting.map((c) => (
                        <CorrectionRow
                          key={c.id}
                          c={c}
                          busy={busy}
                          {...(p.onRemove ? { onRemove: remove } : {})}
                        />
                      ))}
                    </ul>
                    <p className="work-say" style={{ margin: "8px 0 0", fontWeight: 600 }}>
                      {D.runAgain}
                    </p>
                    <p className="work-why" style={{ margin: "0 0 6px" }}>
                      {D.runAgainWhy}
                    </p>
                    <PrepareFirst command={d.next.command} slash={d.next.slash} />
                  </>
                )}
              </section>
              {read.length > 0 && (
                <section aria-label={D.doneTitle}>
                  <h3 className="h" style={{ fontSize: 14, margin: "4px 0" }}>
                    {D.doneTitle}
                  </h3>
                  <ul className="stage-comments">
                    {read.map((c) => (
                      <CorrectionRow key={c.id} c={c} />
                    ))}
                  </ul>
                </section>
              )}
            </div>
          );
        }}
      </View>
    </Panel>
  );
}

/** The panel on a stage page, loading the page's drafts and writing corrections. */
export function StageDraftsPanel({
  change,
  page,
}: {
  change: string;
  page: Api.StageDraftsViewT["page"];
}) {
  const c = encodeURIComponent(change);
  const v = useApi<Drafts>(`/api/changes/${c}/drafts/${page}`);
  useReloadOnFiles(v);
  return (
    <StageDraftsView
      of={v}
      onCorrect={async (x) => {
        const r = await api<Api.CorrectionResultT>(`/api/changes/${c}/corrections`, {
          method: "POST",
          body: x,
        });
        v.reload();
        return r;
      }}
      onRemove={async (x) => {
        await api(`/api/changes/${c}/corrections/${encodeURIComponent(x.id)}/remove`, {
          method: "POST",
        });
        v.reload();
      }}
    />
  );
}
