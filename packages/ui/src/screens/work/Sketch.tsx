import { useEffect, useId, useState } from "react";
import type { Api } from "@maycombhq/core";
import { api, ApiError, useApi, useReloadOnFiles } from "../../api/client.js";
import { COPY } from "../../copy.js";
import { Diff } from "../architecture/Owner.js";
import { CopyButton } from "../run/shared.js";
import { Command } from "./RunNext.js";

/**
 * ADR 0179: a change drawn on the canvas. A person says each stroke (a call, a topic, a table,
 * a step of today's flow taken out or sent elsewhere), sees the lines it adds to the change's
 * target flows, and draws it with a yes; the picture above redraws with the stroke marked. Undo
 * takes one stroke back. Nothing here is a fact: a stroke is a plan, reviewed in the change's
 * pull request. "Fill in the rest" is the architecture stage, run by the person.
 */

const S = COPY.sketch;
type Kind = "call" | "topic" | "table" | "remove" | "retarget";
const KINDS: Kind[] = ["call", "topic", "table", "remove", "retarget"];

/** The form, as typed. */
export interface SketchForm {
  kind: Kind;
  component: string;
  flow: string;
  newFlow: boolean;
  newId: string;
  newName: string;
  triggerKind: "endpoint" | "action" | "page" | "listener" | "job";
  triggerWhat: string;
  /** ADR 0180: what the new box is, one of the organisation's component types (empty: unsaid). */
  newType: string;
  toComponent: string;
  toEntry: string;
  toNew: boolean;
  what: string;
  topic: string;
  listener: string;
  listenerFlow: string;
  op: "read" | "write" | "lookup";
  table: string;
  columns: string;
  tableNew: boolean;
  step: string;
  why: string;
}

export const EMPTY_FORM: SketchForm = {
  kind: "call",
  component: "",
  flow: "",
  newFlow: false,
  newId: "",
  newName: "",
  triggerKind: "endpoint",
  triggerWhat: "",
  newType: "",
  toComponent: "",
  toEntry: "",
  toNew: false,
  what: "",
  topic: "",
  listener: "",
  listenerFlow: "",
  op: "write",
  table: "",
  columns: "",
  tableNew: false,
  step: "",
  why: "",
};

const t = (s: string) => s.trim();
const slug = (s: string) =>
  t(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

/** The stroke the form says, or why it doesn't say one yet. */
export function strokeOf(
  f: SketchForm,
  types: readonly Api.ComponentTypeViewT[] = [],
): { stroke: Record<string, unknown> } | { missing: string } {
  const from = (component: string, flow: string, fresh: boolean) => {
    if (!t(component)) return undefined;
    const base: Record<string, unknown> = { component: t(component) };
    if (fresh) {
      if (!t(f.newName) || !t(f.triggerWhat)) return undefined;
      const type = types.find((x) => x.id === t(f.newType));
      base.newFlow = {
        id: t(f.newId) || `${t(component)}.${slug(f.newName)}`,
        name: t(f.newName),
        trigger: { kind: f.triggerKind, what: t(f.triggerWhat) },
        // The type and where one of its kind usually runs (ADR 0180), when a type is picked.
        ...(type
          ? {
              runsOn: {
                type: type.id,
                ...(type.runsOn?.platform ? { platform: type.runsOn.platform } : {}),
                ...(type.runsOn?.cloud ? { cloud: type.runsOn.cloud } : {}),
                ...(type.runsOn?.framework ? { framework: type.runsOn.framework } : {}),
              },
            }
          : {}),
      };
    } else if (t(flow)) base.flow = t(flow);
    return base;
  };
  const what = t(f.what) ? { what: t(f.what) } : {};
  switch (f.kind) {
    case "call": {
      const fr = from(f.component, f.flow, f.newFlow);
      if (!fr) return { missing: S.missing.from };
      if (!t(f.toComponent) || !t(f.toEntry)) return { missing: S.missing.to };
      return {
        stroke: {
          kind: "call",
          from: fr,
          to: { component: t(f.toComponent), entry: t(f.toEntry), new: f.toNew },
          ...what,
        },
      };
    }
    case "topic": {
      const fr = from(f.component, f.flow, f.newFlow);
      if (!fr) return { missing: S.missing.from };
      if (!t(f.topic)) return { missing: S.missing.topic };
      const listener = t(f.listener) ? from(f.listener, f.listenerFlow, false) : undefined;
      return {
        stroke: {
          kind: "topic",
          from: fr,
          topic: t(f.topic),
          ...(listener ? { listener } : {}),
          ...what,
        },
      };
    }
    case "table": {
      const fr = from(f.component, f.flow, f.newFlow);
      if (!fr) return { missing: S.missing.from };
      if (!t(f.table)) return { missing: S.missing.table };
      return {
        stroke: {
          kind: "table",
          from: fr,
          op: f.op,
          table: t(f.table),
          columns: f.columns.split(",").map(t).filter(Boolean),
          new: f.tableNew,
          ...what,
        },
      };
    }
    case "remove":
    case "retarget": {
      const step = Number(f.step);
      if (!t(f.flow) || !Number.isInteger(step) || step < 1) return { missing: S.missing.step };
      if (!t(f.why)) return { missing: S.missing.why };
      if (f.kind === "remove")
        return { stroke: { kind: "remove", flow: t(f.flow), step, why: t(f.why) } };
      if (!t(f.toComponent) || !t(f.toEntry)) return { missing: S.missing.to };
      return {
        stroke: {
          kind: "retarget",
          flow: t(f.flow),
          step,
          to: { component: t(f.toComponent), entry: t(f.toEntry), new: f.toNew },
          why: t(f.why),
        },
      };
    }
  }
}

const errorOf = (e: unknown) =>
  e instanceof ApiError
    ? (e.problem.detail ?? e.message)
    : e instanceof Error
      ? e.message
      : String(e);

type Post = (body: Api.SketchStrokeRequestT) => Promise<Api.SketchResultT>;

/** The panel under a change's picture: the form, Preview → Draw, the strokes drawn, Undo. */
export function SketchPanel({ change, map }: { change: string; map?: Api.ChangeMapT }) {
  const state = useApi<Api.SketchResultT>(`/api/changes/${encodeURIComponent(change)}/sketch`);
  const typeList = useApi<Api.ComponentTypesViewT>("/api/component-types");
  // A stroke from elsewhere (another tab, atticus change sketch --save, the stage) shows here too.
  useReloadOnFiles(state);
  const post: Post = (body) =>
    api<Api.SketchResultT>(`/api/changes/${encodeURIComponent(change)}/sketch`, {
      method: "POST",
      body,
    });
  return (
    <SketchForm
      change={change}
      map={map}
      drawn={state.state === "ready" ? state.data.drawn : []}
      commit={state.state === "ready" ? state.data.commit : undefined}
      fingerprint={state.state === "ready" ? state.data.fingerprint : undefined}
      types={typeList.state === "ready" ? typeList.data.types : []}
      post={post}
      onWritten={() => state.reload()}
    />
  );
}

export function SketchForm(p: {
  change: string;
  map?: Api.ChangeMapT;
  drawn: Api.SketchResultT["drawn"];
  commit?: string;
  /** The files as last read: Undo sends it back, so it never takes back a stroke it didn't show. */
  fingerprint?: string;
  /** ADR 0180: the organisation's component types, for a new box. */
  types?: readonly Api.ComponentTypeViewT[];
  post: Post;
  onWritten?: (r: Api.SketchResultT) => void;
}) {
  const id = useId();
  const [f, setF] = useState<SketchForm>(EMPTY_FORM);
  const [busy, setBusy] = useState<"preview" | "write" | string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [preview, setPreview] = useState<Api.SketchResultT | undefined>();
  const [previewed, setPreviewed] = useState<string | undefined>();
  /** The flows to pick from when the component has several (kept until the component changes). */
  const [pick, setPick] = useState<{ component: string; flows: { id: string; name: string }[] }>();
  /** The problem the server said of the stroke as it stood; cleared by any change. */
  const [problem, setProblem] = useState<string | undefined>();
  // The list as last read wins: a write's answer stands only until the next read lands.
  const [written, setWritten] = useState<Api.SketchResultT | undefined>();
  const [wrote, setWrote] = useState(false);
  useEffect(() => setWritten(undefined), [p.drawn, p.fingerprint]);
  const drawn = written?.drawn ?? p.drawn;
  const commit = written?.commit ?? p.commit;
  const fingerprint = written?.fingerprint ?? p.fingerprint;
  const said = strokeOf(f, p.types ?? []);
  const asked = "stroke" in said ? JSON.stringify(said.stroke) : undefined;
  const set = <K extends keyof SketchForm>(k: K, v: SketchForm[K]) => {
    setF((o) => ({ ...o, [k]: v }));
    setPreview(undefined);
    setProblem(undefined);
    setError(undefined);
    if (k === "component" || k === "kind") setPick(undefined);
  };
  const send = async (mode: "preview" | "write") => {
    if (!("stroke" in said)) {
      setError(said.missing);
      return;
    }
    setBusy(mode);
    setError(undefined);
    try {
      const r = await p.post({
        stroke: said.stroke as Api.SketchStrokeRequestT["stroke"],
        ...(mode === "preview"
          ? { preview: true }
          : // The write is of the files the preview saw: changed meanwhile, it is refused.
            preview?.fingerprint
            ? { expect: preview.fingerprint }
            : {}),
      });
      if (r.problem) {
        setPreview(undefined);
        setPreviewed(undefined);
        setProblem(r.problem);
        if (r.pick) setPick({ component: t(f.component), flows: r.pick.flows });
      } else if (mode === "preview") {
        setPreview(r);
        setPreviewed(JSON.stringify(said.stroke));
      } else {
        setWritten(r);
        setWrote(true);
        setPreview(undefined);
        p.onWritten?.(r);
      }
    } catch (e) {
      setError(errorOf(e));
      // Draw it is off again until the stroke is previewed afresh (the files may have changed).
      setPreview(undefined);
    } finally {
      setBusy(undefined);
    }
  };
  const undo = async (d: Api.SketchResultT["drawn"][number]) => {
    const key = `${d.flow}#${d.index}`;
    setBusy(key);
    setError(undefined);
    try {
      const r = await p.post({
        stroke: { kind: "undo", flow: d.flow, index: d.index },
        ...(fingerprint ? { expect: fingerprint } : {}),
      });
      if (r.problem) setError(r.problem);
      else {
        setWritten(r);
        setWrote(true);
        setPreview(undefined);
        p.onWritten?.(r);
      }
    } catch (e) {
      setError(errorOf(e));
    } finally {
      setBusy(undefined);
    }
  };
  const components = [
    ...new Set([...(p.map?.nodes.filter((n) => n.kind === "component").map((n) => n.id) ?? [])]),
  ].sort();
  const flowsOf = pick && pick.component === t(f.component) ? pick.flows : [];
  const needsFrom = f.kind !== "remove" && f.kind !== "retarget";
  const field = (k: keyof SketchForm, label: string, extra: Record<string, unknown> = {}) => (
    <label className="stack" style={{ gap: 2 }}>
      <span className="hud">{label}</span>
      <input
        className="field"
        value={String(f[k])}
        onChange={(e) => set(k, e.target.value as never)}
        {...extra}
      />
    </label>
  );
  const tick = (k: "toNew" | "tableNew" | "newFlow", label: string) => (
    <label className="row" style={{ gap: 6 }}>
      <input type="checkbox" checked={f[k]} onChange={(e) => set(k, e.target.checked)} />
      {label}
    </label>
  );
  return (
    <section className="stack sketch-panel" aria-labelledby={`${id}-t`}>
      <h3 id={`${id}-t`} className="hud">
        {S.title}
      </h3>
      <p className="ev-say">{S.intro}</p>
      <datalist id={`${id}-c`}>
        {components.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <fieldset
        className="row"
        style={{ border: 0, padding: 0, margin: 0, flexWrap: "wrap", gap: 10 }}
      >
        <legend className="hud">{S.kind}</legend>
        {KINDS.map((k) => (
          <label key={k} className="row" style={{ gap: 6 }}>
            <input
              type="radio"
              name={`${id}-k`}
              checked={f.kind === k}
              onChange={() => set("kind", k)}
            />
            {S.kinds[k]}
          </label>
        ))}
      </fieldset>
      {needsFrom ? (
        <div className="stack" style={{ gap: 6 }}>
          {field("component", S.from, { list: `${id}-c` })}
          {!f.newFlow &&
            (flowsOf.length ? (
              <label className="stack" style={{ gap: 2 }}>
                <span className="hud">{S.flow}</span>
                <select
                  className="field"
                  value={f.flow}
                  onChange={(e) => set("flow", e.target.value)}
                >
                  <option value="">{S.pickFlow}</option>
                  {flowsOf.map((fl) => (
                    <option key={fl.id} value={fl.id}>
                      {S.flowOption(fl.name, fl.id)}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              field("flow", S.flowOptional)
            ))}
          {tick("newFlow", S.newFlow)}
          {f.newFlow && (
            <div className="stack" style={{ gap: 6, paddingLeft: 12 }}>
              {field("newName", S.newName)}
              {field("newId", S.newId, {
                placeholder: `${t(f.component) || "component"}.${slug(f.newName) || "flow"}`,
              })}
              <label className="stack" style={{ gap: 2 }}>
                <span className="hud">{S.trigger}</span>
                <select
                  className="field"
                  value={f.triggerKind}
                  onChange={(e) => set("triggerKind", e.target.value as SketchForm["triggerKind"])}
                >
                  {(["endpoint", "action", "page", "listener", "job"] as const).map((k) => (
                    <option key={k} value={k}>
                      {S.triggers[k]}
                    </option>
                  ))}
                </select>
              </label>
              {field("triggerWhat", S.triggerWhat)}
              {(p.types?.length ?? 0) > 0 && (
                <label className="stack" style={{ gap: 2 }}>
                  <span className="hud">{S.newType}</span>
                  <select
                    className="field"
                    value={f.newType}
                    onChange={(e) => set("newType", e.target.value)}
                  >
                    <option value="">{S.newTypeNone}</option>
                    {p.types!.map((x) => (
                      <option key={x.id} value={x.id} title={x.description}>
                        {S.typeOption(x.name, x.draws?.badge)}
                      </option>
                    ))}
                  </select>
                  {f.newType && p.types!.find((x) => x.id === f.newType)?.mustNot.length ? (
                    <span className="muted" style={{ fontSize: 12 }}>
                      {S.typeMustNot(p.types!.find((x) => x.id === f.newType)!.mustNot)}
                    </span>
                  ) : null}
                </label>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="stack" style={{ gap: 6 }}>
          {field("flow", S.todayFlow)}
          {field("step", S.step, { inputMode: "numeric" })}
        </div>
      )}
      {(f.kind === "call" || f.kind === "retarget") && (
        <div className="stack" style={{ gap: 6 }}>
          {field("toComponent", S.toComponent, { list: `${id}-c` })}
          {field("toEntry", S.toEntry, { placeholder: S.toEntryExample })}
          {tick("toNew", S.toNew)}
        </div>
      )}
      {f.kind === "topic" && (
        <div className="stack" style={{ gap: 6 }}>
          {field("topic", S.topic)}
          {field("listener", S.listener, { list: `${id}-c` })}
          {t(f.listener) && field("listenerFlow", S.listenerFlow)}
        </div>
      )}
      {f.kind === "table" && (
        <div className="stack" style={{ gap: 6 }}>
          <label className="stack" style={{ gap: 2 }}>
            <span className="hud">{S.op}</span>
            <select
              className="field"
              value={f.op}
              onChange={(e) => set("op", e.target.value as SketchForm["op"])}
            >
              {(["read", "write", "lookup"] as const).map((k) => (
                <option key={k} value={k}>
                  {S.ops[k]}
                </option>
              ))}
            </select>
          </label>
          {field("table", S.table, { placeholder: S.tableExample })}
          {field("columns", S.columns)}
          {tick("tableNew", S.tableNew)}
        </div>
      )}
      {needsFrom ? field("what", S.what) : field("why", S.why)}
      {error && (
        <p role="alert" className="state error">
          {error}
        </p>
      )}
      {problem && (
        <p role="alert" className="state error">
          {problem}
        </p>
      )}
      <div className="row" style={{ gap: 8 }}>
        <button
          type="button"
          className="btn"
          disabled={!!busy}
          aria-busy={busy === "preview"}
          onClick={() => void send("preview")}
        >
          {busy === "preview" ? S.previewing : S.preview}
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={!!busy || !preview || !asked || previewed !== asked}
          aria-busy={busy === "write"}
          onClick={() => void send("write")}
        >
          {busy === "write" ? S.drawing : S.draw}
        </button>
      </div>
      {preview && previewed === asked && (
        <>
          <p className="ev-say">{S.previewSays}</p>
          <Diff r={{ files: preview.files }} />
        </>
      )}
      {wrote && (
        <div className="stack" role="status">
          <p className="ev-say">{S.written}</p>
          {commit && (
            <div className="row" style={{ gap: 6 }}>
              <code className="mono">{commit}</code>
              <CopyButton text={commit} label={`${S.copy}: ${commit}`} />
            </div>
          )}
        </div>
      )}
      <h4 className="hud">{S.drawnTitle}</h4>
      {drawn.length === 0 ? (
        <p className="muted">{S.drawnNone}</p>
      ) : (
        <ul className="stack sketch-drawn" style={{ gap: 4, listStyle: "none", padding: 0 }}>
          {drawn.map((d) => {
            const key = `${d.flow}#${d.index}`;
            return (
              <li key={key} className="row between" style={{ gap: 8 }}>
                <span>
                  <code className="mono">{d.flow}</code> · {d.what}
                  {d.by ? <span className="muted"> · {S.drawnBy(d.by)}</span> : null}
                </span>
                <button
                  type="button"
                  className="btn"
                  disabled={busy !== undefined}
                  aria-busy={busy === key}
                  onClick={() => void undo(d)}
                >
                  {busy === key ? S.undoing : S.undo}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="ev-say">{S.fill}</p>
      <Command text={`atticus change architecture ${p.change}`} label={COPY.runNext.copy} />
    </section>
  );
}
