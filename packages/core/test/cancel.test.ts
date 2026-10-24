import { describe, expect, it } from "vitest";
import { CancelledError, currentSignal, throwIfCancelled, withSignal } from "../src/cancel.js";

describe("cancelling long work (ADR 0119)", () => {
  it("gives the work started inside withSignal the signal, and nothing outside it", async () => {
    const c = new AbortController();
    expect(currentSignal()).toBeUndefined();
    const seen = await withSignal(c.signal, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return currentSignal();
    });
    expect(seen).toBe(c.signal);
    expect(currentSignal()).toBeUndefined();
  });

  it("throws CancelledError at a check once the signal is aborted", async () => {
    const c = new AbortController();
    await withSignal(c.signal, async () => {
      expect(() => throwIfCancelled()).not.toThrow();
      c.abort();
      expect(() => throwIfCancelled()).toThrow(CancelledError);
    });
    expect(() => throwIfCancelled()).not.toThrow();
  });
});
