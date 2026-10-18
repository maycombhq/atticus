import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseRecord } from "@maycombhq/core";
import { readImage } from "../src/image.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures/images");
const REASON =
  "Edges in a picture are read later, by AI or a person, and each edge is asserted only after a person confirms it.";

/** Hand-made image headers: just enough bytes for the format and size. */
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const png = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  ...be32(13),
  0x49,
  0x48,
  0x44,
  0x52,
  ...be32(800),
  ...be32(600),
  8,
  6,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
]);
const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xf0, 0x00, 0, 0, 0]);
const jpeg = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03,
  0x20, 0x03,
]);
const webp = new Uint8Array([
  ...Buffer.from("RIFF"),
  30,
  0,
  0,
  0,
  ...Buffer.from("WEBPVP8X"),
  10,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0x7f,
  0x02,
  0x00,
  0x1f,
  0x01,
  0x00,
]);

describe("images (golden)", () => {
  it("records a picture as a source document that needs reading, with its format and size", () => {
    const r = readImage("inputs/diagrams/context.png", png);
    expect(r.image).toEqual({ format: "png", width: 800, height: 600 });
    expect(r.needsReading).toEqual({ reason: REASON, candidateLabels: [], confirmed: false });
    expect(r.notes).toEqual([]);
    expect(r.record).toMatchObject({
      kind: "SourceDocument",
      id: "doc.context",
      docType: "image",
      flags: ["needs-reading"],
      recordsProduced: [],
      evidence: [{ source: "diagram", path: "inputs/diagrams/context.png" }],
    });
    expect(parseRecord(r.record).ok).toBe(true);
  });

  it("reads GIF, JPEG and WebP sizes from their headers", () => {
    expect(readImage("a.gif", gif).image).toEqual({ format: "gif", width: 320, height: 240 });
    expect(readImage("a.jpg", jpeg).image).toEqual({ format: "jpeg", width: 800, height: 600 });
    expect(readImage("a.webp", webp).image).toEqual({ format: "webp", width: 640, height: 288 });
  });

  it("trusts the bytes over the extension and says when they disagree", () => {
    const r = readImage("mislabelled.png", jpeg);
    expect(r.image.format).toBe("jpeg");
    expect(r.notes).toEqual(["The file name says png but the content is jpeg."]);
    const junk = readImage("junk.png", new Uint8Array([1, 2, 3]));
    expect(junk.image).toEqual({ format: "unknown" });
    expect(junk.notes).toEqual(["The content is not a picture format Atticus recognises."]);
  });

  it("takes an SVG's text labels as unconfirmed candidate names; scripts are never run or read", () => {
    const r = readImage(
      "forge-context.svg",
      new Uint8Array(readFileSync(join(FIX, "forge-context.svg"))),
    );
    expect(r.image).toEqual({ format: "svg", width: 640, height: 320 });
    expect(r.needsReading).toEqual({
      reason: REASON,
      candidateLabels: [
        "Portal BFF",
        "Ledger Platform",
        "S.GW.SOR POST /ledger/v1/transfers",
        "Fees & limits",
      ],
      confirmed: false,
    });
  });
});
