import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { Api } from "@maycombhq/core";
import { api, useApi, writtenOf, type Loaded } from "../../api/client.js";
import { Citation, useEvidence, type FactsView } from "../../app/evidence.js";
import { escapeCloses, focusIfLost } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { CopyButton, message } from "../run/shared.js";
import { CorrectionNext } from "../../app/correction-next.js";
import { findingsOfJoin, mismatchesHash } from "../../app/contracts.js";
import { AiMark, linkDecisionAt, readyView, useDecisions } from "../../app/decisions.js";
import { aiJoins, linkTypeWord } from "./model.js";
import { CorrectionsList } from "./Declare.js";
import {
  ARROW_CALLS_MAX,
  arrowCalls,
  arrowCorrections,
  callerLine,
  callerRepos,
  callFactsOf,
  dependencyCorrection,
  dependencyFactsOf,
  joinWhat,
  linkCorrection,
  predict,
  type Join,
  type LinkFix,
  type Moved,
  type Prediction,
} from "./links.js";
import "./link-panel.css";

/**
 * Why is this linked (ADR 0135, C1): each call merged into a link on the estate canvas, how
 * Atticus joined it to what it calls (a person's answer, a named target, the host, a path guess,
 * through a gateway), whether it is verified or inferred, and the cited line at both ends, each a
 * citation with Correct this. Read from the link's `joins` (GET /api/graph/node, C4 2.32.0).
 */

const W = COPY.why;

/** Their lines (another team's shared map, ADR 0160): named, never opened as ours. */
function TheirLines({ title, list }: { title: string; list: readonly Api.HierEvidenceT[] }) {
  return (
    <div className="li-lines-group">
      <dt className="hud">{title}</dt>
      <dd>
        <ul className="li-cites">
          {list.map((e) => (
            <li key={`${e.repo ?? ""}:${e.at}`}>
              {e.repo && <span className="mono li-repo">{e.repo}: </span>}
              <code className="mono li-at">{e.at}</code>
            </li>
          ))}
        </ul>
      </dd>
    </div>
  );
}

function Lines({ title, list }: { title: string; list: readonly Api.HierEvidenceT[] }) {
  return (
    <div className="li-lines-group">
      <dt className="hud">{title}</dt>
      <dd>
        {list.length ? (
          <ul className="li-cites">
            {list.map((e) => (
              <li key={`${e.repo ?? ""}:${e.at}`}>
                {e.repo && <span className="mono li-repo">{e.repo}: </span>}
                <Citation repo={e.repo} at={e.at} />
              </li>
            ))}
          </ul>
        ) : (
          <span className="ev-say">{W.noLine}</span>
        )}
      </dd>
    </div>
  );
}

/**
 * A call's head: its method and path (or a dependency's coordinates) on one line across the
 * card, cut with an ellipsis when too long and shown whole on hover or when anything in the head
 * has the focus (its Copy button), with the whole text in its title and the article's name; under
 * it the two ends, and at their right the verified or inferred chip and Copy, never wrapped apart.
 */
function CallHead(p: {
  method?: string | undefined;
  what: string;
  ends: string;
  chip: ReactNode;
  extra?: ReactNode;
}) {
  const full = [p.method, p.what].filter(Boolean).join(" ");
  return (
    <header className="li-call-head">
      <p className="li-what">
        {full && p.method && <span className="li-method mono">{p.method}</span>}
        <code className="mono li-path" title={full || p.ends}>
          {full ? p.what : p.ends}
        </code>
      </p>
      <div className="li-call-sub">
        <p className="li-ends mono">
          {full && p.ends}
          {p.extra}
        </p>
        <span className="li-call-tools">
          {p.chip}
          {full && <CopyButton text={full} label={W.copyOf(full)} />}
        </span>
      </div>
    </header>
  );
}

/**
 * Beta.24 review: on a verified link, the guesses its other merged calls rest on (`also`), said
 * apart from how the link itself was made. Nothing when there are none.
 */
export function AlsoLine({ also }: { also: readonly string[] | undefined }) {
  if (!also?.length) return null;
  const words = also.map((h) => W.alsoHow[h] ?? h).join(", ");
  return <p className="ev-say li-also">{W.also(words)}</p>;
}

/**
 * ADR 0192: one build dependency on the link: the coordinates, the line that declares them in
 * the depending build file and the lines that publish them in the library's.
 */
export function DependencyView({ join, children }: { join: Api.HierJoinT; children?: ReactNode }) {
  const D = W.dependency;
  const what = joinWhat(join);
  const title = D.title(join.from, join.to, what);
  return (
    <article className="li-call" aria-label={title}>
      <CallHead
        what={what}
        ends={D.ends(join.from, join.to)}
        {...(join.dependency?.scope
          ? { extra: <span className="li-scope"> {D.scope(join.dependency.scope)}</span> }
          : {})}
        chip={
          <span className={`chip ${join.verified ? "done" : "warn"}`}>
            {join.verified ? W.verified : W.inferred}
          </span>
        }
      />
      <div className="li-how">
        <p className="ev-say">{W.how.coordinates}</p>
      </div>
      <dl className="li-lines">
        <Lines title={D.caller} list={join.caller} />
        <Lines title={D.callee} list={join.callee} />
      </dl>
      {children && <div className="li-call-foot">{children}</div>}
    </article>
  );
}

/** One call on the link: how it was joined, verified or inferred, and its lines. */
export function JoinView({
  join,
  topic,
  children,
  onCorrected,
}: {
  join: Api.HierJoinT;
  /** The link publishes to or listens on a topic or queue. */
  topic?: boolean;
  children?: ReactNode;
  /** ADR 0181: a correction of the AI's pairing saved (the canvas reads its picture again). */
  onCorrected?: (r: Api.CorrectDecisionResultT) => void;
}) {
  const what = [join.method, join.path].filter(Boolean).join(" ");
  // ADR 0162 §6 (F8): a topic the profile names as an outside system's is the person's word.
  const declared = !!topic && join.how === "declared" && !join.gateway;
  const said = declared ? join.other.filter((e) => e.source === "manual") : [];
  const other = declared ? join.other.filter((e) => e.source !== "manual") : join.other;
  // ADR 0181: a pairing the AI decided rests on its `ai` evidence at the call's line; since C4
  // 2.82.0 the join says so itself (`how: ai`, with its run).
  const aiLine = join.caller.find((e) => e.source === "ai");
  const ai: { repo?: string | undefined; at: string } | undefined =
    aiLine ?? (join.how === "ai" ? (callerLine(join) ?? { at: "" }) : undefined);
  const decisions = useDecisions();
  const decision = ai ? linkDecisionAt(readyView(decisions), ai.repo, ai.at) : undefined;
  if (join.dependency) return <DependencyView join={join}>{children}</DependencyView>;
  return (
    <article className="li-call" aria-label={W.call(join.from, join.to, what)}>
      <CallHead
        method={join.method}
        what={join.path ?? ""}
        ends={W.call(join.from, join.to, "")}
        chip={
          declared ? (
            <span className="chip">{W.declared}</span>
          ) : (
            <span className={`chip ${join.verified ? "done" : "warn"}`}>
              {join.verified ? W.verified : W.inferred}
            </span>
          )
        }
      />
      <div className="li-how">
        <p className="ev-say">
          {declared
            ? W.declaredTopic
            : ai
              ? COPY.decisions.whyLinked
              : (W.how[join.how] ?? W.how.unknown)}
          {join.gateway && ` ${W.gateway}`}
          {join.shared && ` ${W.sharedMap(join.shared.team, join.shared.commit)}`}
        </p>
        {join.verified && <AlsoLine also={join.also} />}
        {ai && (
          <AiMark
            item={decision?.item}
            ai
            {...(join.run ? { run: join.run } : {})}
            {...(onCorrected ? { onDone: onCorrected } : {})}
          />
        )}
        {join.shared && <p className="ev-say">{W.sharedTheirs(join.shared.team)}</p>}
      </div>
      <dl className="li-lines">
        <Lines title={W.caller} list={join.caller} />
        {join.hops.length > 0 && <Lines title={W.hops} list={join.hops} />}
        {join.shared && join.callee.length ? (
          <TheirLines title={W.callee} list={join.callee} />
        ) : (
          <Lines title={W.callee} list={join.callee} />
        )}
        {other.length > 0 && <Lines title={W.other} list={other} />}
        {said.length > 0 && <TheirLines title={W.declaredIn} list={said} />}
      </dl>
      {children && <div className="li-call-foot">{children}</div>}
    </article>
  );
}

/**
 * The contract check's findings on one call of the link (ADR 0164): each mismatch, or a
 * difference a mapping nobody traced leaves unconfirmed, with both lines; a way to all of them.
 */
export function ContractFindings({ list }: { list: readonly Api.ContractMismatchViewT[] }) {
  if (!list.length) return null;
  const m = list.filter((f) => f.status === "mismatch").length;
  return (
    <section className="li-contracts" aria-label={W.contracts}>
      <p className="ev-say">
        <span className="chip warn">
          <span aria-hidden="true">⚠ </span>
          {W.contracts}
        </span>{" "}
        {W.contractsOf(m, list.length - m)}
      </p>
      <ul className="ev-list">
        {list.map((f) => (
          <li key={f.id}>
            <span className={`chip ${f.status === "mismatch" ? "warn" : ""}`}>
              {COPY.mismatches.status[f.status]}
            </span>{" "}
            {f.message}
          </li>
        ))}
      </ul>
      <a href={mismatchesHash}>{W.contractsAll}</a>
    </section>
  );
}

/** Why a link is there: every call on it, or, for a link that isn't a call, that there is none. */
export function WhyLinked(p: {
  link: Api.HierEdgeT;
  /** What to show under each call (This link is wrong, C2). */
  under?: (join: Api.HierJoinT) => ReactNode;
  /** Beta.24: what to show above the calls (All calls on this arrow are wrong). */
  above?: (link: Api.HierEdgeT) => ReactNode;
  /** ADR 0164: the contract check's findings, of which each call's are shown under it. */
  contracts?: readonly Api.ContractMismatchViewT[];
  /** ADR 0181: a correction of one of its AI pairings saved. */
  onCorrected?: (r: Api.CorrectDecisionResultT) => void;
}) {
  const joins = p.link.joins ?? [];
  if (!joins.length) return <p className="ev-say">{W.none}</p>;
  const above = p.above?.(p.link);
  return (
    <div className="li-body">
      <p className="ev-say li-intro">
        {p.link.type === "depends-on" ? W.dependency.intro : W.intro}
      </p>
      {above && <div className="li-arrow-actions">{above}</div>}
      <ul className="li-calls">
        {joins.map((j) => (
          <li key={j.interface}>
            <JoinView
              join={j}
              topic={p.link.type === "publishes" || p.link.type === "subscribes"}
              {...(p.onCorrected ? { onCorrected: p.onCorrected } : {})}
            >
              {p.contracts && <ContractFindings list={findingsOfJoin(j, p.contracts)} />}
              {p.under?.(j)}
            </JoinView>
          </li>
        ))}
      </ul>
      {p.link.count > joins.length && (
        <p className="ev-say li-more">{W.more(p.link.count - joins.length)}</p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ a picked link (ADR 0181)

/**
 * A link picked on the canvas (clicked, or from the Detected by AI list): who made it, its calls
 * with Why is this linked, and, on a call the AI paired, the chip with its run and Correct. The
 * heading takes the focus when it opens, so a keyboard user lands on it; undefined: the link left
 * the picture (a correction or a new read moved it).
 */
export function LinkInspector(p: {
  link: Api.HierEdgeT | undefined;
  labelOf: (id: string) => string;
  onClose: () => void;
  under?: (join: Api.HierJoinT) => ReactNode;
  above?: (link: Api.HierEdgeT) => ReactNode;
  contracts?: readonly Api.ContractMismatchViewT[];
  onCorrected?: (r: Api.CorrectDecisionResultT) => void;
  /** Move the focus to the heading when it opens (picked from the keyboard). */
  autoFocus?: boolean;
}) {
  const A = COPY.canvasAi;
  const D = COPY.decisions;
  const id = useId();
  const head = useRef<HTMLHeadingElement | null>(null);
  const decisions = useDecisions();
  const linkId = p.link?.id;
  useEffect(() => {
    if (p.autoFocus) head.current?.focus();
  }, [linkId, p.autoFocus]);
  const ai = p.link ? aiJoins(p.link) : { n: 0 };
  const view = decisions?.view;
  return (
    <section className="link-inspector li" aria-labelledby={`${id}-h`}>
      {/* Its name, kind and count stay in sight while its calls scroll; Close beside them. */}
      <header className="li-head">
        <div className="li-head-name">
          <h3 id={`${id}-h`} className="h li-title" tabIndex={-1} ref={head}>
            {p.link
              ? A.linkTitle(p.labelOf(p.link.from), p.labelOf(p.link.to), linkTypeWord(p.link.type))
              : A.link}
          </h3>
          {p.link && (
            <p className="li-meta mono">
              {p.link.type === "depends-on"
                ? W.dependency.count(p.link.count)
                : W.count(p.link.count)}
            </p>
          )}
        </div>
        <button type="button" className="btn li-close" onClick={p.onClose}>
          {A.close}
        </button>
      </header>
      {!p.link ? (
        <p className="state" role="status">
          {A.gone}
        </p>
      ) : (
        <>
          {/* Each AI call's chip, run and Correct are on the call, below. */}
          {ai.n > 0 && (
            <>
              {view?.state === "loading" && (
                <p className="ev-say" role="status" aria-busy="true" style={{ margin: 0 }}>
                  {D.loading}
                </p>
              )}
              {view?.state === "error" && (
                <p className="state error" role="alert" style={{ margin: 0 }}>
                  {D.failed(view.error)}
                </p>
              )}
            </>
          )}
          <WhyLinked
            link={p.link}
            {...(p.under ? { under: p.under } : {})}
            {...(p.above ? { above: p.above } : {})}
            {...(p.contracts ? { contracts: p.contracts } : {})}
            {...(p.onCorrected ? { onCorrected: p.onCorrected } : {})}
          />
        </>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ this link is wrong (C2)

/** A correction form's moment: open or not, its submit done or not. */
export interface FormMoment {
  open: boolean;
  done: boolean;
}

/**
 * WCAG 2.4.3: where the keyboard goes after a correction form changes. Closed (Close, Escape):
 * back to the button that opened it. Written, where the submit is taken away: to what was
 * written. Otherwise nowhere: the focus stays where the person put it.
 */
export function focusAfter(was: FormMoment, now: FormMoment): "opener" | "result" | undefined {
  if (was.open && !now.open) return "opener";
  if (now.open && now.done && !was.done) return "result";
  return undefined;
}

/** focusAfter, done: only when the control that had the focus went (focusIfLost). */
function useFocusBack(
  now: FormMoment,
  opener: { current: HTMLElement | null },
  result?: { current: HTMLElement | null },
) {
  const was = useRef(now);
  useEffect(() => {
    const to = focusAfter(was.current, now);
    was.current = now;
    if (to === "opener") focusIfLost(opener.current);
    else if (to === "result") focusIfLost(result?.current);
    // The refs are stable; the moment is the two flags.
  }, [now.open, now.done]);
}

export type LinkSaving =
  | { state: "idle" }
  | { state: "working" }
  | { state: "done"; result: Api.FactCorrectionResultT; will: Prediction }
  | { state: "error"; text: string };

const CHOICES = ["estate", "outside", "not-a-call"] as const;

/** What the re-join will do, in words. */
export function willSay(w: Prediction): string[] {
  if (w.kind === "moves") return [W.will.moves(w.from, w.was, w.to)];
  if (w.kind === "dropped") return [W.will.dropped(w.from, w.was)];
  return [...(w.unknown ? [W.will.unknown(w.to)] : []), W.will.outside(w.from, w.was, w.to)];
}

/**
 * The form from its state, so tests can render each one (ADR 0135, C2): the call on the
 * caller's line, where it really goes or that it isn't a call, and, once written, what
 * `atticus verify <repo> --write` will change, that command and the git command.
 */
export function LinkWrongForm(p: {
  join: Join;
  facts: Loaded<FactsView> | undefined;
  known: readonly string[];
  saving?: LinkSaving;
  onSave?: (repo: string, body: Record<string, unknown>, will: Prediction) => void;
  onClose: () => void;
}) {
  const id = useId();
  const line = callerLine(p.join);
  const calls = callFactsOf(p.join, p.facts?.state === "ready" ? p.facts.data : undefined);
  const [pick, setPick] = useState<string | undefined>();
  const [choice, setChoice] = useState<(typeof CHOICES)[number]>("estate");
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | undefined>();
  const saving = p.saving ?? { state: "idle" };
  const what = [p.join.method, p.join.path].filter(Boolean).join(" ");
  const label = W.call(p.join.from, p.join.to, what);
  const fact = calls.find((f) => f.id === pick) ?? calls[0];

  if (!line) return <p className="ev-say">{W.noLine}</p>;
  if (!p.facts || p.facts.state === "loading")
    return (
      <p role="status" aria-busy="true" className="ev-say">
        {W.loadingFacts}
      </p>
    );
  if (p.facts.state === "error")
    return (
      <p role="alert" className="state error">
        {W.factsFailed(p.facts.error)}
      </p>
    );
  if (!fact) return <p className="ev-say">{W.noCall(line.repo)}</p>;

  const fix = (): LinkFix =>
    choice === "not-a-call" ? { kind: choice, reason } : { kind: choice, target, reason };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const b = linkCorrection(fact, fix());
    if ("error" in b) return setProblem(W[b.error]);
    setProblem(undefined);
    p.onSave?.(line.repo, b.body, predict(p.join, fix(), p.known));
  };
  return (
    <form
      className="ev-correct stack li-form"
      onSubmit={submit}
      onKeyDown={escapeCloses(p.onClose)}
      aria-labelledby={`${id}-t`}
    >
      <h4 id={`${id}-t`} className="li-form-title">
        {W.wrongTitle(label)}
      </h4>
      <p className="ev-say">{W.wrongIntro}</p>
      {calls.length > 1 && (
        <fieldset className="ev-choice">
          <legend className="hud">{W.pickCall}</legend>
          {calls.map((c) => (
            <label key={c.id} className="li-choice">
              <input
                type="radio"
                name={`${id}-call`}
                value={c.id}
                checked={fact.id === c.id}
                onChange={() => setPick(c.id)}
              />
              <code className="mono">{c.label}</code>
            </label>
          ))}
        </fieldset>
      )}
      <fieldset className="ev-choice">
        <legend className="sr">{W.wrongTitle(label)}</legend>
        {CHOICES.map((c) => (
          <label key={c} className="li-choice">
            <input
              type="radio"
              name={`${id}-choice`}
              value={c}
              checked={choice === c}
              onChange={() => setChoice(c)}
            />
            {W.choice[c]}
          </label>
        ))}
      </fieldset>
      {choice !== "not-a-call" && (
        <label className="li-field">
          <span className="hud">{choice === "estate" ? W.target : W.outsideTarget}</span>
          <input
            value={target}
            list={choice === "estate" ? `${id}-known` : undefined}
            aria-describedby={`${id}-hint`}
            onChange={(e) => setTarget(e.target.value)}
          />
          <span id={`${id}-hint`} className="ev-say">
            {choice === "estate" ? W.targetHint : W.outsideHint}
          </span>
          {choice === "estate" && (
            <datalist id={`${id}-known`}>
              {p.known.map((k) => (
                <option key={k} value={k} />
              ))}
            </datalist>
          )}
        </label>
      )}
      <label className="li-field">
        <span className="hud">{choice === "not-a-call" ? W.reason : W.reasonOptional}</span>
        <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="li-form-actions">
        <button type="submit" className="btn primary" disabled={saving.state === "working"}>
          {saving.state === "working" ? W.saving : W.save}
        </button>
        <button type="button" className="btn" onClick={p.onClose}>
          {COPY.evidence.close}
        </button>
      </div>
      {problem && (
        <p role="alert" className="state error" style={{ margin: 0 }}>
          {problem}
        </p>
      )}
      {saving.state === "working" && (
        <p role="status" aria-busy="true" className="ev-say">
          {W.saving}
        </p>
      )}
      {saving.state === "error" && (
        <p role="alert" className="state error" style={{ margin: 0 }}>
          {saving.text}
        </p>
      )}
      {saving.state === "done" && (
        <div role="status" className="li-result">
          {willSay(saving.will).map((t) => (
            <p key={t} className="ev-say" style={{ margin: 0 }}>
              {t}
            </p>
          ))}
          <p className="ev-say">{W.saved(saving.result.file)}</p>
          {/* C4 (ADR 0149): the commands to run and what the next verify --write changes. */}
          <CorrectionNext repo={line.repo} result={saving.result} />
        </div>
      )}
    </form>
  );
}

/**
 * ADR 0192: This link is wrong, on a build dependency: the dependency fact on the depending build
 * file's line, marked wrong with why (required), so verify leaves it out and the link goes. From
 * its state, so tests can render each one.
 */
export function DependencyWrongForm(p: {
  join: Join;
  facts: Loaded<FactsView> | undefined;
  saving?: LinkSaving;
  onSave?: (repo: string, body: Record<string, unknown>, will: Prediction) => void;
  onClose: () => void;
}) {
  const D = W.dependency;
  const id = useId();
  const line = callerLine(p.join);
  const deps = dependencyFactsOf(p.join, p.facts?.state === "ready" ? p.facts.data : undefined);
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | undefined>();
  const saving = p.saving ?? { state: "idle" };
  const label = D.title(p.join.from, p.join.to, joinWhat(p.join));

  if (!line) return <p className="ev-say">{W.noLine}</p>;
  if (!p.facts || p.facts.state === "loading")
    return (
      <p role="status" aria-busy="true" className="ev-say">
        {D.loadingFacts}
      </p>
    );
  if (p.facts.state === "error")
    return (
      <p role="alert" className="state error">
        {D.factsFailed(p.facts.error)}
      </p>
    );
  const fact = deps[0];
  if (!fact) return <p className="ev-say">{D.noFact(line.repo)}</p>;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const b = dependencyCorrection(fact, reason);
    if ("error" in b) return setProblem(D.needReason);
    setProblem(undefined);
    p.onSave?.(line.repo, b.body, { kind: "dropped", from: p.join.from, was: p.join.to });
  };
  return (
    <form
      className="ev-correct stack li-form"
      onSubmit={submit}
      onKeyDown={escapeCloses(p.onClose)}
      aria-labelledby={`${id}-t`}
    >
      <h4 id={`${id}-t`} className="li-form-title">
        {D.wrongTitle(label)}
      </h4>
      <p className="ev-say">{D.wrongIntro}</p>
      <p className="ev-say" style={{ margin: 0 }}>
        <code className="mono">{fact.label}</code>
      </p>
      <label className="li-field">
        <span className="hud">{D.reason}</span>
        <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="li-form-actions">
        <button type="submit" className="btn primary" disabled={saving.state === "working"}>
          {saving.state === "working" ? W.saving : W.save}
        </button>
        <button type="button" className="btn" onClick={p.onClose}>
          {COPY.evidence.close}
        </button>
      </div>
      {problem && (
        <p role="alert" className="state error" style={{ margin: 0 }}>
          {problem}
        </p>
      )}
      {saving.state === "working" && (
        <p role="status" aria-busy="true" className="ev-say">
          {W.saving}
        </p>
      )}
      {saving.state === "error" && (
        <p role="alert" className="state error" style={{ margin: 0 }}>
          {saving.text}
        </p>
      )}
      {saving.state === "done" && (
        <div role="status" className="li-result">
          <p className="ev-say" style={{ margin: 0 }}>
            {D.will(p.join.from, p.join.to)}
          </p>
          <p className="ev-say">{W.saved(saving.result.file)}</p>
          <CorrectionNext repo={line.repo} result={saving.result} />
        </div>
      )}
    </form>
  );
}

/**
 * Review of beta.24: a link a person declared has no call in code to correct: what undoes it is
 * withdrawing the declaration (POST /api/declared-links/undo, from the declaring system's
 * declarations), or, written by hand in the profile, changing it there. From its state, so tests
 * can render each one.
 */
export function DeclaredLinkWrongView(p: {
  join: Join;
  of: Loaded<Api.BoxCorrectionsT> & { reload?: () => void };
  undo?: Parameters<typeof CorrectionsList>[0]["undo"];
}) {
  const D = W.declaredLink;
  const file = p.join.other.find((e) => e.source === "manual")?.at;
  const of: Loaded<Api.BoxCorrectionsT> & { reload?: () => void } =
    p.of.state === "ready"
      ? {
          state: "ready",
          data: { items: declarationsOf(p.join, p.of.data.items) },
          ...(p.of.reload ? { reload: p.of.reload } : {}),
        }
      : p.of;
  return (
    <div className="ev-correct stack li-form">
      <p className="ev-say" style={{ margin: 0 }}>
        {file ? D.say(file) : D.sayNoFile}
      </p>
      {of.state === "ready" && !of.data.items.length ? (
        <p className="ev-say" style={{ margin: 0 }}>
          {D.byHand(file ?? D.profile)}
        </p>
      ) : (
        <CorrectionsList of={of} {...(p.undo ? { undo: p.undo } : {})} />
      )}
    </div>
  );
}

/**
 * The systems whose profile entry may hold a declared link's declaration. A gateway route's
 * declared caller is the system that calls it (`from`). A declared topic (core merge.ts) runs
 * from the publisher to the listener: the code side is the estate's component and the other the
 * system the profile names, which is `to` when the estate publishes and `from` when it listens;
 * which one isn't said on the join, so both are asked (a component has no declarations).
 */
export function declaringSystems(join: Join): string[] {
  return join.gateway ? [join.from] : [...new Set([join.to, join.from])];
}

/**
 * Of a system's corrections, the declarations that are this link's: a topic's by its name; a
 * gateway route's by its method and path, or, as a declared route can name the gateway's own path
 * rather than the one served, every route the system declared when none says this one's.
 */
export function declarationsOf(
  join: Join,
  items: Api.BoxCorrectionsT["items"],
): Api.BoxCorrectionsT["items"] {
  const same = (a: string | undefined, b: string | undefined) =>
    !!a && !!b && a.toLowerCase() === b.toLowerCase();
  const declared = items.filter(
    (x): x is (typeof items)[number] & { undo: { kind: "topic" | "call"; value: string } } =>
      "kind" in x.undo,
  );
  if (!join.gateway)
    return declared.filter((x) => x.undo.kind === "topic" && same(x.undo.value, join.path));
  const calls = declared.filter((x) => x.undo.kind === "call");
  const route = [join.method, join.path].filter(Boolean).join(" ");
  const these = calls.filter((x) => same(x.undo.value, route) || same(x.undo.value, join.path));
  return these.length ? these : calls;
}

/** Every answer, as one: loading or failed while any is; all their items once each is read. */
export function bothRead(
  list: readonly Loaded<Api.BoxCorrectionsT>[],
): Loaded<Api.BoxCorrectionsT> {
  const failed = list.find((v) => v.state === "error");
  if (failed) return failed;
  if (list.some((v) => v.state === "loading")) return { state: "loading" };
  return {
    state: "ready",
    data: { items: list.flatMap((v) => (v.state === "ready" ? v.data.items : [])) },
  };
}

const correctionsOf = (system: string | undefined) =>
  system ? `/api/boxes/corrections?system=${encodeURIComponent(system)}` : undefined;

function DeclaredLinkWrong(p: { join: Join }) {
  const [a, b] = declaringSystems(p.join);
  const first = useApi<Api.BoxCorrectionsT>(correctionsOf(a));
  const second = useApi<Api.BoxCorrectionsT>(correctionsOf(b));
  const of = bothRead(b ? [first, second] : [first]);
  const reload = () => {
    first.reload();
    if (b) second.reload();
  };
  return <DeclaredLinkWrongView join={p.join} of={{ ...of, reload }} />;
}

/**
 * This link is wrong: the button under a call, the form, its POST and the facts read again.
 * Review of beta.24: a link a person declared offers to withdraw the declaration; one with no
 * line of a caller's (a gateway proxy's routing) says where its forwarding is corrected, as
 * correcting that changes the route for every caller; neither writes a call's correction here.
 */
export function LinkWrong(p: {
  join: Join;
  known: readonly string[];
  /** The call's line was corrected: watch it move when the estate is joined again. */
  onSaved?: (call: string) => void;
}) {
  const ev = useEvidence();
  const declared = p.join.how === "declared";
  const line = declared ? undefined : callerLine(p.join);
  const repo = line?.repo;
  useEffect(() => {
    if (repo) ev?.need(repo);
  }, [repo, ev]);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState<LinkSaving>({ state: "idle" });
  const opener = useRef<HTMLButtonElement | null>(null);
  useFocusBack({ open, done: saving.state === "done" }, opener);
  const what = joinWhat(p.join);
  const dependency = !!p.join.dependency;
  const onSave = (repo: string, body: Record<string, unknown>, will: Prediction) => {
    if (!line) return;
    setSaving({ state: "working" });
    api<Api.FactCorrectionResultT>(`/api/facts/${encodeURIComponent(repo)}/corrections`, {
      method: "POST",
      body,
    }).then(
      (result) => {
        setSaving({ state: "done", result, will });
        ev?.reload(repo);
        p.onSaved?.(`${line.repo}:${line.at}`);
      },
      (e: unknown) => setSaving({ state: "error", text: message(e) }),
    );
  };
  return (
    <div className="li-fix">
      <button
        ref={opener}
        type="button"
        className="btn li-fix-open"
        aria-expanded={open}
        aria-label={
          dependency
            ? W.dependency.wrongOf(W.dependency.title(p.join.from, p.join.to, what))
            : W.wrongOf(W.call(p.join.from, p.join.to, what))
        }
        onClick={() => setOpen((o) => !o)}
      >
        {W.wrong}
      </button>
      {open &&
        (declared ? (
          <DeclaredLinkWrong join={p.join} />
        ) : dependency ? (
          <DependencyWrongForm
            join={p.join}
            facts={line ? ev?.of(line.repo) : undefined}
            saving={saving}
            onSave={onSave}
            onClose={() => setOpen(false)}
          />
        ) : !line ? (
          <p className="ev-say li-note">{W.routingLink}</p>
        ) : (
          <LinkWrongForm
            join={p.join}
            facts={ev?.of(line.repo)}
            known={p.known}
            saving={saving}
            onSave={onSave}
            onClose={() => setOpen(false)}
          />
        ))}
    </div>
  );
}

// ------------------------------------------------------------------ this whole arrow is wrong

export type ArrowSaving =
  | { state: "idle" }
  | { state: "working" }
  | { state: "done"; result: Api.LinkCorrectionsResultT }
  | { state: "error"; text: string };

/**
 * All calls on this arrow are wrong (beta.24): one button above an arrow's calls, and one small
 * form, from its state so tests can render each one: they all go to another box, to an outside
 * system, or none is a call. Its one submit is the confirmation; the page writes every call's
 * correction in one request, and Corrections to apply takes it from there. Review of beta.24:
 * every call on the arrow (`joins`, read from the server when the view lists only some), every
 * line of each; the count it says is the number of calls it corrects; once written, the done
 * state stands where the submit was until the form is opened again.
 */
export function ArrowWrongForm(p: {
  link: Api.HierEdgeT;
  /**
   * Every call on the arrow; undefined while it is read (the view lists at most 20: `count`
   * says how many in all). Left out when the view lists them all.
   */
  joins?: readonly Join[];
  /** Every call on the arrow couldn't be read: why. */
  callsFailed?: string;
  /** A box's name, as the Inspector says it. */
  labelOf?: (id: string) => string;
  /** A caller repo's facts once read; undefined while they load. */
  viewOf: (repo: string) => FactsView | undefined;
  known: readonly string[];
  /** A repo's facts couldn't be read: why. */
  failed?: string;
  startOpen?: boolean;
  saving?: ArrowSaving;
  onSave?: (body: Api.LinkCorrectionsRequestT, lines: string[]) => void;
  /** The form was opened (again): a fresh start. */
  onOpen?: () => void;
}) {
  const id = useId();
  const A = W.arrow;
  const listed = p.link.joins ?? [];
  const joins = p.joins ?? (listed.length < p.link.count ? undefined : listed);
  const labelOf = p.labelOf ?? ((x: string) => x);
  const [open, setOpen] = useState(!!p.startOpen);
  const [choice, setChoice] = useState<(typeof CHOICES)[number]>("estate");
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | undefined>();
  const saving = p.saving ?? { state: "idle" };
  const repos = callerRepos(joins ?? []);
  const loading = !joins || repos.some((r) => !p.viewOf(r));
  const fix = (): LinkFix =>
    choice === "not-a-call" ? { kind: choice, reason } : { kind: choice, target, reason };
  const planned = loading || !joins ? undefined : arrowCorrections(joins, p.viewOf, fix());
  const found = loading || !joins ? undefined : arrowCalls(joins, p.viewOf);
  // The number of calls the submit corrects: those planned, or, until the fix is said, all.
  const n = planned && "body" in planned ? planned.body.items.length : (found?.calls.length ?? 0);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!joins || saving.state === "done" || saving.state === "working") return;
    const b = arrowCorrections(joins, p.viewOf, fix());
    if ("error" in b)
      return setProblem(
        b.error === "noCalls"
          ? A.noCalls
          : b.error === "tooMany"
            ? A.tooMany(found?.calls.length ?? 0, ARROW_CALLS_MAX)
            : W[b.error],
      );
    setProblem(undefined);
    p.onSave?.(b.body, b.lines);
  };
  const label = W.call(labelOf(p.link.from), labelOf(p.link.to), "");
  const written = saving.state === "done" ? saving.result.files : [];
  const skipped = saving.state === "done" ? (saving.result.skipped ?? []).length : 0;
  // WCAG 2.4.3: Close and Escape take the form away, and a write its submit, with the focus in it.
  const opener = useRef<HTMLButtonElement | null>(null);
  const result = useRef<HTMLDivElement | null>(null);
  useFocusBack({ open, done: saving.state === "done" }, opener, result);
  return (
    <div className="li-fix li-arrow">
      <div>
        <button
          ref={opener}
          type="button"
          className="btn li-fix-open"
          aria-expanded={open}
          aria-label={A.openOf(label)}
          onClick={() => {
            if (!open) p.onOpen?.();
            setOpen((o) => !o);
          }}
        >
          {A.open}
        </button>
      </div>
      {open &&
        (p.callsFailed ? (
          <p role="alert" className="state error">
            {A.callsFailed(p.callsFailed)}
          </p>
        ) : p.failed ? (
          <p role="alert" className="state error">
            {W.factsFailed(p.failed)}
          </p>
        ) : loading ? (
          <p role="status" aria-busy="true" className="ev-say">
            {joins ? W.loadingFacts : A.loadingCalls}
          </p>
        ) : (
          <form
            className="ev-correct stack li-form"
            onSubmit={submit}
            onKeyDown={escapeCloses(() => setOpen(false))}
            aria-labelledby={`${id}-t`}
          >
            <h4 id={`${id}-t`} className="li-form-title">
              {A.title(n)}
            </h4>
            <p className="ev-say">{A.intro}</p>
            <fieldset className="ev-choice">
              <legend className="sr">{A.title(n)}</legend>
              {CHOICES.map((c) => (
                <label key={c} className="li-choice">
                  <input
                    type="radio"
                    name={`${id}-choice`}
                    value={c}
                    checked={choice === c}
                    onChange={() => setChoice(c)}
                  />
                  {A.choice[c]}
                </label>
              ))}
            </fieldset>
            {choice !== "not-a-call" && (
              <label className="li-field">
                <span className="hud">{choice === "estate" ? A.target : A.outsideTarget}</span>
                <input
                  value={target}
                  list={choice === "estate" ? `${id}-known` : undefined}
                  aria-describedby={`${id}-hint`}
                  onChange={(e) => setTarget(e.target.value)}
                />
                <span id={`${id}-hint`} className="ev-say">
                  {choice === "estate" ? W.targetHint : W.outsideHint}
                </span>
                {choice === "estate" && (
                  <datalist id={`${id}-known`}>
                    {p.known.map((k) => (
                      <option key={k} value={k} />
                    ))}
                  </datalist>
                )}
              </label>
            )}
            <label className="li-field">
              <span className="hud">{choice === "not-a-call" ? W.reason : W.reasonOptional}</span>
              <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            {found && found.missing.length > 0 && (
              <p className="ev-say" style={{ margin: 0 }}>
                {A.missing(found.missing.length)}
              </p>
            )}
            {found && found.declared.length > 0 && (
              <p className="ev-say" style={{ margin: 0 }}>
                {A.declared(found.declared.length)}
              </p>
            )}
            {found && found.byLine.length > 0 && (
              <p className="ev-say" style={{ margin: 0 }}>
                {A.byLine(found.byLine.length)}
              </p>
            )}
            {found && found.routing.length > 0 && (
              <p className="ev-say" style={{ margin: 0 }}>
                {A.routing(found.routing.length)}
              </p>
            )}
            <div className="li-form-actions">
              {saving.state !== "done" && (
                <button type="submit" className="btn primary" disabled={saving.state === "working"}>
                  {saving.state === "working" ? A.saving : A.save(n)}
                </button>
              )}
              <button type="button" className="btn" onClick={() => setOpen(false)}>
                {COPY.evidence.close}
              </button>
            </div>
            {problem && (
              <p role="alert" className="state error" style={{ margin: 0 }}>
                {problem}
              </p>
            )}
            {saving.state === "working" && (
              <p role="status" aria-busy="true" className="ev-say">
                {A.saving}
              </p>
            )}
            {saving.state === "error" && (
              <p role="alert" className="state error" style={{ margin: 0 }}>
                {saving.text}
              </p>
            )}
            {saving.state === "done" && (
              <div role="status" className="li-result" tabIndex={-1} ref={result}>
                {written.length ? (
                  <p className="ev-say" style={{ margin: 0 }}>
                    {A.saved(
                      written.reduce((k, f) => k + f.lines.length, 0),
                      written.map((f) => f.file).join(", "),
                    )}
                    {skipped ? ` ${A.skipped(skipped)}` : ""}
                  </p>
                ) : (
                  <p className="ev-say" style={{ margin: 0 }}>
                    {A.already}
                  </p>
                )}
                {written.length > 0 && (
                  <p className="ev-say" style={{ margin: 0 }}>
                    {A.apply}
                  </p>
                )}
              </div>
            )}
          </form>
        ))}
    </div>
  );
}

/**
 * All calls on this arrow are wrong: every call on it (read from GET /api/graph/edge-calls when
 * the view lists only some), the callers' facts read, the one POST, the facts read again.
 */
export function ArrowWrong(p: {
  link: Api.HierEdgeT;
  known: readonly string[];
  labelOf?: (id: string) => string;
  /** GET /api/graph/edge-calls for this edge of its view: every call on it. */
  callsPath?: string;
  /** Each corrected call's line: watch it move when the estate is joined again. */
  onSaved?: (calls: readonly string[]) => void;
}) {
  const ev = useEvidence();
  const listed = p.link.joins ?? [];
  const capped = listed.length < p.link.count;
  const [wanted, setWanted] = useState(false);
  const full = useApi<Api.GraphEdgeCallsViewT>(
    capped && wanted && p.callsPath ? p.callsPath : undefined,
  );
  // Without a way to read them all, the calls the view lists (said as their number).
  const joins =
    !capped || !p.callsPath ? listed : full.state === "ready" ? full.data.joins : undefined;
  const key = callerRepos(joins ?? []).join("\u0000");
  useEffect(() => {
    for (const r of key.split("\u0000")) if (r) ev?.need(r);
  }, [key, ev]);
  const [saving, setSaving] = useState<ArrowSaving>({ state: "idle" });
  if (!listed.length) return null;
  const viewOf = (r: string) => {
    const v = ev?.of(r);
    return v?.state === "ready" ? v.data : undefined;
  };
  const failed = key
    .split("\u0000")
    .map((r) => (r ? ev?.of(r) : undefined))
    .find((v): v is { state: "error"; error: string } => v?.state === "error")?.error;
  const onSave = (body: Api.LinkCorrectionsRequestT, lines: string[]) => {
    setSaving({ state: "working" });
    api<Api.LinkCorrectionsResultT>("/api/links/corrections", { method: "POST", body }).then(
      (result) => {
        setSaving({ state: "done", result });
        for (const f of result.files) ev?.reload(f.repo);
        p.onSaved?.(lines);
      },
      (e: unknown) => {
        // Review of beta.24: files written all the same (a 500 names them) are read again.
        for (const w of writtenOf(e)) ev?.reload(w.repo);
        setSaving({ state: "error", text: message(e) });
      },
    );
  };
  return (
    <ArrowWrongForm
      link={p.link}
      {...(joins ? { joins } : {})}
      {...(capped && p.callsPath && full.state === "error" ? { callsFailed: full.error } : {})}
      {...(p.labelOf ? { labelOf: p.labelOf } : {})}
      viewOf={viewOf}
      known={p.known}
      saving={saving}
      onSave={onSave}
      onOpen={() => {
        setWanted(true);
        setSaving({ state: "idle" });
      }}
      {...(failed ? { failed } : {})}
    />
  );
}

/** What moved when the estate was joined again, for each call a person corrected here. */
export function WhatMoved({ moved }: { moved: readonly Moved[] }) {
  return (
    <div role="status" className="li-result">
      <h3 className="li-form-title">{W.moved}</h3>
      {moved.length ? (
        <ul className="ev-list">
          {moved.map((m) => (
            <li key={m.call}>
              <code className="mono">{m.call}</code>{" "}
              {m.now ? W.movedTo(m.what, m.was, m.now) : W.movedOff(m.what, m.was)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="ev-say">{W.notYet}</p>
      )}
    </div>
  );
}
