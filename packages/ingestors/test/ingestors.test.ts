import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseRecord, type CatalogRecord } from "@maycombhq/core";
import type { Ingestor, ScanContext } from "@maycombhq/sdk";
import { listIngestors, pickIngestor } from "../src/ingestors.js";
import { writeZip, zipFolder } from "./helpers/zip-writer.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures");
const file = (p: string) => new Uint8Array(readFileSync(join(FIX, p)));
const text = (s: string) => new TextEncoder().encode(s);

async function ingest(ing: Ingestor, name: string, content: Uint8Array) {
  const warnings: string[] = [];
  const ctx: ScanContext = {
    dialects: [],
    scannedAt: "2026-10-18T09:00:00Z",
    warn: (m) => warnings.push(m),
  };
  const out: CatalogRecord[] = [];
  for await (const r of ing.ingest(name, content, ctx)) out.push(r);
  return { out, warnings };
}

const SAMPLES: [string, () => Uint8Array, string, string][] = [
  [
    "forge-context.drawio",
    () => file("../../../../fixtures/forge/inputs/diagrams/forge-context.drawio"),
    "drawio",
    "diagram",
  ],
  ["forge-context.csv", () => file("forge/forge-context.lucid.csv"), "lucid", "diagram"],
  [
    "forge-context.vsdx",
    () => zipFolder(join(FIX, "forge/forge-context-vsdx")),
    "visio",
    "diagram",
  ],
  ["forge-context.mmd", () => file("forge/forge-context.mmd"), "mermaid", "diagram"],
  ["sketch.svg", () => file("images/forge-context.svg"), "image", "image"],
  ["spec.md", () => file("documents/payments-hub-spec.md"), "markdown", "document"],
  ["runbook.html", () => file("documents/ledger-runbook.html"), "html", "document"],
  ["notes.txt", () => file("documents/notes.txt"), "text", "document"],
  ["transfers.docx", () => zipFolder(join(FIX, "documents/transfers-docx")), "docx", "document"],
  ["roadmap.pptx", () => zipFolder(join(FIX, "documents/roadmap-pptx")), "pptx", "presentation"],
  ["inventory.xlsx", () => zipFolder(join(FIX, "documents/inventory-xlsx")), "xlsx", "spreadsheet"],
  ["letter.pdf", () => file("documents/partner-letter.pdf"), "pdf", "document"],
  ["checkout.figma.json", () => file("design/checkout.figma.json"), "figma", "design"],
  ["checkout-flow.url", () => file("design/checkout-flow.url"), "figma", "design"],
];

describe("the ingestors (C4)", () => {
  it("lists every ingestor with a unique id and a semver version, draw.io included", () => {
    const all = listIngestors();
    expect(all.map((i) => i.id)).toEqual([
      "drawio",
      "lucid",
      "visio",
      "mermaid",
      "image",
      "markdown",
      "html",
      "text",
      "docx",
      "pptx",
      "xlsx",
      "pdf",
      "figma",
    ]);
    for (const i of all) expect(i.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it.each(SAMPLES)(
    "%s is picked by %s and yields one valid SourceDocument (%s)",
    async (name, content, id, docType) => {
      const bytes = content();
      const ing = pickIngestor(name, bytes.slice(0, 512));
      expect(ing?.id).toBe(id);
      const { out, warnings } = await ingest(ing!, `inputs/${name}`, bytes);
      expect(warnings).toEqual([]);
      expect(out).toHaveLength(1);
      const parsed = parseRecord(out[0]);
      expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
      expect(out[0]).toMatchObject({ kind: "SourceDocument", docType, path: `inputs/${name}` });
      const source = ["diagram", "image"].includes(docType) ? "diagram" : "document";
      expect(out[0]!.evidence).toEqual([{ source, path: `inputs/${name}` }]);
    },
  );

  it("sniffs by content when the extension says nothing", () => {
    const pick = (name: string, head: Uint8Array) => pickIngestor(name, head)?.id;
    expect(pick("export", file("forge/forge-context.lucid.csv"))).toBe("lucid");
    expect(pick("diagram", text("%% x\nflowchart LR\n a-->b"))).toBe("mermaid");
    expect(pick("blob", text("%PDF-1.7\n"))).toBe("pdf");
    expect(pick("blob", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      "image",
    );
    expect(pick("blob", zipFolder(join(FIX, "documents/transfers-docx")).slice(0, 512))).toBe(
      "docx",
    );
    expect(pick("blob", zipFolder(join(FIX, "forge/forge-context-vsdx")).slice(0, 512))).toBe(
      "visio",
    );
    expect(pick("blob", text("fig-kiwi\u0000"))).toBe("figma");
    expect(pick("data.csv", text("name,amount\nx,1\n"))).toBeUndefined();
    expect(pick("data.json", text('{"a":1}'))).toBeUndefined();
    expect(pick("archive.zip", writeZip([{ name: "a.txt", data: "x" }]))).toBeUndefined();
  });

  it("an unreadable file still yields its SourceDocument and warns in plain words", async () => {
    const ing = listIngestors().find((i) => i.id === "docx")!;
    const { out, warnings } = await ingest(ing, "broken.docx", text("PK\u0003\u0004 garbage"));
    expect(out).toHaveLength(1);
    expect(parseRecord(out[0]).ok).toBe(true);
    expect(warnings).toEqual(["This file could not be read as a .docx: not a zip archive."]);
  });

  it("a picture is flagged as needing reading", async () => {
    const ing = listIngestors().find((i) => i.id === "image")!;
    const { out } = await ingest(ing, "context.svg", file("images/forge-context.svg"));
    expect(out[0]!.flags).toEqual(["needs-reading"]);
  });
});
