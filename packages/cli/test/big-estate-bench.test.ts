import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import {
  buildAndWrite,
  buildPhases,
  estateJoinOf,
  estateFacts,
  manifestToV1,
  parseBuildManifest,
  serializeBuildManifest,
  serializeBuildManifestV1,
} from "@maycombhq/scanner";
import { setFlagsFromString, getHeapStatistics } from "node:v8";
import { runInNewContext } from "node:vm";
import {
  appMemoryHeld,
  factsParseHooks,
  releaseAppMemory,
  loadOrgPack,
  orgPackDirOf,
  settleAfterResult,
  startAppMemory,
  stopAppMemory,
} from "@maycombhq/core";
import { writeFactsHooks, writeFactsIntoCatalog } from "../src/map-render-commands.js";
import { verifyCommand } from "../src/verify-commands.js";
import { candidatesOf } from "../src/ui-api-links.js";
import { verifyWritePreview } from "../src/verify-preview.js";
import { forgetKeptChecks } from "../src/contract-check-files.js";
import { BIG_COMMIT, bigGatewayId, bigRepoId, makeBigEstate, writeBigRepo } from "./big-estate.js";
import { v1Of } from "./build-json-v1.js";
import { makeFieldEstate } from "./field-estate.js";

/**
 * The benchmark of field report 6 (beta.28.1): not part of `pnpm check`. Run it with
 * `ATTICUS_BENCH=1 pnpm -s vitest run test/big-estate-bench.test.ts` in packages/cli (and
 * `ATTICUS_BENCH_DIR=<dir>` to keep the estate and its cold build between runs; `ATTICUS_BENCH_REPOS`
 * for another size). It prints each phase's wall-clock time: the cold build, then for one
 * changed repo `verify <repo> --write`'s catalog write, the Connect panel's read (cold, after
 * the write, and warm) and the pairing preview.
 */
const ON = !!process.env.ATTICUS_BENCH;
const N = Number(process.env.ATTICUS_BENCH_REPOS ?? 60);
/** ATTICUS_BENCH_GATEWAYS: gateway proxy repos (big-estate.ts `gateways`), none by default. */
const G = Number(process.env.ATTICUS_BENCH_GATEWAYS ?? 0);
/** ATTICUS_BENCH_WRITES=0: the cold build and the reads only, no write of a changed repo. */
const WRITES = process.env.ATTICUS_BENCH_WRITES !== "0";
/**
 * Beta.30 (slice 10, ADR 0205): ATTICUS_BENCH_FIELD=1 makes the field-shaped estate
 * (field-estate.ts) at ATTICUS_BENCH_REPOS repos in all, 3 in 8 of them gateway proxies, in place
 * of big-estate.ts's; ATTICUS_BENCH_RUNS steady writes follow the first (2 by default).
 */
const FIELD = !!process.env.ATTICUS_BENCH_FIELD;
const RUNS = Math.max(1, Number(process.env.ATTICUS_BENCH_RUNS ?? 2));
const fieldGateways = Math.round((N * 3) / 8);
/** ATTICUS_BENCH_READS=0: the writes only, none of the reads after them. */
const READS = process.env.ATTICUS_BENCH_READS !== "0";
/**
 * ADR 0205: ATTICUS_BENCH_APP=1 runs each write as the app's Apply does (verify --write in this
 * process, the caches after its result, the app's memory on); ATTICUS_BENCH_STEPS_OFF=1 runs it
 * the way before the ADR's steps (the whole comparison, every facts file parsed, the caches
 * before the result, no memory kept): the before and after of one build of the code.
 */
const APP = !!process.env.ATTICUS_BENCH_APP;
const STEPS_OFF = !!process.env.ATTICUS_BENCH_STEPS_OFF;
const say = (l: string) => console.log(`bench ${l}`);
const quiet = { out: () => undefined, err: (l: string) => say(`  err: ${l.slice(0, 200)}`) };

async function timed<T>(label: string, run: () => Promise<T>): Promise<T> {
  const phases: [string, number, number][] = [];
  buildPhases.on = (p, ms, cpu) => phases.push([p, ms, cpu]);
  // ATTICUS_BENCH_PROF=<words of a label>: a CPU profile of that phase, beside the estate.
  const prof = process.env.ATTICUS_BENCH_PROF;
  const session = prof && label.includes(prof) ? new Session() : undefined;
  if (session) {
    session.connect();
    await session.post("Profiler.enable");
    // ATTICUS_BENCH_PROF_US: the sampling interval in microseconds (5000 by default).
    await session.post("Profiler.setSamplingInterval", {
      interval:
        Number(process.env.ATTICUS_BENCH_PROF_US) > 0
          ? Number(process.env.ATTICUS_BENCH_PROF_US)
          : 5000,
    });
    await session.post("Profiler.start");
  }
  const t = performance.now();
  const c = process.cpuUsage();
  // The peak of the process's memory while it runs, sampled every 100 ms.
  let rss = process.memoryUsage().rss;
  let heap = process.memoryUsage().heapUsed;
  const sample = setInterval(() => {
    const m = process.memoryUsage();
    rss = Math.max(rss, m.rss);
    heap = Math.max(heap, m.heapUsed);
  }, 100);
  try {
    return await run();
  } finally {
    clearInterval(sample);
    if (session) {
      const { profile } = await session.post("Profiler.stop");
      await writeFile(
        join(process.env.ATTICUS_BENCH_DIR ?? tmpdir(), `bench-${prof}.cpuprofile`),
        JSON.stringify(profile),
      );
      session.disconnect();
    }
    buildPhases.on = undefined;
    const used = process.cpuUsage(c);
    say(
      `${label}: ${((performance.now() - t) / 1000).toFixed(2)} s (${((used.user + used.system) / 1e6).toFixed(1)} CPU s), peak RSS ${(rss / 1e9).toFixed(2)} GB, heap ${(heap / 1e9).toFixed(2)} GB, load ${loadavg()
        .map((x) => x.toFixed(1))
        .join(" ")}`,
    );
    // Each phase's wall clock and the CPU the process used meanwhile (every thread's).
    const sum = new Map<string, [number, number]>();
    for (const [p, ms, cpu] of phases) {
      const was = sum.get(p) ?? [0, 0];
      sum.set(p, [was[0] + ms, was[1] + cpu]);
    }
    for (const [p, [ms, cpu]] of sum)
      if (ms >= 50) say(`  ${p}: ${(ms / 1000).toFixed(2)} s (${(cpu / 1000).toFixed(1)} CPU s)`);
  }
}

describe.skipIf(!ON)("the big estate's speeds (benchmark)", () => {
  it("measures each phase", async () => {
    const dir = process.env.ATTICUS_BENCH_DIR ?? join(tmpdir(), `atticus-big-${N}`);
    const root = join(dir, "forge");
    let options: Awaited<ReturnType<typeof makeBigEstate>>["options"];
    if (!existsSync(join(root, "catalog", "sources", "build.json"))) {
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      const made = await timed("generate", () =>
        FIELD
          ? makeFieldEstate(dir, { services: N - fieldGateways, gateways: fieldGateways })
          : makeBigEstate(dir, { repos: N, gateways: G }),
      );
      options = made.options;
      const cold = await timed("cold build (catalog build)", () =>
        buildAndWrite(root, { command: "atticus catalog build" }),
      );
      say(
        `  records: ${cold.build.records.length}, refused: ${cold.guard.refused?.reasons.join(", ") ?? "no"}`,
      );
    } else options = (await makeOptions())!;
    const r = 1;
    const repo = bigRepoId(r);
    const first = Number(process.env.ATTICUS_BENCH_EDIT ?? Date.now() % 90) + 1;
    // ADR 0205: the way before its steps, or the app's memory on as the server has it.
    if (STEPS_OFF) {
      writeFactsHooks.fullDiff = true;
      factsParseHooks.off = true;
    } else if (APP) startAppMemory();
    // Two changes of one repo, each `verify <repo> --write`'s catalog write: the first after
    // the code changed (an upgrade: the build cache's texts are another version's), the second
    // as every write after it.
    for (const [edit, label] of WRITES
      ? ([
          [first, "first write after an upgrade"],
          ...Array.from({ length: RUNS }, (_, k) => [first + 1 + k, `write ${k + 1}`] as const),
        ] as const)
      : []) {
      const facts = await writeBigRepo(root, r, options, edit, true, false);
      say(`edit ${edit} of ${repo}: ${facts.length} facts`);
      if (APP) {
        // The app's Apply: verify --write in this process, to its result ("done"), the caches
        // written after it (ADR 0205 step 2), timed apart.
        const code = await timed(`the app's Apply of ${repo} (${label})`, () =>
          verifyCommand(
            root,
            repo,
            {
              write: true,
              verbose: false,
              json: false,
              // The estate's checkouts have no .git: the facts' commit, as the command is given.
              commit: BIG_COMMIT,
              cachesAfterResult: !STEPS_OFF,
            },
            quiet,
          ),
        );
        await timed(`  its caches after the result (${label})`, () => settleAfterResult());
        say(`  exit: ${code}`);
        continue;
      }
      const w = await timed(`verify ${repo} --write, the catalog (${label})`, () =>
        writeFactsIntoCatalog(
          root,
          repo,
          facts,
          { dir: join(root, "workspace", repo), command: `atticus verify ${repo} --write` },
          quiet,
        ),
      );
      say(`  written: ${JSON.stringify(w?.written)}`);
    }
    if (APP && !STEPS_OFF) {
      // ADR 0205 step 4: what the app's server holds after its Applies, each keeper's own count
      // and the heap after a full collection with it and once it is let go.
      const gc = () => {
        setFlagsFromString("--expose-gc");
        (runInNewContext("gc") as () => void)();
      };
      const held = appMemoryHeld();
      gc();
      const withIt = getHeapStatistics().used_heap_size;
      releaseAppMemory();
      gc();
      const without = getHeapStatistics().used_heap_size;
      say(
        `the app's memory: ${Object.entries(held)
          .map(([k, v]) => `${k} ${(v / 1e6).toFixed(0)} MB`)
          .join(
            ", ",
          )}; the heap ${(withIt / 1e9).toFixed(2)} GB with it, ${(without / 1e9).toFixed(2)} GB let go (${((withIt - without) / 1e6).toFixed(0)} MB held)`,
      );
      stopAppMemory();
    }
    // ATTICUS_BENCH_CLI=<the CLI's dist/bin.js>: one repo's whole Apply as the command runs it
    // (`atticus verify <repo> --write`: its own process, verify's check of every fact, then the
    // write), RUNS times, each after another change of the repo.
    const cli = process.env.ATTICUS_BENCH_CLI;
    for (let k = 0; cli && k < RUNS; k++) {
      const edit = first + 1 + RUNS + k;
      await writeBigRepo(root, r, options, edit, true, false);
      const run = spawnSync(
        "bash",
        [
          "-c",
          `TIMEFORMAT="%R %U %S"; time node --max-old-space-size=4096 "${cli}" verify ${repo} --write --commit ${BIG_COMMIT} > /dev/null 2>&1`,
        ],
        { cwd: root, encoding: "utf8" },
      );
      const [wall, user, sys] = run.stderr.trim().split(/\s+/).map(Number);
      say(
        `atticus verify ${repo} --write (edit ${edit}, its own process): ${wall!.toFixed(2)} s (${(user! + sys!).toFixed(1)} CPU s), exit ${run.status}, load ${loadavg()
          .map((x) => x.toFixed(1))
          .join(" ")}`,
      );
    }
    // ATTICUS_BENCH_ONE=1 (or another script's path): each write in a process of its own, `node
    // test/bench-one-write.mjs <root> <repo>` after another change of the repo, which times it
    // and prints its phases (the vitest worker stays small on a machine whose memory is shared);
    // ATTICUS_BENCH_ONE_VERIFY=1 runs verify --write as the app does; ATTICUS_BENCH_ONE_FLAGS are
    // node's flags for it. Build first: the script runs the built code.
    const one =
      process.env.ATTICUS_BENCH_ONE === "1"
        ? join(import.meta.dirname, "bench-one-write.mjs")
        : process.env.ATTICUS_BENCH_ONE;
    for (let k = 0; one && k < RUNS; k++) {
      const edit = first + 1 + 2 * RUNS + k;
      await writeBigRepo(root, r, options, edit, true, false);
      const run = spawnSync(
        "node",
        [
          ...(process.env.ATTICUS_BENCH_ONE_FLAGS ?? "").split(" ").filter(Boolean),
          one,
          root,
          repo,
          ...(process.env.ATTICUS_BENCH_ONE_VERIFY ? ["--verify"] : []),
        ],
        { cwd: root, encoding: "utf8" },
      );
      say(
        `one write (edit ${edit}), exit ${run.status}: ${run.stdout.trim()} ${run.stderr.slice(-400)}`,
      );
    }
    if (!READS) return;
    // ADR 0197: build.json in both versions, the same build: size, the guards' read (a parse,
    // version 1 turned into version 2), the write's serializing, and the round trip.
    {
      const text = await readFile(join(root, "catalog", "sources", "build.json"), "utf8");
      const v1 = v1Of(text);
      const at = (f: () => unknown) => {
        const t = performance.now();
        f();
        return ((performance.now() - t) / 1000).toFixed(2);
      };
      let p2: ReturnType<typeof parseBuildManifest> | undefined;
      let p1: ReturnType<typeof parseBuildManifest> | undefined;
      const r2 = at(() => (p2 = parseBuildManifest(text)));
      const r1 = at(() => (p1 = parseBuildManifest(v1)));
      if (!p1?.ok || !p2?.ok) throw new Error("build.json doesn't read");
      const old = manifestToV1(p2.slot);
      const w2 = at(() => serializeBuildManifest(p2!.ok ? p2!.slot : (undefined as never)));
      const w1 = at(() => serializeBuildManifestV1(old));
      say(
        `build.json version 2: ${(text.length / 1e6).toFixed(1)} MB, read ${r2} s, written ${w2} s; version 1: ${(v1.length / 1e6).toFixed(1)} MB, read ${r1} s, written ${w1} s`,
      );
      const same = serializeBuildManifest(p1.slot) === text && serializeBuildManifestV1(old) === v1;
      say(`  round trip version 1 to 2 and back: ${same ? "byte for byte" : "DIFFERS"}`);
      if (!same) throw new Error("build.json's round trip differs");
    }
    const op = await loadOrgPack(orgPackDirOf(root));
    const estate = await timed("estateFacts", () => estateFacts(root, op, ""));
    await timed("estateJoinOf (pure)", async () =>
      estateJoinOf(op, estate.repos, estate.targets, estate.pairs, estate.aiTargets),
    );
    forgetKeptChecks();
    await timed("Connect panel read (after the write)", () =>
      candidatesOf(root, repo, { repo: bigRepoId(2) }),
    );
    await timed("Connect panel read (again)", () =>
      candidatesOf(root, repo, { repo: bigRepoId(2) }),
    );
    // The repo's calls through the gateway's host, to a proxy that fronts another service.
    if (G > 1)
      await timed("Connect panel read (a gateway proxy)", () =>
        candidatesOf(root, repo, { repo: bigGatewayId(G - 1) }),
      );
    await timed("pairing preview", () => verifyWritePreview(root, repo));
  }, 3_600_000);
});

async function makeOptions() {
  if (FIELD)
    return {
      repos: N - fieldGateways,
      entries: 60,
      calls: 40,
      tables: 8,
      settings: 40,
      seed: 1,
      gateways: fieldGateways,
      routes: 20,
      clusters: 1,
      fieldNames: 6000,
      termRepos: fieldGateways,
      termValues: 90,
    };
  return {
    repos: N,
    entries: 360,
    calls: 220,
    tables: 40,
    settings: 300,
    seed: 1,
    gateways: Math.min(G, N),
    routes: 40,
    clusters: 1,
    fieldNames: 0,
    termRepos: 0,
    termValues: 90,
  };
}
