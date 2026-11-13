import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { buildAndWrite, buildPhases, estateJoinOf, estateFacts } from "@maycombhq/scanner";
import { loadOrgPack, orgPackDirOf } from "@maycombhq/core";
import { writeFactsIntoCatalog } from "../src/map-render-commands.js";
import { candidatesOf } from "../src/ui-api-links.js";
import { verifyWritePreview } from "../src/verify-preview.js";
import { forgetKeptChecks } from "../src/contract-check-files.js";
import { bigRepoId, makeBigEstate, writeBigRepo } from "./big-estate.js";

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
    await session.post("Profiler.setSamplingInterval", { interval: 5000 });
    await session.post("Profiler.start");
  }
  const t = performance.now();
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
    say(`${label}: ${((performance.now() - t) / 1000).toFixed(2)} s`);
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
      const made = await timed("generate", () => makeBigEstate(dir, { repos: N }));
      options = made.options;
      const cold = await timed("cold build (catalog build)", () =>
        buildAndWrite(root, { command: "atticus catalog build" }),
      );
      say(
        `  records: ${cold.build.records.length}, refused: ${cold.guard.refused?.reason ?? "no"}`,
      );
    } else options = (await makeOptions())!;
    const r = 1;
    const repo = bigRepoId(r);
    const first = Number(process.env.ATTICUS_BENCH_EDIT ?? Date.now() % 90) + 1;
    // Two changes of one repo, each `verify <repo> --write`'s catalog write: the first after
    // the code changed (an upgrade: the build cache's texts are another version's), the second
    // as every write after it.
    for (const [edit, label] of [
      [first, "first write after an upgrade"],
      [first + 1, "write"],
    ] as const) {
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
  };
}
