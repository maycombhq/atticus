import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { readDrawio, type Diagram } from "@maycombhq/reconcile";
import { readLucidCsv } from "../src/lucid.js";
import { readMermaid } from "../src/mermaid.js";
import { readVsdx } from "../src/vsdx.js";
import { zipFolder } from "./helpers/zip-writer.js";

/**
 * The Forge context diagram redrawn in Lucidchart CSV, Mermaid and Visio. Every format must
 * read to the same edges the hand-written ground truth lists for the draw.io original.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const FIX = join(HERE, "fixtures/forge");
const expected = parse(readFileSync(join(FORGE, "expected/inputs.yaml"), "utf8")) as {
  diagramEdges: Record<string, unknown>[];
};
const PAGE = "Forge context (as the architect drew it)";
const BOXES = [
  "Portal UI",
  "Portal BFF",
  "Ledger Platform",
  "Reports Job",
  "Northwind Pay",
  "Notifications Service",
];

/** Compare every field the ground truth names (cell aside: each tool numbers its own shapes). */
function expectForgeEdges(d: Diagram, checkCells: boolean) {
  expect(d.problems).toEqual([]);
  expect(d.edges).toHaveLength(expected.diagramEdges.length);
  expected.diagramEdges.forEach((want, i) => {
    const got = d.edges[i] as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(want)) {
      if (k === "cell" && !checkCells) continue;
      expect(got[k] ?? null, `${String(want.cell)}.${k}`).toEqual(v);
    }
    // Fields the ground truth leaves out must be absent too (no extra legend, topic, ...).
    for (const k of ["pattern", "method", "path", "topic", "legend"])
      if (!(k in want)) expect(got[k], `${String(want.cell)}.${k}`).toBeUndefined();
    expect(got.page).toBe(PAGE);
  });
}

function expectForgeBoxes(d: Diagram) {
  expect(d.nodes.map((n) => n.label)).toEqual(BOXES);
  expect(d.nodes.filter((n) => n.legend).map((n) => [n.label, n.legend])).toEqual([
    ["Notifications Service", "new"],
  ]);
  expect(d.nodes.every((n) => n.page === PAGE)).toBe(true);
}

describe("the Forge context diagram in other formats (golden: expected/inputs.yaml)", () => {
  it("the draw.io original still reads to the ground truth (sanity check of the comparison)", () => {
    const d = readDrawio(readFileSync(join(FORGE, "inputs/diagrams/forge-context.drawio"), "utf8"));
    expectForgeEdges(d, true);
  });

  it("Lucidchart CSV", () => {
    const d = readLucidCsv(readFileSync(join(FIX, "forge-context.lucid.csv"), "utf8"));
    expectForgeEdges(d, false);
    expectForgeBoxes(d);
    expect(d.edges.map((e) => e.cell)).toEqual(["9", "10", "11", "12", "13", "14", "15"]);
    expect(d.edges.map((e) => e.line)).toEqual([10, 11, 12, 13, 14, 15, 16]);
  });

  it("Mermaid, with edge ids that match the draw.io cells", () => {
    const d = readMermaid(readFileSync(join(FIX, "forge-context.mmd"), "utf8"));
    expectForgeEdges(d, true);
    expectForgeBoxes(d);
    expect(d.edges.map((e) => e.line)).toEqual([13, 14, 15, 16, 17, 18, 19]);
  });

  it("Visio .vsdx", () => {
    const d = readVsdx(zipFolder(join(FIX, "forge-context-vsdx")));
    expectForgeEdges(d, false);
    expectForgeBoxes(d);
    expect(d.edges.map((e) => e.cell)).toEqual([
      "0.7",
      "0.8",
      "0.9",
      "0.10",
      "0.11",
      "0.12",
      "0.13",
    ]);
    expect(d.nodes[0]).toEqual({
      cell: "0.1",
      label: "Portal UI",
      page: PAGE,
      line: 4,
      style: { master: "Rectangle", x: "1", y: "6" },
    });
  });
});
