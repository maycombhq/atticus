import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeTrialEstate, type TrialEstate } from "@maycombhq/synth";

/**
 * The commands a person runs all day, on the shape of a real estate (trial.ts: about 1,500
 * catalog records, 2,300 facts, 400 flows, a change with 3 stories and 14 tasks, knowledge
 * items and questions). The app's screens have their own budgets in perf.test.ts; these are
 * the command line's.
 *
 * Each is measured twice: the first run after a scan, which parses every record file, and the
 * run after that, which reuses the parses kept in `.atticus/cache/` (record-cache.ts). The
 * second is what a person feels: the first command of a session pays the parse, every one after
 * it doesn't. Budgets are about three times what the build machine (2 CPUs, shared with other
 * work) measures, as the budgets in perf.test.ts are, so a slower laptop still passes and a
 * command that goes back to reading everything fails.
 *
 * Measured on the build machine, the fastest of several runs: next 1.4 s in the steady state
 * and 3.5 s on the first run, change status 1.2 s and 2.2 s, questions list 0.6 s either way.
 * Before the work of 2026-10-26 (CHANGELOG) every run cost what the first does: 4.7 s, 3.9 s
 * and 1.0 s.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "../../cli/dist/bin.js");

const BUDGET = {
  /** The steady state: the parses of the files that haven't changed are kept. */
  nextMs: 4_000,
  changeStatusMs: 4_000,
  questionsListMs: 3_000,
  /** The first run after a scan, which parses every record, flow and knowledge item. */
  firstRunMs: 15_000,
};

let top: string;
let estate: TrialEstate;
const timings: Record<string, number> = {};

/** Run the built command line against the estate; the fastest of `runs`, in milliseconds. */
function fastest(args: string[], runs: number, cold?: () => void): number {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    cold?.();
    const t = performance.now();
    const r = spawnSync(process.execPath, [BIN, ...args, "--root", estate.root], {
      encoding: "utf8",
    });
    const ms = performance.now() - t;
    expect(r.status, `${args.join(" ")}: ${r.stderr}`).toBe(0);
    best = Math.min(best, ms);
  }
  return best;
}

/** Forget the kept parses, so the next run is the first run after a scan. */
const forget = () => () =>
  rmSync(join(estate.root, ".atticus", "cache"), { recursive: true, force: true });

beforeAll(async () => {
  top = await mkdtemp(join(tmpdir(), "atticus-perf-commands-"));
  estate = await writeTrialEstate(join(top, "metarepo"));
  Object.assign(timings, estate.counts);
}, 600_000);
afterAll(async () => {
  console.log(`The commands on the trial estate:\n${JSON.stringify(timings, null, 2)}`);
  await rm(top, { recursive: true, force: true });
});

describe("the commands a person runs all day", () => {
  it("is the shape of the estate the trial measured", () => {
    expect(estate.counts.records).toBeGreaterThan(1_400);
    expect(estate.counts.flows).toBe(400);
    expect(estate.counts.facts).toBe(2_300);
    expect(estate.counts.stories).toBe(3);
    expect(estate.counts.tasks).toBe(14);
    expect(estate.counts.questions).toBeGreaterThan(0);
    expect(estate.counts.knowledge).toBeGreaterThan(0);
  });

  it("says what is next within budget", () => {
    timings.nextFirstMs = Math.round(fastest(["next"], 2, forget()));
    expect(timings.nextFirstMs).toBeLessThan(BUDGET.firstRunMs);
    timings.nextMs = Math.round(fastest(["next"], 3));
    expect(timings.nextMs).toBeLessThan(BUDGET.nextMs);
  });

  it("reports a change's status within budget", () => {
    const args = ["change", "status", estate.change];
    timings.changeStatusFirstMs = Math.round(fastest(args, 2, forget()));
    expect(timings.changeStatusFirstMs).toBeLessThan(BUDGET.firstRunMs);
    timings.changeStatusMs = Math.round(fastest(args, 3));
    expect(timings.changeStatusMs).toBeLessThan(BUDGET.changeStatusMs);
  });

  it("lists the open questions within budget", () => {
    timings.questionsListFirstMs = Math.round(fastest(["questions", "list"], 2, forget()));
    expect(timings.questionsListFirstMs).toBeLessThan(BUDGET.firstRunMs);
    timings.questionsListMs = Math.round(fastest(["questions", "list"], 3));
    expect(timings.questionsListMs).toBeLessThan(BUDGET.questionsListMs);
  });

  it("reads the record files once, not on every run", () => {
    // The budgets above are wall-clock on a shared machine; this is the saving itself, which
    // holds however loaded the machine is: a run that reuses the kept parses is well clear of
    // the first. Before the kept parses the two cost the same, so the ratio was about 1.
    for (const [first, warm, what] of [
      [timings.nextFirstMs, timings.nextMs, "next"],
      [timings.changeStatusFirstMs, timings.changeStatusMs, "change status"],
    ] as const)
      expect(warm, `${what}: ${warm} ms against ${first} ms for the first run`).toBeLessThan(
        first * 0.8,
      );
  });

  it("answers the same whether the parses were kept or read again", () => {
    const run = () =>
      spawnSync(
        process.execPath,
        [BIN, "change", "status", estate.change, "--json", "--root", estate.root],
        { encoding: "utf8" },
      ).stdout;
    const warm = run();
    forget()();
    expect(run()).toBe(warm);
    expect(run()).toBe(warm);
  });
});
