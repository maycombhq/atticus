import { useId, useRef, useState } from "react";
import type { Api } from "@maycombhq/core";
import { api } from "../../api/client.js";
import { ApplyAndPropose } from "../../app/propose.js";
import { COPY } from "../../copy.js";
import { Note, useAction } from "../know/common.js";
import { DiffLines } from "../setup/EditPreview.js";
import "../questions.css";

/**
 * Beta.24 review: on Map › Trust, the boxes an answer's words made ("ignore this, its cicd
 * related" drawn as a system with arrows to it). Each says where it is (a system of a profile, the
 * answers that name it) and offers two fixes, each previewed first and written only on the
 * person's yes: "It was 'ignore this'" (the answers become Ignore, the system leaves its profile)
 * and "Rename to a real system". The writes are local in the metarepo; Apply puts them on the map
 * and Propose for review opens the pull request, as the setup forms' writes are.
 */

const B = COPY.trust.answerBoxes;
type Box = Api.AnswerBoxT;
type Result = Api.AnswerBoxResultT;

/** What a fix changes: each answer, and the profile's lines. */
export function AnswerBoxChanges({ r, rename }: { r: Result; rename?: string }) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      <p className="work-say" style={{ margin: 0 }}>
        {rename ? B.willRename(r.answers.length, rename) : B.willIgnore(r.answers.length)}
      </p>
      {r.answers.length > 0 && (
        <ul style={{ margin: 0 }}>
          {r.answers.map((a) => (
            <li key={a.id} className="mono" style={{ fontSize: 12 }}>
              {B.answerChange(a.id, a.was, a.now)}
            </li>
          ))}
        </ul>
      )}
      {r.profile && (
        <>
          <p className="work-say" style={{ margin: 0 }}>
            {B.profileChange(r.profile.path)}
          </p>
          <DiffLines
            edit={{ path: r.profile.path, changes: r.profile.changes, written: false, note: "" }}
          />
        </>
      )}
    </div>
  );
}

/** One box and its two fixes. */
export function AnswerBoxRow({ box }: { box: Box }) {
  const id = useId();
  const look = useAction();
  const send = useAction();
  const [mode, setMode] = useState<"ignore" | "rename" | undefined>();
  const [name, setName] = useState("");
  // Beta.25: a preview is kept with the fix it is of, and one that answers after the person has
  // switched fixes is dropped, so "Yes, rename it" never shows Ignore's plan.
  const [shown, setPlan] = useState<{ mode: "ignore" | "rename"; r: Result }>();
  const plan = shown && shown.mode === mode ? shown.r : undefined;
  const asked = useRef(0);
  const [done, setDone] = useState<Result>();
  const path = `/api/trust/answer-boxes/${mode ?? "ignore"}`;
  const body = (preview: boolean) => ({
    id: box.id,
    ...(mode === "rename" ? { name: name.trim() } : {}),
    // The write is the one previewed: refused (409) if its files changed since.
    ...(preview ? { preview: true } : plan?.stamp ? { stamp: plan.stamp } : {}),
  });
  const open = (m: "ignore" | "rename") => {
    asked.current++;
    setMode(m);
    setPlan(undefined);
  };
  const look1 = (m: "ignore" | "rename", b: object) => {
    const n = asked.current;
    return look.run(async () => {
      const r = await api<Result>(`/api/trust/answer-boxes/${m}`, { method: "POST", body: b });
      if (asked.current === n) setPlan({ mode: m, r });
    }, "");
  };
  const preview = () => (mode ? look1(mode, body(true)) : undefined);
  const head = `${id}-h`;
  return (
    <section aria-labelledby={head} className="panel qs-card qs-box">
      <h4 id={head} className="qs-q">
        {B.box(box.name)}
      </h4>
      {box.profile && <p className="qs-card-line">{B.inProfile(box.profile)}</p>}
      {box.questions.length > 0 && (
        <>
          <p className="qs-card-line">{B.answeredIn(box.questions.length)}</p>
          <ul className="qs-box-qs">
            {box.questions.map((q) => (
              <li key={q.id}>
                <a href={`#/questions/${q.id}`}>{q.question}</a>{" "}
                <span className="qs-cmd mono">
                  {q.repo} · {q.id}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {done ? (
        <div className="qs-done">
          <p role="status" className="work-say" style={{ margin: 0 }}>
            {B.written(done.repos.join(", "))}
          </p>
          <ApplyAndPropose
            scope="answers"
            repo={done.repos.length === 1 ? done.repos[0] : undefined}
          />
        </div>
      ) : (
        <>
          <div className="qs-group-btns">
            <button
              type="button"
              className="btn"
              aria-pressed={mode === "ignore"}
              aria-label={B.ignoreOf(box.name)}
              onClick={() => {
                open("ignore");
                void look1("ignore", { id: box.id, preview: true });
              }}
            >
              {B.ignore}
            </button>
            <button
              type="button"
              className="btn"
              aria-pressed={mode === "rename"}
              aria-label={B.renameOf(box.name)}
              onClick={() => open("rename")}
            >
              {B.rename}
            </button>
          </div>
          {mode === "rename" && !plan && (
            <div className="qs-field">
              <label htmlFor={`${id}-name`} className="qs-field-label">
                {B.nameLabel}
              </label>
              <input
                id={`${id}-name`}
                className="field"
                maxLength={200}
                value={name}
                aria-describedby={`${id}-name-d`}
                onChange={(e) => setName(e.target.value)}
              />
              <span id={`${id}-name-d`} className="qs-hint">
                {B.nameHint}
              </span>
              <div className="qs-group-btns">
                <button
                  type="button"
                  className="btn"
                  disabled={look.busy || !name.trim()}
                  onClick={() => void preview()}
                >
                  {look.busy ? B.previewing : B.preview}
                </button>
              </div>
            </div>
          )}
          {look.busy && mode === "ignore" && !plan && (
            <p role="status" aria-busy="true" className="muted" style={{ margin: 0 }}>
              {B.previewing}
            </p>
          )}
          {look.note && !look.note.ok && <Note note={look.note} />}
          {plan && mode && (
            <div className="qs-answered">
              <AnswerBoxChanges r={plan} {...(mode === "rename" ? { rename: name.trim() } : {})} />
              <div className="qs-group-btns">
                <button
                  type="button"
                  className="btn primary"
                  disabled={send.busy}
                  onClick={() =>
                    void send.run(async () => {
                      setDone(await api<Result>(path, { method: "POST", body: body(false) }));
                    }, "")
                  }
                >
                  {send.busy ? B.writing : mode === "rename" ? B.confirmRename : B.confirmIgnore}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={send.busy}
                  onClick={() => {
                    asked.current++;
                    setMode(undefined);
                    setPlan(undefined);
                  }}
                >
                  {B.cancel}
                </button>
              </div>
              {send.note && !send.note.ok && <Note note={send.note} />}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** Every box an answer's words made, on Map › Trust; nothing when there is none. */
export function AnswerBoxes({ boxes }: { boxes: readonly Box[] | undefined }) {
  if (!boxes?.length) return null;
  return (
    <div className="qs-boxes" role="group" aria-label={B.title(boxes.length)}>
      <p className="work-say" style={{ margin: 0 }}>
        <span aria-hidden="true">⚠ </span>
        {B.title(boxes.length)}
      </p>
      <p className="work-why" style={{ margin: 0 }}>
        {B.intro}
      </p>
      {boxes.map((b) => (
        <AnswerBoxRow key={b.id} box={b} />
      ))}
    </div>
  );
}
