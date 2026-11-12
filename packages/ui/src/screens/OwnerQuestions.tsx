import { useId, useState, type FormEvent } from "react";
import { confirmed } from "../api/confirm.js";
import type { Api } from "@maycombhq/core";
import { api, type Loaded } from "../api/client.js";
import { Propose } from "../app/propose.js";
import { View } from "../app/ui.js";
import { COPY } from "../copy.js";
import { CopyButton, message } from "./run/shared.js";
import "./questions.css";

/**
 * The knowledge gaps' owner questions on the Questions page (UX review, 2026-11-08). Each one
 * takes the owner's answer, which the local API writes to catalog/curated/ownerquestion/<id>.yaml,
 * as `atticus questions owner <id> --text` does; then Propose for review. The gap closes once the
 * fact is in the catalog (ADR 0021): an answer alone doesn't close it.
 */

const O = COPY.questions.ownerQuestions;

export type QuestionsKind = "steps" | "owner";

/** #/questions?kind=owner opens the owner questions; anything else the steps' questions. */
export function questionsKind(hash: string): QuestionsKind {
  const query = hash.split("?")[1] ?? "";
  return new URLSearchParams(query).get("kind") === "owner" ? "owner" : "steps";
}

/** The kind the address asks for (`?kind=steps` or `?kind=owner`), or none. */
export function askedKind(hash: string): QuestionsKind | undefined {
  const k = new URLSearchParams(hash.split("?")[1] ?? "").get("kind");
  return k === "owner" || k === "steps" ? k : undefined;
}

/**
 * Beta.27 review: the kind the page opens on when the address names none: the one that has
 * questions. With no steps' question and 3 owner questions, every way in (the status bar, the
 * activity bar, the Explorer, the bottom panel) opened "From the steps (0)".
 */
export function openingKind(
  asked: QuestionsKind | undefined,
  steps: number | undefined,
  owner: number | undefined,
): QuestionsKind {
  if (asked) return asked;
  return steps === 0 && (owner ?? 0) > 0 ? "owner" : "steps";
}

/**
 * Home's Questions to answer: the open questions on file and the open owner questions, the two
 * kinds the Questions page shows; the link opens the owner questions when only they wait.
 */
export function waitingQuestions(
  files: number | undefined,
  owner: number | undefined,
): { n: number | undefined; href: string } {
  if (files === undefined || owner === undefined) return { n: undefined, href: "#/questions" };
  return {
    n: files + owner,
    href: files === 0 && owner > 0 ? "#/questions?kind=owner" : "#/questions",
  };
}

export function OwnerQuestionList(p: {
  of: Loaded<Api.OwnerQuestionListT> & { reload?: () => void };
  onAnswered?: () => void;
}) {
  return (
    <View
      of={p.of}
      empty={(d) => d.empty || d.questions.length === 0}
      emptyContent={
        p.of.state === "ready" ? (
          <div className="state">{p.of.data.empty ? O.emptyCatalog : O.empty}</div>
        ) : undefined
      }
    >
      {(d) => (
        <ul className="qs-owner-list">
          {d.questions.map((q) => (
            <li key={q.id}>
              <OwnerQuestionCard q={q} onAnswered={() => p.onAnswered?.()} />
            </li>
          ))}
        </ul>
      )}
    </View>
  );
}

/**
 * ADR 0191 (app-only audit): "Asking happens outside Atticus" stays for an owner Atticus can't
 * reach; where notifications are set up, Send posts the question to its owner, on the person's
 * confirmation (it is a message, ADR 0186). Manual notifications make it a step for the person.
 */
export function SendOwnerQuestion({
  id,
  owner,
  again = false,
}: {
  id: string;
  owner: string;
  /** Beta.27 review: already sent: sending again is the secondary choice. */
  again?: boolean;
}) {
  const S = COPY.roleWork.send;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string }>();
  const send = async () => {
    setBusy(true);
    setNote(undefined);
    try {
      const c = await confirmed("owner-ask", id).catch(() => ({}));
      const r = await api<Api.SentOwnerAskT>(
        `/api/owner-questions/${encodeURIComponent(id)}/send`,
        {
          method: "POST",
          body: c,
        },
      );
      setNote(
        r.state === "sent"
          ? { ok: true, text: S.sent(r.to) }
          : r.state === "step"
            ? { ok: true, text: S.step }
            : { ok: false, text: S.notSent(r.why ?? "") },
      );
    } catch (err) {
      setNote({ ok: false, text: message(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="qs-group-btns">
      <button type="button" className="btn" disabled={busy} onClick={() => void send()}>
        {busy ? S.sending : again ? S.again(owner) : S.button(owner)}
      </button>
      {note && (
        <span
          role={note.ok ? "status" : "alert"}
          className={note.ok ? "muted" : "state error"}
          style={{ fontSize: 12.5 }}
        >
          {note.text}
        </span>
      )}
    </div>
  );
}

/** A date as the page says it (2026-11-09), from a timestamp. */
const dayOf = (at?: string) => (at && /^\d{4}-\d{2}-\d{2}/.test(at) ? at.slice(0, 10) : undefined);

export function OwnerQuestionCard(p: { q: Api.OwnerQuestionViewT; onAnswered: () => void }) {
  const q = p.q;
  // Beta.27 review: the team's name and the channel in words, and the state the API says.
  const who = q.ownerName ?? q.owner;
  const by = O.channels[q.channel] ?? q.channel;
  const id = useId();
  const [words, setWords] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string }>();
  const [saved, setSaved] = useState<Api.OwnerAnswerResultT>();
  const shown = saved?.question ?? q;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!words.trim()) {
      setNote({ ok: false, text: O.needAnswer });
      return;
    }
    setBusy(true);
    setNote(undefined);
    try {
      const r = await api<Api.OwnerAnswerResultT>(
        `/api/owner-questions/${encodeURIComponent(q.id)}/answer`,
        { method: "POST", body: { answer: words.trim() } },
      );
      setSaved(r);
      setWords("");
      setNote({ ok: true, text: q.finding ? O.savedGap(q.finding.gate) : O.saved(r.file) });
      p.onAnswered();
    } catch (err) {
      setNote({ ok: false, text: message(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="panel qs-card" aria-labelledby={`${id}-q`}>
      <div className="qs-card-head">
        <h3 id={`${id}-q`} className="qs-q">
          {q.question}
        </h3>
        <span
          className={`chip ${shown.state === "answered" ? "done" : shown.state === "overdue" ? "blocking" : "warn"}`}
        >
          {shown.state === "answered" ? O.answered : shown.state === "overdue" ? O.overdue : O.sent}
        </span>
      </div>
      <p className="qs-meta">
        <span>
          {O.ask(who, q.system, by)} · <code className="mono">{q.id}</code>
        </span>
      </p>
      {shown.state !== "answered" && (
        <span className="qs-card-line">
          {shown.state === "overdue"
            ? O.overdueTo(who, by, dayOf(q.sentAt))
            : O.sentTo(who, by, dayOf(q.sentAt))}
        </span>
      )}
      {q.routeTo && <span className="qs-card-line">{O.routeTo(q.routeTo)}</span>}
      {q.finding && (
        <span className="qs-card-line">
          {O.fromFinding(q.finding.change, q.finding.gate, q.finding.id)}
        </span>
      )}
      <span className="qs-card-line">{O.needs(q.neededFact)}</span>
      {q.fill?.map((f) => (
        <span key={`${f.file}|${f.field}`} className="qs-card-line">
          {O.fill(f.file, f.field)}
        </span>
      ))}
      {shown.answer && (
        <p className="qs-answered" style={{ margin: 0 }}>
          {O.answeredWas(shown.answer)}
        </p>
      )}
      {/* ADR 0191: sent to its owner through the notifications Atticus is set up with. */}
      {shown.state !== "answered" && <SendOwnerQuestion id={q.id} owner={who} again />}
      <form className="qs-form" onSubmit={(e) => void submit(e)}>
        <label htmlFor={`${id}-a`} className="qs-field-label">
          {shown.answer ? O.answerAgain : O.answerLabel}
        </label>
        <textarea
          id={`${id}-a`}
          className="field"
          rows={2}
          value={words}
          onChange={(e) => setWords(e.target.value)}
        />
        <div className="qs-actions">
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? O.saving : O.save}
          </button>
          <code className="mono qs-cmd">{O.command(q.id)}</code>
          <CopyButton text={O.command(q.id)} label={O.copyCommand} />
        </div>
      </form>
      {note && (
        <p role={note.ok ? "status" : "alert"} style={{ margin: 0, fontSize: 12.5 }}>
          {note.text}
        </p>
      )}
      {saved && !q.finding && <Propose scope="owner-answers" />}
    </article>
  );
}
