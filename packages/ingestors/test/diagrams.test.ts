import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Diagram } from "@maycombhq/reconcile";
import { readLucidCsv, parseCsv } from "../src/lucid.js";
import { readMermaid } from "../src/mermaid.js";
import { readVsdx } from "../src/vsdx.js";
import { readDiagram } from "../src/diagram.js";
import { writeZip, zipFolder } from "./helpers/zip-writer.js";
import { ZipError } from "../src/zip.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures/diagrams");
const read = (name: string) => readFileSync(join(FIX, name), "utf8");

describe("CSV", () => {
  it("parses quoted fields with commas, doubled quotes and line breaks, and gives each record's line", () => {
    expect(parseCsv('a,b\n1,"x, ""y""\nz"\r\n2,\n')).toEqual([
      { line: 1, cells: ["a", "b"] },
      { line: 2, cells: ["1", 'x, "y"\nz'] },
      { line: 4, cells: ["2", ""] },
    ]);
  });
});

describe("Lucidchart CSV (golden)", () => {
  it("reads pages, multi-line labels, containers, a legend column and dangling lines", () => {
    const want: Diagram = {
      nodes: [
        {
          cell: "4",
          label: "Billing Service",
          page: "Overview",
          line: 5,
          style: { shape: "Rectangle", library: "Standard" },
        },
        {
          cell: "5",
          label: "Pay Hub",
          page: "Overview",
          line: 7,
          legend: "modify",
          style: { shape: "Container", library: "Containers" },
        },
        {
          cell: "8",
          label: 'Fabrikam "Ledger" Bridge',
          page: "Events",
          line: 10,
          style: { shape: "Rectangle", library: "Standard" },
        },
      ],
      edges: [
        {
          cell: "7",
          from: "Billing Service",
          to: "Pay Hub",
          label: "S.GW.SOR POST /pay",
          pattern: "S.GW.SOR",
          method: "POST",
          path: "/pay",
          page: "Overview",
          line: 9,
        },
        {
          cell: "9",
          from: 'Fabrikam "Ledger" Bridge',
          to: "Billing Service",
          label: "billing.settled",
          topic: "billing.settled",
          legend: "new",
          page: "Events",
          line: 11,
        },
      ],
      problems: [{ cell: "10", message: "edge has no target box" }],
    };
    expect(readLucidCsv(read("contoso.lucid.csv"))).toEqual(want);
  });

  it("uses the profile's legend words", () => {
    const csv =
      "Id,Name,Page ID,Line Source,Line Destination,Text Area 1\n1,Page,,,,P\n2,Box,1,,,Hub (Changed)\n";
    const d = readLucidCsv(csv, { new: ["Added"], modify: ["Changed"], retire: ["Gone"] });
    expect(d.nodes.map((n) => [n.label, n.legend])).toEqual([["Hub", "modify"]]);
  });

  it("returns an empty diagram for a CSV that is not a Lucid export", () => {
    expect(readLucidCsv("name,amount\nx,1\n")).toEqual({
      nodes: [],
      edges: [],
      problems: [{ cell: "", message: "not a Lucidchart export: no Id column" }],
    });
  });
});

describe("Mermaid (golden)", () => {
  it("reads a flowchart inside a Markdown file: shapes, subgraphs, chains, & lists, classes and bad lines", () => {
    const P = "Contoso payments";
    const want: Diagram = {
      nodes: [
        { cell: "pay", label: "Payments", page: P, line: 8, style: { subgraph: "1" } },
        { cell: "api", label: "Pay API", page: P, line: 9, style: { shape: "rect" } },
        {
          cell: "worker",
          label: "Settlement Worker",
          page: P,
          line: 10,
          legend: "retire",
          style: { shape: "stadium" },
        },
        { cell: "web", label: "Web Shop", page: P, line: 12, style: { shape: "hexagon" } },
        {
          cell: "fab",
          label: "Fabrikam Gateway",
          page: P,
          line: 13,
          legend: "new",
          style: { shape: "cylinder" },
        },
        { cell: "queue", label: "Settlement Queue", page: P, line: 14, style: { shape: "cyl" } },
      ],
      edges: [
        { cell: "e1", from: "Web Shop", to: "Pay API", label: "", page: P, line: 12 },
        { cell: "e2", from: "Web Shop", to: "Settlement Worker", label: "", page: P, line: 12 },
        {
          cell: "e3",
          from: "Pay API",
          to: "Fabrikam Gateway",
          label: "S.GW.VND POST /v1/charge",
          pattern: "S.GW.VND",
          method: "POST",
          path: "/v1/charge",
          page: P,
          line: 13,
        },
        {
          cell: "e4",
          from: "Settlement Worker",
          to: "Settlement Queue",
          label: "settlement.done",
          topic: "settlement.done",
          page: P,
          line: 14,
        },
        { cell: "e5", from: "Settlement Queue", to: "Pay API", label: "", page: P, line: 14 },
        { cell: "e6", from: "Pay API", to: "Payments", label: "", page: P, line: 15 },
      ],
      problems: [{ cell: "L16", message: "line not understood" }],
    };
    expect(readMermaid(read("contoso-payments.md"))).toEqual(want);
  });

  it("reads bidirectional, thick, dotted and long links, and nodes with no label", () => {
    const d = readMermaid(
      [
        "graph LR",
        "  a <--> b",
        "  b ---> c",
        "  c -. A.EB.PUB x.y .-> d",
        "  d ==>|GET /v1/z| a;",
      ].join("\n"),
    );
    expect(d.nodes.map((n) => [n.cell, n.label])).toEqual([
      ["a", "a"],
      ["b", "b"],
      ["c", "c"],
      ["d", "d"],
    ]);
    expect(d.edges.map((e) => [e.from, e.to, e.label, e.topic ?? e.path ?? null])).toEqual([
      ["a", "b", "", null],
      ["b", "c", "", null],
      ["c", "d", "A.EB.PUB x.y", "x.y"],
      ["d", "a", "GET /v1/z", "/v1/z"],
    ]);
    expect(d.edges[3]!.method).toBe("GET");
    expect(d.problems).toEqual([]);
  });

  it("is empty for text that is not a flowchart", () => {
    expect(readMermaid("sequenceDiagram\n  A->>B: hi\n")).toEqual({
      nodes: [],
      edges: [],
      problems: [{ cell: "", message: "no flowchart or graph diagram found" }],
    });
  });
});

describe("Visio .vsdx (golden)", () => {
  it("reads pages in document order, groups, shape-data legends and connectors with a missing end", () => {
    const want: Diagram = {
      nodes: [
        {
          cell: "4.2",
          label: "Billing & Settlement",
          page: "Overview",
          line: 6,
          style: { master: "Box", x: "1.25", y: "4" },
        },
        {
          cell: "4.4",
          label: "Pay Hub",
          page: "Overview",
          line: 13,
          legend: "retire",
          style: { master: "Box", group: "1" },
        },
        {
          cell: "4.8",
          label: "Ledger Bridge",
          page: "Overview",
          line: 26,
          legend: "modify",
          style: { master: "Box" },
        },
        { cell: "5.1", label: "Fabrikam Queue", page: "Detail", line: 4, style: { master: "Box" } },
        {
          cell: "5.2",
          label: "Billing & Settlement",
          page: "Detail",
          line: 5,
          style: { master: "Box" },
        },
      ],
      edges: [
        {
          cell: "4.6",
          from: "Billing & Settlement",
          to: "Pay Hub",
          label: "S.GW.SOR POST /pay",
          pattern: "S.GW.SOR",
          method: "POST",
          path: "/pay",
          page: "Overview",
          line: 19,
        },
        {
          cell: "5.3",
          from: "Billing & Settlement",
          to: "Fabrikam Queue",
          label: "billing.settled",
          topic: "billing.settled",
          legend: "new",
          page: "Detail",
          line: 6,
        },
      ],
      problems: [{ cell: "4.7", message: "edge has no target box" }],
    };
    expect(readVsdx(zipFolder(join(FIX, "contoso-vsdx")))).toEqual(want);
  });

  it("throws a ZipError for a corrupt file and reports an archive with no pages", () => {
    expect(() => readVsdx(new TextEncoder().encode("PK\u0003\u0004 not really"))).toThrow(ZipError);
    expect(readVsdx(writeZip([{ name: "visio/document.xml", data: "<VisioDocument/>" }]))).toEqual({
      nodes: [],
      edges: [],
      problems: [{ cell: "", message: "no pages found in the Visio file" }],
    });
  });
});

describe("readDiagram", () => {
  it("picks the reader by file name, draw.io included", () => {
    const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge");
    const drawio = readFileSync(join(FORGE, "inputs/diagrams/forge-context.drawio"));
    expect(readDiagram("forge-context.drawio", drawio)!.edges).toHaveLength(7);
    expect(
      readDiagram("x.lucid.csv", readFileSync(join(FIX, "contoso.lucid.csv")))!.edges,
    ).toHaveLength(2);
    expect(readDiagram("x.mmd", new TextEncoder().encode("graph TD\n a-->b"))!.edges).toHaveLength(
      1,
    );
    expect(readDiagram("x.vsdx", zipFolder(join(FIX, "contoso-vsdx")))!.edges).toHaveLength(2);
    expect(readDiagram("notes.txt", new TextEncoder().encode("hello"))).toBeUndefined();
  });
});
