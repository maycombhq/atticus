import { useEffect, useId, useRef, useState, type FormEvent, type RefObject } from "react";
import type { Api } from "@maycombhq/core";
import { api, useApi, useLiveEvents, type Loaded } from "../../api/client.js";
import { focusIfLost, Panel, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { message } from "../know/common.js";
import { QuestionDetail } from "../Questions.js";
import { ArtifactEditor } from "../Changes.js";
import { CopyButton } from "../run/shared.js";
import { Problems } from "./RunNext.js";
import "./work.css";

/**
 * ADR 0188: a stage is one conversation. The stage's tab shows its thread inline, in order: the
 * prompt for the person's assistant (with Copy), the answer and what its checks said (the app
 * checks it as soon as the file is written; nobody presses Done), what the stage wrote, what the
 * critic found (Reply, Make the fix, Ask the owner), the questions answered in place, the
 * questions that couldn't be kept (Keep it anyway), and a reply box at the bottom ("Tell the
 * assistant…") that starts the next round. Sizes, models and file paths are under Details; Set
 * up › Model runs stays the administrator's view of every run.
 */

const T = COPY.thread;
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
            <a href={`#/runs?run=${encodeURIComponent(it.runId)}`}>{T.adminView}</a>
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

function FindingCardInThread(p: {
  it: FindingItem;
  change: string;
  onReplyTo: (it: FindingItem) => void;
  onAct?: ThreadHandlers["onAct"];
  onFixToAssistant: (it: FindingItem) => void;
  reason: string;
}) {
  const f = p.it.view.finding;
  const o = p.it.view.options;
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | undefined>();
  const open = f.state === "open";
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
    <article className="thread-item stage-finding" aria-label={`${T.finding}: ${f.id}`}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <span className="hud">{T.finding}</span>
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
          {o.apply && (
            <button
              type="button"
              className="btn"
              aria-label={T.makeFixFor(f.id)}
              onClick={() =>
                p.it.assistantWrites || !p.it.edit ? p.onFixToAssistant(p.it) : setEditing(true)
              }
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
        </div>
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
  reason: string;
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
          reason={p.reason}
          {...(p.handlers.onAct ? { onAct: p.handlers.onAct } : {})}
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
        setNote({ ok: false, text: message(err) });
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

/** The thread from loaded data, so tests can render every state. */
export function StageThreadView(p: { of: Loaded<View_>; stage: Stage } & ThreadHandlers) {
  const [about, setAbout] = useState<FindingItem | undefined>();
  const [text, setText] = useState("");
  const [starting, setStarting] = useState<{ busy: boolean; error?: string }>({ busy: false });
  const box = useRef<HTMLTextAreaElement>(null);
  const replyTo = (it: FindingItem) => {
    setAbout(it);
    box.current?.focus();
  };
  const handlers: ThreadHandlers = p;
  return (
    <Panel title={T.title(p.stage)} span="1 / -1">
      <p className="work-why" style={{ marginTop: 0 }}>
        {T.intro}
      </p>
      <View of={p.of}>
        {(v) => {
          const fixToAssistant = (it: FindingItem) => {
            setAbout(it);
            setText(T.fixToAssistant(it.view.options.fix));
            box.current?.focus();
          };
          return (
            <div className="stack" style={{ gap: 10 }}>
              <p role="status" aria-live="polite" className="thread-headline" style={{ margin: 0 }}>
                {v.headline}
              </p>
              {!v.waiting && v.state !== "done" && (
                <div>
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
              {v.items.length === 0 ? (
                <div className="state">{T.empty}</div>
              ) : (
                <ol className="thread" aria-label={T.title(p.stage)}>
                  {v.items.map((it, i) => (
                    <li key={`${it.kind}-${i}-${it.at}`}>
                      <ThreadItemView
                        it={it}
                        change={v.change}
                        handlers={handlers}
                        onReplyTo={replyTo}
                        onFixToAssistant={fixToAssistant}
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
  const onReply: ThreadHandlers["onReply"] = async (text, about, next) => {
    await api(path, {
      method: "POST",
      body: about
        ? { kind: "finding", finding: about.view.finding.id, gate: about.view.finding.gate, text }
        : { kind: "reply", text },
    });
    if (next) await start();
    else view.reload();
  };
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
  return (
    <StageThreadView
      of={view}
      stage={stage}
      onStart={start}
      onReply={onReply}
      onAct={onAct}
      onKeep={onKeep}
      onAnswered={() => view.reload()}
    />
  );
}
