import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { screenOf } from "../src/app/screens.js";
import { ChangeDiagramView, diagramGraph } from "../src/screens/work/ChangeDiagram.js";

/** The Change diagram (ADR 0108): a change's picture, its parts and lines, and its Mermaid. */

const D = COPY.changeDiagram;
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const MAP: Api.ChangeMapT = {
  change: "add-transfer-limit",
  title: "Daily transfer limit",
  source: "openspec/changes/add-transfer-limit/target-flows",
  groups: [
    { id: "ledger", label: "Ledger", kind: "system" },
    { id: "audit", label: "Audit", kind: "system" },
  ],
  nodes: [
    {
      id: "ledger-api",
      label: "◇ ledger-api",
      kind: "component",
      group: "ledger",
      legend: "modify",
    },
    { id: "limits-svc", label: "+ limits-svc", kind: "component", legend: "new" },
  ],
  edges: [
    {
      id: "change.ledger-api.limits-svc.post-checks",
      from: "ledger-api",
      to: "limits-svc",
      label: "+ POST /checks",
      async: false,
      legend: "new",
    },
    {
      id: "change.ledger-api.audit-svc.events",
      from: "ledger-api",
      to: "audit-svc",
      label: "✕ POST /events",
      async: true,
      legend: "retire",
    },
  ],
  mermaid: 'flowchart LR\n  limits_svc["+ limits-svc"]\n',
  flows: 1,
  problems: ["target-flows/broken.yaml: flow: Required"],
};

describe("the Change diagram (ADR 0108)", () => {
  it("is a screen under More, in Design", () => {
    expect(screenOf("#/change-diagram?change=add-transfer-limit")).toMatchObject({
      id: "change-diagram",
      group: "Design",
    });
  });

  it("puts each part in its group, keeps each mark, and leaves out groups with nothing in them", () => {
    const g = diagramGraph(MAP);
    expect(g.boxes.map((b) => b.id)).toEqual(["ledger", "ledger-api", "limits-svc"]);
    expect(g.boxes.find((b) => b.id === "ledger")).toMatchObject({ group: true });
    expect(g.boxes.find((b) => b.id === "ledger-api")).toMatchObject({
      parent: "ledger",
      mark: "modify",
    });
    expect(g.boxes.find((b) => b.id === "limits-svc")).toMatchObject({ mark: "new" });
    expect(g.links.map((l) => [l.id, l.mark, l.async])).toEqual([
      ["change.ledger-api.limits-svc.post-checks", "new", false],
      ["change.ledger-api.audit-svc.events", "retire", true],
    ]);
  });

  it("says each mark in words: the legend, and a table of every part and every line", () => {
    const out = renderToStaticMarkup(<ChangeDiagramView map={MAP} />);
    for (const k of [D.legendNew, D.legendModify, D.legendRetire, D.legendContext])
      expect(out).toContain(esc(k));
    expect(out).toContain('<th scope="col">' + D.col.part + "</th>");
    expect(out).toMatch(
      /<tr class="m-new"><td class="mono">limits-svc<\/td>.*?<td>New<\/td><\/tr>/,
    );
    expect(out).toMatch(
      /<td class="mono">✕ POST \/events<\/td><td class="mono">audit-svc<\/td><td>Retired<\/td>/,
    );
    expect(out).toContain(esc(D.from(1, MAP.source)));
    expect(out).toContain("target-flows/broken.yaml: flow: Required");
  });

  it("gives the same picture as Mermaid, in a box the keyboard reaches, with a copy button", () => {
    const out = renderToStaticMarkup(<ChangeDiagramView map={MAP} />);
    expect(out).toContain('<pre tabindex="0"');
    expect(out).toContain(esc('limits_svc["+ limits-svc"]'));
    expect(out).toContain(esc(D.copyMermaid));
  });

  it("with no target flows yet, says so and gives the command that writes them", () => {
    const out = renderToStaticMarkup(
      <ChangeDiagramView map={{ ...MAP, flows: 0, nodes: [], edges: [], groups: [] }} />,
    );
    expect(out).toContain(esc(D.noTargets("add-transfer-limit")));
    expect(out).toContain("atticus change architecture add-transfer-limit");
    expect(out).not.toContain(esc(D.parts));
  });
});
