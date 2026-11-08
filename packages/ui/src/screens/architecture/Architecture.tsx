import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { Api } from "@maycombhq/core";
import { api, ApiError, useApi, useLiveEvents } from "../../api/client.js";
import type { Laid, Point } from "../../app/layout/index.js";
import { Panel } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { queryParam, setQueryParam } from "../know/common.js";
import { systemHash } from "../know/Systems.js";
import { CopyButton, Facts } from "../run/shared.js";
import { ConnectPanel, type BoxChoice } from "./Connect.js";
import { OwnerPanel } from "./Owner.js";
import { AddBoxPanel, BoxCorrections, DeclarePanel } from "./Declare.js";
import { CanvasTools, type ToolsState } from "./Tools.js";
import { OpenCode } from "./OpenCode.js";
import {
  ALL_LAYERS,
  blastRadius,
  compare,
  snapshotOf,
  withFilter,
  withLayers,
  type Snapshot,
} from "./tools.js";
import { RunStep } from "../../app/runstep.js";
import { ArchitectureCanvas, type TypeDraws } from "./Canvas.js";
import { LinkWrong, WhatMoved, WhyLinked } from "./WhyLinked.js";
import { knownTargets, whatMoved } from "./links.js";
import { Citation, EvidenceProvider, useEvidence } from "../../app/evidence.js";
import {
  canvasGraph,
  directionFor,
  evidenceRepos,
  withContractGaps,
  withEvidenceGaps,
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
 * Each box's and link's evidence is looked up in its repo's facts (ADR 0124 addendum D-app, F3):
 * the details panel cites each line with its quote and Correct this, and what lacks a verified
 * fact or has a question open is a gap like any other.
 */
export function Architecture(p: {
  hash: string;
  /** The page it is shown on: Change's Architecture tab, or the Map's estate canvas. */
  screen?: string;
}) {
  return (
    <EvidenceProvider>
      <Workspace {...p} />
    </EvidenceProvider>
  );
}

const NO_FINDINGS: readonly Api.ContractMismatchViewT[] = [];

/**
 * When the canvas asks for the contract check (ADR 0164): once the picture is drawn, never with
 * it. A first check joins the whole estate, and the app's server answers one thing at a time, so
 * asked at once it would hold the picture back; its marks come after.
 */
export const contractsPathWhen = (o: { ready: boolean; drawn: boolean }): string | undefined =>
  o.ready && o.drawn ? "/api/contracts" : undefined;

/** An answer that came after the picture started again: not an error anyone sees. */
class StalePicture extends Error {}

function Workspace({ hash, screen = "architecture" }: { hash: string; screen?: string }) {
  const lensParam = queryParam(hash, "lens");
  const lens: Lens = (LENSES as readonly string[]).includes(lensParam ?? "")
    ? (lensParam as Lens)
    : "architecture";
  // A link to one node (#/architecture?node=<id>, ADR 0091), e.g. from @atticus /diagram.
  const nodeParam = queryParam(hash, "node");
  const [loaded, setViews] = useState<Views>(new Map());
  // F3: the repos' facts, so each box and link says what its evidence lacks.
  const ev = useEvidence();
  const repos = evidenceRepos(loaded).join(" ");
  useEffect(() => {
    for (const r of repos.split(" ").filter(Boolean)) ev?.need(r);
  }, [repos, ev]);
  const [status, setStatus] = useState<Status>({ state: "loading" });
  // One node that couldn't be opened or shown: said beside the picture, which stays drawn.
  const [stepError, setStepError] = useState<string | undefined>();
  const [laid, setLaid] = useState<Laid | undefined>();
  const stepFailed = (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    // Nothing drawn yet: the page's state; otherwise a note beside the picture.
    setStatus((st) => (st.state === "ready" ? st : { state: "error", error: msg }));
    setStepError(msg);
  };
  // ADR 0164: the contract check's findings, each link whose two sides disagree marked; asked
  // for once the picture is first drawn (and kept after), so the picture never waits on it.
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    if (status.state === "ready" && laid) setDrawn(true);
  }, [status.state, laid]);
  const contracts = useApi<Api.ContractsViewT>(
    contractsPathWhen({ ready: status.state === "ready", drawn }),
  );
  const findings = contracts.state === "ready" ? contracts.data.findings : NO_FINDINGS;
  const views = useMemo(
    () =>
      withContractGaps(
        withEvidenceGaps(loaded, (r) => {
          const v = ev?.of(r);
          return v?.state === "ready" ? v.data : undefined;
        }),
        findings,
      ),
    [loaded, ev, findings],
  );
  const [current, setCurrent] = useState("estate");
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["estate"]));
  const [selected, setSelected] = useState<string | undefined>();
  // G1 (ADR 0174): connecting a repo's box to another, call by call.
  const [connecting, setConnecting] = useState<
    { from: string; initial?: Api.LinkBoxT } | undefined
  >();
  // G2 (ADR 0174): setting a repo's owner and system.
  const [owning, setOwning] = useState<string | undefined>();
  // G3 (ADR 0174): declaring a system's link, and adding to the picture.
  const [declaring, setDeclaring] = useState<{ system: string; label: string } | undefined>();
  const [adding, setAdding] = useState(false);
  const [focus, setFocus] = useState<Api.GraphFocusViewT | undefined>();
  const [inPlace, setInPlace] = useState<Set<string>>(new Set());
  const [arrangement, setArrangement] = useState<Arrangement>({ state: "loading", key: "" });
  const [tidy, setTidy] = useState(0);
  const [keeping, setKeeping] = useState<Keeping>({ state: "idle" });
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  // Counts the picture's starts again (a new lens or address): a box opened from before one is
  // left, as its answers belong to the picture before.
  const epoch = useRef(0);
  // C2 (ADR 0135): the calls a person said are wrong here, and the views as they were then.
  const [watched, setWatched] = useState<{ calls: string[]; before: Views } | undefined>();

  const load = useCallback(
    async (id: string, into?: Views) => {
      // An answer from before the picture started again (another lens) is dropped: it would
      // put that lens's boxes on this one.
      const at = epoch.current;
      const v = await api<Api.GraphNodeViewT>(nodePath(id, lens));
      if (at !== epoch.current) throw new StalePicture();
      setViews((old) => new Map(into ?? old).set(id, v));
      return v;
    },
    [lens],
  );

  // A new lens starts again from the estate, or from the node a link names.
  useEffect(() => {
    let live = true;
    epoch.current++;
    // A snapshot is of one picture: another lens or address starts without it.
    setSnapshot(undefined);
    setTools((t) => (t.compareWith ? { ...t, compareWith: undefined } : t));
    setStatus({ state: "loading" });
    // A note about a node of the last picture doesn't hang over this one.
    setStepError(undefined);
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
          // The boxes above it load together, not one after another (G7).
          await Promise.all(
            at.expanded
              .filter((id) => id !== "estate" && id !== v.node.id)
              .map((id) => load(id).catch(() => undefined)),
          );
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

  /** A box anywhere in this lens opened as a link to it opens it, the boxes above it too. */
  const openDeep = async (id: string) => {
    const at0 = epoch.current;
    try {
      const v = await load(id);
      const at = openAt(v);
      await Promise.all(
        at.expanded
          .filter((x) => x !== "estate" && x !== v.node.id)
          .map((x) => load(x).catch(() => undefined)),
      );
      if (epoch.current !== at0) return;
      setExpanded(new Set(at.expanded));
      setCurrent(at.current);
      setSelected(at.selected);
      setFocus(undefined);
      setInPlace(new Set());
    } catch (e) {
      // A box the catalog no longer has leaves the picture where it is; anything else is said.
      if (
        e instanceof StalePicture ||
        epoch.current !== at0 ||
        (e instanceof ApiError && e.problem.status === 404)
      )
        return;
      setStatus({ state: "error", error: e instanceof Error ? e.message : String(e) });
    }
  };

  const open = async (id: string) => {
    const n = find(id);
    if (!n || n.childCount === 0) {
      setSelected(id);
      setStepError(undefined);
      return;
    }
    try {
      if (!views.has(id)) await load(id);
      setExpanded((s) => new Set(s).add(id));
      setCurrent(id);
      setSelected(id);
      setStepError(undefined);
      setFocus(undefined);
      setInPlace(new Set());
    } catch (e) {
      if (e instanceof StalePicture) return;
      stepFailed(e);
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
      setStepError(undefined);
    } catch (e) {
      if (e instanceof StalePicture) return;
      stepFailed(e);
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
      setStepError(undefined);
    } catch (e) {
      stepFailed(e);
    }
  };

  const rows = useMemo(() => outlineRows(views, "estate", expanded), [views, expanded]);
  const view = views.get(current);
  const whole = useMemo(
    () => canvasGraph(views, current, inPlace, focus),
    [views, current, inPlace, focus],
  );
  // G6 (ADR 0175): layers, filter, overlay and compare, on the picture already loaded.
  const [tools, setTools] = useState<ToolsState>({
    layers: ALL_LAYERS,
    mismatches: false,
    filter: "",
    overlay: "none",
  });
  const [snapshot, setSnapshot] = useState<Snapshot | undefined>();
  // ADR 0180: how the organisation's component types are drawn (badge, colour), by id.
  const typeList = useApi<Api.ComponentTypesViewT>("/api/component-types");
  const types = useMemo<TypeDraws | undefined>(
    () =>
      typeList.state === "ready"
        ? Object.fromEntries(
            typeList.data.types.map((t) => [
              t.id,
              {
                name: t.name,
                description: t.description,
                ...(t.draws?.badge ? { badge: t.draws.badge } : {}),
                ...(t.draws?.colour ? { colour: t.draws.colour } : {}),
                ...(t.draws?.shape ? { shape: t.draws.shape } : {}),
              },
            ]),
          )
        : undefined,
    [typeList],
  );
  const openQuestions = useApi<Api.QuestionListT>(
    tools.overlay === "questions" ? "/api/questions?state=open" : undefined,
  );
  const propsOf = useCallback((id: string) => find(id)?.properties, [views, focus]);
  const graph = useMemo(() => {
    let g = withFilter(
      withLayers(whole, tools.layers, {
        ...(tools.mismatches
          ? {
              mismatches: new Set(
                whole.links
                  .filter((l) => l.gaps.some((x) => x === "contract-mismatch"))
                  .map((l) => l.id),
              ),
            }
          : {}),
      }),
      tools.filter,
      propsOf,
    );
    if (tools.compareWith) {
      // Against the whole picture, not what the layers and filter leave: hiding a link isn't
      // losing it. Only the links drawn are marked.
      const c = compare(tools.compareWith, whole);
      const added = new Set(c.added.map((l) => l.id));
      g = {
        ...g,
        links: g.links.map((l) => (added.has(l.id) ? { ...l, mark: "new" as const } : l)),
      };
    }
    if (tools.overlay !== "none") {
      const byRepo =
        openQuestions.state === "ready" ? (openQuestions.data.counts?.byRepo ?? {}) : {};
      g = {
        ...g,
        boxes: g.boxes.map((b) =>
          b.group
            ? b
            : tools.overlay === "gaps"
              ? b.gaps.length
                ? { ...b, badge: { n: b.gaps.length, what: WORDS.gapsBadge(b.gaps.length) } }
                : b
              : b.kind === "repo" && openQuestions.state === "ready" && byRepo[b.label]?.open
                ? {
                    ...b,
                    badge: {
                      n: byRepo[b.label]!.open,
                      what: COPY.canvasTools.questionsBadge(byRepo[b.label]!.open),
                    },
                  }
                : b,
        ),
      };
    }
    return g;
  }, [whole, tools, propsOf, openQuestions]);
  const radius = useMemo(
    () =>
      tools.radius && selected
        ? new Set(blastRadius(graph.links, selected, tools.radius.depth, tools.radius.dir).keys())
        : undefined,
    [tools.radius, selected, graph.links],
  );
  const shown = focus ? focus.node.id : current;
  // A snapshot is of one view of the picture: another box opened is another set of links.
  const shownKey = `${shown}|${focus ? "f" : "n"}`;
  const snapshotView = useRef(shownKey);
  useEffect(() => {
    if (snapshotView.current === shownKey) return;
    snapshotView.current = shownKey;
    setSnapshot(undefined);
    setTools((t) => (t.compareWith ? { ...t, compareWith: undefined } : t));
  }, [shownKey]);
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
  const boxes = connectChoices(views);
  const known = knownTargets(loaded);
  const moved = watched ? whatMoved(watched.before, loaded, watched.calls) : [];
  const under = (j: Api.HierJoinT) => (
    <LinkWrong
      join={j}
      known={known}
      onSaved={(call) =>
        setWatched((w) => ({
          calls: [...new Set([...(w?.calls ?? []), call])],
          before: w?.before ?? loaded,
        }))
      }
    />
  );
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
                onClick={() => setQueryParam(screen, "lens", l, { drop: ["node"] })}
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
                  {/* Where you are is no button: clicking it would do nothing. */}
                  {i === crumbs.length - 1 && !focus ? (
                    <span className="chip" aria-current="location">
                      {c.label}
                    </span>
                  ) : (
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
                  )}
                </li>
              ))}
            </ol>
          </nav>
        </div>
      </Panel>

      {status.state === "loading" && (
        <Panel span="1 / -1">
          <div className="stack" aria-busy="true" aria-live="polite">
            <p className="hud">{WORDS.readingEstate}</p>
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

      {status.state === "ready" && stepError && (
        <div className="state error" role="alert" style={{ marginBottom: 8 }}>
          {WORDS.stepFailed(stepError)}{" "}
          <button type="button" className="link" onClick={() => setStepError(undefined)}>
            {WORDS.dismiss}
          </button>
        </div>
      )}
      {status.state === "ready" && view && (
        <>
          <Panel
            title={WORDS.canvas}
            span="1 / -1"
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
            {/* The contract check after the picture: what it is doing, or why it couldn't. */}
            {drawn && contracts.state === "loading" && (
              <p className="hud" role="status" aria-live="polite">
                {WORDS.joiningEstate}
              </p>
            )}
            {contracts.state === "error" && (
              <p className="hud" role="status">
                {WORDS.contractsFailed(contracts.error)}
              </p>
            )}
            {graph.shared && graph.shared.length > 0 && (
              <p className="arch-shared">
                <span aria-hidden="true">⚠ </span>
                {WORDS.sharedGaps(graph.shared.map((g) => WORDS.gap[g] ?? g).join("; "))}
              </p>
            )}
            <div className="row" style={{ gap: 8 }}>
              <button type="button" className="btn" onClick={() => setAdding(true)}>
                {COPY.addBox.open}
              </button>
            </div>
            <CanvasTools
              graph={graph}
              {...(types ? { types } : {})}
              allBoxes={whole.boxes.length}
              state={tools}
              onChange={setTools}
              {...(selected ? { selected } : {})}
              onSelect={setSelected}
              labelOf={(id) => find(id)?.label ?? id}
              placed={(id) => laid?.boxes[id]}
              lens={lens}
              node={shown}
              {...(tools.overlay === "questions" && openQuestions.state !== "ready"
                ? {
                    overlayNote:
                      openQuestions.state === "error"
                        ? COPY.canvasTools.overlayFailed(openQuestions.error)
                        : COPY.canvasTools.overlayLoading,
                  }
                : {})}
              onOpenView={(l, n) => {
                // Another lens is another picture (the address); in this one, the box is opened.
                if (l !== lens) {
                  const q = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
                  q.set("lens", l);
                  q.set("node", n);
                  window.location.hash = `#/${screen}?${q.toString()}`;
                } else void openDeep(n);
              }}
              {...(tools.compareWith
                ? (() => {
                    const c = compare(tools.compareWith, whole);
                    return { compared: { added: c.added.length, removed: c.removed } };
                  })()
                : {})}
              {...(snapshot ? { snapshot } : {})}
              onSnapshot={() => {
                const snap = snapshotOf(whole, new Date().toLocaleTimeString());
                setSnapshot(snap);
                // Compare, when on, is against the newest snapshot.
                setTools((t) => (t.compareWith ? { ...t, compareWith: snap } : t));
              }}
              name={key}
            />
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
                <p className="hud">{WORDS.layingOutBoxes(graph.boxes.length)}</p>
                <div className="skeleton" style={{ width: "70%" }} />
              </div>
            ) : (
              <ArchitectureCanvas
                key={key}
                graph={graph}
                {...(types ? { types } : {})}
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
                {...(radius ? { lit: radius } : {})}
                onConnect={(a, b) => {
                  // A line is drawn from a repo (or its component) to another box; drawn the
                  // other way round from a system, the ends swap; within one repo, nothing.
                  let from = boxOf(find(a));
                  let to = boxOf(find(b));
                  if (from && !from.repo && to?.repo) [from, to] = [to, from];
                  if (!from?.repo || !to) return;
                  if (to.repo === from.repo) return;
                  setConnecting({ from: from.repo, initial: to });
                }}
                aside={
                  <div className="stack">
                    <h2 className="h">{WORDS.inspector}</h2>
                    {sel ? (
                      <Inspector
                        node={sel}
                        isCurrent={sel.id === current}
                        onOpen={open}
                        onFocus={showFocus}
                        lens={lens}
                        links={(focus?.edges ?? view.edges).filter(
                          (e) => e.from === sel.id || e.to === sel.id,
                        )}
                        labelOf={(id) => find(id)?.label ?? id}
                        under={under}
                        contracts={findings}
                        {...(boxOf(sel)?.repo
                          ? {
                              onConnect: () => setConnecting({ from: boxOf(sel)!.repo! }),
                              onOwner: () => setOwning(boxOf(sel)!.repo!),
                            }
                          : boxOf(sel)?.system
                            ? {
                                onDeclare: () =>
                                  setDeclaring({ system: boxOf(sel)!.system!, label: sel.label }),
                              }
                            : {})}
                        {...(!focus && graph.boxes.some((b) => b.id === sel.id)
                          ? {
                              here: {
                                open: inPlace.has(sel.id),
                                toggle: () => void toggleHere(sel.id),
                              },
                            }
                          : {})}
                      />
                    ) : (
                      <p>{WORDS.pick}</p>
                    )}
                    {connecting && (
                      <ConnectPanel
                        key={`${connecting.from}:${connecting.initial?.repo ?? connecting.initial?.system ?? ""}`}
                        from={connecting.from}
                        boxes={boxes.filter((b) => b.box.repo !== connecting.from)}
                        {...(connecting.initial ? { initial: connecting.initial } : {})}
                        onClose={() => setConnecting(undefined)}
                      />
                    )}
                    {declaring && (
                      <DeclarePanel
                        key={declaring.system}
                        system={declaring.system}
                        label={declaring.label}
                        onClose={() => setDeclaring(undefined)}
                      />
                    )}
                    {adding && <AddBoxPanel onClose={() => setAdding(false)} />}
                    {owning && (
                      <OwnerPanel key={owning} repo={owning} onClose={() => setOwning(undefined)} />
                    )}
                    {watched && <WhatMoved moved={moved} />}
                  </div>
                }
              />
            )}
            <p className="hud" style={{ marginTop: 8 }}>
              {WORDS.canvasHelp}
            </p>
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
                    {r.gaps.length > 0 &&
                      ` · ${WORDS.gaps}: ${r.gaps.map((g) => WORDS.gap[g] ?? g).join(", ")}`}
                    {r.inside.length > 0 &&
                      ` · ${WORDS.insideGaps(r.inside.map((g) => WORDS.gap[g] ?? g).join(", "))}`}
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

/** G1 (ADR 0174): the repo or outside system a box stands for, when it stands for one. */
export function boxOf(n: Api.HierNodeT | undefined): Api.LinkBoxT | undefined {
  if (!n) return undefined;
  if (n.kind === "repo") return { repo: n.label };
  if (n.kind === "component" && typeof n.properties.repo === "string")
    return { repo: n.properties.repo };
  if (n.kind === "system" && n.id.startsWith("system:")) return { system: n.id.slice(7) };
  return undefined;
}

/** Every repo and system box of the views loaded, once each, for the Connect to… list. */
export function connectChoices(views: Views): BoxChoice[] {
  const seen = new Map<string, BoxChoice>();
  for (const v of views.values())
    for (const n of [v.node, ...v.children]) {
      if (n.kind !== "repo" && n.kind !== "system") continue;
      const b = boxOf(n);
      if (!b) continue;
      const k = b.repo ? `r:${b.repo}` : `s:${b.system}`;
      if (!seen.has(k))
        seen.set(k, { label: `${WORDS.kindWord[n.kind] ?? n.kind}: ${n.label}`, box: b });
    }
  return [...seen.values()].sort((x, y) => (x.label < y.label ? -1 : 1));
}

export function Inspector({
  node,
  isCurrent,
  lens,
  onOpen,
  onFocus,
  here,
  links = [],
  labelOf = (id) => id,
  under,
  contracts,
  onConnect,
  onOwner,
  onDeclare,
}: {
  /** G3 (ADR 0174): declare a link of this system the code can't show. */
  onDeclare?: () => void;
  /** G1 (ADR 0174): connect this box to another, call by call. */
  onConnect?: () => void;
  /** G2 (ADR 0174): set the repo's owner and system. */
  onOwner?: () => void;
  /** What to show under each call of a link (This link is wrong, C2). */
  under?: (join: Api.HierJoinT) => ReactNode;
  /** ADR 0164: the contract check's findings, each call's shown under it. */
  contracts?: readonly Api.ContractMismatchViewT[];
  node: Api.HierNodeT;
  /** The links in the view that start or end on the box, each with its evidence (F3). */
  links?: Api.HierEdgeT[];
  labelOf?: (id: string) => string;
  /** The box is the one the canvas shows already: Open would do nothing. */
  isCurrent?: boolean;
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
        {node.childCount > 0 && !isCurrent && (
          <button type="button" className="btn" onClick={() => onOpen(node.id)}>
            {WORDS.open}
          </button>
        )}
        {node.childCount > 0 && here && (
          <button type="button" className="btn" onClick={here.toggle}>
            {here.open ? WORDS.closeHere : WORDS.openHere}
          </button>
        )}
        {node.kind === "repo" && (
          <a className="btn" href={`#/flows?repo=${encodeURIComponent(node.label)}`}>
            {COPY.flows.openFlows}
          </a>
        )}
        {node.kind === "repo" && (
          <a className="btn" href="#/trust">
            {WORDS.repoCounts}
          </a>
        )}
        {onConnect && (
          <button type="button" className="btn" onClick={onConnect}>
            {COPY.connect.open}
          </button>
        )}
        {onOwner && (
          <button type="button" className="btn" onClick={onOwner}>
            {COPY.owner.open}
          </button>
        )}
        {onDeclare && (
          <button type="button" className="btn" onClick={onDeclare}>
            {COPY.declare.open}
          </button>
        )}
        {/* WP7.7: a system's page, its guide, questions and changes. */}
        {/* Only a System record has a page: a system the manifest or a call names has none yet. */}
        {node.kind === "system" && node.id.startsWith("system:") && node.record && (
          <a className="btn" href={systemHash(node.id.slice("system:".length))}>
            {COPY.systems.openPage}
          </a>
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
            <li key={g}>
              {WORDS.gap[g] ?? g}
              {WORDS.gapFix[g] && <span className="hud"> · {WORDS.gapFix[g]}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p>{WORDS.noGaps}</p>
      )}
      {boxOf(node) && <BoxCorrections key={node.id} box={boxOf(node)!} />}
      <h4 className="hud">{WORDS.evidence}</h4>
      {node.evidence.length ? (
        <ul>
          {node.evidence.map((e) => (
            <li key={`${e.repo ?? ""}:${e.at}`}>
              {e.repo && <span className="mono">{e.repo}: </span>}
              <Citation repo={e.repo} at={e.at} />
              {e.repo && <OpenCode repo={e.repo} at={e.at} />}
            </li>
          ))}
        </ul>
      ) : (
        <p>{WORDS.noEvidence}</p>
      )}
      <h4 className="hud">{COPY.evidence.links}</h4>
      {links.length ? (
        <ul>
          {links.map((l) => (
            <li key={l.id}>
              {COPY.evidence.linkOf(labelOf(l.from), labelOf(l.to), l.type)}
              {l.gaps.length > 0 &&
                ` · ${WORDS.gaps}: ${l.gaps.map((g) => WORDS.gap[g] ?? g).join(", ")}`}
              {l.joins?.length ? (
                // ADR 0135, C1: each call on the link, how it was joined and its lines.
                <details>
                  <summary>
                    {COPY.why.openOf(COPY.evidence.linkOf(labelOf(l.from), labelOf(l.to), l.type))}
                  </summary>
                  <WhyLinked
                    link={l}
                    {...(under ? { under } : {})}
                    {...(contracts ? { contracts } : {})}
                  />
                </details>
              ) : (
                l.evidence.length > 0 && (
                  <ul>
                    {l.evidence.map((e) => (
                      <li key={`${e.repo ?? ""}:${e.at}`}>
                        {e.repo && <span className="mono">{e.repo}: </span>}
                        <Citation repo={e.repo} at={e.at} />
                      </li>
                    ))}
                  </ul>
                )
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p>{COPY.evidence.noLinks}</p>
      )}
      {node.next && (
        <>
          <h4 className="hud">{WORDS.next}</h4>
          <p>{node.next.why}</p>
          <div className="row" style={{ gap: 6 }}>
            <code className="mono">{node.next.command}</code>
            <CopyButton text={node.next.command} label={`${WORDS.copy}: ${node.next.command}`} />
          </div>
          <RunStep command={node.next.command} />
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
  // Reset drops the kept arrangement for everyone: a second click says so first.
  const [confirmReset, setConfirmReset] = useState(false);
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
      {confirmReset ? (
        <>
          <span className="hud" role="status">
            {WORDS.resetAsk}
          </span>
          <button
            type="button"
            className="btn danger"
            disabled={!p.ready || p.saving}
            onClick={() => {
              setConfirmReset(false);
              p.onReset();
            }}
          >
            {WORDS.resetYes}
          </button>
          <button type="button" className="btn" onClick={() => setConfirmReset(false)}>
            {WORDS.resetNo}
          </button>
        </>
      ) : (
        <button
          type="button"
          className="btn"
          disabled={!p.ready || p.saving}
          onClick={() => setConfirmReset(true)}
        >
          {WORDS.reset}
        </button>
      )}
      {p.moved > 0 && <span className="hud">{WORDS.moved(p.moved)}</span>}
    </div>
  );
}
