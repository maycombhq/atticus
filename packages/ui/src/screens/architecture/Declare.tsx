import { useId, useState } from "react";
import type { Api } from "@maycombhq/core";
import { api, ApiError, useApi, type Loaded } from "../../api/client.js";
import { appStep, ReadRepo, WrittenNext } from "../../app/app-step.js";
import { Command } from "../work/RunNext.js";
import { CopyButton } from "../run/shared.js";
import { COPY } from "../../copy.js";
import { usePopupFocus } from "./popup.js";
import { AiChip } from "../../app/decisions.js";
import { Diff } from "./Owner.js";

/**
 * G3 (ADR 0174): declare a link the code can't show, a box's corrections with Undo, and Add to
 * the picture. Each writes a file for review after the person's yes, preview first; nothing here
 * is a fact.
 */

const D = COPY.declare;
const K = COPY.corrections;
const A = COPY.addBox;

const errorOf = (e: unknown) =>
  e instanceof ApiError
    ? (e.problem.detail ?? e.message)
    : e instanceof Error
      ? e.message
      : String(e);

/** ADR 0188: written; Apply redraws the map, then Propose for review (the commands folded). */
function Cmds({ r, label }: { r: Api.FileChangeResultT; label: string }) {
  return <WrittenNext said={label} verify={r.verify} commit={r.commit} />;
}

/**
 * Beta.28.1 (field report 4): the System a declaration adds to a profile first, for a box no
 * profile had: said before it is written, and once it is.
 */
export function CreatedNote(p: { created?: Api.FileChangeResultT["created"]; written: boolean }) {
  if (!p.created) return null;
  const { system, file } = p.created;
  return p.written ? (
    <p className="ev-say" role="status">
      {D.created(system, file)}
    </p>
  ) : (
    <p className="ev-say" role="note">
      {D.willCreate(system, file)}
    </p>
  );
}

/** S3: the System the canvas added, taken away with its last declaration (Undo), said. */
export function RemovedNote(p: { removed?: Api.FileChangeResultT["removed"] }) {
  if (!p.removed) return null;
  return (
    <p className="ev-say" role="status">
      {K.removedSystem(p.removed.system, p.removed.file)}
    </p>
  );
}

/**
 * A request built from the form, or none when it lacks the topic or the route. ADR 0200: for a
 * call, the routes ticked (and one typed, if any), sorted, each once; a typed route alone is
 * sent as before.
 */
export function declareBody(
  system: string,
  kind: "publishes" | "listens" | "call",
  value: string,
  picked: ReadonlySet<string> = new Set(),
): Api.DeclareLinkRequestT | undefined {
  const v = value.trim();
  if (kind !== "call") return v ? { kind: "topic", system, topic: v, side: kind } : undefined;
  if (!picked.size) return v ? { kind: "call", system, route: v } : undefined;
  const routes = [...new Set([...picked, ...(v ? [v] : [])])].sort((x, y) =>
    x < y ? -1 : x > y ? 1 : 0,
  );
  return { kind: "call", system, routes };
}

/** ADR 0200: where the gateways are read from, and a repo's routes once one is picked. */
export const routesPath = (system: string, repo: string | undefined): string =>
  `/api/declared-links/routes?system=${encodeURIComponent(system)}${
    repo ? `&repo=${encodeURIComponent(repo)}` : ""
  }`;

/** A search box is offered past this many routes. */
const SEARCH_FROM = 8;

type RoutesRead = Loaded<Api.DeclarableRoutesViewT> & { reload?: () => void };

/** A step that reads or verifies a repo: its button first, the command folded (ADR 0188). */
function Step({ text }: { text: string }) {
  if (appStep(text)) return <Command text={text} label={D.copy} scope="corrections" />;
  return (
    <div className="row" style={{ gap: 6 }}>
      <code className="mono">{text}</code>
      <CopyButton text={text} label={`${D.copy}: ${text}`} />
    </div>
  );
}

export function DeclarePanel(p: {
  system: string;
  label: string;
  /**
   * ADR 0200: the repo a line drawn from this system ended on. The panel opens with "Calls a
   * gateway route" chosen and that repo's routes listed: the system is the caller, as drawn.
   */
  target?: string;
  onClose(): void;
  post?: (body: Api.DeclareLinkRequestT) => Promise<Api.FileChangeResultT>;
  /** Tests pass their own read of the routes; the app asks the local API. */
  routesOf?: (path: string | undefined) => RoutesRead;
}) {
  const id = useId();
  const [kind, setKind] = useState<"publishes" | "listens" | "call">(
    p.target ? "call" : "publishes",
  );
  const [value, setValue] = useState("");
  // ADR 0200: the gateway picked, the routes ticked (by the words that declare each) and the
  // words the list is narrowed by.
  const [repo, setRepo] = useState(p.target ?? "");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [find, setFind] = useState("");
  const [busy, setBusy] = useState<"preview" | "write" | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [preview, setPreview] = useState<Api.FileChangeResultT | undefined>();
  const [written, setWritten] = useState<Api.FileChangeResultT | undefined>();
  const post =
    p.post ??
    ((body: Api.DeclareLinkRequestT) =>
      api<Api.FileChangeResultT>("/api/declared-links", { method: "POST", body }));
  // Read only once "Calls a gateway route" is the kind. The gateways stay listed while another
  // one's routes are read (`view`: the same answer, asked again).
  const path = kind === "call" ? routesPath(p.system, repo || undefined) : undefined;
  const live = useApi<Api.DeclarableRoutesViewT>(p.routesOf ? undefined : path, {
    view: `declarable:${p.system}`,
  });
  const read: RoutesRead = p.routesOf ? p.routesOf(path) : live;
  const data = read.state === "ready" ? read.data : undefined;
  // The answer for the repo picked, never another repo's shown as this one's.
  const target = data?.target && data.target.repo === repo ? data.target : undefined;
  const reading =
    kind === "call" && (read.state === "loading" || (!!repo && read.state === "ready" && !target));
  const open = target?.gateway ? target.routes.filter((r) => !r.declared) : [];
  const done = target?.gateway ? target.routes.filter((r) => r.declared) : [];
  const words = find.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (r: (typeof open)[number]) => {
    const text = `${r.method ?? ""} ${r.path} ${r.handler ?? ""}`.toLowerCase();
    return words.every((w) => text.includes(w));
  };
  // What is ticked stays in sight, whatever the search says.
  const shown = open.filter((r) => !words.length || picked.has(r.say) || matches(r));
  const noMatch = words.length > 0 && !open.some(matches);
  // What the form says now: Write it writes only what was previewed, nothing changed since.
  const body = declareBody(p.system, kind, value, picked);
  const count = body?.kind === "call" && body.routes ? body.routes.length : 1;
  const asked = JSON.stringify(body ?? null);
  const [previewed, setPreviewed] = useState<string | undefined>();
  const send = async (mode: "preview" | "write") => {
    const b = body;
    if (!b) {
      setError(kind === "call" ? D.emptyRoutes : D.empty);
      return;
    }
    setBusy(mode);
    setError(undefined);
    try {
      const r = await post({ ...b, ...(mode === "preview" ? { preview: true } : {}) });
      if (mode === "preview") {
        setPreview(r);
        // The form as it was sent, not as it is when the answer comes.
        setPreviewed(JSON.stringify(b));
      } else {
        setWritten(r);
        setPreview(undefined);
        if (b.kind === "call") {
          // Declared now: nothing stays ticked, and the list is read again to say so.
          setPicked(new Set());
          setValue("");
          read.reload?.();
        }
      }
    } catch (e) {
      setError(errorOf(e));
    } finally {
      setBusy(undefined);
    }
  };
  const tick = (say: string, on: boolean) => {
    setPicked((old) => {
      const n = new Set(old);
      if (on) n.add(say);
      else n.delete(say);
      return n;
    });
    setPreview(undefined);
  };
  const head = usePopupFocus<HTMLHeadingElement>();
  const gateways = data?.gateways ?? [];
  const nothing = kind === "call" && !body;
  return (
    <section className="stack connect-panel" aria-labelledby={`${id}-t`}>
      <div className="box-pop-head">
        <h4 id={`${id}-t`} ref={head} tabIndex={-1} className="h box-pop-title">
          {D.title(p.label)}
        </h4>
        <button type="button" className="btn" onClick={p.onClose}>
          {D.close}
        </button>
      </div>
      {/* ADR 0200: the two ends of the line, as drawn: the system it started on is the caller. */}
      {kind === "call" && repo && (
        <p className="box-ends">
          <span className="sr">{D.ends(p.label, repo)}</span>
          <span aria-hidden="true" className="chip mono">
            {p.label}
          </span>
          <span aria-hidden="true">→</span>
          <span aria-hidden="true" className="chip mono">
            {repo}
          </span>
        </p>
      )}
      <p className="ev-say">{D.intro}</p>
      <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="hud">{D.kind}</legend>
        {(["publishes", "listens", "call"] as const).map((k) => (
          <label key={k} className="row" style={{ gap: 6 }}>
            <input
              type="radio"
              name={`${id}-k`}
              checked={kind === k}
              onChange={() => {
                setKind(k);
                setValue("");
                setPreview(undefined);
              }}
            />
            {D.kinds[k]}
          </label>
        ))}
      </fieldset>
      {kind !== "call" && (
        <>
          <label htmlFor={`${id}-v`} className="hud">
            {D.topic}
          </label>
          <input
            id={`${id}-v`}
            className="field"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setPreview(undefined);
            }}
          />
        </>
      )}
      {kind === "call" && <p className="ev-say">{D.callIntro(p.label)}</p>}
      {kind === "call" && read.state === "error" && (
        <div className="stack">
          <p role="alert" className="state error">
            {D.routesFailed(read.error)}
          </p>
          {read.reload && (
            <div className="box-btns">
              <button type="button" className="btn" onClick={read.reload}>
                {D.again}
              </button>
            </div>
          )}
        </div>
      )}
      {kind === "call" && data && (gateways.length > 0 || !!repo) && (
        <>
          <label htmlFor={`${id}-g`} className="hud">
            {D.gateway}
          </label>
          <select
            id={`${id}-g`}
            className="field"
            value={repo}
            onChange={(e) => {
              // Another gateway: what was ticked and typed for the first isn't carried over.
              setRepo(e.target.value);
              setPicked(new Set());
              setFind("");
              setPreview(undefined);
            }}
          >
            <option value="">{D.gatewayNone}</option>
            {gateways.map((g) => (
              <option key={g.repo} value={g.repo}>
                {D.gatewayOption(g.repo, g.routes)}
              </option>
            ))}
            {/* The repo the line ended on, when it has no gateway route: named, never dropped. */}
            {repo && !gateways.some((g) => g.repo === repo) && (
              <option value={repo}>{D.notGatewayOption(repo)}</option>
            )}
          </select>
        </>
      )}
      {kind === "call" && data && !gateways.length && !repo && (
        <p className="ev-say">{D.noGateways}</p>
      )}
      {reading && (
        <p role="status" aria-busy="true" className="ev-say">
          {D.routesLoading}
        </p>
      )}
      {kind === "call" && target?.notRead && (
        <div className="stack">
          <p className="ev-say">{D.notRead[target.notRead.why]!(repo)}</p>
          <Step text={target.notRead.command} />
        </div>
      )}
      {kind === "call" && target && !target.gateway && !target.notRead && (
        // The truth about what a declaration can name: a gateway's route, and nothing else yet.
        <div className="stack" role="note">
          <p className="ev-say">{D.notGateway(repo)}</p>
          <p className="ev-say">{D.notGatewayEntries(repo, target.entries)}</p>
          <p className="ev-say">{D.notGatewayDo(p.label, repo, gateways.length > 0)}</p>
        </div>
      )}
      {kind === "call" && target?.gateway && open.length > 0 && (
        <>
          {open.length > SEARCH_FROM && (
            <>
              <label htmlFor={`${id}-f`} className="sr">
                {D.findRoute}
              </label>
              <input
                id={`${id}-f`}
                className="field"
                type="search"
                placeholder={D.findRoute}
                value={find}
                onChange={(e) => setFind(e.target.value)}
              />
            </>
          )}
          <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <legend className="hud">{D.routesOf(repo, open.length)}</legend>
            {words.length > 0 && (
              <p className="hud box-sub">{D.shown(shown.length, open.length)}</p>
            )}
            {noMatch && (
              <p className="ev-say" role="status">
                {D.noMatch(find.trim())}
              </p>
            )}
            <ul className="box-calls">
              {shown.map((r) => (
                <li key={r.id} className="box-call">
                  <label
                    className="box-call-head"
                    title={`${r.method ?? ""} ${r.path}\n${r.at}`.trim()}
                  >
                    <input
                      type="checkbox"
                      checked={picked.has(r.say)}
                      onChange={(e) => tick(r.say, e.target.checked)}
                    />
                    <span className="box-call-what">
                      <span className="box-path">
                        {r.method && <span className="box-method">{r.method}</span>}
                        <code className="mono">{r.path}</code>
                      </span>
                      <span className="box-at mono">
                        {r.handler ? `${D.handler(r.handler)} · ${r.at}` : r.at}
                      </span>
                    </span>
                  </label>
                  {r.also?.length ? <span className="box-why">{D.also(r.also)}</span> : null}
                </li>
              ))}
            </ul>
          </fieldset>
          <div className="box-btns">
            {shown.some((r) => !picked.has(r.say)) && (words.length > 0 || open.length > 1) && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setPicked((old) => new Set([...old, ...shown.map((r) => r.say)]));
                  setPreview(undefined);
                }}
              >
                {D.pickShown(shown.length)}
              </button>
            )}
            {picked.size > 0 && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setPicked(new Set());
                  setPreview(undefined);
                }}
              >
                {D.unpickAll}
              </button>
            )}
          </div>
          <p className="hud" role="status">
            {D.picked(picked.size)}
          </p>
        </>
      )}
      {kind === "call" && target?.gateway && !open.length && (
        <p className="ev-say">{D.allDeclared(p.label, repo)}</p>
      )}
      {kind === "call" && done.length > 0 && (
        <details className="stack">
          <summary className="hud">{D.declaredList(p.label, done.length)}</summary>
          <ul className="box-calls">
            {done.map((r) => (
              <li key={r.id} className="box-call">
                <span className="box-path">
                  {r.method && <span className="box-method">{r.method}</span>}
                  <code className="mono">{r.path}</code>
                </span>
                <span className="chip dim">{D.declaredAlready}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {kind === "call" && (
        // A route not read yet, or one the person knows by heart: typed, as before.
        <details className="stack" open={!target?.gateway || value !== ""}>
          <summary className="hud">{D.typed}</summary>
          <label htmlFor={`${id}-v`} className="hud">
            {D.route}
          </label>
          <input
            id={`${id}-v`}
            className="field"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setPreview(undefined);
            }}
          />
        </details>
      )}
      {error && (
        <p role="alert" className="state error">
          {error}
        </p>
      )}
      {nothing && (
        <p id={`${id}-why`} className="hud">
          {D.pickFirst}
        </p>
      )}
      <div className="row" style={{ gap: 8 }}>
        <button
          type="button"
          className="btn"
          disabled={!!busy || nothing}
          aria-busy={busy === "preview"}
          {...(nothing ? { "aria-describedby": `${id}-why` } : {})}
          onClick={() => void send("preview")}
        >
          {busy === "preview" ? D.previewing : D.preview}
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={!!busy || !preview || previewed !== asked}
          {...(nothing ? { "aria-describedby": `${id}-why` } : {})}
          onClick={() => void send("write")}
        >
          {busy === "write" ? D.writing : D.confirmN(count)}
        </button>
      </div>
      {preview && previewed === asked && (
        <>
          <CreatedNote created={preview.created} written={false} />
          <Diff r={preview} />
        </>
      )}
      {written && (
        <>
          <CreatedNote created={written.created} written />
          <Cmds r={written} label={D.written} />
        </>
      )}
    </section>
  );
}

/** A box's corrections (a repo's) or declarations (a system's), each with Undo. */
export function BoxCorrections(p: { box: Api.LinkBoxT }) {
  const [open, setOpen] = useState(false);
  const path = p.box.repo
    ? `/api/boxes/corrections?repo=${encodeURIComponent(p.box.repo)}`
    : `/api/boxes/corrections?system=${encodeURIComponent(p.box.system!)}`;
  const v = useApi<Api.BoxCorrectionsT>(open ? path : undefined);
  return (
    <div className="stack">
      <h4 className="hud">{K.title}</h4>
      {!open ? (
        <button type="button" className="btn" onClick={() => setOpen(true)}>
          {K.show}
        </button>
      ) : (
        <CorrectionsList of={v} />
      )}
    </div>
  );
}

export function CorrectionsList(p: {
  of: Loaded<Api.BoxCorrectionsT> & { reload?: () => void };
  undo?: (
    u: Api.BoxCorrectionsT["items"][number]["undo"],
  ) => Promise<Api.FileChangeResultT | { verify: string; commit: string }>;
}) {
  const [busy, setBusy] = useState<number | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<
    { verify: string; commit: string; removed?: Api.FileChangeResultT["removed"] } | undefined
  >();
  const undo =
    p.undo ??
    ((u: Api.BoxCorrectionsT["items"][number]["undo"]) =>
      "line" in u
        ? api<{ verify: string; commit: string }>(
            `/api/facts/${encodeURIComponent(u.repo)}/corrections/undo`,
            { method: "POST", body: { line: u.line } },
          )
        : api<Api.FileChangeResultT>("/api/declared-links/undo", { method: "POST", body: u }));
  if (p.of.state === "loading")
    return (
      <p role="status" aria-busy="true" className="ev-say">
        {K.loading}
      </p>
    );
  if (p.of.state === "error")
    return (
      <p role="alert" className="state error">
        {K.failed(p.of.error)}
      </p>
    );
  const items = p.of.data.items;
  return (
    <div className="stack">
      {!items.length && <p className="ev-say">{K.none}</p>}
      {items.length > 0 && (
        <ul className="stack" style={{ paddingLeft: 18, margin: 0 }}>
          {items.map((x, i) => (
            <li key={`${x.file}:${i}`}>
              <span className="chip dim">{K.kinds[x.kind]}</span> {x.says}
              {/* ADR 0181: a pairing the AI decided is the AI's, with its run, never a person's. */}
              {x.ai && (
                <>
                  {" "}
                  <AiChip run={x.ai.run} />
                </>
              )}
              {x.by && <span className="hud"> · {K.by(x.by, x.at ?? "")}</span>}{" "}
              <button
                type="button"
                className="btn"
                disabled={busy !== undefined}
                aria-busy={busy === i}
                onClick={() => {
                  setBusy(i);
                  setError(undefined);
                  undo(x.undo)
                    .then((r) => {
                      setDone({
                        verify: r.verify,
                        commit: r.commit,
                        ...("removed" in r && r.removed ? { removed: r.removed } : {}),
                      });
                      p.of.reload?.();
                    })
                    .catch((e: unknown) => setError(errorOf(e)))
                    .finally(() => setBusy(undefined));
                }}
              >
                {busy === i ? K.undoing : K.undo}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="state error">
          {error}
        </p>
      )}
      {done && <RemovedNote removed={done.removed} />}
      {done && <WrittenNext said={K.undone} verify={done.verify} commit={done.commit} />}
    </div>
  );
}

/** Add to the picture: read a repo not read yet, or add a vendor or team system for review. */
export function AddBoxPanel(p: { onClose(): void }) {
  const v = useApi<Api.AddableViewT>("/api/boxes/addable");
  return <AddBoxForm of={v} onClose={p.onClose} />;
}

export function AddBoxForm(p: {
  of: Loaded<Api.AddableViewT>;
  onClose(): void;
  post?: (b: Api.AddSystemRequestT) => Promise<Api.FileChangeResultT>;
}) {
  const id = useId();
  const [sid, setSid] = useState("");
  const [name, setName] = useState("");
  const [boundary, setBoundary] = useState<"vendor" | "internal">("vendor");
  const [owner, setOwner] = useState("");
  const [busy, setBusy] = useState<"preview" | "write" | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [preview, setPreview] = useState<Api.FileChangeResultT | undefined>();
  const [written, setWritten] = useState<Api.FileChangeResultT | undefined>();
  const post =
    p.post ??
    ((b: Api.AddSystemRequestT) =>
      api<Api.FileChangeResultT>("/api/boxes", { method: "POST", body: b }));
  // What the form says now: Write it writes only what was previewed, nothing changed since.
  const body = {
    id: sid.trim(),
    name: name.trim(),
    boundary,
    ...(owner && boundary === "internal" ? { owner } : {}),
  };
  const asked = JSON.stringify(body);
  const [previewed, setPreviewed] = useState<string | undefined>();
  const send = async (mode: "preview" | "write") => {
    setBusy(mode);
    setError(undefined);
    try {
      const r = await post({ ...body, ...(mode === "preview" ? { preview: true } : {}) });
      if (mode === "preview") {
        setPreview(r);
        setPreviewed(JSON.stringify(body));
      } else {
        setWritten(r);
        setPreview(undefined);
      }
    } catch (e) {
      setError(errorOf(e));
    } finally {
      setBusy(undefined);
    }
  };
  const head = usePopupFocus<HTMLHeadingElement>();
  return (
    <section className="stack connect-panel" aria-labelledby={`${id}-t`}>
      <div className="box-pop-head">
        <h4 id={`${id}-t`} ref={head} tabIndex={-1} className="h box-pop-title">
          {A.title}
        </h4>
        <button type="button" className="btn" onClick={p.onClose}>
          {A.close}
        </button>
      </div>
      {p.of.state === "loading" && (
        <p role="status" aria-busy="true" className="ev-say">
          {A.loading}
        </p>
      )}
      {p.of.state === "error" && (
        <p role="alert" className="state error">
          {A.failed(p.of.error)}
        </p>
      )}
      {p.of.state === "ready" && (
        <>
          {(() => {
            const unread = p.of.data.repos.filter((r) => !r.read);
            return unread.length ? (
              <>
                <p className="ev-say">{A.notRead}</p>
                <ul className="stack" style={{ paddingLeft: 18, margin: 0 }}>
                  {unread.map((r) => (
                    <li key={r.id} className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                      <span className="mono">{r.name}</span>
                      {/* ADR 0188: Copilot, the server's model or the person's assistant. */}
                      <ReadRepo repo={r.id} />
                      <details className="work-terminal">
                        <summary>{COPY.appStep.inTerminal}</summary>
                        <code className="mono">{A.readCommand(r.id)}</code>
                      </details>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="ev-say">{A.allRead}</p>
            );
          })()}
          <h5 className="hud">{A.newSystem}</h5>
          <label htmlFor={`${id}-id`} className="hud">
            {A.id}
          </label>
          <input
            id={`${id}-id`}
            className="field"
            value={sid}
            onChange={(e) => setSid(e.target.value)}
          />
          <label htmlFor={`${id}-n`} className="hud">
            {A.name}
          </label>
          <input
            id={`${id}-n`}
            className="field"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <label htmlFor={`${id}-b`} className="hud">
            {A.boundary}
          </label>
          <select
            id={`${id}-b`}
            className="field"
            value={boundary}
            onChange={(e) => setBoundary(e.target.value as "vendor" | "internal")}
          >
            {(["vendor", "internal"] as const).map((b) => (
              <option key={b} value={b}>
                {A.boundaries[b]}
              </option>
            ))}
          </select>
          {boundary === "internal" && (
            <>
              <label htmlFor={`${id}-o`} className="hud">
                {A.owner}
              </label>
              <select
                id={`${id}-o`}
                className="field"
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
              >
                <option value="">{A.noOwner}</option>
                {p.of.data.teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </>
          )}
          {error && (
            <p role="alert" className="state error">
              {error}
            </p>
          )}
          <div className="row" style={{ gap: 8 }}>
            <button
              type="button"
              className="btn"
              disabled={!!busy || !sid.trim() || !name.trim()}
              aria-busy={busy === "preview"}
              onClick={() => void send("preview")}
            >
              {busy === "preview" ? A.previewing : A.preview}
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={!!busy || !preview || previewed !== asked}
              onClick={() => void send("write")}
            >
              {busy === "write" ? A.writing : A.confirm}
            </button>
          </div>
          {preview && previewed === asked && <Diff r={preview} />}
          {written && <Cmds r={written} label={A.written} />}
        </>
      )}
    </section>
  );
}
