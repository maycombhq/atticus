import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import type { Api } from "@maycombhq/core";
import { api, type Loaded } from "../../api/client.js";
import { Citation, useEvidence, type FactsView } from "../../app/evidence.js";
import { escapeCloses } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { message } from "../run/shared.js";
import { CorrectionNext } from "../../app/correction-next.js";
import { findingsOfJoin, mismatchesHash } from "../../app/contracts.js";
import {
  callerLine,
  callFactsOf,
  linkCorrection,
  predict,
  type Join,
  type LinkFix,
  type Moved,
  type Prediction,
} from "./links.js";

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
    <>
      <dt className="hud">{title}</dt>
      <dd style={{ margin: 0 }}>
        <ul className="ev-list">
          {list.map((e) => (
            <li key={`${e.repo ?? ""}:${e.at}`}>
              {e.repo && <span className="mono">{e.repo}: </span>}
              <code className="mono">{e.at}</code>
            </li>
          ))}
        </ul>
      </dd>
    </>
  );
}

function Lines({ title, list }: { title: string; list: readonly Api.HierEvidenceT[] }) {
  return (
    <>
      <dt className="hud">{title}</dt>
      <dd style={{ margin: 0 }}>
        {list.length ? (
          <ul className="ev-list">
            {list.map((e) => (
              <li key={`${e.repo ?? ""}:${e.at}`}>
                {e.repo && <span className="mono">{e.repo}: </span>}
                <Citation repo={e.repo} at={e.at} />
              </li>
            ))}
          </ul>
        ) : (
          <span className="ev-say">{W.noLine}</span>
        )}
      </dd>
    </>
  );
}

/** One call on the link: how it was joined, verified or inferred, and its lines. */
export function JoinView({
  join,
  topic,
  children,
}: {
  join: Api.HierJoinT;
  /** The link publishes to or listens on a topic or queue. */
  topic?: boolean;
  children?: ReactNode;
}) {
  const what = [join.method, join.path].filter(Boolean).join(" ");
  // ADR 0162 §6 (F8): a topic the profile names as an outside system's is the person's word.
  const declared = !!topic && join.how === "declared" && !join.gateway;
  const said = declared ? join.other.filter((e) => e.source === "manual") : [];
  const other = declared ? join.other.filter((e) => e.source !== "manual") : join.other;
  return (
    <article className="stack" style={{ gap: 4 }} aria-label={W.call(join.from, join.to, what)}>
      <p style={{ margin: 0 }}>
        <code className="mono">{W.call(join.from, join.to, what)}</code>{" "}
        {declared ? (
          <span className="chip">{W.declared}</span>
        ) : (
          <span className={`chip ${join.verified ? "done" : "warn"}`}>
            {join.verified ? W.verified : W.inferred}
          </span>
        )}
      </p>
      <p className="ev-say" style={{ margin: 0 }}>
        {declared ? W.declaredTopic : (W.how[join.how] ?? W.how.unknown)}
        {join.gateway && ` ${W.gateway}`}
        {join.shared && ` ${W.sharedMap(join.shared.team, join.shared.commit)}`}
      </p>
      {join.shared && (
        <p className="ev-say" style={{ margin: 0 }}>
          {W.sharedTheirs(join.shared.team)}
        </p>
      )}
      <dl className="stack" style={{ gap: 2, margin: 0 }}>
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
      {children}
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
    <section className="stack" style={{ gap: 2 }} aria-label={W.contracts}>
      <p className="ev-say" style={{ margin: 0 }}>
        <span className="chip warn">
          <span aria-hidden="true">⚠ </span>
          {W.contracts}
        </span>{" "}
        {W.contractsOf(m, list.length - m)}
      </p>
      <ul className="ev-list" style={{ margin: 0 }}>
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
  /** ADR 0164: the contract check's findings, of which each call's are shown under it. */
  contracts?: readonly Api.ContractMismatchViewT[];
}) {
  const joins = p.link.joins ?? [];
  if (!joins.length) return <p className="ev-say">{W.none}</p>;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <p className="ev-say" style={{ margin: 0 }}>
        {W.intro}
      </p>
      {joins.map((j) => (
        <JoinView
          key={j.interface}
          join={j}
          topic={p.link.type === "publishes" || p.link.type === "subscribes"}
        >
          {p.contracts && <ContractFindings list={findingsOfJoin(j, p.contracts)} />}
          {p.under?.(j)}
        </JoinView>
      ))}
      {p.link.count > joins.length && (
        <p className="ev-say">{W.more(p.link.count - joins.length)}</p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ this link is wrong (C2)

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
      className="ev-correct stack"
      onSubmit={submit}
      onKeyDown={escapeCloses(p.onClose)}
      aria-labelledby={`${id}-t`}
    >
      <h4 id={`${id}-t`} className="h" style={{ fontSize: 14 }}>
        {W.wrongTitle(label)}
      </h4>
      <p className="ev-say">{W.wrongIntro}</p>
      {calls.length > 1 && (
        <fieldset className="ev-choice">
          <legend className="hud">{W.pickCall}</legend>
          {calls.map((c) => (
            <label key={c.id} className="row" style={{ gap: 6 }}>
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
          <label key={c} className="row" style={{ gap: 6 }}>
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
        <label className="stack" style={{ gap: 2 }}>
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
      <label className="stack" style={{ gap: 2 }}>
        <span className="hud">{choice === "not-a-call" ? W.reason : W.reasonOptional}</span>
        <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="row" style={{ gap: 6 }}>
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
        <div role="status" className="stack" style={{ gap: 4 }}>
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

/** This link is wrong: the button under a call, the form, its POST and the facts read again. */
export function LinkWrong(p: {
  join: Join;
  known: readonly string[];
  /** The call's line was corrected: watch it move when the estate is joined again. */
  onSaved?: (call: string) => void;
}) {
  const ev = useEvidence();
  const line = callerLine(p.join);
  const repo = line?.repo;
  useEffect(() => {
    if (repo) ev?.need(repo);
  }, [repo, ev]);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState<LinkSaving>({ state: "idle" });
  const what = [p.join.method, p.join.path].filter(Boolean).join(" ");
  if (!line) return null;
  const onSave = (repo: string, body: Record<string, unknown>, will: Prediction) => {
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
    <div>
      <button
        type="button"
        className="btn"
        aria-expanded={open}
        aria-label={W.wrongOf(W.call(p.join.from, p.join.to, what))}
        onClick={() => setOpen((o) => !o)}
      >
        {W.wrong}
      </button>
      {open && (
        <LinkWrongForm
          join={p.join}
          facts={ev?.of(line.repo)}
          known={p.known}
          saving={saving}
          onSave={onSave}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/** What moved when the estate was joined again, for each call a person corrected here. */
export function WhatMoved({ moved }: { moved: readonly Moved[] }) {
  return (
    <div role="status" className="stack" style={{ gap: 4 }}>
      <h3 className="h" style={{ fontSize: 14 }}>
        {W.moved}
      </h3>
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
