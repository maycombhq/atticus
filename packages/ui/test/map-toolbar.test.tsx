import { ReactFlowProvider } from "@xyflow/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COPY } from "../src/copy.js";
import { availableHeight, availableHeightIn, DiagramFrame } from "../src/app/viewer.js";
import { ArrangementBar } from "../src/screens/architecture/Architecture.js";
import { ArchitectureCanvas } from "../src/screens/architecture/Canvas.js";
import {
  CanvasLegend,
  LEGEND_KEY,
  MapBar,
  readLegendOpen,
  saveLegendOpen,
} from "../src/screens/architecture/MapBar.js";
import type { CanvasGraph } from "../src/screens/architecture/model.js";
import { ALL_LAYERS } from "../src/screens/architecture/canvas-tools.js";
import { CanvasTools, type ToolsState } from "../src/screens/architecture/Tools.js";
import { WORDS } from "../src/screens/architecture/words.js";

/**
 * Beta.26: the map gives the canvas most of the space. Its controls are one slim bar (the lens as
 * a segmented control, the tools as named icon buttons, the view controls at its right), the
 * legend lies over a corner of the canvas and folds (remembered per browser), the tools open as
 * a drawer over the canvas, and the details are a right-hand panel beside it that can be closed.
 * The invented Forge estate.
 */

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
const noop = () => undefined;
const T = COPY.canvasTools;
const V = COPY.viewer;

const graph: CanvasGraph = {
  boxes: [
    {
      id: "repo:forge-ledger-api",
      label: "forge-ledger-api",
      kind: "repo",
      gaps: [],
      childCount: 0,
      outside: false,
      group: false,
      inside: 0,
    },
    {
      id: "system:portal",
      label: "Portal",
      kind: "system",
      gaps: [],
      childCount: 1,
      outside: false,
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

const LENSES = [
  { id: "architecture", label: WORDS.lenses.architecture },
  { id: "repo", label: WORDS.lenses.repo },
  { id: "data", label: WORDS.lenses.data },
];

const bar = (o: Partial<Parameters<typeof MapBar>[0]> = {}) =>
  html(
    <MapBar
      lenses={LENSES}
      lens="repo"
      onLens={noop}
      crumbs={<span className="chip">Estate</span>}
      onAdd={noop}
      tools={{ open: false, bodyId: "tools-body", onToggle: noop, shown: 2, all: 2 }}
      arrangement={
        <ArrangementBar ready saving={false} moved={0} onKeep={noop} onTidy={noop} onReset={noop} />
      }
      {...o}
    />,
  );

describe("the map's bar: one slim row", () => {
  it("has the lens as a segmented tablist, the one shown selected", () => {
    const out = bar();
    expect(out).toMatch(/^<div class="arch-bar" role="group" aria-label="Map controls">/);
    expect(out).toContain(`role="tablist" aria-label="${WORDS.lens}" class="arch-seg"`);
    expect(out.match(/role="tab"/g)).toHaveLength(3);
    expect(out).toMatch(/role="tab" aria-selected="true"[^>]*>Repo</);
    expect(out).toMatch(/role="tab" aria-selected="false"[^>]*>Architecture</);
    expect(out).toContain(">Estate<");
  });

  it("names every icon button, with a tooltip of the same words", () => {
    const out = bar();
    for (const name of [COPY.addBox.open, T.show, WORDS.keep, WORDS.tidy, WORDS.reset])
      expect(out).toContain(`aria-label="${esc(name)}" title="${esc(name)}"`);
    // The tools button is a disclosure of the drawer it opens.
    expect(out).toMatch(
      /aria-expanded="false" aria-controls="tools-body"[^>]*aria-label="Show the tools"/,
    );
    expect(
      bar({ tools: { open: true, bodyId: "tools-body", onToggle: noop, shown: 2, all: 2 } }),
    ).toContain(`aria-label="${esc(T.hide)}"`);
    // Icons are drawn, not read.
    expect(out).toContain('aria-hidden="true" focusable="false"');
  });

  it("says how many boxes are shown only when a filter hides some", () => {
    expect(bar()).not.toContain(esc(T.filtered(2, 2)));
    expect(
      bar({ tools: { open: false, bodyId: "b", onToggle: noop, shown: 1, all: 2 } }),
    ).toContain(esc(T.filtered(1, 2)));
  });

  it("keeps a place at its right for the picture's own controls, and says what runs", () => {
    const out = bar({ status: <span role="status">{WORDS.joiningEstate}</span> });
    expect(out).toContain('class="arch-bar-view"');
    expect(out).toContain(esc(WORDS.joiningEstate));
  });
});

describe("Keep, Tidy up and Reset in the bar", () => {
  it("are icon buttons named in words, Keep marked once boxes moved", () => {
    const still = html(
      <ArrangementBar ready saving={false} moved={0} onKeep={noop} onTidy={noop} onReset={noop} />,
    );
    expect(still).toContain("viewer-btn");
    expect(still).not.toContain("primary");
    const moved = html(
      <ArrangementBar ready saving={false} moved={2} onKeep={noop} onTidy={noop} onReset={noop} />,
    );
    expect(moved).toContain("primary");
    expect(moved).toContain(esc(WORDS.moved(2)));
  });
});

describe("the tools as a drawer over the canvas", () => {
  const state: ToolsState = { layers: ALL_LAYERS, mismatches: false, filter: "", overlay: "none" };
  const tools = (open: boolean) =>
    html(
      <CanvasTools
        graph={graph}
        allBoxes={2}
        state={state}
        onChange={noop}
        onSelect={noop}
        labelOf={(id) => id}
        placed={() => undefined}
        lens="architecture"
        node="estate"
        onSnapshot={noop}
        name="architecture.estate"
        drawer={{ open, bodyId: "tools-body", onClose: noop }}
      />,
    );

  it("is nothing while closed: its button is in the bar", () => {
    expect(tools(false)).toBe("");
  });

  it("opens as its own labelled panel, the filter its first search box, with a close button", () => {
    const out = tools(true);
    expect(out).toMatch(/^<section id="tools-body" class="canvas-tools arch-tools-drawer"/);
    expect(out).toContain(`>${esc(T.title)}</h3>`);
    expect(out).toContain('class="canvas-tools-body"');
    expect(out.indexOf('type="search"')).toBeGreaterThan(out.indexOf("canvas-tools-body"));
    expect(out).toContain(`aria-label="${esc(T.hide)}" title="${esc(T.hide)}"`);
    expect(out).toContain(esc(T.filtered(2, 2)));
  });
});

describe("the legend over a corner of the canvas", () => {
  const store = (v: string | null) => {
    const m = new Map<string, string>(v === null ? [] : [[LEGEND_KEY, v]]);
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, x: string) => void m.set(k, x),
      m,
    };
  };

  it("is open until it is folded, and remembers that in this browser", () => {
    expect(readLegendOpen(store(null))).toBe(true);
    expect(readLegendOpen(store("closed"))).toBe(false);
    expect(readLegendOpen(store("open"))).toBe(true);
    const s = store(null);
    saveLegendOpen(false, s);
    expect(s.m.get(LEGEND_KEY)).toBe("closed");
    saveLegendOpen(true, s);
    expect(s.m.get(LEGEND_KEY)).toBe("open");
  });

  it("is open, and saves nothing, where storage refuses", () => {
    const refuses = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readLegendOpen(refuses)).toBe(true);
    expect(() => saveLegendOpen(false, refuses)).not.toThrow();
  });

  it("is a disclosure: the links counted and how each kind is drawn", () => {
    const out = html(<CanvasLegend meta={WORDS.edges(1, 0)} links={graph.links} initialOpen />);
    expect(out).toMatch(/^<div class="arch-legend viewer-own">/);
    expect(out).toMatch(/aria-expanded="true" aria-controls="[^"]+"/);
    expect(out).toContain(`>${V.legend}<`);
    expect(out).toContain(esc(WORDS.edges(1, 0)));
    expect(out).toContain(`aria-label="${esc(COPY.canvasAi.legend)}"`);
    const shut = html(
      <CanvasLegend meta={WORDS.edges(1, 0)} links={graph.links} initialOpen={false} />,
    );
    expect(shut).toContain('aria-expanded="false"');
    expect(shut).not.toContain(esc(WORDS.edges(1, 0)));
  });
});

describe("the details beside the canvas", () => {
  const frame = (o: Partial<Parameters<typeof DiagramFrame>[0]> = {}) =>
    html(
      <DiagramFrame
        title="Estate"
        full={false}
        height={600}
        toolbar={<span className="tb" />}
        aside={<p>inspector</p>}
        asideBeside
        onKeyAction={noop}
        {...o}
      >
        <div className="arch-canvas" />
      </DiagramFrame>,
    );

  it("is a right-hand panel, not laid over the picture, closed by its own named button", () => {
    const out = frame();
    expect(out).toContain('class="viewer-stage beside"');
    expect(out).toMatch(/<aside id="[^"]+" class="viewer-aside" aria-label="Details">/);
    expect(out).toMatch(
      /<button type="button" class="btn viewer-btn viewer-aside-close" aria-expanded="true" aria-controls="[^"]+" aria-label="Hide details" title="Hide details">/,
    );
    // Open, there is no Show details over the picture.
    expect(out).not.toContain(esc(V.showDetails));
    // The picture comes first, the panel after it.
    expect(out.indexOf("arch-canvas")).toBeLessThan(out.indexOf("viewer-aside"));
  });

  it("keeps the overlaying panel for other pictures", () => {
    const out = frame({ asideBeside: false });
    expect(out).toContain('class="viewer-stage"');
    expect(out).toContain('class="btn viewer-aside-toggle"');
  });
});

describe("the canvas's own overlay and controls", () => {
  it("lays the legend over the canvas itself, and the details beside it", () => {
    const out = html(
      <ReactFlowProvider>
        <ArchitectureCanvas
          graph={graph}
          direction="RIGHT"
          pinned={{}}
          tidy={0}
          onSelect={noop}
          onToggle={noop}
          onMoved={noop}
          onLaid={noop}
          overlay={<div className="legend-here" />}
          aside={<p>inspector</p>}
          asideBeside
        />
      </ReactFlowProvider>,
    );
    const canvas = out.slice(out.indexOf('class="arch-canvas'));
    expect(canvas.indexOf("legend-here")).toBeGreaterThan(-1);
    expect(canvas.indexOf("legend-here")).toBeLessThan(canvas.indexOf("viewer-aside"));
    expect(out).toContain('class="viewer-stage beside"');
    // Without a place given for them, the picture's controls stay in its frame.
    expect(out).toContain(`aria-label="${V.toolbar}"`);
  });
});

describe("the canvas's height in the IDE layout", () => {
  it("fills what is left of the page's scrolling area, not the window", () => {
    // The shell's page scrolls between the tabs (76 px) and the bottom panel (843 px).
    expect(availableHeightIn({ top: 76, bottom: 843 }, 232)).toBe(843 - 232 - 24);
    // The classic layout's page is the window: the same as before.
    expect(availableHeightIn({ top: 0, bottom: 900 }, 100)).toBe(availableHeight(900, 100));
    // Far down, most of the area still; never under the least.
    expect(availableHeightIn({ top: 76, bottom: 843 }, 2400)).toBe(843 - 76 - 160 - 24);
    expect(availableHeightIn({ top: 76, bottom: 400 }, 232)).toBe(420);
  });
});
