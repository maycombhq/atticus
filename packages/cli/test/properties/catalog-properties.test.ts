import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * ADR 0195 point 10 (ticket CS4): model-based property tests of the catalog's writers. Each
 * sequence is a small invented Forge estate on disk (2 to 5 repos, cross-repo calls and topics,
 * local git clones in a temporary folder, no network) and a sequence of fast-check commands:
 * scans (in full, a repo not cloned, a reader failing, `--repos`), `verify --write` that
 * succeeds or is refused, a live facts edit, answers, curated decisions, archive, remove, a hand
 * edit, rename, undo, upgrade and "the same writer again". After each command the invariants are
 * checked against the model (model.ts); equivalence is checked at the end against a fresh build.
 *
 * The system under test is chosen in one place (`SYSTEM`, system.ts). Today it is beta.26's
 * writers, which break the invariants in KNOWN_FAILURES: each runs here as a known failure from
 * its committed, shrunk counterexample (regressions/), and CS2 turns them green.
 */

// The readers are the mock reader adapter (CLAUDE.md rule 5): while `fault.on` names a repo, the
// scan runs one more extractor, which throws on that repo, as a broken reader would.
vi.mock("@maycombhq/scanner", async (orig) =>
  (await import("./fault.js")).withFault(await orig<typeof import("@maycombhq/scanner")>()),
);

const { loadRegressions, replay, said, search, settings } = await import("./runner.js");
const { INVARIANTS, KNOWN_FAILURES } = await import("./invariants.js");
const { EXAMPLES, FAILS_TODAY } = await import("./examples.js");

// One clock for the whole run: the scan stamps evidence with it, and a replay must give the
// same bytes.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-11T09:00:00Z"));
});
afterAll(() => vi.useRealTimers());

const s = settings();
const T = Math.max(600_000, 3_000 * s.runs);
// About one sequence in seven is the order property's (two writes, in both orders).
const orderRuns = s.enabled.has("order-independence") ? Math.max(1, Math.round(s.runs / 7)) : 0;
const modelRuns = s.runs - orderRuns;
const checked = [...s.enabled].filter((i) => i !== "order-independence");

describe("the catalog's invariants hold after any sequence of commands (ADR 0195 point 10)", () => {
  it.skipIf(!checked.length)(
    `${modelRuns} sequences: ${checked.join(", ")}`,
    async () => {
      // Printed on every run, so a failure seen in a log can be replayed.
      console.info(`catalog properties: seed ${s.seed}, ${s.runs} sequences`);
      const f = await search({
        runs: modelRuns,
        seed: s.seed,
        ...(s.path ? { path: s.path } : {}),
        ...(s.commands ? { commands: s.commands } : {}),
        enabled: s.enabled,
        record: s.record,
      });
      if (f) throw new Error(said(f));
    },
    T,
  );

  it.skipIf(!orderRuns)(
    orderRuns
      ? `${orderRuns} sequences: order-independence (two writes of different repos, in both orders)`
      : "order-independence: a known failure, checked by its counterexample below",
    async () => {
      const f = await search({
        runs: orderRuns,
        seed: s.seed,
        ...(s.path ? { path: s.path } : {}),
        enabled: s.enabled,
        order: true,
        record: s.record,
      });
      if (f) throw new Error(said(f));
    },
    T,
  );
});

describe("known failures of today's writers, each by its shrunk counterexample (CS2 turns these green)", () => {
  const regressions = loadRegressions();
  it("every known failure has its counterexample committed", () => {
    expect([...KNOWN_FAILURES].filter((i) => !regressions.some((r) => r.invariant === i))).toEqual(
      [],
    );
  });
  for (const r of regressions) {
    // A known failure fails here, as `it.fails` expects. Once CS2 makes it pass, this test fails
    // until the invariant comes off KNOWN_FAILURES; the counterexample stays, as a regression.
    const known = KNOWN_FAILURES.has(r.invariant);
    (known ? it.fails : it)(
      `${r.invariant}${known ? " (known failure, CS2 turns this green)" : ""}: ${JSON.stringify(r.commands).slice(0, 140)}`,
      () => replay(r),
      T,
    );
  }
});

describe("each invariant, by a hand-written example", () => {
  it("every invariant has one, and only a known failure's example fails today", () => {
    expect(INVARIANTS.filter((i) => !EXAMPLES.some((x) => x.invariant === i))).toEqual([]);
    expect([...FAILS_TODAY].filter((i) => !KNOWN_FAILURES.has(i))).toEqual([]);
  });
  for (const x of EXAMPLES) {
    const known = FAILS_TODAY.has(x.invariant);
    (known ? it.fails : it)(
      `${x.invariant}${known ? " (known failure, CS2 turns this green)" : ""}: ${x.name}`,
      () => x.run(),
      T,
    );
  }
});
