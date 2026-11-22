import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { cpus, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { settleAfterResult, startAppMemory, stopAppMemory } from "@maycombhq/core";
import { buildAndWrite } from "@maycombhq/scanner";
import { verifyCommand } from "../src/verify-commands.js";
import { BIG_COMMIT, bigRepoId, writeBigRepo } from "./big-estate.js";
import { makeFieldEstate, type FieldEstate } from "./field-estate.js";

/**
 * ADR 0205, the owner's answer of 2026-11-19: one repo's Apply in 15 seconds on the field-shaped
 * estate at up to 60 repos, as a CI budget. A wall-clock budget, so it runs only when asked:
 * with ATTICUS_APPLY_BUDGET=1, which the nightly workflow (.github/workflows/apply-budget-nightly.yml)
 * sets, and never in `pnpm check` or the benchmark (ATTICUS_BENCH is the benchmark's).
 *
 * The workflow's machine is a GitHub-hosted runner (ubuntu-24.04), not one of our own: no other
 * job of ours runs on it, but it is a virtual machine on a shared host, and its neighbours can
 * slow it. So each figure is the median of three, after one write that fills the caches, with
 * its CPU time and the load said beside it: a median over 15 s whose CPU time is well under it
 * was the runner's noise, not the code's (run it again from the Actions tab). The margin, from
 * ADR 0205's measurements at 60 repos (2 CPUs): the app's Apply takes about 5.7 CPU s, two fifths
 * of the budget, and the command about 10 CPU s, two thirds of it; on an idle runner the clock is
 * about the CPU time, so a runner slowed by half again still passes the app's and is at the edge
 * for the command's.
 *
 * Two Applies, each with the budget:
 * - the app's: `verify <repo> --write` in the process that runs it, the caches written after
 *   its result (step 2), the app's memory on (step 4); the time is to its result, "done";
 * - the command's: `atticus verify <repo> --write` in a process of its own (the built CLI), from
 *   its start to its end, its caches written after its lines and before it ends (step 2).
 */
const ON = !!process.env.ATTICUS_APPLY_BUDGET;
const BUDGET_S = 15;
/** ATTICUS_BUDGET_REPOS: the estate's repos in all (60 by default), 3 in 8 gateway proxies. */
const N = Number(process.env.ATTICUS_BUDGET_REPOS ?? 60);
const gateways = Math.round((N * 3) / 8);
/** The built command line: build first (the workflow does). */
const BIN = join(import.meta.dirname, "..", "dist", "bin.js");

let dir: string;
let estate: FieldEstate;
const quiet = { out: () => undefined, err: () => undefined, progress: () => undefined };
const repo = bigRepoId(1);

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const load = () =>
  `load ${loadavg()
    .map((x) => x.toFixed(1))
    .join(" ")} on ${cpus().length} CPUs`;

describe.skipIf(!ON)("one repo's Apply on the field-shaped estate (ADR 0205's budget)", () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "atticus-apply-budget-"));
    estate = await makeFieldEstate(dir, { services: N - gateways, gateways });
    const cold = await buildAndWrite(estate.root, { command: "atticus catalog build" });
    expect(cold.guard.refused).toBeUndefined();
  }, 1_800_000);
  afterAll(async () => {
    await settleAfterResult();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it(`the app's Apply is done in under ${BUDGET_S} s at ${N} repos (median of three)`, async () => {
    startAppMemory();
    try {
      const walls: number[] = [];
      const cpus_: number[] = [];
      for (let k = 0; k < 4; k++) {
        await writeBigRepo(estate.root, 1, estate.options, 20 + k, true, false);
        const t = performance.now();
        const c = process.cpuUsage();
        const code = await verifyCommand(
          estate.root,
          repo,
          { write: true, verbose: false, json: false, commit: BIG_COMMIT, cachesAfterResult: true },
          quiet,
        );
        const wall = (performance.now() - t) / 1000;
        const u = process.cpuUsage(c);
        await settleAfterResult();
        expect(code).toBe(0);
        console.log(
          `apply-budget the app's Apply ${k}${k === 0 ? " (fills the caches, not counted)" : ""}: ${wall.toFixed(2)} s, ${((u.user + u.system) / 1e6).toFixed(1)} CPU s, ${load()}`,
        );
        if (k > 0) {
          walls.push(wall);
          cpus_.push((u.user + u.system) / 1e6);
        }
      }
      console.log(
        `apply-budget the app's Apply, median: ${median(walls).toFixed(2)} s, ${median(cpus_).toFixed(1)} CPU s (budget ${BUDGET_S} s)`,
      );
      expect(median(walls)).toBeLessThan(BUDGET_S);
    } finally {
      stopAppMemory();
    }
  }, 1_800_000);

  it(`the command's Apply ends in under ${BUDGET_S} s at ${N} repos (median of three)`, async () => {
    expect(existsSync(BIN), `${BIN}: build the CLI first`).toBe(true);
    const walls: number[] = [];
    const cpus_: number[] = [];
    const err = join(dir, "command.err");
    for (let k = 0; k < 4; k++) {
      await writeBigRepo(estate.root, 1, estate.options, 30 + k, true, false);
      // Timed by bash's `time` where there is one (the workflow's Linux), for the child's CPU.
      const args = [BIN, "verify", repo, "--write", "--commit", BIG_COMMIT, "--root", estate.root];
      const bash = process.platform !== "win32";
      const t = performance.now();
      const run = bash
        ? spawnSync(
            "bash",
            [
              "-c",
              `TIMEFORMAT="%R %U %S"; time "$0" "$@" > /dev/null 2> "$ATTICUS_BUDGET_ERR"`,
              process.execPath,
              ...args,
            ],
            {
              cwd: estate.root,
              encoding: "utf8",
              env: { ...process.env, ATTICUS_BUDGET_ERR: err },
            },
          )
        : spawnSync(process.execPath, args, { cwd: estate.root, encoding: "utf8" });
      const wall = (performance.now() - t) / 1000;
      expect(run.status, bash ? await readFile(err, "utf8").catch(() => "") : run.stderr).toBe(0);
      const [, user, sys] = bash ? run.stderr.trim().split(/\s+/).map(Number) : [];
      const cpu = user !== undefined && sys !== undefined ? user + sys : undefined;
      console.log(
        `apply-budget the command's Apply ${k}${k === 0 ? " (fills the caches, not counted)" : ""}: ${wall.toFixed(2)} s${cpu !== undefined ? `, ${cpu.toFixed(1)} CPU s` : ""}, ${load()}`,
      );
      if (k > 0 && cpu !== undefined) cpus_.push(cpu);
      if (k > 0) walls.push(wall);
    }
    console.log(
      `apply-budget the command's Apply, median: ${median(walls).toFixed(2)} s${cpus_.length ? `, ${median(cpus_).toFixed(1)} CPU s` : ""} (budget ${BUDGET_S} s)`,
    );
    expect(median(walls)).toBeLessThan(BUDGET_S);
  }, 1_800_000);
});
