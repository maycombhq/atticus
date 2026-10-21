import { ReactFlowProvider } from "@xyflow/react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Laid } from "../src/app/layout/index.js";
import { Architecture, ArrangementBar } from "../src/screens/architecture/Architecture.js";
import {
  ArchitectureCanvas,
  flowElements,
  layoutInput,
} from "../src/screens/architecture/Canvas.js";
import type { CanvasGraph } from "../src/screens/architecture/model.js";
import { WORDS } from "../src/screens/architecture/words.js";

const html = (el: ReactElement) => renderToStaticMarkup(el);
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

const graph: CanvasGraph = {
  boxes: [
    {
      id: "system:ledger",
      label: "Ledger",
      kind: "system",
      gaps: [],
      childCount: 2,
      outside: false,
      group: true,
      inside: 0,
    },
    {
      id: "repo:forge-ledger-api",
      label: "forge-ledger-api",
      kind: "repo",
      gaps: ["no-owner", "inferred"],
      childCount: 0,
      outside: false,
      group: false,
      parent: "system:ledger",
      inside: 2,
    },
    {
      id: "system:portal",
      label: "Portal",
      kind: "system",
      gaps: [],
      childCount: 1,
      outside: true,
      group: false,
      inside: 0,
    },
  ],
  links: [
    {
      id: "e1",
      from: "system:portal",
      to: "repo:forge-ledger-api",
      type: "calls",
      count: 3,
      label: "3 × calls",
      async: false,
      gaps: [],
    },
  ],
};

const laid: Laid = {
  boxes: {
    "system:ledger": { id: "system:ledger", x: 0, y: 0, width: 220, height: 130, group: true },
    "repo:forge-ledger-api": {
      id: "repo:forge-ledger-api",
      x: 16,
      y: 36,
      width: 188,
      height: 64,
      parent: "system:ledger",
      group: false,
    },
    "system:portal": { id: "system:portal", x: 320, y: 20, width: 150, height: 64, group: false },
  },
  routes: {
    e1: {
      id: "e1",
      from: "system:portal",
      to: "repo:forge-ledger-api",
      points: [
        { x: 320, y: 52 },
        { x: 204, y: 68 },
      ],
    },
  },
  dropped: [],
  score: {
    nodes: 3,
    leaves: 2,
    edges: 1,
    crossings: 0,
    crossingsPerEdge: 0,
    overlaps: 0,
    averageEdgeLength: 100,
    width: 470,
    height: 130,
    screens: 0.04,
  },
  over: [],
};

const noop = () => undefined;
/** Server-side, React Flow draws what its provider starts with (effects don't run). */
const canvas = (o: Partial<Parameters<typeof ArchitectureCanvas>[0]> = {}) => (
  <ReactFlowProvider
    {...(o.initial
      ? {
          initialNodes: flowElements(graph, o.initial, "RIGHT").nodes,
          initialEdges: flowElements(graph, o.initial, "RIGHT").edges,
          initialWidth: 800,
          initialHeight: 500,
        }
      : {})}
  >
    <ArchitectureCanvas
      graph={graph}
      direction="RIGHT"
      pinned={{}}
      tidy={0}
      onSelect={noop}
      onToggle={noop}
      onMoved={noop}
      onLaid={noop}
      {...o}
    />
  </ReactFlowProvider>
);

describe("the Architecture screen's states", () => {
  it("is loading before the estate arrives", () => {
    const out = html(<Architecture hash="#/architecture" />);
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain(WORDS.loading);
    // The lens switcher is there from the start.
    expect(out).toContain('role="tablist"');
  });

  it("shows the canvas laying out before the first layout returns", () => {
    const out = html(canvas());
    expect(out).toContain(WORDS.layingOut);
    expect(out).toContain('aria-busy="true"');
  });

  it("draws boxes in their groups, gap flags with an icon and words, and edge counts", () => {
    const out = html(canvas({ initial: laid }));
    expect(out).toContain("react-flow");
    expect(out).toContain("forge-ledger-api");
    // Missing things: the triangle, the words and the amber class, never colour alone.
    expect(out).toContain("arch-gap");
    expect(out).toContain(esc(WORDS.gapsOn(2)));
    expect(out).toContain("<svg");
    expect(out).toContain("gappy");
    expect(out).toContain(esc(WORDS.insideLinks(2)));
    expect(out).toContain(`Portal (${WORDS.outsideMark})`);
    expect(out).toContain(esc(WORDS.minimap));
  });

  it("has Keep, Tidy up and Reset, off until the arrangement is read", () => {
    const off = html(
      <ArrangementBar
        ready={false}
        saving={false}
        moved={0}
        onKeep={noop}
        onTidy={noop}
        onReset={noop}
      />,
    );
    expect(off.match(/disabled=""/g)?.length).toBe(3);
    const on = html(
      <ArrangementBar ready saving={false} moved={2} onKeep={noop} onTidy={noop} onReset={noop} />,
    );
    expect(on).not.toContain("disabled");
    expect(on).toContain(esc(WORDS.keep));
    expect(on).toContain(esc(WORDS.tidy));
    expect(on).toContain(esc(WORDS.reset));
    expect(on).toContain(esc(WORDS.moved(2)));
    expect(
      html(<ArrangementBar ready saving moved={0} onKeep={noop} onTidy={noop} onReset={noop} />),
    ).toContain(WORDS.keeping);
  });
});

describe("React Flow's elements for a laid-out graph", () => {
  it("puts groups first, children relative to them, and edges on the engine's route", () => {
    const { nodes, edges } = flowElements(graph, laid, "RIGHT", "system:portal");
    expect(nodes.map((n) => [n.id, n.parentId ?? ""])).toEqual([
      ["system:ledger", ""],
      ["system:portal", ""],
      ["repo:forge-ledger-api", "system:ledger"],
    ]);
    expect(nodes[2]!.position).toEqual({ x: 16, y: 36 });
    expect(nodes[1]!.data.selected).toBe(true);
    expect(edges[0]!.data!.points).toHaveLength(2);
    // Where the two boxes were when the route was drawn, so a drag can tell it moved.
    expect(edges[0]!.data!.ends).toEqual({ from: { x: 320, y: 20 }, to: { x: 16, y: 36 } });
  });

  it("gives the layout each box's size, the groups, and room for edge labels", () => {
    const i = layoutInput(graph);
    expect(i.groups).toEqual([{ id: "system:ledger" }]);
    expect(i.nodes.find((n) => n.id === "repo:forge-ledger-api")).toMatchObject({
      parent: "system:ledger",
      height: 64,
    });
    expect(i.edges[0]!.label!.width).toBeGreaterThan(0);
  });
});
