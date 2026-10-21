import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import {
  canvasView,
  keyStep,
  outlineRows,
  viewKey,
  type Views,
} from "../src/screens/architecture/model.js";

const node = (id: string, kind: Api.HierKindT, childCount = 0, parent?: string): Api.HierNodeT => ({
  id,
  kind,
  label: id.split(":")[1] ?? "Estate",
  ...(parent ? { parent } : {}),
  childCount,
  state: "current",
  gaps: [],
  evidence: [],
  properties: {},
});

const view = (
  n: Api.HierNodeT,
  children: Api.HierNodeT[],
  edges: Partial<Api.HierEdgeT>[] = [],
  outside: Api.HierNodeT[] = [],
): Api.GraphNodeViewT => ({
  lens: "architecture",
  node: n,
  path: [],
  children,
  outside,
  edges: edges.map((e, i) => ({
    id: `e${i}`,
    from: "",
    to: "",
    type: "calls",
    count: 1,
    state: "current",
    gaps: [],
    evidence: [],
    ...e,
  })),
  reduced: true,
  hiddenEdges: 0,
});

const estate = node("estate", "estate", 2);
const ledger = node("system:ledger", "system", 1, "estate");
const portal = node("system:portal", "system", 1, "estate");
const repo = node("repo:forge-ledger", "repo", 0, "system:ledger");

const views: Views = new Map([
  ["estate", view(estate, [ledger, portal])],
  ["system:ledger", view(ledger, [repo])],
]);

describe("the outline: the same graph as a tree for keyboards and screen readers", () => {
  it("lists the open nodes' children under them, in order, with their depth", () => {
    const rows = outlineRows(views, "estate", new Set(["estate", "system:ledger"]));
    expect(rows.map((r) => [r.node.id, r.depth, r.expanded])).toEqual([
      ["estate", 0, true],
      ["system:ledger", 1, true],
      ["repo:forge-ledger", 2, false],
      ["system:portal", 1, false],
    ]);
    // A closed node shows only itself.
    expect(outlineRows(views, "estate", new Set()).map((r) => r.node.id)).toEqual(["estate"]);
  });

  it("moves with the arrow keys, opens with Enter and closes with Escape", () => {
    const rows = outlineRows(views, "estate", new Set(["estate", "system:ledger"]));
    expect(keyStep(rows, "system:ledger", "ArrowDown")).toEqual({ focus: "repo:forge-ledger" });
    expect(keyStep(rows, "system:ledger", "ArrowUp")).toEqual({ focus: "estate" });
    expect(keyStep(rows, "system:portal", "ArrowDown")).toEqual({ focus: "system:portal" });
    expect(keyStep(rows, "system:portal", "Enter")).toEqual({ open: "system:portal" });
    expect(keyStep(rows, "system:ledger", "Escape")).toEqual({ close: "system:ledger" });
    // Escape on a closed node goes to its parent.
    expect(keyStep(rows, "repo:forge-ledger", "Escape")).toEqual({ focus: "system:ledger" });
    // A node with nothing inside can't be opened: Enter shows its details.
    expect(keyStep(rows, "repo:forge-ledger", "Enter")).toEqual({ select: "repo:forge-ledger" });
    expect(keyStep(rows, "estate", "Home")).toEqual({ focus: "estate" });
    expect(keyStep(rows, "estate", "End")).toEqual({ focus: "system:portal" });
    expect(keyStep(rows, "estate", "x")).toBeUndefined();
  });
});

describe("the picture of one open node", () => {
  it("draws its children and the nodes outside it that edges reach, edges with their count", () => {
    const audit = node("system:audit", "system", 1, "estate");
    const v = view(
      portal,
      [node("repo:a", "repo", 0, "system:portal"), node("repo:b", "repo", 0, "system:portal")],
      [
        { from: "repo:a", to: "repo:b", type: "calls", count: 1 },
        { from: "repo:b", to: "system:audit", type: "calls", count: 3 },
      ],
      [audit],
    );
    const c = canvasView(v, "Portal");
    expect(c.nodes.map((n) => [n.id, n.kind])).toEqual([
      ["repo:a", "component"],
      ["repo:b", "component"],
      ["system:audit", "box"],
    ]);
    expect(c.nodes[2]!.label).toBe("audit (outside)");
    expect(c.edges.map((e) => e.label)).toEqual(["calls", "3 × calls"]);
  });
});

describe("a view's layout file name", () => {
  it("matches the server's view key", () => {
    expect(viewKey("architecture", "system:ledger")).toBe("architecture.system-ledger");
    expect(viewKey("data", "table:ledger-db.entry", "focus")).toBe(
      "data.focus.table-ledger-db.entry",
    );
  });
});
