import { readFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { drawioIngestor, readDrawio } from "../src/drawio.js";

const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge");
const XML = readFileSync(join(FORGE, "inputs/diagrams/forge-context.drawio"), "utf8");
const expected = parse(readFileSync(join(FORGE, "expected/inputs.yaml"), "utf8")) as {
  diagramEdges: Record<string, unknown>[];
};

describe("the draw.io reader (golden: expected/inputs.yaml)", () => {
  it("reads every edge with its ends, pattern, method and path or topic, and legend", () => {
    const d = readDrawio(XML);
    expect(d.edges).toHaveLength(expected.diagramEdges.length);
    for (const want of expected.diagramEdges) {
      const got = d.edges.find((e) => e.cell === want.cell) as unknown as Record<string, unknown>;
      expect(got, String(want.cell)).toBeDefined();
      for (const [k, v] of Object.entries(want))
        expect(got[k] ?? null, `${String(want.cell)}.${k}`).toEqual(v);
    }
  });

  it("reads the boxes, their legend and which page they are on", () => {
    const d = readDrawio(XML);
    expect(d.nodes.map((n) => n.label)).toEqual([
      "Portal UI",
      "Portal BFF",
      "Ledger Platform",
      "Reports Job",
      "Northwind Pay",
      "Notifications Service",
    ]);
    expect(d.nodes.find((n) => n.label === "Notifications Service")!.legend).toBe("new");
    expect(d.nodes.every((n) => n.page === "Forge context (as the architect drew it)")).toBe(true);
    expect(d.nodes[0]!.line).toBe(7);
  });

  it("reads compressed diagrams the same way", () => {
    const inner = XML.slice(
      XML.indexOf("<mxGraphModel>"),
      XML.indexOf("</mxGraphModel>") + "</mxGraphModel>".length,
    );
    const packed = deflateRawSync(Buffer.from(encodeURIComponent(inner))).toString("base64");
    const compressed = `<mxfile><diagram id="ctx" name="Forge context (as the architect drew it)">${packed}</diagram></mxfile>`;
    const a = readDrawio(XML);
    const b = readDrawio(compressed);
    expect(b.edges.map(({ line: _l, ...e }) => e)).toEqual(a.edges.map(({ line: _l, ...e }) => e));
  });

  it("handles HTML labels, wrapped objects, labels on edge children, grouped boxes and legend markers in text", () => {
    const xml = `<mxfile><diagram name="p1"><mxGraphModel><root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <object id="a" label="&lt;b&gt;Billing&lt;/b&gt;&lt;br&gt;Service"><mxCell vertex="1" parent="1" style="html=1;"/></object>
      <mxCell id="g" value="Group" vertex="1" parent="1" style="group"/>
      <mxCell id="b" value="Pay&amp;nbsp;Hub [New]" vertex="1" parent="g"/>
      <mxCell id="b1" value="" vertex="1" parent="b" style="text"/>
      <mxCell id="e" value="" edge="1" source="a" target="b1" parent="1"/>
      <mxCell id="e-l" value="S.GW.SOR&lt;br&gt;POST /pay" vertex="1" connectable="0" parent="e" style="edgeLabel"/>
      <mxCell id="loose" value="dangling" edge="1" source="a" parent="1"/>
    </root></mxGraphModel></diagram></mxfile>`;
    const d = readDrawio(xml);
    expect(d.nodes.map((n) => [n.cell, n.label, n.legend ?? null])).toEqual([
      ["a", "Billing Service", null],
      ["g", "Group", null],
      ["b", "Pay Hub", "new"],
    ]);
    expect(d.edges).toEqual([
      {
        cell: "e",
        from: "Billing Service",
        to: "Pay Hub",
        label: "S.GW.SOR POST /pay",
        pattern: "S.GW.SOR",
        method: "POST",
        path: "/pay",
        page: "p1",
        line: 7,
      },
    ]);
    expect(d.problems).toEqual([{ cell: "loose", message: "edge has no target box" }]);
  });

  it("is an ingestor that records the diagram as a source document", async () => {
    expect(drawioIngestor.sniff("x.drawio", new TextEncoder().encode("<mxfile"))).toBe(1);
    expect(drawioIngestor.sniff("x.xml", new TextEncoder().encode("<project"))).toBe(0);
    const out = [];
    for await (const r of drawioIngestor.ingest(
      "inputs/diagrams/forge-context.drawio",
      new TextEncoder().encode(XML),
      { dialects: [], scannedAt: "2026-10-18T09:00:00Z", warn: () => {} },
    ))
      out.push(r);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: "SourceDocument",
      id: "doc.forge-context",
      docType: "diagram",
      path: "inputs/diagrams/forge-context.drawio",
      confidence: "verified",
    });
  });
});
