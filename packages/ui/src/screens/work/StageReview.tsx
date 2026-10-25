import { useId, useState, type FormEvent } from "react";
import type { Api, Question } from "@maycombhq/core";
import { api, useApi, useReloadOnFiles, type Loaded } from "../../api/client.js";
import { Panel, View } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { message } from "../know/common.js";
import { QuestionDetail } from "../Questions.js";
import { Command, Problems } from "./RunNext.js";
import "./work.css";

/**
 * A stage tab's findings with their options and a comment box (ADR 0124 addendum D-app, B10):
 * Feature design, Architecture and Stories each show what the critic found in the stage's
 * latest draft (the latest round of the stage's gate), with what each finding allows (make the
 * fix, not relevant, waive where the rule allows it, ask a knowledge gap's owner), recorded as
 * `atticus finding` records it; a comment box per finding, whose words the stage's next run
 * gives the drafter as the person's answer; the stage's own questions, answered here; and the
 * command to run the stage again. The app runs no stage and no git: it shows the commands.
 */

const S = COPY.stageReview;
const R = COPY.runNext;

type Review = Api.StageReviewViewT;
type Item = Api.StageFindingViewT;
type Stage = Review["stage"];

/** What a write said, per finding: under way, done with what to run, or why it failed. */
export type Wrote =
  | { state: "working" }
  | { state: "acted"; action: string }
  | { state: "commented"; result: Api.StageCommentResultT }
  | { state: "error"; text: string };

export interface StageReviewHandlers {
  onAct?: (item: Item, action: string, reason: string) => void;
  onComment?: (item: Item, text: string) => void;
  onAnswered?: () => void;
}

function WroteNote({ w }: { w: Wrote | undefined }) {
  if (!w) return null;
  if (w.state === "working")
    return (
      <p role="status" aria-busy="true" className="work-say">
        {S.savingComment}
      </p>
    );
  if (w.state === "error")
    return (
      <p role="alert" className="state error" style={{ margin: "6px 0 0" }}>
        {w.text}
      </p>
    );
  if (w.state === "acted")
    return (
      <p role="status" className="work-say">
        {S.acted(S.actions[w.action] ?? w.action)}
      </p>
    );
  return (
    <div role="status">
      <p className="work-say">{S.commented(w.result.files.join(", "))}</p>
      <Command text={w.result.commit} label={S.copyCommit} />
    </div>
  );
}

/** One finding: what, where, why, the fix, what you can do, its comments and the comment box. */
export function FindingCard(p: { item: Item; wrote?: Wrote } & StageReviewHandlers) {
  const f = p.item.finding;
  const o = p.item.options;
  const id = useId();
  const [reason, setReason] = useState("");
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | undefined>();
  const busy = p.wrote?.state === "working";
  const act = (action: string) => {
    if ((action === "not-relevant" || action === "waive") && !reason.trim())
      return setProblem(S.needReason);
    setProblem(undefined);
    p.onAct?.(p.item, action, reason.trim());
  };
  const comment = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return setProblem(S.needComment);
    setProblem(undefined);
    p.onComment?.(p.item, text.trim());
  };
  const open = f.state === "open";
  const any = o.apply || o.dismiss || o.waive || !!o.ask;
  return (
    <article className="stage-finding" aria-labelledby={`${id}-h`}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <span
          className={`chip ${f.severity === "blocking" ? "blocking" : f.severity === "gap" ? "warn" : "dim"}`}
        >
          {S.severity[f.severity] ?? f.severity}
        </span>
        <span className={`chip ${open ? "" : "done"}`}>{S.state[f.state] ?? f.state}</span>
        <code className="mono muted">{f.id}</code>
      </div>
      <h3 id={`${id}-h`} className="h" style={{ fontSize: 15, margin: "6px 0" }}>
        {f.summary}
      </h3>
      <dl className="stage-facts">
        <dt>{S.where}</dt>
        <dd>
          <code className="mono">
            {f.artifact}
            {f.locator.line ? `:${f.locator.line}` : ""}
          </code>
        </dd>
        <dt>{S.why}</dt>
        <dd>{f.why}</dd>
        <dt>{S.fix}</dt>
        <dd>{o.fix}</dd>
        {o.ask && (
          <>
            <dt>{S.question(o.ask.owner)}</dt>
            <dd>{o.ask.text}</dd>
          </>
        )}
      </dl>
      {f.resolution && (
        <p className="work-say">
          {S.resolved(S.state[f.state] ?? f.state, f.resolution.by)}
          {f.resolution.reason ? `: ${f.resolution.reason}` : ""}
        </p>
      )}
      {open && any && (
        <div className="stack" style={{ gap: 6 }}>
          <span className="hud">{S.options}</span>
          {(o.dismiss || o.waive) && (
            <label className="stack" style={{ gap: 2 }}>
              <span className="hud">{S.reason(f.id)}</span>
              <input className="field" value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
          )}
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            {o.apply && (
              <button
                type="button"
                className="btn"
                disabled={busy}
                aria-label={S.applyFor(f.id)}
                onClick={() => act("apply")}
              >
                {S.apply}
              </button>
            )}
            {o.dismiss && (
              <button
                type="button"
                className="btn"
                disabled={busy}
                aria-label={S.dismissFor(f.id)}
                onClick={() => act("not-relevant")}
              >
                {S.dismiss}
              </button>
            )}
            {o.waive && (
              <button
                type="button"
                className="btn"
                disabled={busy}
                aria-label={S.waiveFor(f.id)}
                onClick={() => act("waive")}
              >
                {S.waive}
              </button>
            )}
            {o.ask && (
              <button
                type="button"
                className="btn"
                disabled={busy}
                aria-label={S.askFor(f.id, o.ask.owner)}
                onClick={() => act("ask")}
              >
                {S.ask(o.ask.owner)}
              </button>
            )}
          </div>
          {o.dismiss && !o.waive && f.severity === "blocking" && (
            <p className="work-say">{S.cantWaive}</p>
          )}
        </div>
      )}
      <div className="stack" style={{ gap: 6, marginTop: 8 }}>
        {p.item.comments.length > 0 && (
          <>
            <span className="hud">{S.comments}</span>
            <ul className="stage-comments">
              {p.item.comments.map((c) => (
                <li key={c.question}>
                  {c.text}{" "}
                  <span className="muted">
                    — {c.by}, {c.at.slice(0, 10)} · {c.read ? S.read : S.unread}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        <form className="stack" style={{ gap: 4 }} onSubmit={comment}>
          <label htmlFor={`${id}-c`} className="hud">
            {S.comment(f.id)}
          </label>
          <textarea
            id={`${id}-c`}
            className="field"
            rows={2}
            value={text}
            aria-describedby={`${id}-ch`}
            onChange={(e) => setText(e.target.value)}
          />
          <p id={`${id}-ch`} className="work-say" style={{ margin: 0 }}>
            {S.commentHint}
          </p>
          <div>
            <button type="submit" className="btn" disabled={busy}>
              {busy ? S.savingComment : S.saveComment}
            </button>
          </div>
        </form>
        {problem && (
          <p role="alert" className="state error" style={{ margin: 0 }}>
            {problem}
          </p>
        )}
        <WroteNote w={p.wrote} />
      </div>
    </article>
  );
}

function StageQuestions({ qs, onAnswered }: { qs: Question[]; onAnswered: () => void }) {
  if (!qs.length) return <p className="work-say">{S.noQuestions}</p>;
  return (
    <ul className="stage-comments">
      {qs.map((q) => (
        <li key={q.id}>
          {q.state === "open" ? (
            <details>
              <summary>{S.answerIt(q.question)}</summary>
              <QuestionDetail question={q} onAnswered={onAnswered} />
            </details>
          ) : (
            <>
              {q.question}{" "}
              <span className="muted">
                {S.answered(q.answer?.text ?? q.options[(q.answer?.option ?? 1) - 1]?.label ?? "")}
              </span>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The panel from loaded data, so tests can render every state. */
export function StageReviewView(
  p: {
    of: Loaded<Review> & { reload?: () => void };
    wrote?: Record<string, Wrote>;
  } & StageReviewHandlers,
) {
  return (
    <Panel title={S.title} span="1 / -1">
      <p className="work-why" style={{ marginTop: 0 }}>
        {S.intro}
      </p>
      <View
        of={p.of}
        empty={(v) => !v.loop.present && v.findings.length === 0}
        emptyContent={
          p.of.state === "ready" ? (
            <div className="state">
              <p style={{ margin: "0 0 8px" }}>{S.notRun}</p>
              <p className="work-say">{R.terminal}</p>
              <Command text={p.of.data.next.command} label={R.copy} />
              <p className="work-say">{R.slash}</p>
              <Command text={p.of.data.next.slash} label={R.copySlash} />
            </div>
          ) : undefined
        }
      >
        {(v) => (
          <div className="stack" style={{ gap: 12 }}>
            {v.loop.state && (
              <p className="work-say">{S.loopState[v.loop.state] ?? v.loop.state}</p>
            )}
            {v.round === null || !v.gate ? (
              <div className="state">{S.noRound(v.gate)}</div>
            ) : v.findings.length === 0 ? (
              <div className="state">{S.clean(v.gate, v.round)}</div>
            ) : (
              <>
                <p className="hud" style={{ margin: 0 }}>
                  {S.round(v.gate, v.round, v.findings.length)}
                </p>
                {v.findings.map((item) => (
                  <FindingCard
                    key={`${item.finding.gate}/${item.finding.id}`}
                    item={item}
                    {...(p.wrote?.[item.finding.id] ? { wrote: p.wrote[item.finding.id] } : {})}
                    {...(p.onAct ? { onAct: p.onAct } : {})}
                    {...(p.onComment ? { onComment: p.onComment } : {})}
                  />
                ))}
              </>
            )}
            <h3 className="h" style={{ fontSize: 15, margin: "8px 0 0" }}>
              {S.questions}
            </h3>
            <StageQuestions qs={v.questions} onAnswered={() => p.onAnswered?.()} />
            <h3 className="h" style={{ fontSize: 15, margin: "8px 0 0" }}>
              {S.next}
            </h3>
            <p className="work-why" style={{ margin: 0 }}>
              {S.nextWhy}
            </p>
            <p className="work-say">{R.terminal}</p>
            <Command text={v.next.command} label={R.copy} />
            <p className="work-say">{R.slash}</p>
            <Command text={v.next.slash} label={R.copySlash} />
            {v.problems.length > 0 && <Problems list={v.problems} />}
          </div>
        )}
      </View>
    </Panel>
  );
}

/** The panel on a stage tab: its findings, the actions and comments, and reading again after. */
export function StageReviewPanel({ change, stage }: { change: string; stage: Stage }) {
  const path = `/api/changes/${encodeURIComponent(change)}/stages/${stage}`;
  const view = useApi<Review>(path);
  useReloadOnFiles(view);
  const [wrote, setWrote] = useState<Record<string, Wrote>>({});
  const set = (id: string, w: Wrote) => setWrote((m) => ({ ...m, [id]: w }));
  const onAct = (item: Item, action: string, reason: string) => {
    const f = item.finding;
    set(f.id, { state: "working" });
    api(`/api/findings/${encodeURIComponent(change)}/${encodeURIComponent(f.id)}/action`, {
      method: "POST",
      body: {
        action,
        gate: f.gate,
        ...(reason ? { reason } : {}),
        ...(action === "ask" && item.options.ask ? { askedOf: item.options.ask.owner } : {}),
      },
    }).then(
      () => {
        set(f.id, { state: "acted", action });
        view.reload();
      },
      (e: unknown) => set(f.id, { state: "error", text: message(e) }),
    );
  };
  const onComment = (item: Item, text: string) => {
    const f = item.finding;
    set(f.id, { state: "working" });
    api<Api.StageCommentResultT>(`${path}/comments`, {
      method: "POST",
      body: { finding: f.id, gate: f.gate, text },
    }).then(
      (result) => {
        set(f.id, { state: "commented", result });
        view.reload();
      },
      (e: unknown) => set(f.id, { state: "error", text: message(e) }),
    );
  };
  return (
    <StageReviewView
      of={view}
      wrote={wrote}
      onAct={onAct}
      onComment={onComment}
      onAnswered={() => view.reload()}
    />
  );
}
