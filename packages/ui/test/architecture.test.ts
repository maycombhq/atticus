import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import {
  canvasGraph,
  directionFor,
  keyStep,
  legibility,
  openAt,
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
  const audit = node("system:audit", "system", 1, "estate");
  const a = node("repo:a", "repo", 2, "system:portal");
  const b = node("repo:b", "repo", 0, "system:portal");
  const portalView = view(
    portal,
    [a, b],
    [
      { id: "ab", from: "repo:a", to: "repo:b", type: "calls", count: 1 },
      { id: "b-audit", from: "repo:b", to: "system:audit", type: "calls", count: 3 },
      { id: "a-audit", from: "repo:a", to: "system:audit", type: "publishes", count: 1 },
      { id: "aa", from: "repo:a", to: "repo:a", type: "calls", count: 2 },
    ],
    [audit],
  );
  const inner = view(
    a,
    [
      node("component:a.http", "component", 0, "repo:a"),
      node("component:a.jobs", "component", 0, "repo:a"),
    ],
    [
      { id: "http-jobs", from: "component:a.http", to: "component:a.jobs", type: "calls" },
      { id: "jobs-audit", from: "component:a.jobs", to: "system:audit", type: "publishes" },
      { id: "jobs-gone", from: "component:a.jobs", to: "system:elsewhere", type: "calls" },
    ],
  );
  const vs: Views = new Map([
    ["system:portal", portalView],
    ["repo:a", inner],
  ]);

  it("draws its children and the nodes outside it that edges reach, edges with their count", () => {
    const c = canvasGraph(vs, "system:portal", new Set());
    expect(c.boxes.map((n) => [n.id, n.outside, n.group])).toEqual([
      ["repo:a", false, false],
      ["repo:b", false, false],
      ["system:audit", true, false],
    ]);
    expect(c.links.map((e) => [e.id, e.label, e.async])).toEqual([
      ["ab", "calls", false],
      ["b-audit", "3 × calls", false],
      ["a-audit", "publishes", true],
    ]);
    // Calls that start and end on one box are counted on it, not drawn.
    expect(c.boxes[0]!.inside).toBe(2);
  });

  it("opens a child in place as a group around its own children", () => {
    const c = canvasGraph(vs, "system:portal", new Set(["repo:a"]));
    expect(c.boxes.map((n) => [n.id, n.parent ?? "", n.group])).toEqual([
      ["repo:a", "", true],
      ["component:a.http", "repo:a", false],
      ["component:a.jobs", "repo:a", false],
      ["repo:b", "", false],
      ["system:audit", "", false],
    ]);
    // The lifted edge from the part is replaced by the sharper one from inside it; an edge to
    // a box that isn't drawn is left out.
    expect(c.links.map((e) => e.id)).toEqual(["ab", "b-audit", "http-jobs", "jobs-audit"]);
  });

  it("in focus draws the node and its neighbours", () => {
    const c = canvasGraph(vs, "system:portal", new Set(), {
      lens: "data",
      node: audit,
      path: [],
      neighbours: [b],
      edges: portalView.edges.filter((e) => e.id === "b-audit"),
    });
    expect(c.boxes.map((n) => n.id)).toEqual(["system:audit", "repo:b"]);
    expect(c.links.map((e) => e.id)).toEqual(["b-audit"]);
  });

  it("lays context out downwards and flows across", () => {
    expect(directionFor("architecture")).toBe("DOWN");
    expect(directionFor("integration")).toBe("RIGHT");
    expect(directionFor("data")).toBe("RIGHT");
  });
});

describe("a picture too big to read", () => {
  const big = node("repo:big", "repo", 9, "system:portal");
  const small = node("repo:small", "repo", 2, "system:portal");
  it("says nothing when the layout is within the limits and the API suggests nothing", () => {
    expect(legibility([], undefined, new Set(), [big])).toBeUndefined();
  });
  it("offers focus when the API suggests it", () => {
    expect(legibility([], { mode: "focus", id: "table:ledger-db.entry" }, new Set(), [])).toEqual({
      mode: "focus",
      id: "table:ledger-db.entry",
      why: "api",
    });
  });
  it("offers to close parts opened in place, else to open the biggest part", () => {
    expect(legibility(["nodes"], undefined, new Set(["repo:big"]), [big, small])).toEqual({
      mode: "collapse",
      why: "nodes",
    });
    expect(legibility(["crossings"], undefined, new Set(), [small, big])).toEqual({
      mode: "group",
      id: "repo:big",
      why: "crossings",
    });
    expect(legibility([], { mode: "group" }, new Set(), [])).toEqual({ mode: "group", why: "api" });
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

describe("a link to one node (#/architecture?node=<id>, ADR 0091)", () => {
  const comp = node("component:ledger-api", "component", 3, "repo:forge-ledger");
  const table = node("table:ledger.entries", "table", 0, "component:ledger-api");
  const withPath = (v: Api.GraphNodeViewT, path: Api.HierNodeT[]) => ({ ...v, path });

  it("opens a node that has parts, with its ancestors open in the outline", () => {
    expect(openAt(withPath(view(comp, [table]), [estate, ledger, repo]))).toEqual({
      current: "component:ledger-api",
      expanded: ["estate", "system:ledger", "repo:forge-ledger", "component:ledger-api"],
      selected: "component:ledger-api",
    });
  });

  it("opens the parent of a node that has none, with the node picked", () => {
    expect(openAt(withPath(view(table, []), [estate, ledger, repo, comp]))).toEqual({
      current: "component:ledger-api",
      expanded: ["estate", "system:ledger", "repo:forge-ledger", "component:ledger-api"],
      selected: "table:ledger.entries",
    });
  });

  it("opens the estate for the estate itself", () => {
    expect(openAt(view(estate, [ledger, portal]))).toEqual({
      current: "estate",
      expanded: ["estate"],
      selected: "estate",
    });
  });
});

describe("a gap every part of the picture shares", () => {
  const gappy = (id: string, gaps: string[]) => ({ ...node(id, "component", 0, "repo:x"), gaps });
  const x = node("repo:x", "repo", 3, "system:s");

  it("is said once for the picture, not on every box", () => {
    const g = canvasGraph(
      new Map([
        [
          "repo:x",
          view(x, [
            gappy("component:x.a", ["no-system", "inferred"]),
            gappy("component:x.b", ["no-system"]),
            gappy("component:x.c", ["no-system"]),
          ]),
        ],
      ]),
      "repo:x",
      new Set(),
    );
    expect(g.shared).toEqual(["no-system"]);
    expect(g.boxes.map((b) => b.gaps)).toEqual([["inferred"], [], []]);
  });

  it("stays on the box when only some parts have it, or there is one part", () => {
    const some = canvasGraph(
      new Map([
        ["repo:x", view(x, [gappy("component:x.a", ["no-system"]), gappy("component:x.b", [])])],
      ]),
      "repo:x",
      new Set(),
    );
    expect(some.shared).toEqual([]);
    expect(some.boxes[0]!.gaps).toEqual(["no-system"]);
    const one = canvasGraph(
      new Map([["repo:x", view(x, [gappy("component:x.a", ["no-system"])])]]),
      "repo:x",
      new Set(),
    );
    expect(one.shared).toEqual([]);
  });
});

describe("the outline says a gap every part shares once (ADR 0097 follow-up)", () => {
  const g = (id: string, gaps: string[]) => ({ ...node(id, "component", 0, "repo:x"), gaps });
  const x = { ...node("repo:x", "repo", 3, "estate"), gaps: [] };
  const vs: Views = new Map([
    ["estate", view(estate, [x])],
    [
      "repo:x",
      view(x, [
        g("component:a", ["no-system", "inferred"]),
        g("component:b", ["no-system"]),
        g("component:c", ["no-system"]),
      ]),
    ],
  ]);

  it("puts it on the node they are inside, and takes it off each part", () => {
    const rows = outlineRows(vs, "estate", new Set(["estate", "repo:x"]));
    expect(rows.map((r) => [r.node.id, r.gaps, r.inside])).toEqual([
      ["estate", [], []],
      ["repo:x", [], ["no-system"]],
      ["component:a", ["inferred"], []],
      ["component:b", [], []],
      ["component:c", [], []],
    ]);
  });
});
