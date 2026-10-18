import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseRecord } from "@maycombhq/core";
import { readFigma } from "../src/figma.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures/design");
const bytes = (name: string) => new Uint8Array(readFileSync(join(FIX, name)));

describe("Figma, reference only (golden)", () => {
  it("a JSON export becomes a design source document with its version and date", () => {
    const r = readFigma("designs/checkout.figma.json", bytes("checkout.figma.json"));
    expect(r).toMatchObject({
      title: "Checkout flow",
      pages: ["Payment screens", "Error states"],
      notes: [],
    });
    expect(r.link).toBeUndefined();
    expect(r.record).toMatchObject({
      kind: "SourceDocument",
      id: "doc.checkout",
      docType: "design",
      version: "4211",
      date: "2026-10-01",
      recordsProduced: [],
      evidence: [{ source: "document", path: "designs/checkout.figma.json" }],
    });
    expect(parseRecord(r.record).ok).toBe(true);
  });

  it("a link file keeps the link as text and never opens it", () => {
    const r = readFigma("designs/checkout-flow.url", bytes("checkout-flow.url"));
    expect(r.link).toBe("https://www.figma.com/design/AbC123xyz/Checkout-flow?node-id=1-2");
    expect(r.pages).toEqual([]);
    expect(r.record).toMatchObject({ id: "doc.checkout-flow", docType: "design" });
  });

  it("a binary .fig file is recorded by hash only", () => {
    const fig = new Uint8Array([...Buffer.from("fig-kiwi"), 0, 0, 0, 0, 9, 9, 9]);
    const r = readFigma("checkout.fig", fig);
    expect(r).toMatchObject({ pages: [], notes: [] });
    expect(r.title).toBeUndefined();
    expect(r.record).toMatchObject({ id: "doc.checkout", docType: "design" });
  });
});
