import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Api } from "@maycombhq/core";
import { api, ApiError, useLiveEvents } from "../../api/client.js";
import { FlowCanvas } from "../../app/flow.js";
import { Panel } from "../../app/ui.js";
import { queryParam, setQueryParam } from "../know/common.js";
import { CopyButton, Facts } from "../run/shared.js";
import { canvasView, keyStep, outlineRows, type Views } from "./model.js";
import { WORDS } from "./words.js";

const LENSES = ["architecture", "repo", "data", "integration", "infrastructure"] as const;
type Lens = (typeof LENSES)[number];

type Status =
  { state: "loading" } | { state: "error"; error: string; notYet?: boolean } | { state: "ready" };

const nodePath = (id: string, lens: Lens) =>
  `/api/graph/node/${encodeURIComponent(id)}?lens=${lens}`;

/**
 * The Architecture workspace (plan 4.6, ADR 0081): the estate from the graph API, opened a node
 * at a time. A lens switcher, breadcrumbs, the picture of the open node, an outline of the same
 * graph for keyboards and screen readers, and a details panel with the command for the next step.
 */
export function Architecture({ hash }: { hash: string }) {
  const lensParam = queryParam(hash, "lens");
  const lens: Lens = (LENSES as readonly string[]).includes(lensParam ?? "")
    ? (lensParam as Lens)
    : "architecture";
  const [views, setViews] = useState<Views>(new Map());
  const [status, setStatus] = useState<Status>({ state: "loading" });
  const [current, setCurrent] = useState("estate");
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["estate"]));
  const [selected, setSelected] = useState<string | undefined>();
  const [focus, setFocus] = useState<Api.GraphFocusViewT | undefined>();
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  const load = useCallback(
    async (id: string, into?: Views) => {
      const v = await api<Api.GraphNodeViewT>(nodePath(id, lens));
      setViews((old) => new Map(into ?? old).set(id, v));
      return v;
    },
    [lens],
  );

  // A new lens starts again from the estate.
  useEffect(() => {
    let live = true;
    setStatus({ state: "loading" });
    setCurrent("estate");
    setExpanded(new Set(["estate"]));
    setSelected(undefined);
    setFocus(undefined);
    load("estate", new Map()).then(
      () => live && setStatus({ state: "ready" }),
      (e: unknown) =>
        live &&
        setStatus({
          state: "error",
          error: e instanceof Error ? e.message : String(e),
          ...(e instanceof ApiError && e.problem.notYet ? { notYet: true } : {}),
        }),
    );
    return () => {
      live = false;
    };
  }, [load]);

  // A rescan or a kept arrangement changes files: load the open views again.
  useLiveEvents((e) => {
    if (e.type !== "file.changed" || typeof e.path !== "string") return;
    if (!e.path.startsWith("catalog")) return;
    for (const id of views.keys()) void load(id).catch(() => undefined);
  });

  const find = (id: string): Api.HierNodeT | undefined => {
    if (focus) {
      if (focus.node.id === id) return focus.node;
      const n = focus.neighbours.find((x) => x.id === id);
      if (n) return n;
    }
    for (const v of views.values()) {
      if (v.node.id === id) return v.node;
      const n = v.children.find((x) => x.id === id) ?? v.outside.find((x) => x.id === id);
      if (n) return n;
    }
    return undefined;
  };

  const open = async (id: string) => {
    const n = find(id);
    if (!n || n.childCount === 0) {
      setSelected(id);
      return;
    }
    try {
      if (!views.has(id)) await load(id);
      setExpanded((s) => new Set(s).add(id));
      setCurrent(id);
      setSelected(id);
      setFocus(undefined);
    } catch (e) {
      setStatus({ state: "error", error: e instanceof Error ? e.message : String(e) });
    }
  };

  const close = (id: string) => {
    setExpanded((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
    const parent = find(id)?.parent;
    if (current === id && parent) setCurrent(parent);
    setFocus(undefined);
  };

  const showFocus = async (id: string) => {
    try {
      setFocus(
        await api<Api.GraphFocusViewT>(`/api/graph/focus/${encodeURIComponent(id)}?lens=${lens}`),
      );
      setSelected(id);
    } catch (e) {
      setStatus({ state: "error", error: e instanceof Error ? e.message : String(e) });
    }
  };

  const rows = useMemo(() => outlineRows(views, "estate", expanded), [views, expanded]);
  const view = views.get(current);
  const picture = useMemo(() => {
    if (focus)
      return canvasView(
        {
          ...focus,
          children: [focus.node, ...focus.neighbours],
          outside: [],
          reduced: true,
          hiddenEdges: 0,
        },
        focus.node.label,
      );
    return view ? canvasView(view, view.node.label) : undefined;
  }, [view, focus]);

  const onKey = (id: string, e: KeyboardEvent) => {
    const step = keyStep(rows, id, e.key);
    if (!step) return;
    e.preventDefault();
    if ("focus" in step) rowRefs.current.get(step.focus)?.focus();
    else if ("open" in step) void open(step.open);
    else if ("close" in step) close(step.close);
    else setSelected(step.select);
  };

  const sel = selected ? find(selected) : undefined;
  const crumbs = view ? [...view.path, view.node] : [];

  return (
    <div className="bento">
      <Panel title={WORDS.title} span="1 / -1">
        <div className="row" style={{ flexWrap: "wrap", gap: 12 }}>
          <div role="tablist" aria-label={WORDS.lens} className="row" style={{ gap: 6 }}>
            {LENSES.map((l) => (
              <button
                key={l}
                type="button"
                role="tab"
                aria-selected={l === lens}
                className={`btn ${l === lens ? "primary" : ""}`}
                onClick={() => setQueryParam("architecture", "lens", l)}
              >
                {WORDS.lenses[l]}
              </button>
            ))}
          </div>
          <nav aria-label={WORDS.breadcrumbs}>
            <ol className="row" style={{ gap: 4, listStyle: "none", margin: 0, padding: 0 }}>
              {crumbs.map((c, i) => (
                <li key={c.id} className="row" style={{ gap: 4 }}>
                  {i > 0 && <span aria-hidden="true">/</span>}
                  <button
                    type="button"
                    className="btn"
                    aria-current={i === crumbs.length - 1 ? "location" : undefined}
                    onClick={() => {
                      setCurrent(c.id);
                      setFocus(undefined);
                    }}
                  >
                    {c.label}
                  </button>
                </li>
              ))}
            </ol>
          </nav>
        </div>
      </Panel>

      {status.state === "loading" && (
        <Panel span="1 / -1">
          <div className="stack" aria-busy="true" aria-live="polite">
            <span className="sr">{WORDS.loading}</span>
            <div className="skeleton" style={{ width: "80%" }} />
            <div className="skeleton" style={{ width: "60%" }} />
          </div>
        </Panel>
      )}
      {status.state === "error" && (
        <Panel span="1 / -1">
          {status.notYet ? (
            <div className="state">{WORDS.emptyEstate}</div>
          ) : (
            <div className="state error" role="alert">
              {WORDS.loadFailed(status.error)}
            </div>
          )}
        </Panel>
      )}

      {status.state === "ready" && view && (
        <>
          <Panel
            title={WORDS.canvas}
            span="1 / span 8"
            meta={WORDS.edges(picture?.edges.length ?? 0, focus ? 0 : view.hiddenEdges)}
          >
            {view.suggest?.mode === "focus" && !focus && view.suggest.id && (
              <p className="row" style={{ gap: 8 }}>
                {WORDS.focusHint}
                <button
                  type="button"
                  className="btn"
                  onClick={() => void showFocus(view.suggest!.id!)}
                >
                  {WORDS.focus}
                </button>
              </p>
            )}
            {view.suggest?.mode === "group" && <p>{WORDS.groupHint}</p>}
            {focus && (
              <button type="button" className="btn" onClick={() => setFocus(undefined)}>
                {WORDS.focusOff}
              </button>
            )}
            {picture && picture.nodes.length ? (
              <FlowCanvas
                key={`${lens}:${current}:${focus?.node.id ?? ""}`}
                view={picture}
                {...(selected ? { selected } : {})}
                onPick={(id) => setSelected(id)}
              />
            ) : (
              <div className="state">{WORDS.empty}</div>
            )}
            <p className="hud" style={{ marginTop: 8 }}>
              {WORDS.canvasNote}
            </p>
          </Panel>

          <Panel title={WORDS.inspector} span="span 4">
            {sel ? (
              <Inspector node={sel} onOpen={open} onFocus={showFocus} lens={lens} />
            ) : (
              <p>{WORDS.pick}</p>
            )}
          </Panel>

          <Panel title={WORDS.outline} span="1 / -1">
            <p className="hud" id="outline-help">
              {WORDS.outlineHelp}
            </p>
            <ul
              role="tree"
              aria-describedby="outline-help"
              style={{ listStyle: "none", padding: 0 }}
            >
              {rows.map((r) => (
                <li
                  key={r.node.id}
                  role="treeitem"
                  aria-level={r.depth + 1}
                  aria-expanded={r.node.childCount > 0 ? r.expanded : undefined}
                  aria-selected={r.node.id === selected}
                  style={{ paddingLeft: r.depth * 18 }}
                >
                  <button
                    type="button"
                    className={`btn ${r.node.id === current ? "primary" : ""}`}
                    ref={(el) => {
                      if (el) rowRefs.current.set(r.node.id, el);
                      else rowRefs.current.delete(r.node.id);
                    }}
                    onKeyDown={(e) => onKey(r.node.id, e)}
                    onClick={() => setSelected(r.node.id)}
                    onDoubleClick={() => void (r.expanded ? close(r.node.id) : open(r.node.id))}
                  >
                    <span className="hud">{r.node.kind}</span> {r.node.label}
                    {r.node.childCount > 0 && ` · ${WORDS.children(r.node.childCount)}`}
                    {r.node.gaps.length > 0 &&
                      ` · ${WORDS.gaps}: ${r.node.gaps.map((g) => WORDS.gap[g] ?? g).join(", ")}`}
                  </button>
                </li>
              ))}
            </ul>
          </Panel>
        </>
      )}
    </div>
  );
}

function Inspector({
  node,
  lens,
  onOpen,
  onFocus,
}: {
  node: Api.HierNodeT;
  lens: Lens;
  onOpen: (id: string) => void;
  onFocus: (id: string) => void;
}) {
  return (
    <div className="stack">
      <h3 className="h">{node.label}</h3>
      <Facts
        rows={[
          [WORDS.kind, node.kind],
          [WORDS.stateLabel, WORDS.state[node.state]],
          ...Object.entries(node.properties).map(
            ([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v)] as [string, string],
          ),
        ]}
      />
      <div className="row" style={{ gap: 6 }}>
        {node.childCount > 0 && (
          <button type="button" className="btn" onClick={() => onOpen(node.id)}>
            {WORDS.open}
          </button>
        )}
        {node.kind !== "estate" && (lens === "data" || node.kind === "table") && (
          <button type="button" className="btn" onClick={() => onFocus(node.id)}>
            {WORDS.focus}
          </button>
        )}
      </div>
      <h4 className="hud">{WORDS.gaps}</h4>
      {node.gaps.length ? (
        <ul>
          {node.gaps.map((g) => (
            <li key={g}>{WORDS.gap[g] ?? g}</li>
          ))}
        </ul>
      ) : (
        <p>{WORDS.noGaps}</p>
      )}
      <h4 className="hud">{WORDS.evidence}</h4>
      {node.evidence.length ? (
        <ul>
          {node.evidence.map((e) => (
            <li key={`${e.repo ?? ""}:${e.at}`} className="mono">
              {e.repo ? `${e.repo}: ` : ""}
              {e.at}
            </li>
          ))}
        </ul>
      ) : (
        <p>{WORDS.noEvidence}</p>
      )}
      {node.next && (
        <>
          <h4 className="hud">{WORDS.next}</h4>
          <p>{node.next.why}</p>
          <div className="row" style={{ gap: 6 }}>
            <code className="mono">{node.next.command}</code>
            <CopyButton text={node.next.command} label={`${WORDS.copy}: ${node.next.command}`} />
          </div>
        </>
      )}
    </div>
  );
}
