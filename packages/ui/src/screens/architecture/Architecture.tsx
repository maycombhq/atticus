import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { Api } from "@maycombhq/core";
import { api, ApiError, useApi, useLiveEvents } from "../../api/client.js";
import { latestCall } from "../../api/latest.js";
import type { Laid, Point } from "../../app/layout/index.js";
import { Panel } from "../../app/ui.js";
import { COPY } from "../../copy.js";
import { CatalogEmpty } from "../../app/app-step.js";
import { queryParam, setQueryParam } from "../know/common.js";
import { systemHash } from "../know/Systems.js";
import { CopyButton, Facts } from "../run/shared.js";
import { ConnectPanel, type BoxChoice } from "./Connect.js";
import { OwnerPanel } from "./Owner.js";
import { AddBoxPanel, BoxCorrections, DeclarePanel } from "./Declare.js";
import { CanvasTools, type ToolsState } from "./Tools.js";
import { CanvasLegend, IconButton, MapBar } from "./MapBar.js";
import { OpenCode } from "./OpenCode.js";
import {
  ALL_LAYERS,
  blastRadius,
  compare,
  isOnlyAi,
  snapshotOf,
  withFilter,
  withLayers,
  type Snapshot,
} from "./canvas-tools.js";
import { RunStep } from "../../app/runstep.js";
import { ArchitectureCanvas, type TypeDraws } from "./Canvas.js";
import { ArrowWrong, LinkInspector, LinkWrong, WhatMoved, WhyLinked } from "./WhyLinked.js";
import { DeleteLink, DeletedLinks } from "./DeleteLink.js";
import { ResultsInPanel } from "../../app/propose.js";
import {
  AddLinkForm,
  EditMap,
  EditMapToggle,
  StageLink,
  type FromChoice,
  type ToChoice,
} from "./EditMap.js";
import {
  stage,
  stagedOf,
  STAGED_LINK,
  unstage,
  withStaged,
  type Staged,
  type StagedDelete,
} from "./edit-map.js";
import { knownTargets, whatMoved } from "./links.js";
import { EveryDependency } from "./EveryDependency.js";
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
  linkTypeWord,
  type Views,
} from "./model.js";
import { WORDS } from "./words.js";
import { flash } from "../../app/flash.js";
import { CorrectionsToApply } from "../../app/propose.js";
import "./box-panel.css";

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

/**
 * What opens the details again when it changes: a panel asked for (Add, Connect, Declare,
 * Owner), a link picked, and (beta.26 review) a box the person picked, never one the address
 * or a load selected.
 */
export function revealOf(o: {
  adding: boolean;
  connecting: { from: string } | undefined;
  declaring: { system: string } | undefined;
  owning: string | undefined;
  pickedLink: { id: string } | undefined;
  pickedBox: string | undefined;
  /** Beta.28: Edit the map turned on (its list is in the details). */
  editing?: boolean;
}): string {
  return [
    o.adding ? "add" : "",
    o.editing ? "edit" : "",
    o.pickedBox ? `box:${o.pickedBox}` : "",
    o.connecting?.from ?? "",
    o.declaring?.system ?? "",
    o.owning ?? "",
    o.pickedLink?.id ?? "",
  ]
    .filter(Boolean)
    .join("|");
}

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
  // Beta.26 review: the box the person picked (the canvas, the outline, the tools), which opens
  // the details again; a box the address or a load selects doesn't.
  const [pickedBox, setPickedBox] = useState<string | undefined>();
  const pick = (id: string) => {
    setSelected(id);
    setPickedBox(id);
  };
  // G1 (ADR 0174): connecting a repo's box to another, call by call.
  const [connecting, setConnecting] = useState<{ from: string; initial?: BoxChoice } | undefined>();
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
  // ADR 0181: the link picked (clicked, or from the Detected by AI list: the keyboard's way), and
  // what was said after a correction of the AI's pairing.
  const [pickedLink, setPickedLink] = useState<{ id: string; keyboard: boolean } | undefined>();
  // Beta.28: the link just deleted from its panel (what the panel says once it left the picture).
  const [deletedLink, setDeletedLink] = useState<
    { link: string; from: string; to: string; interfaces: ReadonlySet<string> } | undefined
  >();
  const [corrected, setCorrected] = useState(false);
  // Beta.28, Edit the map: on or off, the changes staged (kept while it is off, until applied or
  // removed), and the arrow a redirect is said for.
  const [editing, setEditing] = useState(false);
  const [staged, setStaged] = useState<Staged[]>([]);
  const [redirecting, setRedirecting] = useState<StagedDelete | undefined>();
  // Review round 46: a focus answer counts only if it is the newest asked, in this picture.
  const focusCall = useRef(latestCall()).current;
  const dropFocus = () => {
    focusCall.drop();
    setFocus(undefined);
  };

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
    setPickedBox(undefined);
    setPickedLink(undefined);
    setCorrected(false);
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
  const reloadViews = () => {
    for (const id of views.keys()) void load(id).catch(() => undefined);
  };
  useLiveEvents((e) => {
    if (e.type !== "file.changed" || typeof e.path !== "string") return;
    if (!e.path.startsWith("catalog")) return;
    reloadViews();
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
      dropFocus();
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
      dropFocus();
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
    dropFocus();
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
    const at0 = epoch.current;
    const newest = focusCall.start();
    // An answer for another lens, or older than the last ask (or a move since), is dropped.
    const stillAsked = () => newest() && epoch.current === at0;
    try {
      const f = await api<Api.GraphFocusViewT>(
        `/api/graph/focus/${encodeURIComponent(id)}?lens=${lens}`,
      );
      if (!stillAsked()) return;
      setFocus(f);
      setSelected(id);
      setStepError(undefined);
    } catch (e) {
      if (!stillAsked()) return;
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
  // Beta.26: the map's bar. The tools' drawer, its button (focus comes back to it), and the place
  // at the bar's right where the canvas puts its own controls.
  const uid = useId();
  const [toolsOpen, setToolsOpen] = useState(false);
  const toolsButton = useRef<HTMLButtonElement | null>(null);
  const [viewSlot, setViewSlot] = useState<HTMLDivElement | null>(null);
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
    // Beta.28, Edit the map: the changes staged, drawn on the picture until applied.
    if (staged.length) g = withStaged(g, staged);
    return g;
  }, [whole, tools, propsOf, openQuestions, staged]);
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
    else pick(step.select);
  };

  const sel = selected ? find(selected) : undefined;
  // ADR 0181: the picked link as the views have it now (undefined once it left the picture).
  const pickedEdge = pickedLink
    ? [...(focus?.edges ?? []), ...[...views.values()].flatMap((v) => v.edges)].find(
        (e) => e.id === pickedLink.id,
      )
    : undefined;
  const boxes = connectChoices(views);
  // Beta.28, Edit the map: the systems a link can be added from (Declare a link…'s), and the
  // boxes a staged add can be drawn to.
  const { fromChoices, toChoices } = editChoices(views);
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
  // Beta.24: one correction for every call on the arrow, above its calls.
  // Review of beta.24: every call on it, from the view the edge is drawn from (a view lists 20).
  const callsPath = (l: Api.HierEdgeT): string | undefined => {
    const e = encodeURIComponent(l.id);
    if (focus?.edges.some((x) => x.id === l.id))
      return `/api/graph/edge-calls?focus=${encodeURIComponent(focus.node.id)}&lens=${lens}&edge=${e}`;
    for (const v of views.values())
      if (v.edges.some((x) => x.id === l.id))
        return `/api/graph/edge-calls?node=${encodeURIComponent(v.node.id)}&lens=${lens}&edge=${e}`;
    return undefined;
  };
  // ADR 0192: a build dependency has no calls to correct at once: each is corrected under it.
  // Beta.25: an arrow merged from more than its view lists reads the rest, each with its form.
  const above = (l: Api.HierEdgeT) =>
    l.type === "depends-on" ? (
      l.count > (l.joins?.length ?? 0) && callsPath(l) ? (
        <EveryDependency link={l} path={callsPath(l)!} under={under} />
      ) : null
    ) : (
      <ArrowWrong
        link={l}
        known={known}
        labelOf={(id) => find(id)?.label ?? id}
        {...(callsPath(l) ? { callsPath: callsPath(l)! } : {})}
        onSaved={(calls) =>
          setWatched((w) => ({
            calls: [...new Set([...(w?.calls ?? []), ...calls])],
            before: w?.before ?? loaded,
          }))
        }
      />
    );
  const crumbs = view ? [...view.path, view.node] : [];
  // Beta.26: the canvas is drawn (not loading, failing or empty): the tools lie over it.
  const canvasShown =
    status.state === "ready" &&
    !!view &&
    graph.boxes.length > 0 &&
    arrangement.state === "ready" &&
    arrangement.key === key;
  const reveal = revealOf({
    adding,
    connecting,
    declaring,
    owning,
    pickedLink,
    pickedBox,
    editing,
  });

  return (
    <div className="bento">
      {/* Corrections drawn here and not yet applied: Apply for them all, on the map itself. */}
      <CorrectionsToApply />
      {/* Beta.26: one panel, the canvas taking most of it: one slim bar of controls above it,
          the tools a drawer over it, the legend in its corner, the details beside it. */}
      <section
        className="panel arch-work"
        aria-labelledby={`${uid}-h`}
        style={{ gridColumn: "1 / -1" }}
      >
        <h2 id={`${uid}-h`} className="sr">
          {WORDS.title}
        </h2>
        <MapBar
          lenses={LENSES.map((l) => ({ id: l, label: WORDS.lenses[l] }))}
          lens={lens}
          onLens={(l) => setQueryParam(screen, "lens", l, { drop: ["node"] })}
          crumbs={
            <nav aria-label={WORDS.breadcrumbs} className="arch-crumbs">
              <ol>
                {crumbs.map((c, i) => (
                  <li key={c.id}>
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
                          dropFocus();
                        }}
                      >
                        {c.label}
                      </button>
                    )}
                  </li>
                ))}
              </ol>
            </nav>
          }
          onAdd={() => setAdding(true)}
          edit={
            <EditMapToggle
              on={editing}
              count={staged.length}
              onToggle={() => {
                setEditing((on) => !on);
                setRedirecting(undefined);
              }}
            />
          }
          tools={{
            open: toolsOpen,
            bodyId: `${uid}-tools`,
            onToggle: () => setToolsOpen((o) => !o),
            shown: graph.boxes.length,
            all: whole.boxes.length,
            buttonRef: toolsButton,
          }}
          {...(status.state === "ready" && view
            ? {
                arrangement: (
                  <ArrangementBar
                    ready={arrangement.state === "ready"}
                    saving={keeping.state === "saving"}
                    moved={arrangement.state === "ready" ? arrangement.moved : 0}
                    {...(focus ? { onFocusOff: () => dropFocus() } : {})}
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
                ),
              }
            : {})}
          status={
            <>
              {/* The contract check after the picture: what it is doing, or why it couldn't. */}
              {drawn && contracts.state === "loading" && (
                <span className="hud" role="status" aria-live="polite">
                  {WORDS.joiningEstate}
                </span>
              )}
              {contracts.state === "error" && (
                <span className="hud" role="status">
                  {WORDS.contractsFailed(contracts.error)}
                </span>
              )}
              {keeping.state === "done" && (
                <span className="hud" role="status">
                  {keeping.text}
                </span>
              )}
            </>
          }
          viewSlot={setViewSlot}
        />

        {status.state === "loading" && (
          <div className="stack" aria-busy="true" aria-live="polite">
            <p className="hud">{WORDS.readingEstate}</p>
            <div className="skeleton" style={{ width: "80%" }} />
            <div className="skeleton" style={{ width: "60%" }} />
          </div>
        )}
        {status.state === "error" &&
          (status.notYet ? (
            <CatalogEmpty text={WORDS.emptyEstate} />
          ) : (
            <div className="state error" role="alert">
              {WORDS.loadFailed(status.error)}
            </div>
          ))}

        {status.state === "ready" && stepError && (
          <div className="state error" role="alert" style={{ marginBottom: 8 }}>
            {WORDS.stepFailed(stepError)}{" "}
            <button type="button" className="link" onClick={() => setStepError(undefined)}>
              {WORDS.dismiss}
            </button>
          </div>
        )}
        {keeping.state === "error" && (
          <p className="state error" role="alert">
            {keeping.text}
          </p>
        )}
        {status.state === "ready" && view && (
          <>
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
            {graph.shared && graph.shared.length > 0 && (
              <p className="arch-shared">
                <span aria-hidden="true">⚠ </span>
                {WORDS.sharedGaps(graph.shared.map((g) => WORDS.gap[g] ?? g).join("; "))}
              </p>
            )}
            {isOnlyAi(tools.layers) && !graph.links.length && graph.boxes.length > 0 && (
              <p className="state" role="status">
                {COPY.canvasAi.noneOnly}
              </p>
            )}
            {/* Said once a correction of the AI's pairing is saved and the picture read again. */}
            <p className="sr" role="status" aria-live="polite">
              {corrected ? COPY.canvasAi.corrected : ""}
            </p>
            {/* The tools' drawer stays put while the picture comes and goes (a filter that leaves
                nothing): over the canvas while it is drawn, in the page's flow otherwise. */}
            <div className={`arch-stage-wrap${canvasShown ? "" : " flat"}`}>
              <CanvasTools
                drawer={{
                  open: toolsOpen,
                  bodyId: `${uid}-tools`,
                  onClose: () => {
                    setToolsOpen(false);
                    toolsButton.current?.focus();
                  },
                }}
                graph={graph}
                {...(types ? { types } : {})}
                allBoxes={whole.boxes.length}
                state={tools}
                onChange={setTools}
                {...(selected ? { selected } : {})}
                onSelect={pick}
                onPickLink={(id) => {
                  setPickedLink({ id, keyboard: true });
                  setCorrected(false);
                }}
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
                onLinkBack={reloadViews}
                onSnapshot={() => {
                  const snap = snapshotOf(whole, new Date().toLocaleTimeString());
                  setSnapshot(snap);
                  // Compare, when on, is against the newest snapshot.
                  setTools((t) => (t.compareWith ? { ...t, compareWith: snap } : t));
                }}
                name={key}
              />
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
                  onSelect={pick}
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
                  onSelectLink={(id) => {
                    // Beta.28: a staged add is drawn, not yet a link of the catalog.
                    if (id.startsWith(STAGED_LINK)) return;
                    setPickedLink({ id, keyboard: false });
                    setCorrected(false);
                  }}
                  {...(pickedLink ? { selectedLink: pickedLink.id } : {})}
                  onConnect={(a, b) => {
                    const c = connectDrawn(find(a), find(b));
                    // Said, not silently dropped: why a line connects nothing.
                    if ("say" in c) return flash({ text: c.say });
                    setConnecting(c);
                  }}
                  aside={
                    // Beta.28: results here are one line and one button; the rest full width.
                    <ResultsInPanel.Provider value={true}>
                      <div className="stack">
                        <h2 className="h">{WORDS.inspector}</h2>
                        {editing && (
                          <EditMap
                            staged={staged}
                            onRemove={(k) => setStaged((l) => unstage(l, k))}
                            onApplied={() => {
                              setStaged([]);
                              setRedirecting(undefined);
                              reloadViews();
                            }}
                            add={
                              <AddLinkForm
                                key={redirecting?.link ?? "add"}
                                systems={fromChoices}
                                targets={toChoices}
                                staged={staged}
                                {...(redirecting
                                  ? {
                                      redirect: redirecting,
                                      onCancel: () => setRedirecting(undefined),
                                    }
                                  : {})}
                                onStage={(x) => {
                                  setStaged((l) => stage(l, x));
                                  setRedirecting(undefined);
                                }}
                              />
                            }
                          />
                        )}
                        {pickedLink && (
                          <LinkInspector
                            key={pickedLink.id}
                            link={pickedEdge}
                            labelOf={(id) => find(id)?.label ?? id}
                            under={under}
                            above={above}
                            contracts={findings}
                            autoFocus={pickedLink.keyboard}
                            deleteLink={(l) =>
                              editing ? (
                                <StageLink
                                  link={l}
                                  fromRepo={boxOf(find(l.from))?.repo}
                                  from={find(l.from)?.label ?? l.from}
                                  to={find(l.to)?.label ?? l.to}
                                  {...(callsPath(l) ? { callsPath: callsPath(l)! } : {})}
                                  staged={stagedOf(staged, l.id)}
                                  onStage={(x) => setStaged((list) => stage(list, x))}
                                  onRedirect={setRedirecting}
                                  onUnstage={(k) => setStaged((list) => unstage(list, k))}
                                />
                              ) : (
                                <DeleteLink
                                  link={l}
                                  from={find(l.from)?.label ?? l.from}
                                  to={find(l.to)?.label ?? l.to}
                                  {...(callsPath(l) ? { callsPath: callsPath(l)! } : {})}
                                  onDeleted={(d) => {
                                    setDeletedLink({
                                      link: l.id,
                                      from: d.from,
                                      to: d.to,
                                      interfaces: new Set(d.interfaces),
                                    });
                                    reloadViews();
                                  }}
                                />
                              )
                            }
                            {...(deletedLink?.link === pickedLink.id
                              ? {
                                  gone: (
                                    <div className="stack">
                                      <p className="state" role="status">
                                        {COPY.deleteLink.done(deletedLink.from, deletedLink.to)}
                                      </p>
                                      <DeletedLinks
                                        only={deletedLink.interfaces}
                                        onBack={reloadViews}
                                      />
                                    </div>
                                  ),
                                }
                              : {})}
                            onClose={() => setPickedLink(undefined)}
                            onCorrected={() => {
                              // The decisions reload themselves; the picture is read again here.
                              reloadViews();
                              setCorrected(true);
                            }}
                          />
                        )}
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
                            above={above}
                            contracts={findings}
                            {...(boxOf(sel)?.repo
                              ? {
                                  onConnect: () => setConnecting({ from: boxOf(sel)!.repo! }),
                                  onOwner: () => setOwning(boxOf(sel)!.repo!),
                                }
                              : boxOf(sel)?.system
                                ? {
                                    onDeclare: () =>
                                      setDeclaring({
                                        system: boxOf(sel)!.system!,
                                        label: sel.label,
                                      }),
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
                            key={`${connecting.from}:${connecting.initial?.box.repo ?? connecting.initial?.box.system ?? ""}`}
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
                          <OwnerPanel
                            key={owning}
                            repo={owning}
                            onClose={() => setOwning(undefined)}
                          />
                        )}
                        {watched && <WhatMoved moved={moved} />}
                      </div>
                    </ResultsInPanel.Provider>
                  }
                  asideBeside
                  reveal={reveal}
                  asideIdle={!reveal && !selected}
                  toolbarIn={viewSlot}
                  overlay={
                    // ADR 0181: the links drawn, from code, by a person and by AI, and how each
                    // looks: in the canvas's corner, folding.
                    <CanvasLegend
                      meta={WORDS.edges(graph.links.length, focus ? 0 : view.hiddenEdges)}
                      links={graph.links}
                    />
                  }
                />
              )}
            </div>
            <p className="hud" style={{ marginTop: 8 }}>
              {WORDS.canvasHelp}
            </p>
          </>
        )}
      </section>

      {status.state === "ready" && view && (
        <>
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
                    onClick={() => pick(r.node.id)}
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

/** A system box of a system outside the estate (one no estate repo is in): a vendor's, a team's. */
const outsideSystem = (n: Api.HierNodeT) => {
  const repos = n.properties.repos;
  const boundary = n.properties.boundary;
  if (boundary === "outside" || boundary === "vendor") return true;
  return !(Array.isArray(repos) && repos.length > 0) && boundary !== "product";
};

/**
 * The box a line drawn on the canvas means: a system box of the estate that holds exactly one
 * repo means that repo (its calls are the repo's); one with several repos (or none) means no one
 * box, so undefined (review round 2, beta.23: never sent as an outside system); an outside
 * system's box means that system; anything else as boxOf says.
 */
export function drawnBoxOf(n: Api.HierNodeT | undefined): Api.LinkBoxT | undefined {
  const b = boxOf(n);
  if (!b?.system || !n || outsideSystem(n)) return b;
  const repos = n.properties.repos;
  return Array.isArray(repos) && repos.length === 1 ? { repo: String(repos[0]) } : undefined;
}

/** A box as Connect to…'s list names it. */
const choiceOf = (n: Api.HierNodeT, b: Api.LinkBoxT): BoxChoice =>
  b.repo && n.kind !== "repo"
    ? { label: `${WORDS.kindWord.repo}: ${b.repo}`, box: b }
    : { label: `${WORDS.kindWord[n.kind] ?? n.kind}: ${n.label}`, box: b };

/**
 * G1 (ADR 0174): what a line drawn on the canvas from box `a` to box `b` opens, or what to say
 * when it connects nothing. A line is drawn from a repo (or its component, or a system holding
 * one repo) to another box; drawn the other way round from an outside system, the ends swap; a
 * system with several repos at either end, two outside systems, or one repo to itself, said.
 */
export function connectDrawn(
  a: Api.HierNodeT | undefined,
  b: Api.HierNodeT | undefined,
): { from: string; initial: BoxChoice } | { say: string } {
  let from = drawnBoxOf(a);
  let to = drawnBoxOf(b);
  let toNode = b;
  if (from?.system && to?.repo) {
    [from, to] = [to, from];
    toNode = a;
  }
  if (!from?.repo || !to || !toNode) return { say: COPY.connect.dropNeedsRepo };
  if (to.repo === from.repo) return { say: COPY.connect.dropSameRepo };
  return { from: from.repo, initial: choiceOf(toNode, to) };
}

export function boxOf(n: Api.HierNodeT | undefined): Api.LinkBoxT | undefined {
  if (!n) return undefined;
  if (n.kind === "repo") return { repo: n.label };
  if (n.kind === "component" && typeof n.properties.repo === "string")
    return { repo: n.properties.repo };
  if (n.kind === "system" && n.id.startsWith("system:")) return { system: n.id.slice(7) };
  return undefined;
}

/**
 * Beta.28, Edit the map: the boxes of the views loaded a link can be added from (a system's of
 * the profiles, as Declare a link… is offered on; a repo's or a component's of one, as Connect
 * to… is), and every repo, component and system box a staged
 * add can be drawn to, once each, by label.
 */
export function editChoices(views: Views): { fromChoices: FromChoice[]; toChoices: ToChoice[] } {
  const from = new Map<string, FromChoice>();
  const to = new Map<string, ToChoice>();
  for (const v of views.values())
    for (const n of [v.node, ...v.children, ...v.outside]) {
      if (n.kind !== "repo" && n.kind !== "system" && n.kind !== "component") continue;
      const label = `${WORDS.kindWord[n.kind] ?? n.kind}: ${n.label}`;
      // Connect to…'s other box: a repo (a component's, a system's only one) or an outside system.
      const drawn = drawnBoxOf(n);
      to.set(n.id, { box: n.id, label, ...(drawn ? { link: drawn } : {}) });
      const b = boxOf(n);
      if (n.kind === "system" && b?.system) from.set(n.id, { box: n.id, system: b.system, label });
      else if (b?.repo) from.set(n.id, { box: n.id, repo: b.repo, label });
    }
  const byLabel = <T extends { label: string }>(m: Map<string, T>) =>
    [...m.values()].sort((x, y) => (x.label < y.label ? -1 : x.label > y.label ? 1 : 0));
  return { fromChoices: byLabel(from), toChoices: byLabel(to) };
}

/**
 * Every repo and outside system box of the views loaded (their boxes outside the opened box
 * too), once each, for the Connect to… list: a system of the estate by the one repo it holds,
 * never by its id (the candidates know only outside systems by id).
 */
export function connectChoices(views: Views): BoxChoice[] {
  const seen = new Map<string, BoxChoice>();
  for (const v of views.values())
    for (const n of [v.node, ...v.children, ...v.outside]) {
      if (n.kind !== "repo" && n.kind !== "system") continue;
      const b = drawnBoxOf(n);
      if (!b) continue;
      const k = b.repo ? `r:${b.repo}` : `s:${b.system}`;
      // A repo's own box names it before a system that holds only it.
      if (!seen.has(k) || n.kind === "repo") seen.set(k, choiceOf(n, b));
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
  above,
  contracts,
  onConnect,
  onOwner,
  onDeclare,
}: {
  /** Beta.24: what to show above a link's calls (All calls on this arrow are wrong). */
  above?: (link: Api.HierEdgeT) => ReactNode;
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
  const box = boxOf(node);
  // The box's name is its heading: a "name" property saying the same again is left out.
  const props = Object.entries(node.properties)
    .filter(([k, v]) => !(k === "name" && v === node.label))
    .map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v)] as [string, ReactNode]);
  // What the box does here (open, focus, connect, own, declare), then where it leads.
  const doing: ReactNode[] = [
    node.childCount > 0 && !isCurrent && (
      <button key="open" type="button" className="btn" onClick={() => onOpen(node.id)}>
        {WORDS.open}
      </button>
    ),
    node.childCount > 0 && here && (
      <button key="here" type="button" className="btn" onClick={here.toggle}>
        {here.open ? WORDS.closeHere : WORDS.openHere}
      </button>
    ),
    node.kind !== "estate" && (lens === "data" || node.kind === "table") && (
      <button key="focus" type="button" className="btn" onClick={() => onFocus(node.id)}>
        {WORDS.focus}
      </button>
    ),
    onConnect && (
      <button key="connect" type="button" className="btn" onClick={onConnect}>
        {COPY.connect.open}
      </button>
    ),
    onOwner && (
      <button key="owner" type="button" className="btn" onClick={onOwner}>
        {COPY.owner.open}
      </button>
    ),
    onDeclare && (
      <button key="declare" type="button" className="btn" onClick={onDeclare}>
        {COPY.declare.open}
      </button>
    ),
  ].filter(Boolean);
  const going: ReactNode[] = [
    node.kind === "repo" && (
      <a key="flows" className="btn" href={`#/flows?repo=${encodeURIComponent(node.label)}`}>
        {COPY.flows.openFlows}
      </a>
    ),
    node.kind === "repo" && (
      <a key="trust" className="btn" href="#/trust">
        {WORDS.repoCounts}
      </a>
    ),
    // WP7.7: a system's page, its guide, questions and changes. Only a System record has a page:
    // a system the manifest or a call names has none yet.
    node.kind === "system" && node.id.startsWith("system:") && node.record && (
      <a key="page" className="btn" href={systemHash(node.id.slice("system:".length))}>
        {COPY.systems.openPage}
      </a>
    ),
  ].filter(Boolean);
  return (
    <div className="stack box-panel">
      {/* Who the box is: its name (in its own case, wrapped, never cut), its kind and state. */}
      <header className="box-head">
        <h3 className="h box-name">{node.label}</h3>
        <p className="box-tags">
          <span className="chip">
            <span className="sr">{WORDS.kind}: </span>
            {WORDS.kindWord[node.kind] ?? node.kind}
          </span>
          <span className={`chip ${node.state === "current" ? "dim" : "warn"}`}>
            <span className="sr">{WORDS.stateLabel}: </span>
            {WORDS.state[node.state]}
          </span>
          {node.gaps.length > 0 && (
            <span className="chip warn">{`${node.gaps.length} ${WORDS.gapsBadge(node.gaps.length)}`}</span>
          )}
        </p>
        {props.length > 0 && <Facts rows={props} />}
      </header>
      {(doing.length > 0 || going.length > 0) && (
        <div className="box-actions">
          {doing.length > 0 && <div className="box-btns">{doing}</div>}
          {going.length > 0 && <div className="box-btns box-go">{going}</div>}
        </div>
      )}
      <section className="box-sec" aria-label={WORDS.gaps}>
        <h4 className="hud">{WORDS.gaps}</h4>
        {node.gaps.length ? (
          <ul className="box-list">
            {node.gaps.map((g) => (
              <li key={g}>
                <span className="box-gap">
                  <span aria-hidden="true">⚠ </span>
                  {WORDS.gap[g] ?? g}
                </span>
                {WORDS.gapFix[g] && <span className="box-why">{WORDS.gapFix[g]}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="box-none">{WORDS.noGaps}</p>
        )}
      </section>
      {box && (
        <section className="box-sec">
          <BoxCorrections key={node.id} box={box} />
        </section>
      )}
      <section className="box-sec" aria-label={WORDS.evidence}>
        <h4 className="hud">{WORDS.evidence}</h4>
        {node.evidence.length ? (
          <ul className="box-list">
            {node.evidence.map((e) => (
              <li key={`${e.repo ?? ""}:${e.at}`} className="box-cite">
                {e.repo && <span className="mono box-repo">{e.repo}</span>}
                <Citation repo={e.repo} at={e.at} />
                {e.repo && <OpenCode repo={e.repo} at={e.at} />}
              </li>
            ))}
          </ul>
        ) : (
          <p className="box-none">{WORDS.noEvidence}</p>
        )}
      </section>
      <section className="box-sec" aria-label={COPY.evidence.links}>
        <h4 className="hud">
          {COPY.evidence.links}
          {links.length > 0 && <span className="box-count"> · {links.length}</span>}
        </h4>
        {links.length ? (
          <ul className="box-list box-links">
            {links.map((l) => (
              <li key={l.id}>
                <span className="box-link-say">
                  {COPY.evidence.linkOf(labelOf(l.from), labelOf(l.to), linkTypeWord(l.type))}
                </span>
                {l.gaps.length > 0 && (
                  <span className="box-gap">
                    <span aria-hidden="true">⚠ </span>
                    {`${WORDS.gaps}: ${l.gaps.map((g) => WORDS.gap[g] ?? g).join(", ")}`}
                  </span>
                )}
                {l.joins?.length ? (
                  // ADR 0135, C1: each call on the link, how it was joined and its lines.
                  <details>
                    <summary>
                      {COPY.why.openOf(
                        COPY.evidence.linkOf(labelOf(l.from), labelOf(l.to), linkTypeWord(l.type)),
                      )}
                    </summary>
                    <WhyLinked
                      link={l}
                      {...(under ? { under } : {})}
                      {...(above ? { above } : {})}
                      {...(contracts ? { contracts } : {})}
                    />
                  </details>
                ) : (
                  l.evidence.length > 0 && (
                    <ul className="box-list">
                      {l.evidence.map((e) => (
                        <li key={`${e.repo ?? ""}:${e.at}`} className="box-cite">
                          {e.repo && <span className="mono box-repo">{e.repo}</span>}
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
          <p className="box-none">{COPY.evidence.noLinks}</p>
        )}
      </section>
      {node.next && (
        <section className="box-sec" aria-label={WORDS.next}>
          <h4 className="hud">{WORDS.next}</h4>
          <p className="box-why">{node.next.why}</p>
          <div className="box-cmd">
            <code className="mono">{node.next.command}</code>
            <CopyButton text={node.next.command} label={`${WORDS.copy}: ${node.next.command}`} />
          </div>
          <RunStep command={node.next.command} />
        </section>
      )}
    </div>
  );
}

/**
 * Keep this arrangement, Tidy up and Reset (ADR 0081): what a person does with the layout. In the
 * map's bar (beta.26) each is an icon button named in words, Keep marked once boxes were moved.
 */
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
    <div className="arch-arrange">
      {p.onFocusOff && (
        <button type="button" className="btn" onClick={p.onFocusOff}>
          {WORDS.focusOff}
        </button>
      )}
      <IconButton
        label={p.saving ? WORDS.keeping : WORDS.keep}
        icon="keep"
        primary={p.moved > 0}
        busy={p.saving}
        disabled={!p.ready || p.saving}
        onClick={p.onKeep}
      />
      <IconButton label={WORDS.tidy} icon="tidy" disabled={!p.ready} onClick={p.onTidy} />
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
        <IconButton
          label={WORDS.reset}
          icon="reset"
          disabled={!p.ready || p.saving}
          onClick={() => setConfirmReset(true)}
        />
      )}
      {p.moved > 0 && <span className="hud">{WORDS.moved(p.moved)}</span>}
    </div>
  );
}
