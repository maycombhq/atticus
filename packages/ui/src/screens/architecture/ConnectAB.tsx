import { useId, useState } from "react";
import type { Api } from "@maycombhq/core";
import {
  api,
  ApiError,
  callAsJob,
  useApi,
  useJobRead,
  type JobWaitParts,
  type Loaded,
} from "../../api/client.js";
import { followJob, JobFailed } from "../../app/job.js";
import { JobWait } from "../../app/job-wait.js";
import { Propose, RefusalLink } from "../../app/propose.js";
import { ReadRepo } from "../../app/app-step.js";
import { Command } from "../work/RunNext.js";
import { useMe } from "../../app/me.js";
import { COPY } from "../../copy.js";
import { usePopupFocus } from "./popup.js";
import { Pairing, type BoxChoice } from "./Connect.js";
import { DeclarePanel } from "./Declare.js";

/**
 * ADR 0204: "Connect <A> to <B>", one panel for every box and for a line drawn. The direction is
 * the person's (two radios; a line's start is the caller), Atticus says which way it connects
 * (GET /api/connect), and the one button writes and applies in one job (POST /api/map/edits):
 * the calls the code shows are paired (today's Pairing), else the arrow is declared, the
 * person's word, drawn dashed "declared by <name>". Undo takes back exactly what it wrote.
 */

const W = COPY.connectAB;

/** The panel's requests: the local API in the app; tests pass their own. */
export interface ConnectIo {
  read: (path: string | undefined) => Loaded<Api.ConnectViewT> & JobWaitParts;
  post: <T>(path: string, body: unknown) => Promise<T>;
  follow: (path: string, body: unknown) => ReturnType<typeof followJob>;
  /** Tests pass the gateway's routes (GET /api/declared-links/routes). */
  routes?: (path: string) => Loaded<Api.DeclarableRoutesViewT>;
  /** ADR 0204 A: POST /api/connect/find as a job. */
  find: (body: Api.ConnectFindRequestT) => Promise<Api.FindResultT>;
}
const APP: Omit<ConnectIo, "read"> = {
  post: <T,>(path: string, body: unknown) => api<T>(path, { method: "POST", body }),
  follow: (path, body) => followJob(path, body),
  find: (body) => callAsJob<Api.FindResultT>("/api/connect/find", { ...body }),
};
const say = (b: Api.LinkBoxT) => (b.repo ? `repo:${b.repo}` : `system:${b.system}`);
const name = (b: Api.LinkBoxT) => b.repo ?? b.system ?? "";
const errorOf = (e: unknown) =>
  e instanceof ApiError
    ? (e.problem.detail ?? e.message)
    : e instanceof Error
      ? e.message
      : String(e);
const day = (at: string) => at.slice(0, 10);

export function ConnectAB(p: {
  a: BoxChoice;
  /** The other box: given by a line drawn, else picked here from `boxes`. */
  b?: BoxChoice;
  boxes: readonly BoxChoice[];
  onClose(): void;
  /** The arrow is on the map: the canvas is read again. */
  onShown?(from: Api.LinkBoxT, to: Api.LinkBoxT): void;
  io?: Partial<ConnectIo>;
}) {
  const io = { ...APP, ...p.io };
  const id = useId();
  const head = usePopupFocus<HTMLHeadingElement>();
  const [other, setOther] = useState<string>(p.b ? say(p.b.box) : "");
  const [aCalls, setACalls] = useState(true);
  // A need's answer: the repo picked for a system of several.
  const [picked, setPicked] = useState<Record<"from" | "to", Api.LinkBoxT | undefined>>({
    from: undefined,
    to: undefined,
  });
  const b = p.b ?? p.boxes.find((x) => say(x.box) === other);
  const [caller0, callee0] = b ? (aCalls ? [p.a, b] : [b, p.a]) : [p.a, undefined];
  const caller = picked.from ?? caller0.box;
  const callee = picked.to ?? callee0?.box;
  const path = callee
    ? `/api/connect?from=${encodeURIComponent(say(caller))}&to=${encodeURIComponent(say(callee))}`
    : undefined;
  const live = useJobRead<Api.ConnectViewT>(p.io?.read ? undefined : path);
  // What a write here said (Remove it's "Done"), kept for these two boxes through the reload it
  // starts: the view it was said in may be gone from the one read after it (journey 39).
  const [said, setSaid] = useState<{ path: string; words: string } | undefined>();
  const view = p.io?.read ? p.io.read(path) : live;
  const v = view.state === "ready" ? view.data : undefined;
  return (
    <section className="stack connect-panel" aria-labelledby={`${id}-t`}>
      <div className="box-pop-head">
        <h4 id={`${id}-t`} ref={head} tabIndex={-1} className="h box-pop-title">
          {v
            ? W.title(v.fromName, v.toName)
            : W.title(name(caller), callee ? name(callee) : W.pickOtherNone)}
        </h4>
        <button type="button" className="btn" onClick={p.onClose}>
          {COPY.connect.close}
        </button>
      </div>
      {!p.b && (
        <>
          <label htmlFor={`${id}-to`} className="hud">
            {W.pickOther}
          </label>
          <select
            id={`${id}-to`}
            className="field"
            value={other}
            onChange={(e) => setOther(e.target.value)}
          >
            <option value="">{W.pickOtherNone}</option>
            {p.boxes
              .filter((x) => say(x.box) !== say(p.a.box))
              .map((x) => (
                <option key={say(x.box)} value={say(x.box)}>
                  {x.label}
                </option>
              ))}
          </select>
        </>
      )}
      {b && (
        <fieldset className="stack" style={{ gap: 4, border: 0, padding: 0, margin: 0 }}>
          <legend className="hud">{W.direction}</legend>
          {[true, false].map((ab) => (
            <label key={String(ab)} className="row" style={{ gap: 6 }}>
              <input
                type="radio"
                name={`${id}-dir`}
                checked={aCalls === ab}
                onChange={() => {
                  setACalls(ab);
                  setPicked({ from: undefined, to: undefined });
                }}
              />
              {ab ? W.calls(name(p.a.box), name(b.box)) : W.calls(name(b.box), name(p.a.box))}
            </label>
          ))}
        </fieldset>
      )}
      {callee && view.state === "loading" && (
        <JobWait what={W.loading} line={view.line} onStop={view.stop} stopping={!!view.stopping} />
      )}
      {view.state === "error" && (
        <p role="alert" className="state error">
          {view.error}
        </p>
      )}
      {v && (
        <Mechanism
          key={`${say(v.from)}>${say(v.to)}`}
          v={v}
          reload={() => view.reload?.()}
          onSaid={(words) => path && setSaid({ path, words })}
          pick={(end, box) => setPicked((x) => ({ ...x, [end]: box }))}
          io={io}
          {...(p.onShown ? { onShown: p.onShown } : {})}
        />
      )}
      {said && said.path === path && (
        <div className="stack">
          <p role="status" className="ev-say">
            {said.words}
          </p>
          <Propose scope="org-pack" />
        </div>
      )}
    </section>
  );
}

function Mechanism(p: {
  io: Omit<ConnectIo, "read">;
  v: Api.ConnectViewT;
  reload(): void;
  /** Words to keep through the reload (ConnectAB holds them for these two boxes). */
  onSaid(words: string): void;
  pick(end: "from" | "to", box: Api.LinkBoxT): void;
  onShown?(from: Api.LinkBoxT, to: Api.LinkBoxT): void;
}) {
  const { v } = p;
  const me = useMe().me?.user ?? "you";
  const [declaring, setDeclaring] = useState(false);
  const [a, b] = [v.fromName, v.toName];
  const could = (v.candidates?.calls ?? []).filter(
    (c) => c.status !== "here" && c.status !== "paired" && !c.inside,
  );
  const sure = could.filter((c) => c.confident && c.status !== "joined").length;
  const said =
    v.mechanism === "calls"
      ? W.mechanism.calls(could.length, a, b, sure)
      : v.mechanism === "connected"
        ? W.mechanism.connected(a, b, v.existing)
        : v.mechanism === "declared" && v.declared
          ? W.mechanism.declared(v.declared.by, day(v.declared.at), v.declared.why)
          : v.mechanism === "declare"
            ? v.from.system
              ? W.mechanism.declareNoCode(a, b, me)
              : W.mechanism.declare(a, b, me)
            : W.mechanism.needs;
  return (
    <div className="stack">
      <p className="ev-say">{said}</p>
      {v.mechanism === "declare" && v.whyNone && (
        <p className="ev-say" data-testid="why-none">
          {v.whyNone.why === "no-calls"
            ? W.mechanism.whyNone["no-calls"](
                a,
                v.whyNone.command ?? "",
                !!v.whyNone.unverified,
                !!v.whyNone.gateway,
              )
            : v.whyNone.why === "outside-unknown"
              ? W.mechanism.whyNone["outside-unknown"](b)
              : v.whyNone.why === "all-inside"
                ? W.mechanism.whyNone["all-inside"](a, v.whyNone.calls)
                : W.mechanism.whyNone["none-open"](a)}
        </p>
      )}
      {v.needs.map((n) => (
        <Need key={`${n.need}:${n.end}`} n={n} v={v} pick={p.pick} reload={p.reload} io={p.io} />
      ))}
      {/* The review: a declared arrow is said beside the calls, never in their place (B.1). */}
      {v.declared && (
        <Declared v={v} d={v.declared} io={p.io} reload={p.reload} onSaid={p.onSaid} />
      )}
      {v.mechanism === "calls" && v.candidates && (
        <>
          <Pairing
            from={v.candidates.from}
            box={v.to}
            cands={{ state: "ready", data: v.candidates, reload: p.reload }}
          />
          {!declaring && !v.declared && (
            <button type="button" className="btn" onClick={() => setDeclaring(true)}>
              {W.noneOfThese}
            </button>
          )}
        </>
      )}
      {v.mechanism === "connected" && p.onShown && (
        <button type="button" className="btn" onClick={() => p.onShown!(v.from, v.to)}>
          {W.show}
        </button>
      )}
      {(v.mechanism === "declare" ||
        declaring ||
        v.needs.some((n) => ["read", "verify", "no-repo"].includes(n.need))) &&
        v.mechanism !== "declared" &&
        v.mechanism !== "connected" && (
          <DeclareArrow v={v} {...(p.onShown ? { onShown: p.onShown } : {})} io={p.io} />
        )}
      {v.from.system && (
        <details className="stack">
          <summary className="hud">{W.details}</summary>
          {/* What Declare a link… did for an outside system: its topics and gateway routes. */}
          <DeclarePanel
            system={v.from.system}
            label={a}
            {...(v.to.repo ? { target: v.to.repo } : {})}
            onClose={() => undefined}
          />
        </details>
      )}
    </div>
  );
}

/** ADR 0204 3.1: what is missing, with the control that fixes it, then on with the same boxes. */
function Need(p: {
  io: Omit<ConnectIo, "read">;
  n: Api.ConnectNeedT;
  v: Api.ConnectViewT;
  pick(end: "from" | "to", box: Api.LinkBoxT): void;
  reload(): void;
}) {
  const { n } = p;
  const [boundary, setBoundary] = useState<"internal" | "vendor">("internal");
  const pickId = useId();
  const words =
    n.need === "pick-repo"
      ? W.need["pick-repo"](n.label, n.repos?.length ?? 0)
      : W.need[n.need](n.label);
  return (
    <div className="stack" style={{ gap: 6 }}>
      <p className="ev-say">{words}</p>
      {n.need === "pick-repo" && (
        <fieldset className="stack" style={{ gap: 4, border: 0, padding: 0, margin: 0 }}>
          <legend className="sr">{words}</legend>
          {(n.repos ?? []).map((r) => (
            <label key={r} className="row" style={{ gap: 6 }}>
              <input
                type="radio"
                name={`${pickId}-pick`}
                onChange={() => p.pick(n.end, { repo: r })}
              />
              <span className="mono">{r}</span>
            </label>
          ))}
        </fieldset>
      )}
      {n.need === "no-repo" && (
        <a className="btn" href="#/setup/repos">
          {W.addRepo}
        </a>
      )}
      {n.need === "read" && n.repos?.[0] && <ReadRepo repo={n.repos[0]} />}
      {n.need === "verify" && n.command && (
        <Command text={n.command} label={W.checkNow(n.label)} scope="corrections" />
      )}
      {n.need === "add-system" && (
        <>
          <fieldset className="row" style={{ gap: 12, border: 0, padding: 0, margin: 0 }}>
            <legend className="hud">{W.boundary(n.label)}</legend>
            {(["internal", "vendor"] as const).map((x) => (
              <label key={x} className="row" style={{ gap: 6 }}>
                <input
                  type="radio"
                  name={`${pickId}-boundary`}
                  checked={boundary === x}
                  onChange={() => setBoundary(x)}
                />
                {W.boundaries[x]}
              </label>
            ))}
          </fieldset>
          {/* The System is added in the same write as the arrow, shown in its preview (3.1). */}
          <DeclareArrow v={p.v} io={p.io} addSystem={{ name: n.label, boundary }} />
        </>
      )}
    </div>
  );
}

/** ADR 0204 1.6, 1.7: a declared arrow's panel: who, when and why; Retire once the code shows it. */
function Declared(p: {
  v: Api.ConnectViewT;
  d: Api.DeclaredArrowViewT;
  io: Omit<ConnectIo, "read">;
  reload(): void;
  onSaid(words: string): void;
}) {
  const { v, d } = p;
  return (
    <div className="stack">
      <p className="ev-say">{W.declaredPanel(d.by, day(d.at), v.fromName, v.toName, d.why)}</p>
      {v.superseded && (
        <p className="ev-say">
          {W.superseded(v.fromName, v.toName, v.superseded.calls, d.by, day(d.at))}
        </p>
      )}
      {v.find && <FindOutcome v={v} e={v.find} by={d.by} />}
      <div className="box-btns">
        <RetireArrow
          d={d}
          io={p.io}
          retire={!!v.superseded || v.find?.outcome === "found"}
          onDone={(words) => {
            p.onSaid(words);
            p.reload();
          }}
        />
        {v.from.repo && v.find?.outcome !== "found" && (
          <FindButton v={v} io={p.io} reload={p.reload} />
        )}
      </div>
    </div>
  );
}

/**
 * ADR 0204 1.7 (the review): Remove it / Retire the declared arrow, through the guarded path: the
 * lines it removes previewed first, then exactly that item taken out and the map built once
 * (POST /api/map/edits/undo), a build that would remove more waiting for the person's confirm.
 */
export function RetireArrow(p: {
  d: Api.DeclaredArrowViewT;
  io: Omit<ConnectIo, "read">;
  retire: boolean;
  /** Built: its words, said by the panel that outlives the reload (not here as well). */
  onDone?: (words: string) => void;
}) {
  const { d } = p;
  const [lines, setLines] = useState<string[] | undefined>();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<"built" | Api.BuildRefusalViewT | undefined>();
  const [error, setError] = useState<string | undefined>();
  const label = p.retire ? W.retire : W.remove;
  const preview = () => {
    setBusy(true);
    setError(undefined);
    p.io
      .post<Api.FileChangeResultT>("/api/declared-links/undo", {
        kind: "link",
        from: d.from,
        to: d.to,
        preview: true,
      })
      .then(
        (r) => setLines(r.files.flatMap((f) => f.changes.flatMap((c) => (c.was ? [c.was] : [])))),
        (e: unknown) => setError(errorOf(e)),
      )
      .finally(() => setBusy(false));
  };
  const go = () => {
    setBusy(true);
    setError(undefined);
    p.io
      .follow("/api/map/edits/undo", { wrote: [{ edit: 0, file: d.file, link: d }] })
      .then(
        () => {
          setDone("built");
          p.onDone?.(W.retired);
        },
        (e: unknown) => {
          const refused =
            e instanceof JobFailed
              ? (e.result?.refused as Api.BuildRefusalViewT | undefined)
              : undefined;
          if (refused) setDone(refused);
          else setError(errorOf(e));
        },
      )
      .finally(() => setBusy(false));
  };
  // Its words are the panel's now: nothing more to offer here (no second Remove).
  if (done === "built" && p.onDone) return null;
  if (done)
    return (
      <div className="stack">
        <p role="status" className="ev-say">
          {done === "built" ? W.retired : W.undoneWaits}
        </p>
        {done !== "built" && <RefusalLink refused={done} />}
        <Propose scope="org-pack" />
      </div>
    );
  return (
    <>
      {!lines ? (
        <button type="button" className="btn" onClick={preview} disabled={busy} aria-busy={busy}>
          {label}
        </button>
      ) : (
        <div className="stack">
          <p className="hud">{W.retireLines}</p>
          <pre className="mono">{lines.map((l) => `- ${l}`).join("\n")}</pre>
          <button
            type="button"
            className="btn primary"
            onClick={go}
            disabled={busy}
            aria-busy={busy}
          >
            {busy ? W.undoing : W.retireConfirm(label)}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="state error">
          {error}
        </p>
      )}
    </>
  );
}

/** ADR 0204 1.6: a drawn declared arrow's own panel, from the profile's item, with Remove it. */
export function DeclaredArrowLink(p: {
  join: Api.HierJoinT;
  from: string;
  to: string;
  io?: Partial<ConnectIo> & { arrow?: (path: string) => Loaded<Api.ArrowOfInterfaceViewT> };
}) {
  const path = `/api/declared-links/arrow?interface=${encodeURIComponent(p.join.interface)}`;
  const live = useApi<Api.ArrowOfInterfaceViewT>(p.io?.arrow ? undefined : path);
  const r = p.io?.arrow ? p.io.arrow(path) : live;
  const io = { ...APP, ...p.io };
  if (r.state === "loading") return <p className="state">{W.loading}</p>;
  if (r.state === "error")
    return (
      <p role="alert" className="state error">
        {r.error}
      </p>
    );
  const d = r.data.declared;
  return (
    <div className="stack">
      <p className="ev-say">{W.declaredPanel(d.by, day(d.at), p.from, p.to, d.why)}</p>
      <RetireArrow d={d} io={io} retire={false} />
    </div>
  );
}

/**
 * ADR 0204 A.1, A.7: Find it in the code, as one job; a hand-off pauses with what to paste. A
 * build that refused (the second review) is said as saved, not built, with its listing's page and
 * Read the answer to go on once it is confirmed; no outcome is told before that build.
 */
export function FindButton(p: {
  v: Api.ConnectViewT;
  io: Omit<ConnectIo, "read">;
  reload(): void;
}) {
  const { v } = p;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [handoff, setHandoff] = useState<string | undefined>();
  const [notBuilt, setNotBuilt] = useState<Api.FindResultT["notBuilt"]>();
  const [readFirst, setReadFirst] = useState<Api.FindResultT["readFirst"]>();
  const go = (read: boolean) => {
    setBusy(true);
    setError(undefined);
    p.io
      .find({ from: v.from.repo!, to: v.to, ...(read ? { read: true } : {}) })
      .then(
        (r) => {
          setNotBuilt(r.notBuilt);
          setReadFirst(r.readFirst);
          if (r.handoff) setHandoff(r.handoff.command);
          else if (!r.notBuilt && !r.readFirst) {
            setHandoff(undefined);
            p.reload();
          }
        },
        (e: unknown) => setError(errorOf(e)),
      )
      .finally(() => setBusy(false));
  };
  const label = !v.find ? W.find : v.findAgain === "again" ? W.findAgain : W.readAgain;
  return (
    <>
      <button
        type="button"
        className="btn"
        onClick={() => go(false)}
        disabled={busy}
        aria-busy={busy}
      >
        {busy ? W.finding : label}
      </button>
      {handoff && (
        <div className="stack">
          <p role="status" className="ev-say">
            {W.handoff}
          </p>
          <Command text={handoff} label={W.handoff} noRun />
          <button type="button" className="btn" onClick={() => go(true)} disabled={busy}>
            {W.readAnswer}
          </button>
        </div>
      )}
      {readFirst && (
        <div className="stack">
          <p role="status" className="ev-say">
            {W.findReadFirst(readFirst.repo)}
          </p>
          <Command text={readFirst.command} label={W.findReadFirst(readFirst.repo)} noRun />
        </div>
      )}
      {notBuilt && (
        <div className="stack">
          <p role="status" className="ev-say">
            {notBuilt.readFailed
              ? // The callee's read: the server names it; else the box's id, never its display name,
                // and never an empty name ("Read  again…").
                W.findReadFailed(notBuilt.repo || name(v.to) || W.thisBox)
              : notBuilt.refused
                ? notBuilt.repo
                  ? W.findNotBuiltRead(notBuilt.repo)
                  : W.findNotBuilt(v.fromName)
                : W.findNotVerified(v.fromName)}
          </p>
          {notBuilt.refused && <RefusalLink refused={notBuilt.refused} />}
          {notBuilt.lines.length > 0 && (
            // WCAG 1.4.10: long lines wrap, never a page that scrolls sideways.
            <pre className="mono" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {notBuilt.lines.join("\n")}
            </pre>
          )}
          {/* B's read stopped the find (the final review): no answer to read; Find it again. */}
          {!handoff && !notBuilt.repo && (
            <button type="button" className="btn" onClick={() => go(true)} disabled={busy}>
              {W.readAnswer}
            </button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="state error">
          {error}
        </p>
      )}
    </>
  );
}

/** ADR 0204 A.5: the outcome, told from the catalog, with each one's way on. */
function FindOutcome(p: { v: Api.ConnectViewT; e: Api.FindEntryViewT; by: string }) {
  const { v, e } = p;
  const [kept, setKept] = useState(false);
  const at = e.shape?.at ?? "";
  // The calls it found, today's pairing of them, ticked (A.5's found-loose and elsewhere).
  const calls = v.candidates
    ? {
        ...v.candidates,
        calls: v.candidates.calls
          .filter((c) => e.facts.includes(c.fact))
          .map((c) => (c.suggestion ? { ...c, confident: true } : c)),
      }
    : undefined;
  // With the calls listed below (mechanism `calls`), they are paired there, not twice.
  const pair = v.mechanism !== "calls" && calls && calls.calls.length > 0 && (
    <Pairing from={calls.from} box={v.to} cands={{ state: "ready", data: calls }} />
  );
  if (e.outcome === "found")
    return (
      <div className="stack">
        <p className="ev-say">{W.outcome.found(day(e.at))}</p>
        <RuleFromFind repo={v.from.repo!} to={v.to} />
      </div>
    );
  if (e.outcome === "found-loose")
    return (
      <div className="stack">
        <p className="ev-say">{W.outcome["found-loose"](at, e.shape?.value ?? "", v.toName)}</p>
        <p className="hud">{W.connectThese(e.facts.length, v.toName)}</p>
        {pair}
        <RuleFromFind repo={v.from.repo!} to={v.to} />
      </div>
    );
  if (e.outcome === "elsewhere")
    return (
      <div className="stack">
        <p className="ev-say">
          {W.outcome.elsewhere(v.fromName, e.other ?? "", at || e.facts[0] || "", p.by, v.toName)}
        </p>
        {kept ? (
          <p role="status" className="ev-say">
            {W.kept}
          </p>
        ) : (
          <button type="button" className="btn" onClick={() => setKept(true)}>
            {W.keepBoth}
          </button>
        )}
        {pair && (
          <details>
            <summary className="hud">{W.moveThis(v.toName)}</summary>
            {pair}
          </details>
        )}
      </div>
    );
  return (
    <div className="stack">
      <p className="ev-say">{W.outcome["not-found"](day(e.at), e.looked.length)}</p>
      {e.looked.length > 0 && (
        <details>
          <summary className="hud">{W.looked}</summary>
          <ul className="mono">
            {e.looked.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </details>
      )}
      {(e.rejected ?? []).map((r) => (
        <p key={r.fact} className="ev-say">
          {W.rejectedFact(r.fact, r.why)}
        </p>
      ))}
    </div>
  );
}

/** ADR 0204 A.8: a draft reading rule from the call a find confirmed; active only by a person. */
function RuleFromFind(p: { repo: string; to: Api.LinkBoxT }) {
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<Api.RuleFromPairingResultT | undefined>();
  const [error, setError] = useState<string | undefined>();
  if (made)
    return (
      <div className="stack">
        <p role="status" className="ev-say">
          {W.ruleDrafted(made.file)}
        </p>
        <Command text={made.activate} label={W.makeRule} noRun />
      </div>
    );
  return (
    <>
      <button
        type="button"
        className="btn"
        disabled={busy}
        aria-busy={busy}
        onClick={() => {
          setBusy(true);
          setError(undefined);
          api<Api.RuleFromPairingResultT>("/api/reading-rules/from-find", {
            method: "POST",
            body: { repo: p.repo, to: p.to },
          })
            .then(setMade, (e: unknown) => setError(errorOf(e)))
            .finally(() => setBusy(false));
        }}
      >
        {W.makeRule}
      </button>
      {error && (
        <p role="alert" className="state error">
          {error}
        </p>
      )}
    </>
  );
}

type Done = { wrote: Api.MapEditWroteT[]; lines: string[]; built: boolean };

/**
 * ADR 0204 1.4 and decision 2: the declare form. The button previews, writes and applies in one
 * go (nothing is removed or replaced by a declared arrow), says each, and offers Show the arrow,
 * Undo and Propose for review.
 */
export function DeclareArrow(p: {
  v: Api.ConnectViewT;
  io: Omit<ConnectIo, "read">;
  onShown?(from: Api.LinkBoxT, to: Api.LinkBoxT): void;
  /** ADR 0204 3.1: the end that is a system only the code names, added in the same write. */
  addSystem?: { name: string; boundary: "vendor" | "internal" };
}) {
  const id = useId();
  const { v } = p;
  const [why, setWhy] = useState("");
  const [planned, setPlanned] = useState(v.needs.some((n) => n.need === "no-repo"));
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<Done | undefined>();
  const [undone, setUndone] = useState(false);
  const [waits, setWaits] = useState<Api.BuildRefusalViewT | undefined>();
  // ADR 0204 1.3: an outside system calling a gateway may say which routes; none, the arrow.
  const [routes, setRoutes] = useState<Set<string>>(new Set());
  const ok =
    (why.trim().length >= 3 && why.trim().length <= 500) || (!!v.routes && routes.size > 0);
  const link = {
    kind: "link",
    from: v.from,
    to: v.to,
    why: why.trim(),
    ...(planned ? { planned } : {}),
    ...(p.addSystem ? { addSystem: p.addSystem } : {}),
  };
  const routing = !!v.routes && !!v.from.system && routes.size > 0;
  const picked = [...routes].sort();
  const go = async () => {
    setError(undefined);
    try {
      setBusy(COPY.connect.previewing);
      const pre = await p.io.post<Api.FileChangeResultT>(
        "/api/declared-links",
        routing
          ? { kind: "call", system: v.from.system, routes: picked, preview: true }
          : { ...link, preview: true },
      );
      setBusy(W.declaring);
      const edits = routing
        ? picked.map((route) => ({
            kind: "add",
            add: { kind: "call", system: v.from.system, route },
          }))
        : [{ kind: "add", add: link }];
      const r = await p.io.follow("/api/map/edits", { edits });
      const res = (r.result ?? {}) as Partial<Api.MapEditsResultT>;
      setDone({
        wrote: (res.wrote ?? []) as Api.MapEditWroteT[],
        lines: pre.files.flatMap((f) => f.changes.flatMap((c) => (c.now ? [c.now] : []))),
        built: res.built === true,
      });
    } catch (e) {
      const res = e instanceof JobFailed ? e.result : undefined;
      if (res?.built === false && Array.isArray(res.wrote) && res.wrote.length)
        setDone({ wrote: res.wrote as Api.MapEditWroteT[], lines: [], built: false });
      else setError(errorOf(e));
    } finally {
      setBusy(undefined);
    }
  };
  const undo = async () => {
    if (!done) return;
    setBusy(W.undoing);
    setError(undefined);
    try {
      await p.io.follow("/api/map/edits/undo", { wrote: done.wrote });
      setUndone(true);
      setDone(undefined);
    } catch (e) {
      // Taken back, the build waiting for a confirm of removals it didn't make (ADR 2.3).
      const refused =
        e instanceof JobFailed
          ? (e.result?.refused as Api.BuildRefusalViewT | undefined)
          : undefined;
      if (refused) {
        setWaits(refused);
        setUndone(true);
        setDone(undefined);
      } else setError(errorOf(e));
    } finally {
      setBusy(undefined);
    }
  };
  if (undone)
    return waits ? (
      <div className="stack">
        <p role="status" className="ev-say">
          {W.undoneWaits}
        </p>
        <RefusalLink refused={waits} />
      </div>
    ) : (
      <p role="status" className="ev-say">
        {W.undone}
      </p>
    );
  if (done)
    return (
      <div className="stack">
        <p role="status" className="ev-say">
          {done.built ? W.connected(v.fromName, v.toName) : W.savedNotBuilt}
        </p>
        {done.lines.length > 0 && (
          <details>
            <summary className="hud">{W.wrote}</summary>
            <pre className="mono">{done.lines.join("\n")}</pre>
          </details>
        )}
        <p className="hud">{W.notProposed}</p>
        <div className="box-btns">
          {p.onShown && done.built && (
            <button type="button" className="btn" onClick={() => p.onShown!(v.from, v.to)}>
              {W.show}
            </button>
          )}
          <button
            type="button"
            className="btn"
            onClick={() => void undo()}
            disabled={!!busy}
            aria-busy={!!busy}
          >
            {busy ?? W.undo}
          </button>
        </div>
        <Propose scope="org-pack" />
      </div>
    );
  return (
    <div className="stack" style={{ gap: 6 }}>
      <label htmlFor={`${id}-why`} className="hud">
        {W.why}
      </label>
      <textarea
        id={`${id}-why`}
        className="field"
        rows={2}
        maxLength={500}
        value={why}
        aria-describedby={`${id}-hint`}
        onChange={(e) => setWhy(e.target.value)}
      />
      <span id={`${id}-hint`} className="hud">
        {W.whyShort}
      </span>
      <label className="row" style={{ gap: 6 }}>
        <input type="checkbox" checked={planned} onChange={(e) => setPlanned(e.target.checked)} />
        {W.planned}
      </label>
      {v.routes && v.from.system && v.to.repo && (
        <RoutesFold
          system={v.from.system}
          repo={v.to.repo}
          picked={routes}
          onPick={setRoutes}
          io={p.io}
        />
      )}
      <button
        type="button"
        className="btn primary"
        disabled={!ok || !!busy}
        aria-busy={!!busy}
        onClick={() => void go()}
      >
        {busy ??
          (routing
            ? W.declareRoutes(routes.size)
            : p.addSystem
              ? W.addAndGo(p.addSystem.name)
              : v.needs.some((n) => n.need === "no-repo")
                ? W.toItself(v.toName)
                : W.declare)}
      </button>
      {error && (
        <p role="alert" className="state error">
          {error}
        </p>
      )}
    </div>
  );
}

/** ADR 0204 1.3: "Say which routes (optional)", ADR 0200's list of the gateway's routes. */
function RoutesFold(p: {
  system: string;
  repo: string;
  picked: ReadonlySet<string>;
  onPick(s: Set<string>): void;
  io: Omit<ConnectIo, "read">;
}) {
  const path = `/api/declared-links/routes?system=${encodeURIComponent(p.system)}&repo=${encodeURIComponent(p.repo)}`;
  const live = useApi<Api.DeclarableRoutesViewT>(p.io.routes ? undefined : path);
  const r = p.io.routes ? p.io.routes(path) : live;
  const list = r.state === "ready" ? (r.data.target?.routes ?? []).filter((x) => !x.declared) : [];
  return (
    <details className="stack">
      <summary className="hud">{W.routesFold}</summary>
      <p className="hud">{W.routesHint}</p>
      {r.state === "loading" && <p className="state">{W.routesLoading}</p>}
      {r.state === "error" && (
        <p role="alert" className="state error">
          {r.error}
        </p>
      )}
      {r.state === "ready" && !list.length && <p className="state">{W.routesNone}</p>}
      {list.map((x) => (
        <label key={x.id} className="row" style={{ gap: 6 }}>
          <input
            type="checkbox"
            checked={p.picked.has(x.say)}
            onChange={(e) => {
              const n = new Set(p.picked);
              if (e.target.checked) n.add(x.say);
              else n.delete(x.say);
              p.onPick(n);
            }}
          />
          <span className="mono">{x.say}</span> <span className="hud">{x.at}</span>
        </label>
      ))}
    </details>
  );
}
