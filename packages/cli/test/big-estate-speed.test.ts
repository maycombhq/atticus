import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildAndWrite,
  buildCacheHooks,
  buildCatalog,
  buildPhases,
  factsSlotOf,
  factsSnapshotWrites,
  loadBuildInputs,
  readCatalog,
} from "@maycombhq/scanner";
import { catalogDirOf } from "@maycombhq/core";
import { writeFactsIntoCatalog } from "../src/map-render-commands.js";
import { candidatesOf } from "../src/ui-api-links.js";
import { verifyWritePreview } from "../src/verify-preview.js";
import { forgetKeptChecks } from "../src/contract-check-files.js";
import {
  BIG_COMMIT,
  bigGatewayId,
  bigRepoFacts,
  bigRepoId,
  makeBigEstate,
  writeBigRepo,
} from "./big-estate.js";

/**
 * beta.28.1, field report 6: `verify <repo> --write` of one changed repo, the Connect panel's
 * read and the pairing preview, on a large estate (big-estate.ts: 12 repos here, about 19,000
 * catalog records from 28,000 facts; the benchmark, big-estate-bench.test.ts, runs 60 repos and
 * 97,000 records). Before beta.28.1 the build searched the whole estate for each record in three
 * places and grouped the features' flows by id, so its time grew with the square of the estate:
 * 60 repos took 209 s for one changed repo, 12 repos about 20 s here.
 *
 * The budgets are of the CPU time this process spends (user and system, every thread), not
 * the time on the clock: a shared CI runner (or this machine, with other tests running at once)
 * stretches the clock but not the work. home-speed's wall-clock budget once failed at 15.3 s
 * against 15 on Windows CI; these are about three times what this build machine measured
 * (2 CPUs, shared), so a slower runner passes, and a return of the squared searches (several
 * times the work at this size, more at 60 repos) does not.
 */
const WRITE_CPU_S = 30;
const PREVIEW_CPU_S = 30;
const CONNECT_CPU_S = 10;
const REPOS = 12;

let dir: string;
let root: string;
let options: Awaited<ReturnType<typeof makeBigEstate>>["options"];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "atticus-big-speed-"));
  // With gateway proxies on one host (field report 2's estate): 6 of the 12 services fronted.
  const made = await makeBigEstate(dir, { repos: REPOS, checkouts: 2, gateways: 6 });
  root = made.root;
  options = made.options;
  const cold = await buildAndWrite(root, { command: "atticus catalog build" });
  expect(cold.guard.refused).toBeUndefined();
}, 600_000);
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The CPU seconds `run` takes, said with the time on the clock. */
async function cpu<T>(label: string, run: () => Promise<T>): Promise<{ s: number; value: T }> {
  const c = process.cpuUsage();
  const t = performance.now();
  const value = await run();
  const used = process.cpuUsage(c);
  const s = (used.user + used.system) / 1e6;
  console.log(
    `big-estate-speed ${label}: ${s.toFixed(1)} CPU s, ${((performance.now() - t) / 1000).toFixed(1)} s`,
  );
  return { s, value };
}

const repo = bigRepoId(1);
const quiet = { out: () => undefined, err: () => undefined };
const write = async (edit: number) => {
  const facts = await writeBigRepo(root, 1, options, edit, true, false);
  return writeFactsIntoCatalog(
    root,
    repo,
    facts,
    { dir: join(root, "workspace", repo), command: `atticus verify ${repo} --write` },
    quiet,
  );
};

describe(`one repo changed on a ${REPOS}-repo estate (beta.28.1)`, () => {
  it("writes the catalog inside the budget", async () => {
    // The cold build leaves no parse kept: one read fills the cache, as the first command after
    // a build does (a write in its place made this file take 30 s longer).
    expect(
      (await readCatalog(join(catalogDirOf(root), "generated"), { cacheRoot: root })).records
        .length,
    ).toBeGreaterThan(10_000);
    const { s, value } = await cpu("verify --write", () => write(2));
    expect(value?.written.written).toBeGreaterThan(0);
    expect(value?.written.unchanged).toBeGreaterThan(10_000);
    expect(s).toBeLessThan(WRITE_CPU_S);
  }, 600_000);

  it("reads the Connect panel and previews a pairing inside the budget", async () => {
    forgetKeptChecks();
    const c = await cpu("Connect panel read", () =>
      candidatesOf(root, repo, { repo: bigRepoId(2) }),
    );
    expect(c.value.view.calls.length).toBeGreaterThan(0);
    expect(c.s).toBeLessThan(CONNECT_CPU_S);
    // Its calls through the gateway's host, to a proxy fronting another service.
    const g = await cpu("Connect panel read (a gateway proxy)", () =>
      candidatesOf(root, repo, { repo: bigGatewayId(5) }),
    );
    expect(g.s).toBeLessThan(CONNECT_CPU_S);
    await writeBigRepo(root, 1, options, 3, true, false);
    const p = await cpu("pairing preview", () => verifyWritePreview(root, repo));
    expect(p.value?.preview?.catalog?.files.length).toBeGreaterThan(0);
    expect(p.s).toBeLessThan(PREVIEW_CPU_S);
  }, 600_000);
});

/**
 * The build's work grows with the estate, not with its square: the same build in memory (no
 * build cache, nothing read from or written to a catalog) of 6 repos and of 18 (about 9,700 and
 * 29,000 records; clusters of 3 repos, so the features grow with the estate as an estate's do).
 * What is compared is the time of the passes the squared searches were in (the projection and
 * estate join, the joins applied, the merge, the features: buildPhases' clock), not the whole
 * build, whose files and build.json still grow faster than the estate (each record lists its
 * sources; build.json lists each source once from beta.28.2). Linear work is 3 times.
 *
 * Measured on this build machine (2 shared CPUs, load 6 to 10): the passes 2.5 times; the whole
 * build 4.9 to 5.6 times, and 6.9 to 7.5 with main's searches (63869566). A first pair of builds
 * is enough when it passes; a second pair (each size's better time is kept) only when it doesn't,
 * so a runner's stall in one build fails nothing. The test takes about 25 s here.
 */
describe("the build's time grows with the estate (beta.28.1)", () => {
  it("runs the passes of 18 repos in under 4 times the time of 6", async () => {
    const SIZES = [6, 18] as const;
    const BOUND = 4;
    const dir18 = await mkdtemp(join(tmpdir(), "atticus-big-growth-"));
    try {
      // An estate of its own, listing 18 repos (a build of 6 has no slot for the others).
      const { root: r18, options: o18 } = await makeBigEstate(dir18, {
        repos: SIZES[1],
        checkouts: 0,
      });
      const inputs = async (n: number) => {
        const facts = new Map<string, ReturnType<typeof factsSlotOf>>();
        const o = { ...o18, repos: n, clusters: n / 3 };
        for (let r = 0; r < n; r++) {
          const id = bigRepoId(r);
          const [a, b] = factsSnapshotWrites(r18, id, bigRepoFacts(r, o).facts, {
            commit: BIG_COMMIT,
            contracts: null,
          });
          facts.set(id, factsSlotOf(id, a!.text!, b!.text!));
        }
        return loadBuildInputs(r18, { slots: (on) => ({ ...on, facts: facts as never }) });
      };
      const of = { small: await inputs(SIZES[0]), big: await inputs(SIZES[1]) };
      const run = async (size: "small" | "big") => {
        let passes = 0;
        buildPhases.on = (p, ms) => {
          if (PASSES.test(p)) passes += ms / 1000;
        };
        buildCacheHooks.off = true;
        try {
          const b = await cpu(`build of ${size} in memory`, () => buildCatalog(of[size]));
          return { s: b.s, passes, records: b.value.records.length };
        } finally {
          buildCacheHooks.off = false;
          buildPhases.on = undefined;
        }
      };
      // A first build, not counted: the code compiled and the heap grown before either size.
      await run("small");
      let small = await run("small");
      let big = await run("big");
      expect(big.records).toBeGreaterThan(2.5 * small.records);
      const ratio = () => big.passes / small.passes;
      if (ratio() >= BOUND) {
        const [s2, b2] = [await run("small"), await run("big")];
        small = s2.passes < small.passes ? s2 : small;
        big = b2.passes < big.passes ? b2 : big;
      }
      console.log(
        `big-estate-speed growth: the passes ${ratio().toFixed(2)} times, the build ${(big.s / small.s).toFixed(2)}`,
      );
      expect(ratio()).toBeLessThan(BOUND);
    } finally {
      await rm(dir18, { recursive: true, force: true });
    }
  }, 600_000);
});

/** The phases the squared searches were in (buildPhases' names). */
const PASSES = /facts projection|joins applied|3 merge|3 features/;
