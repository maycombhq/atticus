import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import {
  connectChoices,
  connectDrawn,
  drawnBoxOf,
} from "../src/screens/architecture/Architecture.js";
import { boxUnder, connectEndOf } from "../src/screens/architecture/Canvas.js";
import { boxesWith, ConnectPanel, undoneWords } from "../src/screens/architecture/Connect.js";

/**
 * Review round 2 (beta.23): an arrow dragged from one box and dropped on another opens Connect
 * with that box picked, or says why it connects nothing; never silently nothing, never a box
 * hidden under an overlay, never an outside system made of a product system. On the invented
 * Forge estate: Ledger and Reports hold one repo each, Portal two, Northwind Pay is a vendor.
 */

const C = COPY.connect;
const un = (h: string) =>
  h
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

const sys = (id: string, repos: string[] | undefined, boundary = "product"): Api.HierNodeT =>
  ({
    id: `system:${id}`,
    kind: "system",
    label: id,
    state: "current",
    gaps: [],
    evidence: [],
    childCount: repos?.length ?? 0,
    properties: { boundary, ...(repos ? { repos } : {}) },
  }) as Api.HierNodeT;
const repo = (name: string): Api.HierNodeT =>
  ({
    id: `repo:${name}`,
    kind: "repo",
    label: name,
    state: "current",
    gaps: [],
    evidence: [],
    childCount: 0,
    properties: { name },
  }) as Api.HierNodeT;
const view = (node: Api.HierNodeT, children: Api.HierNodeT[], outside: Api.HierNodeT[] = []) =>
  ({ node, children, outside, edges: [], path: [] }) as unknown as Api.GraphNodeViewT;

const ledger = sys("ledger", ["forge-ledger"]);
const reports = sys("reports", ["forge-reports"]);
const portal = sys("portal", ["forge-portal-bff", "forge-portal-web"]);
const northwind = sys("northwind-pay", undefined, "vendor");
const synthesized = sys("model-provider", undefined, "outside");
const estateNode = {
  id: "estate",
  kind: "estate",
  label: "Estate",
  state: "current",
  gaps: [],
  evidence: [],
  childCount: 4,
  properties: {},
} as Api.HierNodeT;

describe("the box a drawn line means (drawnBoxOf)", () => {
  it("a system of one repo is that repo; an outside system is itself", () => {
    expect(drawnBoxOf(ledger)).toEqual({ repo: "forge-ledger" });
    expect(drawnBoxOf(northwind)).toEqual({ system: "northwind-pay" });
    expect(drawnBoxOf(synthesized)).toEqual({ system: "model-provider" });
    expect(drawnBoxOf(repo("forge-billing"))).toEqual({ repo: "forge-billing" });
  });

  it("a product system of several repos, or none, is no one box (never an outside system)", () => {
    expect(drawnBoxOf(portal)).toBeUndefined();
    expect(drawnBoxOf(sys("empty", undefined))).toBeUndefined();
  });

  it("a system no estate repo is in (another team's) is an outside system", () => {
    expect(drawnBoxOf(sys("risk", undefined, "internal"))).toEqual({ system: "risk" });
  });
});

describe("what a drawn line opens (connectDrawn)", () => {
  it("on the estate view, Ledger to Reports opens Connect from forge-ledger with forge-reports picked", () => {
    expect(connectDrawn(ledger, reports)).toEqual({
      from: "forge-ledger",
      initial: { label: "repo: forge-reports", box: { repo: "forge-reports" } },
    });
  });

  it("drawn from an outside system to a repo, the ends swap", () => {
    expect(connectDrawn(northwind, ledger)).toEqual({
      from: "forge-ledger",
      initial: { label: "system: northwind-pay", box: { system: "northwind-pay" } },
    });
  });

  it("a product system of several repos at either end is said, never swapped into an outside system", () => {
    expect(connectDrawn(portal, ledger)).toEqual({ say: C.dropNeedsRepo });
    expect(connectDrawn(ledger, portal)).toEqual({ say: C.dropNeedsRepo });
    expect(connectDrawn(northwind, synthesized)).toEqual({ say: C.dropNeedsRepo });
    expect(connectDrawn(ledger, repo("forge-ledger"))).toEqual({ say: C.dropSameRepo });
  });
});

describe("Connect to…'s list (connectChoices, boxesWith)", () => {
  it("names a system of one repo by its repo, skips one of several, and lists the boxes outside the opened one", () => {
    const views = new Map([
      ["estate", view(estateNode, [ledger, reports, portal, northwind])],
      ["system:portal", view(portal, [repo("forge-portal-bff")], [sys("audit", ["forge-audit"])])],
    ]);
    expect(connectChoices(views).map((b) => b.box)).toEqual([
      { repo: "forge-audit" },
      { repo: "forge-ledger" },
      { repo: "forge-portal-bff" },
      { repo: "forge-reports" },
      { system: "northwind-pay" },
    ]);
  });

  it("always holds the box a line was dropped on, picked when the panel opens", () => {
    const dropped = { label: "repo: forge-reports", box: { repo: "forge-reports" } };
    expect(boxesWith([], dropped)).toEqual([dropped]);
    expect(boxesWith([dropped], dropped)).toEqual([dropped]);
    const html = un(
      renderToStaticMarkup(
        <ConnectPanel from="forge-ledger" boxes={[]} initial={dropped} onClose={() => {}} />,
      ),
    );
    expect(html).toMatch(/<option value="repo:forge-reports" selected="">repo: forge-reports/);
  });
});

/** A fake element: what it is inside, by class, and its node id. */
const el = (inside: string[], id?: string) =>
  ({
    closest: (sel: string) => {
      const hit = sel.split(",").some((s) => inside.includes(s.trim().slice(1)));
      if (!hit) return null;
      return { getAttribute: (k: string) => (k === "data-id" ? (id ?? null) : null) };
    },
  }) as unknown as Element;
const drop = { clientX: 10, clientY: 20 } as MouseEvent;

describe("the box under a drop (boxUnder)", () => {
  const node = el(["react-flow", "react-flow__node"], "system:reports");
  it("looks through the line being drawn and the links to the box", () => {
    const line = el(["react-flow", "react-flow__connectionline"]);
    const link = el(["react-flow", "react-flow__edges"]);
    expect(boxUnder(drop, () => [line, link, node])).toBe("system:reports");
  });

  it("finds no box under the inspector, the Connect panel or the minimap", () => {
    const aside = el(["viewer-aside"]);
    const minimap = el(["react-flow", "react-flow__panel", "react-flow__minimap"]);
    expect(boxUnder(drop, () => [aside, node])).toBeUndefined();
    expect(boxUnder(drop, () => [minimap, node])).toBeUndefined();
  });

  it("reads a touch's point, and nothing without one", () => {
    const touch = { changedTouches: [{ clientX: 1, clientY: 2 }] } as unknown as TouchEvent;
    expect(boxUnder(touch, () => [node])).toBe("system:reports");
    expect(boxUnder({} as MouseEvent, () => [node])).toBeUndefined();
  });
});

describe("a line dropped off a dot (connectEndOf)", () => {
  const under = () => "system:reports";
  it("from an outgoing dot: this box calls the other", () => {
    expect(
      connectEndOf(
        drop,
        { isValid: false, fromNode: { id: "system:ledger" }, fromHandle: { type: "source" } },
        under,
      ),
    ).toEqual(["system:ledger", "system:reports"]);
  });

  it("from an incoming dot: the other box calls this one, as xyflow reads a drop on a dot", () => {
    expect(
      connectEndOf(
        drop,
        { isValid: false, fromNode: { id: "system:ledger" }, fromHandle: { type: "target" } },
        under,
      ),
    ).toEqual(["system:reports", "system:ledger"]);
  });

  it("nothing when xyflow connected it already, on the same box, or on no box", () => {
    const from = { fromNode: { id: "system:ledger" }, fromHandle: { type: "source" } };
    expect(connectEndOf(drop, { ...from, isValid: true }, under)).toBeUndefined();
    expect(connectEndOf(drop, { ...from, isValid: false }, () => "system:ledger")).toBeUndefined();
    expect(connectEndOf(drop, { ...from, isValid: false }, () => undefined)).toBeUndefined();
  });
});

describe("what Undo did", () => {
  it("says the lines are removed, and when the rule was written, that its answer stays and how to take it back", () => {
    expect(undoneWords({})).toBe(C.undone);
    const w = undoneWords({
      rule: { question: "q-forge-ledger-targets", match: "/**", target: "forge-reports" },
    });
    expect(w).toContain("q-forge-ledger-targets");
    expect(w).toContain("forge-reports");
    expect(w).toMatch(/not undone/);
  });
});
