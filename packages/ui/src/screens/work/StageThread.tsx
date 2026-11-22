import { useEffect, useId, useRef, useState, type FormEvent, type RefObject } from "react";
import type { Api } from "@maycombhq/core";
import { api, ApiError, useApi, useLiveEvents, type Loaded } from "../../api/client.js";
import { focusIfLost, Panel, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { message } from "../know/common.js";
import { QuestionDetail } from "../Questions.js";
import { ArtifactEditor } from "../Changes.js";
import { CopyButton } from "../run/shared.js";
import { Problems } from "./RunNext.js";
import "./work.css";
import { Explain } from "./cw.js";
import { HandoffStep } from "../../app/runstep.js";

/**
 * ADR 0189: a stage is one conversation. The stage's tab shows its thread inline, in order: the
 * prompt for the person's assistant (with Copy), the answer and what its checks said (the app
 * checks it as soon as the file is written; nobody presses Done), what the stage wrote, what the
 * critic found (Reply, Make the fix, Ask the owner), the questions answered in place, the
 * questions that couldn't be kept (Keep it anyway), and a reply box at the bottom ("Tell the
 * assistant…") that starts the next round. Sizes, models and file paths are under Details; Set
 * up › Model runs stays the administrator's view of every run.
 */

const T = COPY.thread;
const A = COPY.accept;
type View_ = Api.StageThreadViewT;
type Item = Api.ThreadItemT;
type Stage = Api.ThreadStageT;
type FindingItem = Extract<Item, { kind: "finding" }>;

export interface ThreadHandlers {
  /** Start the stage's next round (its prompt is written for the assistant). */
  onStart?: () => Promise<unknown>;
  /** Send a reply (about a finding, when given); `next` also starts the next round. */
  onReply?: (text: string, about: FindingItem | undefined, next: boolean) => Promise<unknown>;
  onAct?: (
    item: FindingItem,
    action: "apply" | "not-relevant" | "ask",
    reason?: string,
  ) => Promise<unknown>;
  onKeep?: (key: string) => Promise<unknown>;
  onAnswered?: () => void;
  /** ADR 0203 A: accept a stage's own finding with a reason, as the person using the app. */
  onAccept?: (item: FindingItem, reason: string) => Promise<unknown>;
}

/** What the Accept form needs of the thread around the finding. */
interface AcceptContext {
  stage: string;
  /** The stage's command, to run it again. */
  command: string;
  /** Other open blocking findings and open questions at the stage. */
  others: number;
  /**
   * The stage goes on from the assistant's next answer (a prompt waits, or its last answer is to
   * be fixed); otherwise it stopped, and its next run checks its files with no new draft.
   */
  waiting: boolean;
  /** The accepted list is on the page and says there is no Undo: the form doesn't say it again. */
  noUndoShown?: boolean;
}

/**
 * A stage's message once accepted ends "(accepted by <who>: <why>.)", which the accepted list
 * says on its own line: said once.
 */
export const withoutAccepted = (summary: string) =>
  summary.replace(/ \(accepted by [^)]*\)\.?$/, "");

/** A stage's own finding (ADR 0203 A): one on the built-in gate `stage-<stage>`. */
const ownFinding = (f: { gate: string }) => f.gate.startsWith("stage-");

/**
 * What accepting a stage's finding does, before anything is written (ADR 0203 A.5, A.6): where it
 * is recorded, whether the stage can then end done, and what the later stages do with it.
 */
export function acceptPreview(o: AcceptContext & { rule: string; file: string }): string[] {
  return [
    A.previewRecord(o.file),
    o.others > 0
      ? A.previewOthers(o.stage, o.others)
      : o.waiting
        ? A.previewWaiting(o.stage)
        : A.previewDone(o.stage, o.command),
    A.carries[o.rule] ?? A.carriesDefault,
  ];
}

/**
 * The status line after an Accept (ADR 0203 A, addendum 2026-11-22): what the app did with the
 * stage, whoever started it; where it couldn't go on, what to press. An older server says nothing
 * of it, and the line says the acceptance alone.
 */
export function acceptedNote(
  id: string,
  stage: string,
  goesOn: Api.StageAcceptThenT | undefined,
): string {
  if (!goesOn) return A.done(id, stage);
  if (goesOn.kind === "held") return A.went.held(stage, goesOn.held ?? 1);
  if (goesOn.kind === "not-resumed") return A.went.notResumed(stage, goesOn.lines?.[0]);
  return A.went[goesOn.kind](stage);
}

/** The `goesOn` of an Accept's answer, when the server sent one. */
const goesOnOf = (r: unknown): Api.StageAcceptThenT | undefined =>
  r && typeof r === "object" && "goesOn" in r
    ? ((r as { goesOn?: Api.StageAcceptThenT }).goesOn ?? undefined)
    : undefined;

type AcceptState = "idle" | "invalid" | "busy" | "error" | "refused";

/**
 * Accept a stage's finding: who (the person the app records, shown, never typed), why
 * (required), and what accepting does. A refusal (403: the command line's own words) leaves no
 * Accept to press again. `initial` lets tests render each state.
 */
export function AcceptForm(
  p: AcceptContext & {
    it: FindingItem;
    onAccept?: (reason: string) => Promise<unknown>;
    onCancel: () => void;
    /** A 403: the server's words, which the card keeps once the form is closed. */
    onRefused?: (words: string) => void;
    initial?: { reason?: string; state?: AcceptState; error?: string };
  },
) {
  const id = useId();
  const f = p.it.view.finding;
  const as = p.it.view.accept?.as ?? "";
  const [reason, setReason] = useState(p.initial?.reason ?? "");
  const [state, setState] = useState<AcceptState>(p.initial?.state ?? "idle");
  const [error, setError] = useState(p.initial?.error);
  const box = useRef<HTMLTextAreaElement>(null);
  const said = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (state === "invalid") box.current?.focus();
    if (state === "error" || state === "refused") focusIfLost(said.current);
  }, [state]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (state === "busy" || state === "refused") return;
    if (!reason.trim()) return setState("invalid");
    setState("busy");
    setError(undefined);
    void (p.onAccept?.(reason.trim()) ?? Promise.resolve()).then(
      () => setState("idle"),
      (err: unknown) => {
        const words = message(err);
        setError(words);
        const refused = err instanceof ApiError && err.problem.status === 403;
        setState(refused ? "refused" : "error");
        if (refused) p.onRefused?.(words);
      },
    );
  };
  const lines = acceptPreview({ ...p, rule: f.rule, file: p.it.view.file });
  const alert =
    state === "invalid"
      ? A.needReason
      : state === "error" || state === "refused"
        ? error
        : undefined;
  return (
    <form
      className="stack thread-accept"
      style={{ gap: 6, marginTop: 8 }}
      aria-labelledby={`${id}-t`}
      aria-busy={state === "busy" ? "true" : undefined}
      onSubmit={submit}
      noValidate
    >
      <h3 id={`${id}-t`} className="hud" style={{ margin: 0 }}>
        {A.title(f.rule)}
      </h3>
      <p className="work-say" style={{ margin: 0 }}>
        {A.intro}
      </p>
      <p style={{ margin: 0 }}>
        <span className="hud">{A.who}</span> <strong>{A.whoIs(as)}</strong>
      </p>
      <p className="muted" style={{ margin: 0 }}>
        {A.whoHint}
      </p>
      <label htmlFor={`${id}-r`} className="hud">
        {A.reason}
      </label>
      <textarea
        id={`${id}-r`}
        ref={box}
        className="field"
        rows={3}
        required
        aria-required="true"
        aria-invalid={state === "invalid" ? "true" : undefined}
        aria-describedby={`${id}-h ${id}-p${alert ? ` ${id}-e` : ""}`}
        value={reason}
        disabled={state === "busy"}
        onChange={(e) => {
          setReason(e.target.value);
          if (state === "invalid") setState("idle");
        }}
      />
      <p id={`${id}-h`} className="work-say" style={{ margin: 0 }}>
        {A.reasonHint}
      </p>
      <div id={`${id}-p`} className="stack" style={{ gap: 4 }}>
        <span className="hud">{A.preview}</span>
        <ul className="stage-comments">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        {!p.noUndoShown && (
          <p className="muted" style={{ margin: 0 }}>
            {A.noUndo}
          </p>
        )}
      </div>
      {alert && (
        <p id={`${id}-e`} ref={said} tabIndex={-1} role="alert" className="state error">
          {alert}
        </p>
      )}
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        {state !== "refused" && (
          <button type="submit" className="btn primary" disabled={state === "busy"}>
            {state === "busy" ? A.busy : A.submit}
          </button>
        )}
        <button type="button" className="btn" onClick={p.onCancel}>
          {state === "refused" ? A.close : A.cancel}
        </button>
      </div>
    </form>
  );
}

/** A reply saved whose next round didn't start (review of beta.23): the reply isn't to be sent again. */
export class ReplySaved extends Error {
  constructor(readonly reason: string) {
    super(T.savedNotStarted(reason));
  }
}

/**
 * Send a reply, then (with `next`) start the next round. When the round doesn't start, the reply
 * is saved all the same: the thread reads again to show it, and the failure says so (ReplySaved).
 */
export async function replyAndStart(
  o: { post: () => Promise<unknown>; start: () => Promise<unknown>; reload: () => void },
  next: boolean,
): Promise<void> {
  await o.post();
  if (!next) return o.reload();
  try {
    await o.start();
  } catch (e) {
    o.reload();
    throw new ReplySaved(message(e));
  }
}

/** What the reply box does when a send fails: a saved reply leaves no words to send twice. */
export function replyFailed(e: unknown): { clear: boolean; text: string } {
  return e instanceof ReplySaved
    ? { clear: true, text: e.message }
    : { clear: false, text: message(e) };
}

const shortFile = (p: string) => p.split("/").slice(-2).join("/");

function PromptItem({ it }: { it: Extract<Item, { kind: "prompt" }> }) {
  const open = it.state === "prepared" || it.state === "waiting";
  return (
    <article className="thread-item" aria-label={it.who === "critic" ? T.criticPrompt : T.prompt}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <span className="hud">{it.who === "critic" ? T.criticPrompt : T.prompt}</span>
        <span className={`chip ${open ? "warn" : it.state === "failed" ? "blocking" : "dim"}`}>
          {T.runState[it.state] ?? it.state}
        </span>
        {it.state !== "cancelled" && (
          <CopyButton text={it.prompt} label={T.copyPromptFor(it.runId)} />
        )}
      </div>
      {open && <p className="work-say">{T.pasteHint}</p>}
      <details>
        <summary>{T.showPrompt}</summary>
        <pre className="thread-prompt">{it.prompt}</pre>
      </details>
      <details>
        <summary>{T.details}</summary>
        <ul className="stage-comments">
          <li>{T.detailAgent(it.details.agent, it.details.runtime)}</li>
          <li>{T.detailAttempt(it.details.attempt)}</li>
          {it.details.promptTokens !== undefined && (
            <li>{T.detailTokens(it.details.promptTokens)}</li>
          )}
          {it.details.model && <li>{T.detailModel(it.details.model)}</li>}
          <li>
            <code className="mono">{it.details.promptPath}</code>
          </li>
          {it.details.output && (
            <li>
              <code className="mono">{it.details.output}</code>
            </li>
          )}
          <li>
            <a href={`#/activity?tab=runs&run=${encodeURIComponent(it.runId)}`}>{T.adminView}</a>
          </li>
        </ul>
      </details>
    </article>
  );
}

function AnswerItem({ it }: { it: Extract<Item, { kind: "answer" }> }) {
  return (
    <article className="thread-item" aria-label={it.who === "critic" ? T.criticAnswer : T.answer}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <span className="hud">{it.who === "critic" ? T.criticAnswer : T.answer}</span>
        <span
          className={`chip ${it.checked === "passed" ? "done" : it.checked === "failed" ? "blocking" : "warn"}`}
        >
          {T.checked[it.checked]}
        </span>
      </div>
      {it.by && <p className="work-say">{T.checkedBy[it.by]}</p>}
      {it.summary.length > 0 && (
        <ul className="stage-comments">
          {it.summary.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      )}
      {it.problems.length > 0 && (
        <>
          <span className="hud">{T.problems}</span>
          <ul className="stage-comments">
            {it.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </>
      )}
    </article>
  );
}

export function FindingCardInThread(p: {
  it: FindingItem;
  change: string;
  onReplyTo: (it: FindingItem) => void;
  onAct?: ThreadHandlers["onAct"];
  onAccept?: ThreadHandlers["onAccept"];
  onAccepted?: (id: string, result: unknown) => void;
  onFixToAssistant: (it: FindingItem) => void;
  reason: string;
  accept: AcceptContext;
  /** Tests: the card as it is after a refusal. */
  initial?: { refused?: string };
}) {
  const f = p.it.view.finding;
  const o = p.it.view.options;
  const own = ownFinding(f);
  const ac = p.it.view.accept;
  const [editing, setEditing] = useState(false);
  const [accepting, setAccepting] = useState(false);
  // A refusal (403) is the server's last word on it: no Accept to press again, until it reads.
  const [refused, setRefused] = useState<string | undefined>(p.initial?.refused);
  const acceptAt = useRef<HTMLButtonElement>(null);
  const wasAccepting = useRef(false);
  useEffect(() => {
    if (!accepting && wasAccepting.current) acceptAt.current?.focus();
    wasAccepting.current = accepting;
  }, [accepting]);
  const [note, setNote] = useState<{ ok: boolean; text: string } | undefined>();
  const open = f.state === "open";
  // Make the fix by what it does (the review of b30/review2-fixes): for a file the assistant
  // drafts, or one with no editor here, it fills the reply to the assistant, which any open issue
  // may; in the editor, saving records the fix (Apply), so only where Apply is offered.
  const toAssistant = p.it.assistantWrites || !p.it.edit;
  const makeFix = toAssistant ? open && f.kind === "issue" : o.apply;
  const where = `${f.artifact}${f.locator.line ? `:${f.locator.line}` : ""}`;
  const act = (action: "apply" | "not-relevant" | "ask", reason?: string) => {
    if (action === "not-relevant" && !reason?.trim())
      return setNote({ ok: false, text: T.notRelevantNeeds });
    setNote(undefined);
    void p.onAct?.(p.it, action, reason)?.then(
      () =>
        setNote({
          ok: true,
          text:
            action === "ask"
              ? T.asked
              : COPY.stageReview.acted(COPY.stageReview.actions[action] ?? action),
        }),
      (e: unknown) => setNote({ ok: false, text: message(e) }),
    );
  };
  return (
    <article
      className="thread-item stage-finding"
      aria-label={`${own ? A.stageFinding : T.finding}: ${f.id}`}
    >
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <span className="hud">{own ? A.stageFinding : T.finding}</span>
        <span
          className={`chip ${f.severity === "blocking" ? "blocking" : f.severity === "gap" ? "warn" : "dim"}`}
        >
          {COPY.stageReview.severity[f.severity] ?? f.severity}
        </span>
        <span className={`chip ${open ? "" : "done"}`}>{T.findingState[f.state] ?? f.state}</span>
        <code className="mono muted">{f.id}</code>
      </div>
      <p style={{ margin: "6px 0" }}>{f.summary}</p>
      <p className="work-say" style={{ margin: 0 }}>
        {T.where(where)} · {T.fix}: {o.fix}
      </p>
      {f.resolution && (
        <p className="work-say">
          {COPY.stageReview.resolved(T.findingState[f.state] ?? f.state, f.resolution.by)}
          {f.resolution.reason ? `: ${f.resolution.reason}` : ""}
        </p>
      )}
      {open && (
        <div className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: 6 }}>
          <button
            type="button"
            className="btn"
            aria-label={T.replyFor(f.id)}
            onClick={() => p.onReplyTo(p.it)}
          >
            {T.reply}
          </button>
          {makeFix && (
            <button
              type="button"
              className="btn"
              aria-label={T.makeFixFor(f.id)}
              onClick={() => (toAssistant ? p.onFixToAssistant(p.it) : setEditing(true))}
            >
              {T.makeFix}
            </button>
          )}
          {o.ask && (
            <button
              type="button"
              className="btn"
              aria-label={T.askOwnerFor(f.id, o.ask.owner)}
              onClick={() => act("ask")}
            >
              {T.askOwner(o.ask.owner)}
            </button>
          )}
          {o.dismiss && (
            <button type="button" className="btn" onClick={() => act("not-relevant", p.reason)}>
              {T.notRelevant}
            </button>
          )}
          {ac?.can && !accepting && !refused && (
            <button
              ref={acceptAt}
              type="button"
              className="btn"
              aria-label={A.acceptFor(f.id)}
              onClick={() => setAccepting(true)}
            >
              {A.accept}
            </button>
          )}
        </div>
      )}
      {open && p.it.view.personOnly && (
        <p className="work-say">
          {T.personOnly(p.it.view.personOnly.why, p.it.view.personOnly.because)}
        </p>
      )}
      {open && ac && !ac.can && ac.why && (
        <p className="work-say">
          {ac.why === "assistant" && ac.as ? A.cantAssistant(ac.as) : A.cant[ac.why]}
        </p>
      )}
      {open && refused && !accepting && <p className="work-say">{A.refused(refused)}</p>}
      {open && ac?.can && accepting && (
        <AcceptForm
          it={p.it}
          {...p.accept}
          onRefused={setRefused}
          onCancel={() => setAccepting(false)}
          onAccept={async (reason) => {
            const r = await (p.onAccept?.(p.it, reason) ?? Promise.resolve());
            p.onAccepted?.(f.id, r);
          }}
        />
      )}
      {editing && p.it.edit && (
        <div className="stack" style={{ gap: 6, marginTop: 8 }}>
          <p className="work-say">{T.fixInEditor(f.artifact)}</p>
          <ArtifactEditor
            change={p.change}
            artifact={p.it.edit.artifact}
            {...(p.it.edit.file ? { file: p.it.edit.file } : {})}
            {...(p.it.edit.line ? { line: p.it.edit.line } : {})}
            onClose={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              act("apply");
            }}
          />
        </div>
      )}
      {note && (
        <p role={note.ok ? "status" : "alert"} className={note.ok ? "work-say" : "state error"}>
          {note.text}
        </p>
      )}
    </article>
  );
}

function QuestionItem({
  it,
  onAnswered,
}: {
  it: Extract<Item, { kind: "question" }>;
  onAnswered: () => void;
}) {
  const q = it.question;
  return (
    <article className="thread-item" aria-label={T.question}>
      <span className="hud">{T.question}</span>
      {q.state === "open" ? (
        <details open>
          <summary>{T.answerHere(q.question)}</summary>
          <QuestionDetail question={q} onAnswered={onAnswered} />
        </details>
      ) : (
        <p style={{ margin: "6px 0 0" }}>
          {q.question}{" "}
          <span className="muted">
            {T.answered(q.answer?.text ?? q.options[(q.answer?.option ?? 1) - 1]?.label ?? "")}
          </span>
        </p>
      )}
    </article>
  );
}

function DroppedItem({
  it,
  onKeep,
}: {
  it: Extract<Item, { kind: "dropped" }>;
  onKeep?: ThreadHandlers["onKeep"];
}) {
  const [note, setNote] = useState<{ ok: boolean; text: string } | undefined>();
  const [busy, setBusy] = useState(false);
  return (
    <article className="thread-item" aria-label={T.dropped}>
      <span className="hud">{T.dropped}</span>
      <p style={{ margin: "6px 0" }}>{it.question}</p>
      <p className="work-say" style={{ margin: 0 }}>
        {T.droppedCites(it.evidence.join(", "))}{" "}
        {it.nearest ? T.droppedNearest(it.nearest) : T.droppedNone}
      </p>
      <div style={{ marginTop: 6 }}>
        <button
          type="button"
          className="btn"
          disabled={busy}
          aria-label={T.keepFor(it.question)}
          onClick={() => {
            setBusy(true);
            void (onKeep?.(it.key) ?? Promise.resolve()).then(
              () => setNote({ ok: true, text: T.kept }),
              (e: unknown) => {
                setBusy(false);
                setNote({ ok: false, text: message(e) });
              },
            );
          }}
        >
          {T.keep}
        </button>
      </div>
      {note && (
        <p role={note.ok ? "status" : "alert"} className={note.ok ? "work-say" : "state error"}>
          {note.text}
        </p>
      )}
    </article>
  );
}

function ThreadItemView(p: {
  it: Item;
  change: string;
  handlers: ThreadHandlers;
  onReplyTo: (it: FindingItem) => void;
  onFixToAssistant: (it: FindingItem) => void;
  onAccepted: (id: string, result: unknown) => void;
  reason: string;
  accept: (it: FindingItem) => AcceptContext;
}) {
  const it = p.it;
  switch (it.kind) {
    case "prompt":
      return <PromptItem it={it} />;
    case "answer":
      return <AnswerItem it={it} />;
    case "changed":
      return (
        <article className="thread-item" aria-label={T.changed}>
          <span className="hud">{T.changed}</span>
          <ul className="stage-comments">
            {it.files.map((f) => (
              <li key={f}>{shortFile(f)}</li>
            ))}
          </ul>
        </article>
      );
    case "finding":
      return (
        <FindingCardInThread
          it={it}
          change={p.change}
          onReplyTo={p.onReplyTo}
          onFixToAssistant={p.onFixToAssistant}
          onAccepted={p.onAccepted}
          reason={p.reason}
          accept={p.accept(it)}
          {...(p.handlers.onAct ? { onAct: p.handlers.onAct } : {})}
          {...(p.handlers.onAccept ? { onAccept: p.handlers.onAccept } : {})}
        />
      );
    case "question":
      return <QuestionItem it={it} onAnswered={() => p.handlers.onAnswered?.()} />;
    case "reply":
      return (
        <article className="thread-item thread-reply" aria-label={T.you(it.by)}>
          <span className="hud">
            {T.you(it.by)}
            {it.about ? ` · ${T.aboutFinding(it.about)}` : ""}
          </span>
          <p style={{ margin: "6px 0 0" }}>{it.text}</p>
          <span className="muted" style={{ fontSize: 12 }}>
            {it.read ? T.read : T.unread}
          </span>
        </article>
      );
    case "correction":
      return (
        <article className="thread-item thread-reply" aria-label={T.correction(it.label)}>
          <span className="hud">{T.correction(it.label)}</span>
          <p style={{ margin: "6px 0 0" }}>{it.text}</p>
          <span className="muted" style={{ fontSize: 12 }}>
            {it.by} · {it.state}
          </span>
        </article>
      );
    case "dropped":
      return <DroppedItem it={it} {...(p.handlers.onKeep ? { onKeep: p.handlers.onKeep } : {})} />;
    case "note":
      return (
        <p role="note" className="work-say thread-item">
          {it.text}
        </p>
      );
  }
}

/** The reply box at the bottom: "Tell the assistant…", about a finding when one was picked. */
function ReplyBox(p: {
  v: View_;
  about: FindingItem | undefined;
  onClearAbout: () => void;
  text: string;
  setText: (t: string) => void;
  handlers: ThreadHandlers;
  box: RefObject<HTMLTextAreaElement | null>;
}) {
  const id = useId();
  const [note, setNote] = useState<{ ok: boolean; text: string } | undefined>();
  const [busy, setBusy] = useState(false);
  const noteAt = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (note) focusIfLost(noteAt.current);
  }, [note]);
  if (!p.v.reply.open) return <p className="work-say">{p.v.reply.why ?? T.replyClosed}</p>;
  const send = (next: boolean) => (e?: FormEvent) => {
    e?.preventDefault();
    if (!p.text.trim()) return setNote({ ok: false, text: T.needText });
    setBusy(true);
    setNote(undefined);
    void (p.handlers.onReply?.(p.text.trim(), p.about, next) ?? Promise.resolve()).then(
      () => {
        setBusy(false);
        p.setText("");
        p.onClearAbout();
        setNote({ ok: true, text: T.sent });
      },
      (err: unknown) => {
        setBusy(false);
        const f = replyFailed(err);
        if (f.clear) {
          p.setText("");
          p.onClearAbout();
        }
        setNote({ ok: false, text: f.text });
      },
    );
  };
  const waiting = !!p.v.waiting;
  return (
    <form className="stack thread-reply-box" style={{ gap: 4 }} onSubmit={send(!waiting)}>
      <label htmlFor={`${id}-r`} className="hud">
        {p.about ? T.replyAbout(p.about.view.finding.id) : T.replyLabel}
      </label>
      <textarea
        id={`${id}-r`}
        ref={p.box}
        className="field"
        rows={3}
        value={p.text}
        aria-describedby={`${id}-h`}
        onChange={(e) => p.setText(e.target.value)}
      />
      <p id={`${id}-h`} className="work-say" style={{ margin: 0 }}>
        {T.replyHint}
      </p>
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? T.sending : waiting ? T.sendOnly : T.send}
        </button>
        {/* Words for the next round, without starting it yet. */}
        {!waiting && (
          <button type="button" className="btn" disabled={busy} onClick={() => send(false)()}>
            {T.sendOnly}
          </button>
        )}
        {p.about && (
          <button type="button" className="btn" onClick={p.onClearAbout}>
            {T.clearAbout}
          </button>
        )}
      </div>
      {note && (
        <p
          ref={noteAt}
          tabIndex={-1}
          role={note.ok ? "status" : "alert"}
          className={note.ok ? "work-say" : "state error"}
        >
          {note.text}
        </p>
      )}
    </form>
  );
}

/**
 * Review of the fix: Draft the stories again over files a person wrote names them, and asks
 * once before the step that replaces them (a copy of each is kept first, and the stage says
 * where). Keep them puts the first button back.
 */
export function ReplacePersonFiles(p: { files: string[]; args: string[]; asking?: boolean }) {
  const [asking, setAsking] = useState(p.asking === true);
  const ask = useRef<HTMLParagraphElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const was = useRef(asking);
  const askId = useId();
  useEffect(() => {
    if (asking) ask.current?.focus();
    else if (was.current) back.current?.focus();
    was.current = asking;
  }, [asking]);
  if (!asking)
    return (
      <div>
        <button ref={back} type="button" className="btn" onClick={() => setAsking(true)}>
          {T.byPersonReplace(p.files)}
        </button>
      </div>
    );
  return (
    <div className="stack" style={{ gap: 6 }} role="group" aria-labelledby={askId}>
      <p id={askId} ref={ask} tabIndex={-1} style={{ margin: 0 }}>
        {T.byPersonConfirm(p.files)}
      </p>
      <HandoffStep args={p.args} />
      <div>
        <button type="button" className="btn" onClick={() => setAsking(false)}>
          {T.byPersonKeep}
        </button>
      </div>
    </div>
  );
}

/** The thread from loaded data, so tests can render every state. */
export function StageThreadView(
  p: {
    of: Loaded<View_>;
    stage: Stage;
    /** Tests: the note an Accept left. */ initialNote?: string;
  } & ThreadHandlers,
) {
  const [about, setAbout] = useState<FindingItem | undefined>();
  const [text, setText] = useState("");
  const [starting, setStarting] = useState<{ busy: boolean; error?: string }>({ busy: false });
  const [acceptedSaid, setAcceptedNote] = useState<string | undefined>(p.initialNote);
  const noteAt = useRef<HTMLParagraphElement>(null);
  const acceptedId = useId();
  useEffect(() => {
    if (acceptedSaid) focusIfLost(noteAt.current);
  }, [acceptedSaid]);
  const box = useRef<HTMLTextAreaElement>(null);
  const replyTo = (it: FindingItem) => {
    setAbout(it);
    box.current?.focus();
  };
  const handlers: ThreadHandlers = p;
  return (
    <Panel title={T.title(p.stage)} span="1 / -1" className="cw-thread">
      <Explain text={T.intro} />
      <View of={p.of}>
        {(v) => {
          const fixToAssistant = (it: FindingItem) => {
            setAbout(it);
            setText(T.fixToAssistant(it.view.options.fix));
            box.current?.focus();
          };
          // ADR 0203 A: an accepted finding of the stage is listed apart, with who and why.
          const accepted = v.items.filter(
            (i): i is FindingItem => i.kind === "finding" && !!i.view.accepted,
          );
          const timeline = v.items.filter((i) => !(i.kind === "finding" && i.view.accepted));
          const acceptOf = (it: FindingItem): AcceptContext => ({
            noUndoShown: accepted.length > 0,
            stage: v.stage,
            command: `atticus ${v.step.join(" ")}`,
            waiting: !!v.waiting || (v.state !== "stopped" && v.state !== "questions"),
            others: v.items.filter(
              (i) =>
                (i.kind === "finding" &&
                  i.view.finding.id !== it.view.finding.id &&
                  i.view.finding.state === "open" &&
                  i.view.finding.severity === "blocking") ||
                (i.kind === "question" && i.question.state === "open"),
            ).length,
          });
          return (
            <div className="stack" style={{ gap: 10 }}>
              {/* Announced once: after an Accept its note says what happened, so the headline,
                  which changes with it, is no live region beside it. */}
              <p
                {...(acceptedSaid ? {} : { role: "status", "aria-live": "polite" as const })}
                className="thread-headline"
                style={{ margin: 0 }}
              >
                {v.headline}
              </p>
              {v.byPerson && v.byPerson.length > 0 && (
                <div className="stack" style={{ gap: 6 }}>
                  <p style={{ margin: 0 }}>
                    <a href={`#/cockpit?change=${encodeURIComponent(v.change)}`}>
                      {T.byPersonGoOn}
                    </a>
                  </p>
                  <p className="muted" style={{ margin: 0 }}>
                    {T.byPersonAgain}
                  </p>
                  <ReplacePersonFiles files={v.byPerson} args={[...v.step, "--force"]} />
                </div>
              )}
              {!v.waiting && v.state !== "done" && (
                <div className="cw-thread-start">
                  <button
                    type="button"
                    className="btn primary"
                    disabled={starting.busy}
                    onClick={() => {
                      setStarting({ busy: true });
                      void (p.onStart?.() ?? Promise.resolve()).then(
                        () => setStarting({ busy: false }),
                        (e: unknown) => setStarting({ busy: false, error: message(e) }),
                      );
                    }}
                  >
                    {starting.busy ? T.starting : v.state === "not-started" ? T.start : T.startNext}
                  </button>
                  {starting.error && (
                    <p role="alert" className="state error">
                      {starting.error}
                    </p>
                  )}
                </div>
              )}
              {acceptedSaid && (
                <p
                  ref={noteAt}
                  tabIndex={-1}
                  role="status"
                  className="work-say"
                  style={{ margin: 0 }}
                >
                  {acceptedSaid}
                </p>
              )}
              {timeline.length === 0 ? (
                // Beta.27 review: a stage done with nothing in its conversation (a proposal
                // written outside the app) says so in its headline; "nothing has happened" under
                // it would say it twice, and wrongly.
                v.state === "done" || accepted.length > 0 ? null : (
                  <div className="state">{T.empty}</div>
                )
              ) : (
                <ol className="thread" aria-label={T.title(p.stage)}>
                  {timeline.map((it, i) => (
                    <li key={`${it.kind}-${i}-${it.at}`}>
                      <ThreadItemView
                        it={it}
                        change={v.change}
                        handlers={handlers}
                        onReplyTo={replyTo}
                        onFixToAssistant={fixToAssistant}
                        onAccepted={(id, r) =>
                          setAcceptedNote(acceptedNote(id, v.stage, goesOnOf(r)))
                        }
                        accept={acceptOf}
                        reason={
                          about &&
                          it.kind === "finding" &&
                          about.view.finding.id === it.view.finding.id
                            ? text
                            : ""
                        }
                      />
                    </li>
                  ))}
                </ol>
              )}
              {accepted.length > 0 && (
                <section aria-labelledby={acceptedId} className="stack" style={{ gap: 6 }}>
                  <h3 id={acceptedId} className="hud" style={{ margin: 0 }}>
                    {A.acceptedTitle(v.stage)}
                  </h3>
                  <ul className="stage-comments">
                    {accepted.map((it) => {
                      const f = it.view.finding;
                      const a = it.view.accepted!;
                      return (
                        <li key={f.id}>
                          <span className="chip done">{f.rule}</span>{" "}
                          <code className="mono muted">{f.id}</code>
                          <p style={{ margin: "4px 0" }}>{withoutAccepted(f.summary)}</p>
                          <p style={{ margin: 0 }}>{A.acceptedBy(a.by, a.why)}</p>
                          <span className="muted" style={{ fontSize: 12 }}>
                            {A.acceptedOn(a.at)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                  <p className="muted" style={{ margin: 0 }}>
                    {A.noUndo}
                  </p>
                </section>
              )}
              <ReplyBox
                v={v}
                about={about}
                onClearAbout={() => setAbout(undefined)}
                text={text}
                setText={setText}
                handlers={handlers}
                box={box}
              />
              {v.problems.length > 0 && <Problems list={v.problems} />}
            </div>
          );
        }}
      </View>
    </Panel>
  );
}

/** The thread on a stage's tab: read, followed live, and written to. */
export function StageThreadPanel({ change, stage }: { change: string; stage: Stage }) {
  const path = `/api/changes/${encodeURIComponent(change)}/stages/${stage}/thread`;
  const view = useApi<View_>(path);
  // The answer arriving, a check, a new round: the thread reads again (runs and files).
  useLiveEvents((e) => {
    if (e.type === "file.changed" || e.type === "run.changed") view.reload();
  });
  const start = async () => {
    const v = view.state === "ready" ? view.data : undefined;
    if (!v) return;
    await api("/api/runs/handoff", { method: "POST", body: { args: v.step } });
    view.reload();
  };
  const onReply: ThreadHandlers["onReply"] = (text, about, next) =>
    replyAndStart(
      {
        post: () =>
          api(path, {
            method: "POST",
            body: about
              ? {
                  kind: "finding",
                  finding: about.view.finding.id,
                  gate: about.view.finding.gate,
                  text,
                }
              : { kind: "reply", text },
          }),
        start,
        reload: () => view.reload(),
      },
      next,
    );
  const onAct: ThreadHandlers["onAct"] = async (it, action, reason) => {
    const f = it.view.finding;
    await api(`/api/findings/${encodeURIComponent(change)}/${encodeURIComponent(f.id)}/action`, {
      method: "POST",
      body: {
        action,
        gate: f.gate,
        ...(reason ? { reason } : {}),
        ...(action === "ask" && it.view.options.ask ? { askedOf: it.view.options.ask.owner } : {}),
      },
    });
    view.reload();
  };
  const onKeep: ThreadHandlers["onKeep"] = async (key) => {
    await api(path, { method: "POST", body: { kind: "keep", key } });
    view.reload();
  };
  // ADR 0203 A: the command line's own waive, in the name of the person using the app.
  const onAccept: ThreadHandlers["onAccept"] = async (it, reason) => {
    // ADR 0203 A (addendum 2026-11-22): the server goes on with the stage, and says how.
    // A refusal reads the thread again too, so its Accept says what the server says now.
    const r = await api(`/api/changes/${encodeURIComponent(change)}/stages/${stage}/accept`, {
      method: "POST",
      body: { finding: it.view.finding.id, reason },
    }).finally(() => view.reload());
    return r;
  };
  return (
    <StageThreadView
      of={view}
      stage={stage}
      onStart={start}
      onReply={onReply}
      onAct={onAct}
      onKeep={onKeep}
      onAccept={onAccept}
      onAnswered={() => view.reload()}
    />
  );
}
