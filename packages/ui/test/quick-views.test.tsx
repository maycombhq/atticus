import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { ChangeDiagramView } from "../src/screens/work/ChangeDiagram.js";
import { ImpactView } from "../src/screens/work/Impact.js";

/**
 * ADR 0206 part B, 2: a quick change has no target flows; its picture and its impact are read
 * from its design.md's In the code (or, before that, its tasks.md), and say so. No network.
 */

const D = COPY.changeDiagram;
const I = COPY.changeImpact;
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
const ID = "publish-settled-refunds";
const SOURCE = `openspec/changes/${ID}/design.md`;

const MAP: Api.ChangeMapT = {
  change: ID,
  title: "Publish settled refunds",
  source: SOURCE,
  groups: [],
  nodes: [
    { id: "forge-svc-01", label: "◇ forge-svc-01", kind: "component", legend: "modify" },
    {
      id: "forge.items.settled",
      label: "◇ forge.items.settled",
      kind: "component",
      legend: "modify",
    },
  ],
  edges: [
    {
      id: "e1",
      from: "forge-svc-01",
      to: "forge.items.settled",
      label: "+ forge.items.settled",
      async: true,
      legend: "new",
    },
  ],
  mermaid: "flowchart LR\n",
  flows: 0,
  from: "design",
  rows: 2,
  problems: [],
};

const IMPACT: Api.ChangeImpactT = {
  change: ID,
  flows: 0,
  breaks: 0,
  mayBreak: 0,
  routes: 0,
  rule: "constitution.change-links-known",
  items: [],
  owners: [],
  from: "design",
  reaches: [
    {
      line: 15,
      has: "publishes",
      name: "forge.items.settled",
      ids: ["forge-svc-03.on-forge-items-settled"],
      receivers: [{ id: "forge-svc-03", kind: "Component", owner: "team-forge" }],
      further: 2,
    },
    { line: 16, has: "listens", name: "forge.items.settled", ids: [], receivers: [], further: 0 },
  ],
  problems: [],
};

describe("a quick change's picture and impact (ADR 0206)", () => {
  it("the picture says it is drawn from design.md's rows, and offers no architecture stage", () => {
    const out = renderToStaticMarkup(<ChangeDiagramView map={MAP} />);
    expect(out).toContain(esc(D.fromDesign(2, SOURCE)));
    expect(out).not.toContain(esc(D.noTargets(ID)));
    const tasks = renderToStaticMarkup(
      <ChangeDiagramView
        map={{ ...MAP, from: "tasks", source: `openspec/changes/${ID}/tasks.md`, edges: [] }}
      />,
    );
    expect(tasks).toContain(esc(D.fromTasks(`openspec/changes/${ID}/tasks.md`)));
  });

  it("impact lists who each row reaches under its own words, never as breaks", () => {
    const out = renderToStaticMarkup(<ImpactView i={IMPACT} />);
    expect(out).toContain(esc(I.quick));
    expect(out).toContain("design.md:15 (publishes)");
    expect(out).toContain("forge-svc-03 (team-forge)");
    expect(out).toContain(esc(I.notInMap));
    expect(out).toContain(`<caption class="sr">${esc(I.reachesCaption)}</caption>`);
    expect(out).not.toContain(esc(I.noTargets(ID)));
    const none = renderToStaticMarkup(<ImpactView i={{ ...IMPACT, reaches: [] }} />);
    expect(none).toContain(esc(I.quickNoTable(ID)));
  });
});
