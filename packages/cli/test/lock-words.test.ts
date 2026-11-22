import { describe, expect, it } from "vitest";
import { interruptedLine, staleLockDetail } from "../src/lock-words.js";

/**
 * The review of ADR 0205 step 2: a writer whose result was given and whose process stopped while
 * it wrote its local caches (its lock marked `caches`) wrote the catalog whole. The next scan,
 * and doctor, say that, not that it stopped before it finished.
 */
const info = {
  pid: 4242,
  host: "here",
  startedAt: "2026-11-21T09:00:00.000Z",
  what: "atticus verify forge-ledger --write",
};

describe("what is said of a lock its process left (ADR 0205)", () => {
  it("a write cut short: it stopped before it finished", () => {
    expect(interruptedLine(info)).toBe(
      "The last scan (started 2026-11-21T09:00:00.000Z) stopped before it finished; this one brings the catalog up to date.",
    );
    expect(staleLockDetail(info)).toBe(
      "the write started 2026-11-21T09:00:00.000Z stopped before it finished",
    );
  });

  it("a write that stopped while it saved its caches: the catalog was written whole", () => {
    const caches = { ...info, phase: "caches" as const };
    expect(interruptedLine(caches)).toBe(
      "The last write (atticus verify forge-ledger --write, started 2026-11-21T09:00:00.000Z) wrote the catalog whole, then stopped while it saved its local caches; they weren't saved, so this run may take a little longer. Nothing is missing.",
    );
    expect(staleLockDetail(caches)).toBe(
      "the write started 2026-11-21T09:00:00.000Z wrote the catalog whole; its local caches weren't saved (the next write rebuilds them)",
    );
  });
});
