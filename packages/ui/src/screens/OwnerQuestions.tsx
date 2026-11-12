import { useId, useState, type FormEvent } from "react";
import { confirmed } from "../api/confirm.js";
import type { Api } from "@maycombhq/core";
import { api, ApiError, type Loaded } from "../api/client.js";
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
  sentOn,
  onSent,
  onAlready,
}: {
  id: string;
  owner: string;
  /** Beta.27 review: already sent: sending again is the secondary choice; not, it is the main one. */
  again?: boolean;
  /** The day it was sent, when known, for Send again's question. */
  sentOn?: string;
  /**
   * Review of the fix: sent, when (the card then says Sent). Beta.27 review, final round: or a
   * step for the person (`how: "step"`), which is no send: the card says Asked.
   */
  onSent?: (at: string, how: "sent" | "step") => void;
  /** Beta.27 review, final round: the server said it was sent already: the card reloads. */
  onAlready?: () => void;
}) {
  const S = COPY.roleWork.send;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string }>();
  // Review of the fix, round 2: the question's record says it was sent (another person's send,
  // merged) though this page didn't know: the server refused, and Send again is offered.
  const [already, setAlready] = useState(false);
  // Send again asks first: it posts the same question to the owner once more.
  const [asking, setAsking] = useState(false);
  const isAgain = again || already;
  const send = async (resend: boolean) => {
    setBusy(true);
    setNote(undefined);
    try {
      const c = await confirmed("owner-ask", id).catch(() => ({}));
      const r = await api<Api.SentOwnerAskT>(
        `/api/owner-questions/${encodeURIComponent(id)}/send`,
        {
          method: "POST",
          body: { ...c, ...(resend ? { again: true } : {}) },
        },
      );
      if (r.state === "sent" || r.state === "step") onSent?.(new Date().toISOString(), r.state);
      setNote(
        r.state === "sent"
          ? { ok: true, text: S.sent(owner) }
          : r.state === "step"
            ? { ok: true, text: r.why ?? S.step }
            : { ok: false, text: S.notSent(r.why ?? "") },
      );
    } catch (err) {
      if (err instanceof ApiError && err.problem.status === 409) {
        setAlready(true);
        setNote({ ok: false, text: S.already(owner) });
        // Beta.27 review, final round: the card reads the send on file, so it doesn't say "Not
        // sent yet" beside "already sent".
        onAlready?.();
      } else setNote({ ok: false, text: message(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="qs-group-btns">
      <button
        type="button"
        className={isAgain ? "btn" : "btn primary"}
        disabled={busy || asking}
        onClick={() => (isAgain ? setAsking(true) : void send(false))}
      >
        {busy ? S.sending : isAgain ? S.again(owner) : S.button(owner)}
      </button>
      {asking && (
        <span role="group" aria-label={S.again(owner)} className="qs-group-btns">
          <span className="muted" style={{ fontSize: 12.5 }}>
            {S.confirmAgain(owner, sentOn)}
          </span>
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              setAsking(false);
              void send(true);
            }}
          >
            {S.yesAgain}
          </button>
          <button type="button" className="btn" onClick={() => setAsking(false)}>
            {S.cancel}
          </button>
        </span>
      )}
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

/**
 * A date as the page says it (2026-11-09), from a timestamp, on the person's own clock: review of
 * the fix, cutting the UTC string said the 10th for a question sent on the evening of the 9th.
 */
export function localDay(at?: string): string | undefined {
  if (!at) return undefined;
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return undefined;
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/**
 * Review of the fix: an owner in words when roles.yaml gives no name: a team id (team-ledger) as
 * "Ledger team", nobody as "Nobody owns it", anything else (a handle) as it is.
 */
export function ownerWords(owner: string, name?: string): string {
  if (name) return name;
  if (owner === "unassigned") return O.nobody;
  const team = /^team-([a-z0-9-]+)$/.exec(owner)?.[1];
  if (!team) return owner;
  const words = team.split("-").join(" ");
  return O.teamWords(words[0]!.toUpperCase() + words.slice(1));
}

export function OwnerQuestionCard(p: { q: Api.OwnerQuestionViewT; onAnswered: () => void }) {
  const q = p.q;
  // Beta.27 review: the team's name and the channel in words, and the state the API says.
  const who = ownerWords(q.owner, q.ownerName);
  // Beta.27 review, round 2: a system nobody owns goes to the role it is routed to ("the
  // architect"); "Nobody owns it" is for the line that says whose it is, never a recipient.
  const to = q.owner === "unassigned" && q.routeTo ? O.toRole(q.routeTo) : who;
  const by = O.channels[q.channel] ?? q.channel;
  // Review of the fix: sent only when it was: a send on file (sentAt) or one from this card.
  const [sentNow, setSentNow] = useState<string>();
  const sentAt = sentNow ?? q.sentAt;
  // Beta.27 review, final round: Send made a step for the person: asked, not sent.
  const [stepNow, setStepNow] = useState(false);
  const asked = stepNow && !sentAt;
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
          className={`chip ${shown.state === "answered" ? "done" : shown.state === "overdue" ? "blocking" : sentAt || asked ? "warn" : ""}`}
        >
          {shown.state === "answered"
            ? O.answered
            : shown.state === "overdue"
              ? O.overdue
              : sentAt
                ? O.sent
                : asked
                  ? O.asked
                  : O.notSent}
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
            ? O.overdueTo(to, by, localDay(sentAt))
            : sentAt
              ? O.sentTo(to, by, localDay(sentAt))
              : asked
                ? O.askedStep(to)
                : O.notSentTo(to, by)}
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
      {shown.state !== "answered" && (
        <SendOwnerQuestion
          id={q.id}
          owner={to}
          again={!!sentAt || shown.state === "overdue"}
          {...(localDay(sentAt) ? { sentOn: localDay(sentAt)! } : {})}
          onSent={(at, how) => (how === "sent" ? setSentNow(at) : setStepNow(true))}
          onAlready={p.onAnswered}
        />
      )}
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
