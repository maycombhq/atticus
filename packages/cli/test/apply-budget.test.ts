import { mkdtemp, rm } from "node:fs/promises";
import { cpus, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { settleAfterResult, startAppMemory, stopAppMemory } from "@maycombhq/core";
import { buildAndWrite } from "@maycombhq/scanner";
import { verifyCommand } from "../src/verify-commands.js";
import { bigRepoId, writeBigRepo } from "./big-estate.js";
import { makeFieldEstate, type FieldEstate } from "./field-estate.js";

/**
 * ADR 0205, the owner's answer of 2026-11-19: one repo's Apply in 15 seconds on the field-shaped
 * estate at up to 60 repos, as a CI budget. A wall-clock budget, so it runs only where the
 * machine is the test's own: with ATTICUS_BENCH=1, which the nightly workflow
 * (.github/workflows/apply-budget-nightly.yml, a dedicated runner) sets; never in `pnpm check`,
 * whose machines are shared. The Apply is the app's: `verify <repo> --write` in the process that
 * runs it, the caches written after its result (step 2), the app's memory on (step 4); the time
 * is to its result, "done". Each figure is the median of three, after one write that fills the
 * caches, with the CPU time and the load said beside it.
 */
const ON = !!process.env.ATTICUS_BENCH;
const BUDGET_S = 15;
/** ATTICUS_BUDGET_REPOS: the estate's repos in all (60 by default), 3 in 8 gateway proxies. */
const N = Number(process.env.ATTICUS_BUDGET_REPOS ?? 60);
const gateways = Math.round((N * 3) / 8);

let dir: string;
let estate: FieldEstate;
const quiet = { out: () => undefined, err: () => undefined, progress: () => undefined };

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

describe.skipIf(!ON)("one repo's Apply on the field-shaped estate (ADR 0205's budget)", () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "atticus-apply-budget-"));
    estate = await makeFieldEstate(dir, { services: N - gateways, gateways });
    const cold = await buildAndWrite(estate.root, { command: "atticus catalog build" });
    expect(cold.guard.refused).toBeUndefined();
    startAppMemory();
  }, 1_800_000);
  afterAll(async () => {
    await settleAfterResult();
    stopAppMemory();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it(`is done in under ${BUDGET_S} s at ${N} repos (median of three)`, async () => {
    const repo = bigRepoId(1);
    const walls: number[] = [];
    const cpus_: number[] = [];
    for (let k = 0; k < 4; k++) {
      await writeBigRepo(estate.root, 1, estate.options, 20 + k, true, false);
      const t = performance.now();
      const c = process.cpuUsage();
      const code = await verifyCommand(
        estate.root,
        repo,
        { write: true, verbose: false, json: false, cachesAfterResult: true },
        quiet,
      );
      const wall = (performance.now() - t) / 1000;
      const u = process.cpuUsage(c);
      await settleAfterResult();
      expect(code).toBe(0);
      console.log(
        `apply-budget write ${k}${k === 0 ? " (fills the caches, not counted)" : ""}: ${wall.toFixed(2)} s, ${((u.user + u.system) / 1e6).toFixed(1)} CPU s, load ${loadavg()
          .map((x) => x.toFixed(1))
          .join(" ")} on ${cpus().length} CPUs`,
      );
      if (k > 0) {
        walls.push(wall);
        cpus_.push((u.user + u.system) / 1e6);
      }
    }
    console.log(
      `apply-budget median: ${median(walls).toFixed(2)} s, ${median(cpus_).toFixed(1)} CPU s (budget ${BUDGET_S} s)`,
    );
    expect(median(walls)).toBeLessThan(BUDGET_S);
  }, 1_800_000);
});
