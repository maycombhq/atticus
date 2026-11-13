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
} from "@maycombhq/scanner";
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
    // The first write after the cold build reads every record file once into the parse cache.
    expect((await write(1))?.written.written).toBeGreaterThan(0);
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
 * 29,000 records), by CPU time, each the better of two runs (a shared runner's stall in one run
 * isn't the build's). Linear work is about 3 times; before beta.28.1 it was about 9 times (at 20
 * and 60 repos, 18 s and 167 s). The bound and the ratios measured are below, at the assertion.
 */
/** The phases the squared searches were in (buildPhases' names). */
const PASSES = /facts projection|joins applied|3 merge|3 features/;

describe("the build's time grows with the estate (beta.28.1)", () => {
  it("builds 18 repos in under 5 times the CPU time of 6", async () => {
    const SIZES = [6, 18] as const;
    const at18 = await mkdtemp(join(tmpdir(), "atticus-big-growth-"));
    try {
      // An estate of its own, listing 18 repos (a build of 6 has no slot for the others).
      const { root: r18, options: o18 } = await makeBigEstate(at18, {
        repos: SIZES[1],
        checkouts: 0,
      });
      const at = async (n: number) => {
        const facts = new Map<string, ReturnType<typeof factsSlotOf>>();
        // Clusters of 3 repos: its features grow with the estate, as an estate's do.
        const o = { ...o18, repos: n, clusters: n / 3 };
        for (let r = 0; r < n; r++) {
          const id = bigRepoId(r);
          const [a, b] = factsSnapshotWrites(r18, id, bigRepoFacts(r, o).facts, {
            commit: BIG_COMMIT,
            contracts: null,
          });
          facts.set(id, factsSlotOf(id, a!.text!, b!.text!));
        }
        const i = await loadBuildInputs(r18, {
          slots: (on) => ({ ...on, facts: facts as never }),
        });
        buildCacheHooks.off = true;
        try {
          const runs: { s: number; passes: number; records: number }[] = [];
          for (const k of [1, 2]) {
            let passes = 0;
            buildPhases.on = (p, ms) => {
              if (PASSES.test(p)) passes += ms / 1000;
            };
            const b = await cpu(`build of ${n} repos in memory (${k})`, () => buildCatalog(i));
            buildPhases.on = undefined;
            console.log(`big-estate-speed   its passes: ${passes.toFixed(2)} s`);
            runs.push({ s: b.s, passes, records: b.value.records.length });
          }
          return {
            s: Math.min(...runs.map((x) => x.s)),
            passes: Math.min(...runs.map((x) => x.passes)),
            records: runs[0]!.records,
          };
        } finally {
          buildCacheHooks.off = false;
          buildPhases.on = undefined;
        }
      };
      // A first build, not counted: the code compiled and the heap grown before either size.
      await at(SIZES[0]);
      const small = await at(SIZES[0]);
      const big = await at(SIZES[1]);
      expect(big.records).toBeGreaterThan(2.5 * small.records);
      console.log(
        `big-estate-speed growth: ${(big.s / small.s).toFixed(2)} (build), ${(big.passes / small.passes).toFixed(2)} (passes)`,
      );
      // MEASURED
      expect(big.s / small.s).toBeLessThan(5);
    } finally {
      await rm(at18, { recursive: true, force: true });
    }
  }, 600_000);
});
