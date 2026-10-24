import { describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME, retrievalOf, Runtime } from "../src/index.js";

/**
 * ADR 0116's addendum: retrieval's defaults are the best the eval measured (the bundled
 * all-MiniLM-L6-v2 embeddings, the model's expansion on, rerank off), and every reader takes
 * them from one helper, so a runtime.yaml without the section, one with an empty section and
 * one that sets only a switch agree on everything else.
 */

const base = { schemaVersion: 1, assistants: { allowed: ["copilot"], default: "copilot" } };

describe("retrieval settings (ADR 0116 addendum)", () => {
  it("defaults to the bundled model and the expansion, rerank off", () => {
    expect(retrievalOf(undefined)).toEqual({
      embeddings: { model: "bundled" },
      expansion: true,
      rerank: false,
    });
    expect(retrievalOf(DEFAULT_RUNTIME)).toEqual(retrievalOf(undefined));
  });

  it("a missing section and an empty one agree", () => {
    const missing = Runtime.parse(base);
    const empty = Runtime.parse({ ...base, retrieval: {} });
    expect(missing.retrieval).toBeUndefined();
    expect(retrievalOf(missing)).toEqual(retrievalOf(empty));
    expect(retrievalOf(empty)).toEqual(retrievalOf(undefined));
  });

  it("an org can turn each off, and what it doesn't set keeps its default", () => {
    const off = Runtime.parse({ ...base, retrieval: { embeddings: { model: "off" } } });
    expect(retrievalOf(off)).toEqual({
      embeddings: { model: "off" },
      expansion: true,
      rerank: false,
    });
    const noExpansion = Runtime.parse({ ...base, retrieval: { expansion: false } });
    expect(retrievalOf(noExpansion)).toMatchObject({
      embeddings: { model: "bundled" },
      expansion: false,
    });
    // A section built in code, not parsed, gets the same defaults.
    expect(retrievalOf({ retrieval: { rerank: true } })).toEqual({
      embeddings: { model: "bundled" },
      expansion: true,
      rerank: true,
    });
  });
});
