import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * ADR 0195 point 10 (ticket CS4): model-based property tests of the catalog's writers. Each
 * sequence is a small invented Forge estate on disk (2 to 4 repos, cross-repo calls and topics,
 * local git clones in a temporary folder, no network), sometimes first a beta.26 metarepo and
 * its upgrade, and a sequence of fast-check commands: scans (in full, a repo not cloned, a
 * reader failing, cancelled, reading nothing, `--repos`), `verify --write` that succeeds or is
 * refused, a live facts edit, answers, curated decisions (suppress, assert, alias) added and
 * taken away, archive, remove, hand edits made curated or discarded, confirmations with the
 * count listed and with another, rename (and one whose new slots fail), build, undo, prune, a
 * crash part way through a write, upgrade and "the same command again". After each command the
 * invariants are checked against the model (model.ts); equivalence at the end, against a fresh
 * build of the final slots.
 *
 * The system under test is chosen in one place (`SYSTEM`, system.ts; its interface is seam.ts).
 * Today it is beta.26's writers, which break the invariants in KNOWN_FAILURES: each must fail
 * with its committed, shrunk counterexample (regressions/), and CS2 turns them green.
 */

// The readers are the mock reader adapter (CLAUDE.md rule 5): the harness's faults (fault.ts)
// are wired into the scanner here.
vi.mock("@maycombhq/scanner", async (orig) =>
  (await import("./fault.js")).withFault(await orig<typeof import("@maycombhq/scanner")>()),
);

const { loadRegressions, neverActed, replay, said, search, settings, statsTable } =
  await import("./runner.js");
const { INVARIANTS, InvariantError, KNOWN_FAILURES } = await import("./invariants.js");
const { EXAMPLES, FAILS_TODAY, TWO } = await import("./examples.js");
const { stats, Cmd } = await import("./commands.js");
const { disposeFirstCommits } = await import("./estate.js");
const { withSystem } = await import("./system.js");
const { alwaysRefuses, writesNothing } = await import("./mutants.js");
const { runSequence } = await import("./runner.js");

// One clock for the whole run: the scan stamps evidence with it, and a replay must give the
// same bytes.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-11T09:00:00Z"));
});
afterAll(async () => {
  vi.useRealTimers();
  await disposeFirstCommits();
});

const s = settings();
const T = Math.max(600_000, 300 * s.runs * s.maxCommands);
// About one sequence in seven is the order property's (two writes, in both orders).
const orderRuns = s.enabled.has("order-independence") ? Math.max(1, Math.round(s.runs / 7)) : 0;
const modelRuns = s.runs - orderRuns;
const checked = [...s.enabled].filter((i) => i !== "order-independence");
/** What a replay's `-t` filters on: the property tests' describe. */
const PROPERTY_TESTS = "the catalog's invariants hold after any sequence of commands";
/** Printed with the default reporter too (it shows a test's stdout, not its console). */
const say = (line: string) => process.stdout.write(`${line}\n`);

describe(`${PROPERTY_TESTS} (ADR 0195 point 10)`, () => {
  it.skipIf(!checked.length)(
    `${modelRuns} sequences of up to ${s.maxCommands} commands: ${checked.join(", ")}`,
    async () => {
      // Printed on every run, so a failure seen in a log can be replayed.
      say(
        `catalog properties: seed ${s.seed}, ${s.runs} sequences of up to ${s.maxCommands} commands`,
      );
      stats.reset();
      const t0 = performance.now();
      const c0 = process.cpuUsage();
      const f = await search({
        runs: modelRuns,
        seed: s.seed,
        ...(s.path ? { path: s.path } : {}),
        ...(s.commands ? { commands: s.commands } : {}),
        enabled: s.enabled,
        record: s.record,
        maxCommands: s.maxCommands,
        test: PROPERTY_TESTS,
      });
      if (s.verbose) {
        const c = process.cpuUsage(c0);
        say(
          `${statsTable()}\n${modelRuns} sequences in ${Math.round(performance.now() - t0)} ms (this process's CPU: ${Math.round((c.user + c.system) / 1000)} ms)`,
        );
      }
      if (f) throw new Error(said(f));
      // Coverage: a run of a hundred sequences or more in which a command never acted tested
      // nothing of it (its precondition never came up), so it fails rather than pass quietly.
      const gate = modelRuns >= 100 && !s.path && !s.commands ? neverActed() : undefined;
      if (gate?.lenient)
        say(
          `catalog properties: the system succeeded in ${stats.succeeded} of ${stats.calls} calls, so commands that start from its success weren't required to act`,
        );
      if (gate?.idle.length)
        throw new Error(
          `harness: in ${modelRuns} sequences (seed ${s.seed}) these commands never acted: ${gate.idle.join(", ")}. Weight them up in commandArbs (commands.ts).\n${statsTable()}`,
        );
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
        test: PROPERTY_TESTS,
      });
      if (f) throw new Error(said(f));
    },
    T,
  );
});

/**
 * A known failure must fail, and with its own invariant: a run that fails for another reason
 * (a harness error, another invariant) is not the failure the list says CS2 must fix, and one
 * that passes means the list is stale.
 */
async function failsWith(invariant: string, run: () => Promise<void>): Promise<void> {
  let err: unknown;
  try {
    await run();
  } catch (e) {
    err = e;
  }
  if (!err)
    throw new Error(
      `${invariant} now passes: remove "${invariant}" from KNOWN_FAILURES (invariants.ts) and FAILS_TODAY (examples.ts)`,
    );
  if (!(err instanceof InvariantError) || err.invariant !== invariant) throw err;
}

describe("known failures of today's writers, each by its shrunk counterexample (CS2 turns these green)", () => {
  const regressions = loadRegressions();
  it("every known failure has its counterexample committed", () => {
    expect([...KNOWN_FAILURES].filter((i) => !regressions.some((r) => r.invariant === i))).toEqual(
      [],
    );
  });
  for (const r of regressions) {
    // Once CS2 makes it pass, this test fails until the invariant comes off KNOWN_FAILURES; the
    // counterexample stays, as a regression.
    const known = KNOWN_FAILURES.has(r.invariant);
    it(
      `${r.invariant}${known ? " (known failure, CS2 turns this green)" : ""}: ${JSON.stringify(r.commands).slice(0, 140)}`,
      () => (known ? failsWith(r.invariant, () => replay(r)) : replay(r)),
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
    it(
      `${x.invariant}${known ? " (known failure, CS2 turns this green)" : ""}: ${x.name}`,
      () => (known ? failsWith(x.invariant, x.run) : x.run()),
      T,
    );
  }
});

describe("the oracle fails systems that are wrong on purpose (mutants.ts)", () => {
  const all = new Set(INVARIANTS);

  for (const sys of [
    alwaysRefuses("large-removals"),
    alwaysRefuses("hand-edits"),
    alwaysRefuses("nothing-read"),
    alwaysRefuses("unexplained-removals"),
    writesNothing,
  ])
    it(`a system that ${sys.name} fails completeness on the first scan`, async () => {
      await withSystem(sys, () =>
        failsWith("completeness", () => runSequence(TWO, [], [new Cmd({ t: "scan" })], all)),
      );
    });
  it(
    "a system that writes nothing fails a property run of every invariant",
    async () => {
      const f = await withSystem(writesNothing, () =>
        search({ runs: 5, seed: 1, enabled: all, maxCommands: 4 }),
      );
      expect(f?.invariant).toBe("completeness");
    },
    T,
  );
});
