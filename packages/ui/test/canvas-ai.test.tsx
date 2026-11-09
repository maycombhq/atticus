import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { DecisionsContext, staticDecisions, type Decisions } from "../src/app/decisions.js";
import { flowElements } from "../src/screens/architecture/Canvas.js";
import {
  aiJoins,
  canvasGraph,
  linkBy,
  linkCounts,
  type CanvasGraph,
  type Views,
} from "../src/screens/architecture/model.js";
import { AiLayer, LinkKinds } from "../src/screens/architecture/Tools.js";
import {
  ALL_LAYERS,
  isOnlyAi,
  layerOf,
  onlyAi,
  toDrawio,
  toMermaid,
  toSvg,
  withLayers,
} from "../src/screens/architecture/canvas-tools.js";
import { LinkInspector } from "../src/screens/architecture/WhyLinked.js";

/**
 * ADR 0181 on the canvas: a link the AI paired is drawn on its own "Detected by AI" layer (on by
 * default), dotted with ◆ and the words, never colour alone; the layer can be the only one shown;
 * the picture's links are counted from code, by a person and by AI; picking an AI link shows the
 * chip with its run and Correct. The invented Forge estate: the AI paired forge-billing's capture
 * call with forge-payments; forge-portal calls forge-ledger by its host; a person paired the
 * reports job with the ledger.
 */

const A = COPY.canvasAi;
const D = COPY.decisions;
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

const node = (id: string, label: string, kind = "repo"): Api.HierNodeT => ({
  id,
  kind: kind as Api.HierNodeT["kind"],
  label,
  childCount: 0,
  state: "current",
  gaps: [],
  evidence: [],
  properties: {},
});

const join = (o: Partial<Api.HierJoinT> & Pick<Api.HierJoinT, "interface" | "how">) => ({
  from: "billing",
  to: "payments",
  gateway: false,
  verified: false,
  caller: [],
  callee: [],
  hops: [],
  other: [],
  ...o,
});

const AI_JOIN: Api.HierJoinT = join({
  interface: "interface:billing->payments:post:/charges/{id}/capture",
  how: "ai",
  run: "run-match-0007",
  method: "POST",
  path: "/charges/{id}/capture",
  caller: [
    {
      source: "ai",
      repo: "forge-billing",
      at: "src/main/java/forge/billing/ChargeClient.java:41",
    },
  ],
});
const HOST_JOIN: Api.HierJoinT = join({
  interface: "interface:billing->payments:get:/charges/{id}",
  how: "host",
  verified: true,
  caller: [{ source: "code", repo: "forge-billing", at: "src/Charges.java:9" }],
});

const edge = (
  id: string,
  from: string,
  to: string,
  joins: Api.HierJoinT[],
  o: Partial<Api.HierEdgeT> = {},
): Api.HierEdgeT => ({
  id,
  from,
  to,
  type: "calls",
  count: joins.length || 1,
  state: "current",
  gaps: [],
  evidence: [],
  joins,
  ...o,
});

const AI_EDGE = edge("e-ai", "repo:forge-billing", "repo:forge-payments", [AI_JOIN], {
  gaps: ["inferred"],
});
const MIXED_EDGE = edge("e-mixed", "repo:forge-billing", "repo:forge-ledger", [
  { ...AI_JOIN, to: "ledger" },
  { ...HOST_JOIN, to: "ledger" },
]);
const CODE_EDGE = edge("e-code", "repo:forge-portal", "repo:forge-ledger", [HOST_JOIN]);
const PAIRED_EDGE = edge("e-paired", "repo:forge-reports", "repo:forge-ledger", [
  { ...HOST_JOIN, how: "person" },
]);

const views: Views = new Map([
  [
    "estate",
    {
      lens: "architecture",
      node: { ...node("estate", "Estate", "estate"), childCount: 5 },
      path: [],
      children: [
        node("repo:forge-billing", "forge-billing"),
        node("repo:forge-payments", "forge-payments"),
        node("repo:forge-ledger", "forge-ledger"),
        node("repo:forge-portal", "forge-portal"),
        node("repo:forge-reports", "forge-reports"),
      ],
      outside: [],
      edges: [AI_EDGE, MIXED_EDGE, CODE_EDGE, PAIRED_EDGE],
      reduced: true,
      hiddenEdges: 0,
    },
  ],
]);

const graph = (): CanvasGraph => canvasGraph(views, "estate", new Set());
const linkOf = (g: CanvasGraph, id: string) => g.links.find((l) => l.id === id)!;

describe("the canvas knows a link the AI paired (C4 2.82.0, `how: ai`)", () => {
  it("counts the AI's calls on a link, with the run of the first", () => {
    expect(aiJoins(AI_EDGE)).toEqual({ n: 1, run: "run-match-0007" });
    expect(aiJoins(MIXED_EDGE)).toEqual({ n: 1, run: "run-match-0007" });
    expect(aiJoins(CODE_EDGE)).toEqual({ n: 0 });
    // A join written before 2.82.0 still says it by its caller line's `source: ai`.
    expect(aiJoins({ joins: [{ ...AI_JOIN, how: "unknown", run: undefined }] }).n).toBe(1);
  });

  it("marks the link in words with ◆, and how many of its calls when not all", () => {
    const g = graph();
    expect(linkOf(g, "e-ai")).toMatchObject({ ai: 1, run: "run-match-0007" });
    expect(linkOf(g, "e-ai").label).toBe(`calls · ${A.mark(1, 1)}`);
    expect(A.mark(1, 1)).toContain("◆");
    expect(A.mark(1, 1)).toContain(D.chip);
    expect(linkOf(g, "e-mixed").label).toContain(A.mark(1, 2));
    expect(A.mark(1, 2)).not.toBe(A.mark(1, 1));
    expect(linkOf(g, "e-code").ai).toBeUndefined();
    expect(linkOf(g, "e-code").label).toBe("calls");
  });

  it("says who made each link, the AI first, and counts them three ways", () => {
    const g = graph();
    expect(g.links.map((l) => [l.id, linkBy(l)])).toEqual([
      ["e-ai", "ai"],
      ["e-mixed", "ai"],
      ["e-code", "code"],
      ["e-paired", "person"],
    ]);
    expect(linkCounts(g.links)).toEqual({ fromCode: 1, byPerson: 1, byAi: 2 });
  });
});

describe("the Detected by AI layer", () => {
  it("is a layer of its own, on by default, ahead of the guesses an AI link also is", () => {
    const g = graph();
    expect(ALL_LAYERS.ai).toBe(true);
    expect(g.links.map(layerOf)).toEqual(["ai", "ai", "verified", "paired"]);
    expect(withLayers(g, { ...ALL_LAYERS, ai: false }).links.map((l) => l.id)).toEqual([
      "e-code",
      "e-paired",
    ]);
  });

  it("can be the only layer of links shown, and back to every layer", () => {
    const only = onlyAi(ALL_LAYERS);
    expect(isOnlyAi(only)).toBe(true);
    expect(isOnlyAi(ALL_LAYERS)).toBe(false);
    // Boxes stay as they were: outside systems and topics are boxes, not links.
    expect(only.outside).toBe(true);
    expect(only.topics).toBe(true);
    expect(withLayers(graph(), only).links.map((l) => l.id)).toEqual(["e-ai", "e-mixed"]);
    expect(onlyAi(only)).toEqual(ALL_LAYERS);
  });

  it("says its name in the layers, a legend entry, the only-AI filter and each AI link as a button", () => {
    const g = graph();
    const out = html(
      <AiLayer
        graph={g}
        layers={ALL_LAYERS}
        onLayers={() => undefined}
        onPick={() => undefined}
        labelOf={(id) => id.replace(/^repo:/, "")}
      />,
    );
    expect(COPY.canvasTools.layer.ai).toBe(D.chip);
    expect(out).toContain(esc(A.title));
    expect(out).toContain(esc(A.legendAi));
    expect(out).toContain(`aria-pressed="false"`);
    expect(out).toContain(esc(A.only));
    expect(out).toContain(esc(A.listed(2)));
    expect(out).toContain(esc(A.pick("forge-billing", "forge-payments")));
    // The sample line is dotted, with the shape, not colour alone.
    expect(out).toContain('stroke-dasharray="1 4"');
    expect(out).toContain("◆");
  });

  it("says so when the picture has no AI link, and when only AI links are asked for", () => {
    const none = { ...graph(), links: graph().links.filter((l) => !l.ai) };
    const props = {
      onLayers: () => undefined,
      onPick: () => undefined,
      labelOf: (id: string) => id,
    };
    expect(html(<AiLayer graph={none} layers={ALL_LAYERS} {...props} />)).toContain(esc(A.none));
    const only = html(<AiLayer graph={none} layers={onlyAi(ALL_LAYERS)} {...props} />);
    expect(only).toContain(esc(A.noneOnly));
    expect(only).toContain('aria-pressed="true"');
  });
});

describe("the canvas counts its links three ways, with a legend", () => {
  it("says from code, by a person and by AI, and how each is drawn", () => {
    const out = html(<LinkKinds links={graph().links} />);
    expect(out).toContain(esc(D.counts.line({ fromCode: 1, byPerson: 1, byAi: 2 })));
    expect(out).toContain(esc(A.legendCode));
    expect(out).toContain(esc(A.legendPerson));
    expect(out).toContain(esc(A.legendAi));
  });

  it("says nothing for a picture with no links", () => {
    expect(html(<LinkKinds links={[]} />)).toBe("");
  });
});

describe("drawing an AI link", () => {
  it("names it in the edge's spoken label, never colour alone", () => {
    const g = graph();
    const laid = {
      boxes: Object.fromEntries(
        g.boxes.map((b, i) => [b.id, { x: i * 200, y: 0, width: 160, height: 64 }]),
      ),
      routes: {},
      over: [],
      score: { nodes: g.boxes.length, crossings: 0 },
    } as unknown as Parameters<typeof flowElements>[1];
    const { edges } = flowElements(g, laid, "RIGHT");
    expect(edges.find((e) => e.id === "e-ai")!.ariaLabel).toContain(D.chip);
    expect(edges.find((e) => e.id === "e-code")!.ariaLabel).not.toContain(D.chip);
  });

  it("exports it dotted, apart from a person's dashes, with its words, the same each time", () => {
    const g = graph();
    const at = (id: string) => ({
      x: g.boxes.findIndex((b) => b.id === id) * 200,
      y: 0,
      width: 160,
      height: 60,
    });
    const m = toMermaid(g);
    expect(m).toContain(
      `n_repo_forge_billing -.->|"calls · ${A.mark(1, 1)}"| n_repo_forge_payments`,
    );
    const d = toDrawio(g, at);
    expect(d).toContain("dashed=1;dashPattern=1 4;");
    expect(d).toContain(esc(`calls · ${A.mark(1, 1)}`));
    const s = toSvg(g, at);
    expect(s).toContain('stroke-dasharray="1 4"');
    expect(s).toContain('stroke-dasharray="6 4"');
    expect(toDrawio(g, at)).toBe(d);
    expect(toSvg(g, at)).toBe(s);
  });
});

const LINK_DECISION: Api.AiDecisionItemT = {
  kind: "link",
  item: "link:forge-billing:call.post.charges-capture",
  repo: "forge-billing",
  what: "forge-billing POST captureChargePath → forge-payments POST /charges/{id}/capture",
  decided: "forge-payments.post.charges-capture",
  call: {
    fact: "call.post.charges-capture",
    file: "src/main/java/forge/billing/ChargeClient.java",
    line: 41,
    value: "captureChargePath",
  },
  to: { repo: "forge-payments", method: "POST", path: "/charges/{id}/capture" },
  runtime: "copilot-acp",
  run: "run-match-0007",
  bar: "confident",
  batch: "b-20261108-101500-a1b2c3",
  at: "2026-11-08T10:15:00Z",
  cites: ["forge-billing src/main/java/forge/billing/ChargeClient.java:41"],
};
const DECISIONS: Api.DecisionsViewT = {
  decide: {
    configured: { links: "auto", questions: "propose", minPrecision: 0.95 },
    now: { links: "auto", questions: "propose" },
    precision: {
      drawn: 0,
      right: 0,
      wrong: 0,
      unsure: 0,
      open: 0,
      gone: 0,
      precision: null,
      low: null,
      high: null,
    },
  },
  links: { counts: { fromCode: 1, byPerson: 1, byAi: 1 }, items: [LINK_DECISION] },
  questions: { counts: { fromCode: 0, byPerson: 0, byAi: 0 }, items: [] },
  batches: [],
  problems: [],
};

const inspect = (d: Decisions, link: Api.HierEdgeT | undefined) =>
  html(
    <DecisionsContext.Provider value={d}>
      <LinkInspector
        link={link}
        labelOf={(id) => id.replace(/^repo:/, "")}
        onClose={() => undefined}
      />
    </DecisionsContext.Provider>,
  );

describe("picking an AI link", () => {
  it("shows the link, the Detected by AI chip with its run, and Correct", () => {
    const out = inspect(staticDecisions(DECISIONS), AI_EDGE);
    expect(out).toContain(esc(A.linkTitle("forge-billing", "forge-payments", "calls")));
    expect(out).toContain(esc(D.chip));
    expect(out).toContain(esc(D.run("run-match-0007")));
    expect(out).toContain(esc(D.correctOf(LINK_DECISION.what)));
    expect(out).toContain(esc(A.close));
    // The inspector's heading takes the focus when a link is picked from the keyboard.
    expect(out).toContain('tabindex="-1"');
  });

  it("says the AI's decisions are loading, or why they couldn't be read, the chip still there", () => {
    const loading: Decisions = {
      view: { state: "loading" },
      need: () => undefined,
      reload: () => undefined,
    };
    const l = inspect(loading, AI_EDGE);
    expect(l).toContain(esc(D.loading));
    expect(l).toContain(esc(D.chip));
    const failed: Decisions = {
      view: { state: "error", error: "the server stopped" },
      need: () => undefined,
      reload: () => undefined,
    };
    const f = inspect(failed, AI_EDGE);
    expect(f).toContain('role="alert"');
    expect(f).toContain(esc(D.failed("the server stopped")));
    // The run is known from the link itself.
    expect(f).toContain(esc(D.run("run-match-0007")));
  });

  it("says when the link is no longer on the picture", () => {
    expect(inspect(staticDecisions(DECISIONS), undefined)).toContain(esc(A.gone));
  });

  it("asks for no decisions for a link nobody's AI made", () => {
    const out = inspect(staticDecisions(DECISIONS), CODE_EDGE);
    expect(out).not.toContain(esc(D.chip));
    expect(out).not.toContain(esc(D.loading));
  });
});
