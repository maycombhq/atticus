import { ReactFlowProvider } from "@xyflow/react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { FlowCanvas, flowLayout, FLOW_FIT_MIN, type FlowViewData } from "../src/app/flow.js";
import {
  availableHeight,
  boundsOf,
  centreOn,
  DiagramFrame,
  fitRect,
  keyAction,
  LABELS_FROM,
  MINIMAP_FROM,
  neighbourhood,
  panBy,
  searchNodes,
  ViewerToolbar,
  wheelFactor,
  ZOOM,
  zoomAt,
} from "../src/app/viewer.js";
import type { Laid } from "../src/app/layout/index.js";
import {
  ArchitectureCanvas,
  dimEdge,
  dimNode,
  flowElements,
  labelScale,
  ownerText,
} from "../src/screens/architecture/Canvas.js";
import { canvasGraph, type CanvasGraph, type Views } from "../src/screens/architecture/model.js";
import { WORDS } from "../src/screens/architecture/words.js";

const V = COPY.viewer;
const html = (el: ReactElement) => renderToStaticMarkup(el);
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
const noop = () => undefined;

describe("the viewer's maths (F10)", () => {
  it("fits a picture whole and centred, never past actual size", () => {
    const v = fitRect({ x: 0, y: 0, w: 2000, h: 1000 }, { width: 1048, height: 548 });
    expect(v.k).toBeCloseTo(0.5, 5);
    // Centred: the picture's middle is the view's middle.
    expect(v.x + 1000 * v.k).toBeCloseTo(524, 5);
    expect(v.y + 500 * v.k).toBeCloseTo(274, 5);
    expect(fitRect({ x: 0, y: 0, w: 100, h: 50 }, { width: 1000, height: 600 }).k).toBe(1);
    // A floor keeps the words readable: a bigger picture pans instead.
    expect(
      fitRect({ x: 0, y: 0, w: 9000, h: 900 }, { width: 900, height: 600 }, { min: 0.6 }).k,
    ).toBe(0.6);
  });

  it("zooms about a point that stays still, within the zoom's bounds", () => {
    const v = { x: 10, y: 20, k: 1 };
    const z = zoomAt(v, 2, { x: 110, y: 120 });
    expect(z.k).toBe(2);
    // The world point under (110, 120) before is under it after.
    expect((110 - z.x) / z.k).toBeCloseTo((110 - v.x) / v.k, 9);
    expect((120 - z.y) / z.k).toBeCloseTo((120 - v.y) / v.k, 9);
    expect(zoomAt(v, 100, { x: 0, y: 0 }).k).toBe(ZOOM.max);
    expect(zoomAt(v, 0.0001, { x: 0, y: 0 }).k).toBe(ZOOM.min);
  });

  it("centres a box, pans by arrows, and turns a wheel into a smooth factor", () => {
    const c = centreOn(
      { x: 0, y: 0, k: 2 },
      { x: 100, y: 100, w: 20, h: 20 },
      {
        width: 400,
        height: 300,
      },
    );
    expect(c).toEqual({ k: 2, x: 200 - 110 * 2, y: 150 - 110 * 2 });
    expect(panBy({ x: 0, y: 0, k: 1 }, "pan-left").x).toBeGreaterThan(0);
    expect(panBy({ x: 0, y: 0, k: 1 }, "pan-down").y).toBeLessThan(0);
    expect(wheelFactor(-100)).toBeGreaterThan(1);
    expect(wheelFactor(100)).toBeLessThan(1);
    expect(wheelFactor(0)).toBe(1);
    expect(
      boundsOf([
        { x: 0, y: 0, w: 10, h: 10 },
        { x: 20, y: 5, w: 10, h: 20 },
      ]),
    ).toEqual({ x: 0, y: 0, w: 30, h: 25 });
  });

  it("maps keys to actions, and leaves a key with Ctrl or Cmd to the browser", () => {
    expect(keyAction({ key: "+" })).toBe("zoom-in");
    expect(keyAction({ key: "-" })).toBe("zoom-out");
    expect(keyAction({ key: "0" })).toBe("fit");
    expect(keyAction({ key: "1" })).toBe("reset");
    expect(keyAction({ key: "f" })).toBe("full-screen");
    expect(keyAction({ key: "Escape" })).toBe("leave");
    expect(keyAction({ key: "s" })).toBe("fit-selection");
    expect(keyAction({ key: "m" })).toBe("focus");
    expect(keyAction({ key: "/" })).toBe("search");
    expect(keyAction({ key: "ArrowUp" })).toBe("pan-up");
    expect(keyAction({ key: "f", ctrlKey: true })).toBeUndefined();
    expect(keyAction({ key: "0", metaKey: true })).toBeUndefined();
    expect(keyAction({ key: "q" })).toBeUndefined();
  });

  it("finds a box by its label, exact first, then the start, then anywhere", () => {
    const nodes = [
      { id: "repo:forge-ledger-api", label: "forge-ledger-api" },
      { id: "system:ledger", label: "Ledger" },
      { id: "topic:payments", label: "payments.initiated", kind: "topic" },
    ];
    expect(searchNodes(nodes, "ledger").map((n) => n.id)).toEqual([
      "system:ledger",
      "repo:forge-ledger-api",
    ]);
    expect(searchNodes(nodes, "payments")[0]!.id).toBe("topic:payments");
    expect(searchNodes(nodes, "  ")).toEqual([]);
    expect(searchNodes(nodes, "nowhere")).toEqual([]);
  });

  it("keeps a box and its neighbours for focus mode", () => {
    const links = [
      { from: "a", to: "b" },
      { from: "c", to: "a" },
      { from: "c", to: "d" },
    ];
    expect([...neighbourhood(links, "a")].sort()).toEqual(["a", "b", "c"]);
  });

  it("gives a picture the height left on the page, never less than its least", () => {
    expect(availableHeight(900, 100)).toBe(776);
    // Far down a long page it still gets most of a screen.
    expect(availableHeight(900, 2400)).toBe(900 - 160 - 24);
    expect(availableHeight(400, 100)).toBe(420);
    expect(availableHeight(400, 100, 200)).toBe(276);
  });
});

describe("the viewer's controls", () => {
  const toolbar = (o: Partial<Parameters<typeof ViewerToolbar>[0]> = {}) =>
    html(
      <ViewerToolbar
        zoom={0.75}
        full={false}
        focus={false}
        picked={false}
        nodes={[{ id: "system:ledger", label: "Ledger" }]}
        onAction={noop}
        onFind={noop}
        {...o}
      />,
    );

  it("labels every control, says the zoom, and has a search box", () => {
    const out = toolbar();
    expect(out).toContain('role="toolbar"');
    expect(out).toContain(`aria-label="${esc(V.toolbar)}"`);
    for (const l of [V.zoomIn, V.zoomOut, V.reset, V.fit, V.fitSelection, V.focus, V.fullScreen])
      expect(out).toContain(`aria-label="${esc(l)}"`);
    expect(out).toContain(esc(V.zoomLevel(75)));
    expect(out).toContain('role="search"');
    expect(out).toContain(`aria-label="${esc(V.search)}"`);
    // Every button is a real button with a type.
    expect(out.match(/<button type="button"/g)).toHaveLength(7);
  });

  it("turns zoom to the picked box and focus off until a box is picked", () => {
    expect(toolbar()).toMatch(new RegExp(`aria-label="${esc(V.fitSelection)}"[^>]*disabled`));
    expect(toolbar({ picked: true })).not.toMatch(
      new RegExp(`aria-label="${esc(V.fitSelection)}"[^>]*disabled`),
    );
  });

  it("says full screen and focus are on, as pressed buttons with the way back", () => {
    const out = toolbar({ full: true, focus: true, picked: true });
    expect(out).toContain(`aria-label="${esc(V.leaveFullScreen)}"`);
    expect(out).toContain(`aria-label="${esc(V.focusOff)}"`);
    expect(out.match(/aria-pressed="true"/g)).toHaveLength(2);
  });

  it("frames the picture at the height given, details over it, and fills the window in full screen", () => {
    const frame = (full: boolean) =>
      html(
        <DiagramFrame
          title="Estate"
          full={full}
          height={640}
          toolbar={<span />}
          aside={<p>inspector</p>}
          onKeyAction={noop}
        >
          <div className="arch-canvas" />
        </DiagramFrame>,
      );
    const out = frame(false);
    expect(out).toContain('role="region"');
    expect(out).toContain(`aria-label="${esc(V.region("Estate"))}"`);
    expect(out).toContain('tabindex="0"');
    expect(out).toContain('style="height:640px"');
    expect(out).toContain('class="viewer-aside"');
    expect(out).toContain('aria-expanded="true"');
    expect(out).toContain(esc(V.hideDetails));
    expect(out).toContain(esc(V.keys));
    expect(out).not.toContain("viewer-full");

    const full = frame(true);
    expect(full).toContain("viewer-full");
    expect(full).toContain('aria-modal="true"');
    expect(full).toContain(esc(V.fullScreenOn));
    // In full screen the stage fills the frame by CSS, not a fixed height.
    expect(full).not.toContain('style="height:640px"');
  });
});

const view: FlowViewData = {
  type: "context",
  title: "Context view",
  groups: [],
  nodes: [
    { id: "ledger", label: "Ledger", kind: "system" },
    { id: "northwind-pay", label: "Northwind Pay", kind: "system" },
    { id: "payments", label: "payments.initiated", kind: "topic" },
  ],
  edges: [
    { id: "e1", from: "ledger", to: "northwind-pay", label: "calls", async: false },
    { id: "e2", from: "ledger", to: "payments", label: "publishes", async: true },
  ],
};

describe("a plain picture in the viewer (flows, Design, Know)", () => {
  it("opens fitted, in a labelled group, with the controls and no minimap when small", () => {
    const out = html(<FlowCanvas view={view} height={460} />);
    expect(out).toMatch(/<svg role="group" aria-label="Context view: 3 nodes/);
    expect(out).toContain('role="toolbar"');
    expect(out).toContain('width="100%" height="100%"');
    // Fitted: a small picture at actual size, centred in the first width.
    expect(out).toMatch(/<g transform="translate\([\d.]+ [\d.]+\) scale\(1\)">/);
    expect(out).not.toContain("flow-minimap");
    // A topic is its own shape.
    expect(out).toContain('stroke-dasharray="4 3"');
  });

  it("draws a minimap on a large picture, hidden from screen readers (the keys do the same)", () => {
    const many: FlowViewData = {
      ...view,
      nodes: Array.from({ length: MINIMAP_FROM + 1 }, (_, i) => ({
        id: `n${i}`,
        label: `node-${i}`,
        kind: "system" as const,
      })),
      edges: [],
    };
    const out = html(<FlowCanvas view={many} />);
    expect(out).toContain('class="flow-minimap" aria-hidden="true"');
  });

  it("never opens smaller than words can be read", () => {
    const wide: FlowViewData = {
      ...view,
      nodes: Array.from({ length: 60 }, (_, i) => ({
        id: `n${i}`,
        label: `a-long-repository-name-${i}`,
        kind: "system" as const,
      })),
      edges: Array.from({ length: 59 }, (_, i) => ({
        id: `e${i}`,
        from: `n${i}`,
        to: `n${i + 1}`,
        label: "calls",
        async: false,
      })),
    };
    expect(flowLayout(wide).width).toBeGreaterThan(2000);
    const out = html(<FlowCanvas view={wide} />);
    expect(out).toContain(`scale(${FLOW_FIT_MIN})`);
  });

  it("opens in full screen and in focus mode, dimming all but a box and its neighbours", () => {
    const out = html(<FlowCanvas view={view} selected="northwind-pay" initialFull initialFocus />);
    expect(out).toContain("viewer-full");
    expect(out).toContain(esc(V.focusOn("Northwind Pay")));
    // The topic is not a neighbour of Northwind Pay: dimmed; Ledger is: lit.
    expect(out).toMatch(/data-node="payments"[^>]*opacity="0.2"/);
    expect(out).toMatch(/data-node="ledger"[^>]*opacity="1"/);
  });
});

const box = (
  id: string,
  label: string,
  kind: string,
  o: Partial<CanvasGraph["boxes"][0]> = {},
) => ({
  id,
  label,
  kind,
  gaps: [],
  childCount: 0,
  outside: false,
  group: false,
  inside: 0,
  ...o,
});

const graph: CanvasGraph = {
  boxes: [
    box("system:portal", "Portal", "system"),
    box("topic:payments", "payments.initiated", "topic", { owner: "Portal" }),
    box("system:ledger", "Ledger", "system"),
    box("topic:refunds", "refunds.requested", "topic", { gaps: ["no-listener"] }),
  ],
  links: [
    {
      id: "p",
      from: "system:portal",
      to: "topic:payments",
      type: "publishes",
      count: 1,
      label: "publishes",
      async: true,
      gaps: [],
    },
    {
      id: "s",
      from: "topic:payments",
      to: "system:ledger",
      type: "subscribes",
      count: 1,
      label: "listens",
      async: true,
      gaps: [],
    },
  ],
};
const laid: Laid = {
  boxes: Object.fromEntries(
    graph.boxes.map((b, i) => [
      b.id,
      { id: b.id, x: i * 240, y: 0, width: 200, height: 64, group: false },
    ]),
  ),
  routes: {},
  dropped: [],
  score: {
    nodes: 4,
    leaves: 4,
    edges: 2,
    crossings: 0,
    crossingsPerEdge: 0,
    overlaps: 0,
    averageEdgeLength: 100,
    width: 900,
    height: 64,
    screens: 0.04,
  },
  over: [],
};

const canvas = (o: Partial<Parameters<typeof ArchitectureCanvas>[0]> = {}, g = graph) => (
  <ReactFlowProvider
    initialNodes={flowElements(g, laid, "RIGHT", o.selected).nodes}
    initialEdges={flowElements(g, laid, "RIGHT", o.selected).edges}
    initialWidth={1000}
    initialHeight={600}
  >
    <ArchitectureCanvas
      graph={g}
      direction="RIGHT"
      pinned={{}}
      tidy={0}
      onSelect={noop}
      onToggle={noop}
      onMoved={noop}
      onLaid={noop}
      initial={laid}
      height={600}
      {...o}
    />
  </ReactFlowProvider>
);

describe("the Architecture canvas in the viewer", () => {
  it("has the controls, the full width, and the inspector laid over the picture", () => {
    const out = html(canvas({ aside: <p>details here</p> }));
    expect(out).toContain('role="toolbar"');
    expect(out).toContain('style="height:600px"');
    expect(out).toContain('class="viewer-aside"');
    expect(out).toContain("details here");
  });

  it("goes full screen", () => {
    expect(html(canvas({ initialFull: true }))).toContain("viewer-full");
  });

  it("draws a topic as its own box with its owner, and marks one with no listener", () => {
    const out = html(canvas());
    expect(out).toMatch(/class="arch-box[^"]*\btopic\b/);
    expect(out).toContain(esc(COPY.topics.owner("Portal")));
    expect(out).toContain(esc(COPY.topics.ownerUnknown));
    expect(out).toContain(
      `aria-label="topic refunds.requested, ${esc(COPY.topics.ownerUnknown)}, ${esc(COPY.topics.noListener)}"`,
    );
    expect(ownerText({ owner: "Tidewater", ownerOutside: true })).toBe(
      COPY.topics.ownerOutside("Tidewater"),
    );
    expect(WORDS.gap["no-publisher"]).toBe(COPY.topics.noPublisher);
    expect(WORDS.gapFix["no-listener"]).toBe(COPY.topics.noListenerFix);
  });

  it("in focus mode dims what is not the picked box or a neighbour; search finds topics", () => {
    // The toolbar says focus is on (React Flow's server render draws the provider's nodes, so
    // the dimming itself is checked on the elements below).
    const out = html(canvas({ selected: "topic:payments", initialFocus: true }));
    expect(out).toContain(`aria-label="${esc(V.focusOff)}"`);
    const { nodes, edges } = flowElements(graph, laid, "RIGHT");
    const lit = neighbourhood(graph.links, "system:portal");
    expect(nodes.map((n) => dimNode(n, lit).className ?? "")).toEqual(["", "", "dim", "dim"]);
    expect(edges.map((e) => dimEdge(e, "system:portal").className ?? "")).toEqual(["", "dim"]);
    expect(searchNodes(graph.boxes, "refunds")[0]!.id).toBe("topic:refunds");
  });

  it("keeps words readable: labels grow as it zooms out, link labels go when far", () => {
    expect(labelScale(1)).toEqual({ "--label-scale": "1" });
    expect(labelScale(0.35)).toEqual({ "--label-scale": "1.8" });
    expect(LABELS_FROM).toBeLessThan(0.6);
  });

  it("draws a minimap only on a large picture", () => {
    const big: CanvasGraph = {
      boxes: Array.from({ length: MINIMAP_FROM + 1 }, (_, i) => box(`repo:r${i}`, `r${i}`, "repo")),
      links: [],
    };
    const bigLaid: Laid = {
      ...laid,
      boxes: Object.fromEntries(
        big.boxes.map((b, i) => [
          b.id,
          { id: b.id, x: i * 200, y: 0, width: 150, height: 64, group: false },
        ]),
      ),
    };
    const out = html(
      <ReactFlowProvider
        initialNodes={flowElements(big, bigLaid, "RIGHT").nodes}
        initialWidth={1000}
        initialHeight={600}
      >
        <ArchitectureCanvas
          graph={big}
          direction="RIGHT"
          pinned={{}}
          tidy={0}
          onSelect={noop}
          onToggle={noop}
          onMoved={noop}
          onLaid={noop}
          initial={bigLaid}
          height={600}
        />
      </ReactFlowProvider>,
    );
    expect(out).toContain(esc(V.minimap));
  });
});

describe("publishers → topic → listeners on the canvas (F10)", () => {
  const node = (id: string, kind: string, o: Partial<Api.HierNodeT> = {}): Api.HierNodeT =>
    ({
      id,
      kind,
      label: id.split(":")[1]!,
      childCount: 0,
      state: "current",
      gaps: [],
      evidence: [],
      properties: {},
      ...o,
    }) as Api.HierNodeT;
  const edge = (from: string, to: string, type: "publishes" | "subscribes"): Api.HierEdgeT => ({
    id: `${type}:${from}>${to}`,
    from,
    to,
    type,
    count: 1,
    state: "current",
    gaps: [],
    evidence: [],
  });

  it("draws a listener's link from the topic to it, async, and carries the owner", () => {
    const views: Views = new Map([
      [
        "estate",
        {
          lens: "architecture",
          node: node("estate", "estate"),
          path: [],
          children: [
            node("system:portal", "system"),
            node("system:ledger", "system"),
            node("topic:payments", "topic", {
              properties: { owner: "Tidewater", ownerOutside: true },
              gaps: ["no-listener"],
            }),
          ],
          outside: [],
          edges: [
            edge("system:portal", "topic:payments", "publishes"),
            edge("system:ledger", "topic:payments", "subscribes"),
          ],
          reduced: true,
          hiddenEdges: 0,
        } as Api.GraphNodeViewT,
      ],
    ]);
    const g = canvasGraph(views, "estate", new Set());
    const t = g.boxes.find((b) => b.id === "topic:payments")!;
    expect(t).toMatchObject({ kind: "topic", owner: "Tidewater", ownerOutside: true });
    expect(g.links.map((l) => [l.from, l.to, l.label, l.async])).toEqual([
      ["system:portal", "topic:payments", "publishes", true],
      ["topic:payments", "system:ledger", COPY.topics.listens, true],
    ]);
  });
});
