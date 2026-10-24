import { describe, expect, it } from "vitest";
import {
  cosine,
  dotInt8,
  HashEmbedder,
  quantize,
  RecordedEmbedder,
  textSha,
  vectorFromText,
  vectorToText,
} from "../src/index.js";

// ADR 0116: the embedder interface (C5), int8 vectors and integer scoring, the tests' hashing
// embedder and the replay embedder.

describe("int8 vectors", () => {
  it("quantise a vector to int8 with one scale: the largest component is ±127, the cosine survives", () => {
    const v = quantize([3, -4, 0]);
    expect(Array.from(v.q)).toEqual([95, -127, 0]);
    expect(v.scale).toBeCloseTo(0.8 / 127, 12);
    expect(cosine(v, v)).toBeCloseTo(1, 2);
    expect(quantize([0, 0]).scale).toBe(0);
  });

  it("score by an exact integer dot product", () => {
    const a = new Int8Array([127, -127, 5]);
    const b = new Int8Array([0, 1, 2, 127, 127, 1]);
    expect(dotInt8(a, b, 3)).toBe(127 * 127 - 127 * 127 + 5);
  });

  it("round-trip as text for golden files", () => {
    const v = quantize([1, 2, 3, -4]);
    const back = vectorFromText(vectorToText(v));
    expect(Array.from(back.q)).toEqual(Array.from(v.q));
    expect(back.scale).toBe(v.scale);
  });
});

describe("the tests' hashing embedder", () => {
  it("is deterministic, puts texts that share words near, and counts what it embedded", async () => {
    const e = new HashEmbedder();
    const [a, b, c, a2] = await e.embed(
      [
        "the renamed timestamp",
        "renamedAt timestamp column",
        "the canteen lunch menu",
        "the renamed timestamp",
      ],
      "document",
    );
    expect(Array.from(a2!.q)).toEqual(Array.from(a!.q));
    expect(cosine(a!, b!)).toBeGreaterThan(cosine(a!, c!));
    expect(e.embedded).toBe(4);
    expect(e.id).toBe("hash-embedder@256");
  });
});

describe("the replay embedder", () => {
  it("gives back a recorded vector by its text's hash, and refuses a text it has none for", async () => {
    const v = quantize([1, 0, 0]);
    const e = new RecordedEmbedder({
      model: "m@1",
      dim: 3,
      maxTokens: 8,
      floor: 0.4,
      document: { [textSha("a")]: vectorToText(v) },
      query: {},
    });
    expect(e.floor).toBe(0.4);
    expect(Array.from((await e.embed(["a"], "document"))[0]!.q)).toEqual(Array.from(v.q));
    await expect(e.embed(["a"], "query")).rejects.toThrow(/no recorded query vector/);
  });
});
