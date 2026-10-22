import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Api } from "@maycombhq/core";
import { api, ApiError, useLiveEvents } from "../../api/client.js";
import type { Laid, Point } from "../../app/layout/index.js";
import { Panel } from "../../app/ui.js";
import { queryParam, setQueryParam } from "../know/common.js";
import { CopyButton, Facts } from "../run/shared.js";
import { ArchitectureCanvas } from "./Canvas.js";
import {
  canvasGraph,
  directionFor,
  keyStep,
  legibility,
  openAt,
  outlineRows,
  viewKey,
  type Views,
} from "./model.js";
import { WORDS } from "./words.js";

const LENSES = ["architecture", "repo", "data", "integration", "infrastructure"] as const;
type Lens = (typeof LENSES)[number];

/** GET and PUT /api/graph/layout/{viewKey} (ViewLayoutResult, C4). */
interface KeptLayout {
  view: string;
  saved: boolean;
  path: string;
  positions: Record<string, Point>;
}

type Arrangement =
  | { state: "loading"; key: string }
  | { state: "ready"; key: string; pinned: Record<string, Point>; moved: number }
  | { state: "error"; key: string; error: string };

type Keeping =
  | { state: "idle" }
  | { state: "saving" }
  | { state: "done"; text: string }
  | { state: "error"; text: string };

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
  // A link to one node (#/architecture?node=<id>, ADR 0091), e.g. from @atticus /diagram.
  const nodeParam = queryParam(hash, "node");
  const [views, setViews] = useState<Views>(new Map());
  const [status, setStatus] = useState<Status>({ state: "loading" });
  const [current, setCurrent] = useState("estate");
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["estate"]));
  const [selected, setSelected] = useState<string | undefined>();
  const [focus, setFocus] = useState<Api.GraphFocusViewT | undefined>();
  const [inPlace, setInPlace] = useState<Set<string>>(new Set());
  const [laid, setLaid] = useState<Laid | undefined>();
  const [arrangement, setArrangement] = useState<Arrangement>({ state: "loading", key: "" });
  const [tidy, setTidy] = useState(0);
  const [keeping, setKeeping] = useState<Keeping>({ state: "idle" });
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  const load = useCallback(
    async (id: string, into?: Views) => {
      const v = await api<Api.GraphNodeViewT>(nodePath(id, lens));
      setViews((old) => new Map(into ?? old).set(id, v));
      return v;
    },
    [lens],
  );

  // A new lens starts again from the estate, or from the node a link names.
  useEffect(() => {
    let live = true;
    setStatus({ state: "loading" });
    setCurrent("estate");
    setExpanded(new Set(["estate"]));
    setSelected(undefined);
    setFocus(undefined);
    setInPlace(new Set());
    load("estate", new Map()).then(
      async () => {
        // A node the estate doesn't have leaves the picture on the estate.
        const v =
          nodeParam && nodeParam !== "estate"
            ? await load(nodeParam).catch(() => undefined)
            : undefined;
        if (v && live) {
          const at = openAt(v);
          for (const id of at.expanded)
            if (id !== "estate" && id !== v.node.id) await load(id).catch(() => undefined);
          setExpanded(new Set(at.expanded));
          setCurrent(at.current);
          setSelected(at.selected);
        }
        if (live) setStatus({ state: "ready" });
      },
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
  }, [load, nodeParam]);

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
      setInPlace(new Set());
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
    if (current === id && parent) {
      setCurrent(parent);
      setInPlace(new Set());
    } else closeHere(id);
    setFocus(undefined);
  };

  /** Open a part inside the picture (a group around its children), or close it again. */
  const toggleHere = async (id: string) => {
    if (inPlace.has(id)) return closeHere(id);
    try {
      if (!views.has(id)) await load(id);
      setInPlace((s) => new Set(s).add(id));
      setExpanded((s) => new Set(s).add(id));
      setSelected(id);
    } catch (e) {
      setStatus({ state: "error", error: e instanceof Error ? e.message : String(e) });
    }
  };
  const closeHere = (id: string) =>
    setInPlace((s) => {
      // Closing a part closes what was opened inside it too.
      const next = new Set(s);
      const inside = (x: string): boolean => {
        for (let p = find(x)?.parent; p; p = find(p)?.parent) if (p === id) return true;
        return false;
      };
      for (const x of s) if (x === id || inside(x)) next.delete(x);
      return next;
    });

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
  const graph = useMemo(
    () => canvasGraph(views, current, inPlace, focus),
    [views, current, inPlace, focus],
  );
  const shown = focus ? focus.node.id : current;
  const key = viewKey(lens, shown, focus ? "focus" : "node");

  // A view's kept arrangement, read before the canvas lays it out.
  useEffect(() => {
    let live = true;
    setArrangement({ state: "loading", key });
    setKeeping({ state: "idle" });
    setLaid(undefined);
    api<KeptLayout>(`/api/graph/layout/${encodeURIComponent(key)}`).then(
      (r) => live && setArrangement({ state: "ready", key, pinned: r.positions, moved: 0 }),
      (e: unknown) =>
        live &&
        setArrangement({ state: "error", key, error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [key]);

  const keep = async (positions: Record<string, Point>, done: string) => {
    setKeeping({ state: "saving" });
    try {
      const r = await api<KeptLayout>(`/api/graph/layout/${encodeURIComponent(key)}`, {
        method: "PUT",
        body: { lens, node: shown, positions },
      });
      setArrangement({ state: "ready", key, pinned: r.positions, moved: 0 });
      setKeeping({ state: "done", text: done || WORDS.kept(r.path) });
      return true;
    } catch (e) {
      setKeeping({
        state: "error",
        text: WORDS.keepFailed(e instanceof Error ? e.message : String(e)),
      });
      return false;
    }
  };
  const pinned = arrangement.state === "ready" ? arrangement.pinned : {};
  const notice =
    !focus && view ? legibility(laid?.over ?? [], view.suggest, inPlace, view.children) : undefined;

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
                      if (c.id !== current) setInPlace(new Set());
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
            meta={WORDS.edges(graph.links.length, focus ? 0 : view.hiddenEdges)}
          >
            {notice && (
              <div className="state arch-notice" role="status">
                <p>
                  {notice.why === "nodes"
                    ? WORDS.legible.nodes(laid?.score.nodes ?? 0)
                    : WORDS.legible[notice.why]}{" "}
                  {WORDS.legible[notice.mode]}
                </p>
                {notice.mode === "focus" && (
                  <button type="button" className="btn" onClick={() => void showFocus(notice.id)}>
                    {WORDS.focus}
                  </button>
                )}
                {notice.mode === "collapse" && (
                  <button type="button" className="btn" onClick={() => setInPlace(new Set())}>
                    {WORDS.collapseAll}
                  </button>
                )}
                {notice.mode === "group" && notice.id && (
                  <button type="button" className="btn" onClick={() => void open(notice.id!)}>
                    {WORDS.openPart(find(notice.id)?.label ?? notice.id)}
                  </button>
                )}
              </div>
            )}
            <ArrangementBar
              ready={arrangement.state === "ready"}
              saving={keeping.state === "saving"}
              moved={arrangement.state === "ready" ? arrangement.moved : 0}
              {...(focus ? { onFocusOff: () => setFocus(undefined) } : {})}
              onKeep={() => {
                if (!Object.keys(pinned).length)
                  setKeeping({ state: "error", text: WORDS.keptNothing });
                else void keep(pinned, "");
              }}
              onTidy={() => setTidy((t) => t + 1)}
              onReset={() =>
                void keep({}, WORDS.resetDone).then((ok) => ok && setTidy((t) => t + 1))
              }
            />
            {keeping.state === "done" && (
              <p className="hud" role="status">
                {keeping.text}
              </p>
            )}
            {keeping.state === "error" && (
              <p className="state error" role="alert">
                {keeping.text}
              </p>
            )}
            {!graph.boxes.length ? (
              <div className="state">{WORDS.empty}</div>
            ) : arrangement.state === "error" ? (
              <div className="state error" role="alert">
                {WORDS.loadFailed(arrangement.error)}
              </div>
            ) : arrangement.state === "loading" || arrangement.key !== key ? (
              <div className="stack" aria-busy="true" aria-live="polite">
                <span className="sr">{WORDS.layingOut}</span>
                <div className="skeleton" style={{ width: "70%" }} />
              </div>
            ) : (
              <ArchitectureCanvas
                key={key}
                graph={graph}
                direction={directionFor(lens)}
                pinned={pinned}
                tidy={tidy}
                {...(selected ? { selected } : {})}
                onSelect={(id) => setSelected(id)}
                onToggle={(id) => void toggleHere(id)}
                onMoved={(id, at) =>
                  setArrangement((a) =>
                    a.state === "ready"
                      ? {
                          ...a,
                          pinned: { ...a.pinned, [id]: { x: at.x, y: at.y } },
                          moved: a.moved + (a.pinned[id] ? 0 : 1),
                        }
                      : a,
                  )
                }
                onLaid={setLaid}
              />
            )}
            <p className="hud" style={{ marginTop: 8 }}>
              {WORDS.canvasHelp}
            </p>
          </Panel>

          <Panel title={WORDS.inspector} span="span 4">
            {sel ? (
              <Inspector
                node={sel}
                onOpen={open}
                onFocus={showFocus}
                lens={lens}
                {...(!focus && graph.boxes.some((b) => b.id === sel.id)
                  ? { here: { open: inPlace.has(sel.id), toggle: () => void toggleHere(sel.id) } }
                  : {})}
              />
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
  here,
}: {
  node: Api.HierNodeT;
  lens: Lens;
  onOpen: (id: string) => void;
  onFocus: (id: string) => void;
  /** The box is on the canvas: it can open in place there. */
  here?: { open: boolean; toggle: () => void };
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
        {node.childCount > 0 && here && (
          <button type="button" className="btn" onClick={here.toggle}>
            {here.open ? WORDS.closeHere : WORDS.openHere}
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

/** Keep this arrangement, Tidy up and Reset (ADR 0081): what a person does with the layout. */
export function ArrangementBar(p: {
  ready: boolean;
  saving: boolean;
  moved: number;
  onKeep: () => void;
  onTidy: () => void;
  onReset: () => void;
  onFocusOff?: () => void;
}) {
  return (
    <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
      {p.onFocusOff && (
        <button type="button" className="btn" onClick={p.onFocusOff}>
          {WORDS.focusOff}
        </button>
      )}
      <button
        type="button"
        className="btn primary"
        disabled={!p.ready || p.saving}
        onClick={p.onKeep}
      >
        {p.saving ? WORDS.keeping : WORDS.keep}
      </button>
      <button type="button" className="btn" disabled={!p.ready} onClick={p.onTidy}>
        {WORDS.tidy}
      </button>
      <button type="button" className="btn" disabled={!p.ready || p.saving} onClick={p.onReset}>
        {WORDS.reset}
      </button>
      {p.moved > 0 && <span className="hud">{WORDS.moved(p.moved)}</span>}
    </div>
  );
}
