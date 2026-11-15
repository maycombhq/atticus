import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { tmpdir } from "node:os";
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
import { loadOrgPack, orgPackDirOf } from "@maycombhq/core";
import { writeFactsIntoCatalog } from "../src/map-render-commands.js";
import { candidatesOf } from "../src/ui-api-links.js";
import { verifyWritePreview } from "../src/verify-preview.js";
import { forgetKeptChecks } from "../src/contract-check-files.js";
import { bigGatewayId, bigRepoId, makeBigEstate, writeBigRepo } from "./big-estate.js";
import { v1Of } from "./build-json-v1.js";

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
const say = (l: string) => console.log(`bench ${l}`);
const quiet = { out: () => undefined, err: (l: string) => say(`  err: ${l.slice(0, 200)}`) };

async function timed<T>(label: string, run: () => Promise<T>): Promise<T> {
  const phases: [string, number][] = [];
  buildPhases.on = (p, ms) => phases.push([p, ms]);
  // ATTICUS_BENCH_PROF=<words of a label>: a CPU profile of that phase, beside the estate.
  const prof = process.env.ATTICUS_BENCH_PROF;
  const session = prof && label.includes(prof) ? new Session() : undefined;
  if (session) {
    session.connect();
    await session.post("Profiler.enable");
    // ATTICUS_BENCH_PROF_US: the sampling interval in microseconds (5000 by default).
    await session.post("Profiler.setSamplingInterval", {
      interval: Number(process.env.ATTICUS_BENCH_PROF_US ?? 5000),
    });
    await session.post("Profiler.start");
  }
  const t = performance.now();
  const c = process.cpuUsage();
  try {
    return await run();
  } finally {
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
      `${label}: ${((performance.now() - t) / 1000).toFixed(2)} s (${((used.user + used.system) / 1e6).toFixed(1)} CPU s)`,
    );
    const sum = new Map<string, number>();
    for (const [p, ms] of phases) sum.set(p, (sum.get(p) ?? 0) + ms);
    for (const [p, ms] of sum) if (ms >= 50) say(`  ${p}: ${(ms / 1000).toFixed(2)} s`);
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
      const made = await timed("generate", () => makeBigEstate(dir, { repos: N, gateways: G }));
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
    // Two changes of one repo, each `verify <repo> --write`'s catalog write: the first after
    // the code changed (an upgrade: the build cache's texts are another version's), the second
    // as every write after it.
    for (const [edit, label] of WRITES
      ? ([
          [first, "first write after an upgrade"],
          [first + 1, "write"],
        ] as const)
      : []) {
      const facts = await writeBigRepo(root, r, options, edit, true, false);
      say(`edit ${edit} of ${repo}: ${facts.length} facts`);
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
  };
}
