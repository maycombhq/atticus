import { useId, useState, type FormEvent } from "react";
import { confirmed } from "../api/confirm.js";
import type { Api } from "@maycombhq/core";
import { api, type Loaded } from "../api/client.js";
import { Propose } from "../app/propose.js";
import { View } from "../app/ui.js";
import { COPY } from "../copy.js";
import { CopyButton, message } from "./run/shared.js";

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
        <ul className="stack" style={{ listStyle: "none", margin: 0, padding: 0, gap: 12 }}>
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
 * ADR 0189 (app-only audit): "Asking happens outside Atticus" stays for an owner Atticus can't
 * reach; where notifications are set up, Send posts the question to its owner, on the person's
 * confirmation (it is a message, ADR 0186). Manual notifications make it a step for the person.
 */
export function SendOwnerQuestion({ id, owner }: { id: string; owner: string }) {
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
    <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
      <button type="button" className="btn" disabled={busy} onClick={() => void send()}>
        {busy ? S.sending : S.button(owner)}
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

export function OwnerQuestionCard(p: { q: Api.OwnerQuestionViewT; onAnswered: () => void }) {
  const q = p.q;
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
    <article className="panel stack" style={{ gap: 6 }} aria-labelledby={`${id}-q`}>
      <div className="row between" style={{ gap: 8, alignItems: "flex-start" }}>
        <h3 id={`${id}-q`} style={{ margin: 0, fontSize: 13.5, fontWeight: 500 }}>
          {q.question}
        </h3>
        <span className={`chip ${shown.state === "answered" ? "done" : "warn"}`}>
          {shown.state === "answered" ? O.answered : O.open}
        </span>
      </div>
      <span className="hud" style={{ fontSize: 10 }}>
        {O.ask(q.owner, q.system, q.channel)} · <code className="mono">{q.id}</code>
      </span>
      {q.routeTo && <span className="muted">{O.routeTo(q.routeTo)}</span>}
      {q.finding && (
        <span className="muted" style={{ fontSize: 12.5 }}>
          {O.fromFinding(q.finding.change, q.finding.gate, q.finding.id)}
        </span>
      )}
      <span className="muted" style={{ fontSize: 12.5 }}>
        {O.needs(q.neededFact)}
      </span>
      {q.fill?.map((f) => (
        <span key={`${f.file}|${f.field}`} className="muted" style={{ fontSize: 12.5 }}>
          {O.fill(f.file, f.field)}
        </span>
      ))}
      {shown.answer && <p style={{ margin: 0 }}>{O.answeredWas(shown.answer)}</p>}
      {/* ADR 0189: sent to its owner through the notifications Atticus is set up with. */}
      {shown.state !== "answered" && <SendOwnerQuestion id={q.id} owner={q.owner} />}
      <form className="stack" style={{ gap: 6 }} onSubmit={(e) => void submit(e)}>
        <label htmlFor={`${id}-a`} className="hud" style={{ fontSize: 10 }}>
          {shown.answer ? O.answerAgain : O.answerLabel}
        </label>
        <textarea
          id={`${id}-a`}
          className="field"
          rows={2}
          value={words}
          onChange={(e) => setWords(e.target.value)}
        />
        <div className="row" style={{ gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? O.saving : O.save}
          </button>
          <code className="mono muted" style={{ fontSize: 11.5 }}>
            {O.command(q.id)}
          </code>
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
