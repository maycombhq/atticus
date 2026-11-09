import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COPY } from "../src/copy.js";
import type { CanvasGraph } from "../src/screens/architecture/model.js";
import { CanvasTools, TypeLegend, type ToolsState } from "../src/screens/architecture/Tools.js";
import {
  ALL_LAYERS,
  blastRadius,
  boxMatches,
  compare,
  inbox,
  layerOf,
  parseFilter,
  snapshotOf,
  toDrawio,
  toMermaid,
  toSvg,
  trace,
  withFilter,
  withLayers,
} from "../src/screens/architecture/canvas-tools.js";

/**
 * G6 (ADR 0175): the canvas's tools on a picture of the invented Forge estate: the portal calls
 * the ledger through the gateway; the ledger publishes to a topic Harbor audit (another team's)
 * owns, declared; a person paired the reports job's call with the ledger.
 */

const box = (id: string, label: string, o: Partial<CanvasGraph["boxes"][number]> = {}) => ({
  id,
  label,
  kind: "repo",
  gaps: [],
  childCount: 0,
  outside: false,
  group: false,
  inside: 0,
  ...o,
});
const link = (
  id: string,
  from: string,
  to: string,
  o: Partial<CanvasGraph["links"][number]> = {},
) => ({
  id,
  from,
  to,
  type: "calls",
  count: 1,
  label: "calls",
  async: false,
  gaps: [],
  ...o,
});
const g: CanvasGraph = {
  boxes: [
    box("repo:forge-portal", "forge-portal"),
    box("repo:forge-gw", "forge-gw"),
    box("repo:forge-ledger", "forge-ledger", { gaps: ["no-component"] }),
    box("repo:forge-reports", "forge-reports"),
    box("topic:ledger.events", "ledger.events", { kind: "topic" }),
    box("system:harbor-audit", "Harbor audit", { kind: "system", outside: true }),
  ],
  links: [
    link("l1", "repo:forge-portal", "repo:forge-gw"),
    link("l2", "repo:forge-gw", "repo:forge-ledger", { gaps: ["joined-by-path"] }),
    link("l3", "repo:forge-ledger", "topic:ledger.events", { type: "publishes", declared: true }),
    link("l4", "repo:forge-reports", "repo:forge-ledger", {
      paired: true,
      label: "calls · paired by a person",
    }),
    link("l5", "topic:ledger.events", "system:harbor-audit", { type: "subscribes" }),
  ],
};
const props: Record<string, Record<string, string>> = {
  "repo:forge-ledger": { owner: "team-ledger", type: "spring-boot", system: "ledger" },
  "repo:forge-gw": { owner: "team-platform", type: "gateway-external", path: "/accounts/{id}" },
};

describe("layers and filters", () => {
  it("puts each link on one layer and hides the layers turned off", () => {
    expect(g.links.map(layerOf)).toEqual(["verified", "guessed", "declared", "paired", "verified"]);
    const v = withLayers(g, { ...ALL_LAYERS, guessed: false, topics: false });
    expect(v.links.map((l) => l.id)).toEqual(["l1", "l4"]);
    expect(v.boxes.some((b) => b.kind === "topic")).toBe(false);
    expect(
      withLayers(g, ALL_LAYERS, { mismatches: new Set(["l2"]) }).links.map((l) => l.id),
    ).toEqual(["l2"]);
  });

  it("keeps the boxes a filter names, and what they link to", () => {
    expect(parseFilter("team:team-ledger  payments")).toEqual([
      { key: "team", value: "team-ledger" },
      { value: "payments" },
    ]);
    expect(boxMatches(g.boxes[2]!, props["repo:forge-ledger"], parseFilter("type:spring"))).toBe(
      true,
    );
    expect(boxMatches(g.boxes[1]!, props["repo:forge-gw"], parseFilter("path:/accounts/**"))).toBe(
      true,
    );
    const f = withFilter(g, "team:team-ledger", (id) => props[id]);
    expect(f.boxes.map((b) => b.label).sort()).toEqual([
      "forge-gw",
      "forge-ledger",
      "forge-reports",
      "ledger.events",
    ]);
  });
});

describe("blast radius, trace and the inbox", () => {
  it("walks upstream, downstream or both, to a depth", () => {
    const down = blastRadius(g.links, "repo:forge-portal", 2, "down");
    expect([...down.entries()]).toEqual([
      ["repo:forge-portal", 0],
      ["repo:forge-gw", 1],
      ["repo:forge-ledger", 2],
    ]);
    expect([...blastRadius(g.links, "repo:forge-ledger", 1, "up").keys()].sort()).toEqual([
      "repo:forge-gw",
      "repo:forge-ledger",
      "repo:forge-reports",
    ]);
  });

  it("traces a request hop by hop, and lists what is open", () => {
    expect(trace(g.links, "repo:forge-portal").map((h) => [h.depth, h.link.id])).toEqual([
      [1, "l1"],
      [2, "l2"],
      [3, "l3"],
      [4, "l5"],
    ]);
    expect(inbox(g).map((x) => x.label)).toEqual(["forge-gw → forge-ledger", "forge-ledger"]);
  });
});

describe("compare and export", () => {
  it("marks the links added since a snapshot and lists those gone", () => {
    const before = snapshotOf({ ...g, links: g.links.slice(0, 3) }, "10:00");
    const c = compare(before, { ...g, links: g.links.slice(1) });
    expect(c.added.map((l) => l.id)).toEqual(["l4", "l5"]);
    expect(c.removed.map((l) => l.id)).toEqual(["l1"]);
  });

  it("writes Mermaid, draw.io and SVG with the labels, a person's word dashed", () => {
    const at = (id: string) => ({
      x: g.boxes.findIndex((b) => b.id === id) * 200,
      y: 0,
      width: 160,
      height: 60,
    });
    const m = toMermaid(g);
    expect(m.startsWith("flowchart LR\n")).toBe(true);
    expect(m).toContain(
      'n_repo_forge_reports -.->|"calls · paired by a person"| n_repo_forge_ledger',
    );
    const d = toDrawio(g, at);
    expect(d).toContain('value="forge-ledger"');
    expect(d).toContain("dashed=1;");
    const s = toSvg(g, at);
    expect(s).toContain("<svg");
    expect(s).toContain(">Harbor audit</text>");
    expect(s).toContain('stroke-dasharray="6 4"');
  });
});

describe("the tools panel", () => {
  it("collapses to its button with the count of boxes shown", () => {
    const state: ToolsState = {
      layers: ALL_LAYERS,
      mismatches: false,
      filter: "",
      overlay: "none",
    };
    const out = renderToStaticMarkup(
      <CanvasTools
        graph={g}
        allBoxes={10}
        state={state}
        onChange={() => undefined}
        onSelect={() => undefined}
        labelOf={(id) => id}
        placed={() => undefined}
        lens="architecture"
        node="estate"
        onSnapshot={() => undefined}
        name="architecture.estate"
      />,
    );
    expect(out).toContain(COPY.canvasTools.title);
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain(COPY.canvasTools.filtered(6, 10));
  });

  it("lists the component types the picture has as a legend (ADR 0180), each a filter on its type", () => {
    const typed: CanvasGraph = {
      ...g,
      boxes: g.boxes.map((b) =>
        b.id === "repo:forge-gw"
          ? { ...b, typeId: "gateway" }
          : b.id === "repo:forge-portal"
            ? { ...b, typeId: "spa" }
            : b,
      ),
    };
    const types = {
      gateway: {
        name: "Forge gateway proxy",
        description: "Policy only.",
        badge: "gw",
        colour: "#e06c75",
      },
      spa: { name: "Single-page app", description: "A browser app.", badge: "ui" },
      worker: { name: "Worker", description: "Takes work from a queue.", badge: "wkr" },
    };
    const out = renderToStaticMarkup(
      <TypeLegend types={types} graph={typed} filter="type:gateway" onFilter={() => undefined} />,
    );
    expect(out).toContain(COPY.canvasTools.types);
    expect(out).toContain("Forge gateway proxy");
    expect(out).toContain("Single-page app");
    // A type no box in the picture is of isn't listed.
    expect(out).not.toContain("Takes work from a queue");
    expect(out).toContain('aria-pressed="true"');
    expect(out).toContain("border-left:3px solid #e06c75");
  });
});
