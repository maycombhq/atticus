import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  afterResultPending,
  appMemory,
  factsParseHooks,
  factsParseStats,
  forgetFactsParses,
  recordCacheHooks,
  recordCacheStats,
  settleAfterResult,
  startAppMemory,
  stopAppMemory,
} from "@maycombhq/core";
import {
  buildAndWrite,
  buildCacheHooks,
  buildCacheStats,
  projectionHooks,
  projectionStats,
} from "@maycombhq/scanner";
import { traceHooks, traceStats } from "@maycombhq/features";
import type { CatalogDiff } from "@maycombhq/scanner";
import { writeFactsHooks, writeFactsIntoCatalog } from "../src/map-render-commands.js";
import { bigRepoFacts, bigRepoId, makeBigEstate, writeBigRepo } from "./big-estate.js";
import { makeFieldEstate } from "./field-estate.js";

/**
 * ADR 0205: one repo's Apply in fifteen seconds, each step proven to change nothing. Two small
 * estates, one of each shape (big-estate.ts's, and field-estate.ts's, the owner's), are applied
 * with the steps on and with them off (each step's hook gives the way before it), and after every
 * write every file a person or a commit sees is the same bytes and the write says the same. Where
 * a step computes a result another way, the run with it on computes both and they must be equal:
 * if they ever differ, the step is held back (the ADR's proof).
 */

/** Every file under `root` a person or a commit sees: not this machine's caches and state. */
async function tree(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (rel: string) => {
    for (const e of await readdir(join(root, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (p === ".atticus" || p === ".index" || p === "workspace") continue;
        await walk(p);
      } else out.set(p, await readFile(join(root, p), "utf8"));
    }
  };
  await walk("");
  return out;
}

/** The last build kept by the build cache (its header line), once its writes are done. */
const keptBuild = (root: string) =>
  readFile(join(root, ".index", "build-cache", "last-build.jsonl"), "utf8").then(
    (t) => {
      // Its key hashes the folder too, so the two runs' keys differ; what it holds doesn't.
      const h = JSON.parse(t.slice(0, t.indexOf("\n"))) as Record<string, unknown>;
      const manifest = (h.manifest as { sha256?: string } | undefined)?.sha256;
      return { records: h.records, files: h.files, manifest, lines: t.split("\n").length };
    },
    () => undefined,
  );

type Made = { root: string; options: Awaited<ReturnType<typeof makeBigEstate>>["options"] };

const SHAPES: Record<string, (dir: string) => Promise<Made>> = {
  big: (dir) =>
    makeBigEstate(dir, {
      repos: 5,
      entries: 40,
      calls: 30,
      tables: 6,
      settings: 30,
      seed: 2,
      checkouts: 5,
      gateways: 2,
    }),
  "field-shaped": (dir) =>
    makeFieldEstate(dir, {
      services: 6,
      gateways: 3,
      entries: 24,
      calls: 16,
      fieldNames: 300,
      legacy: 2,
      questions: 20,
      links: 8,
      suppressed: 6,
      checkouts: 3,
    }),
};

/** The hooks that give the way before each step (ADR 0205), all of them, or none. */
function stepsOff(off: boolean): void {
  forgetFactsParses();
  if (off) {
    writeFactsHooks.fullDiff = true;
    factsParseHooks.off = true;
    projectionHooks.off = true;
    traceHooks.off = true;
  } else {
    delete writeFactsHooks.fullDiff;
    delete factsParseHooks.off;
    delete projectionHooks.off;
    delete traceHooks.off;
  }
}

const quiet = { out: () => undefined, err: () => undefined };
const made: string[] = [];
afterEach(async () => {
  stepsOff(false);
  delete writeFactsHooks.onDiffs;
  delete factsParseHooks.check;
  delete buildCacheHooks.checkTexts;
  delete recordCacheHooks.checkMemory;
  delete projectionHooks.check;
  await Promise.all(made.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** The estate made, built cold, then four writes of one repo each, as `verify --write` runs them. */
async function applies(shape: string, off: boolean) {
  const dir = await mkdtemp(join(tmpdir(), `atticus-apply15-${off ? "off" : "on"}-`));
  made.push(dir);
  stepsOff(off);
  // Step 4, as the app's server keeps it: the last build's texts and the facts parses in memory.
  // The machine's memory as roomy, whatever else runs on it (the test is of what is kept).
  if (!off) {
    appMemory.system = () => ({ free: 64 * 2 ** 30, total: 64 * 2 ** 30 });
    startAppMemory();
  }
  try {
    return await appliesIn(dir, shape, off);
  } finally {
    if (!off) stopAppMemory();
    delete appMemory.system;
  }
}

async function appliesIn(dir: string, shape: string, off: boolean) {
  const { root, options } = await SHAPES[shape]!(dir);
  const cold = await buildAndWrite(root, { command: "atticus catalog build" });
  expect(cold.guard.refused).toBeUndefined();
  const outcomes: unknown[] = [];
  for (const [r, edit] of [
    [1, 2],
    [1, 3],
    [2, 1],
    [1, 3],
  ] as const) {
    const facts =
      r === 1
        ? await writeBigRepo(root, r, options, edit, true, false)
        : bigRepoFacts(r, options, edit).facts;
    const repo = bigRepoId(r);
    const w = await writeFactsIntoCatalog(
      root,
      repo,
      facts,
      {
        dir: join(root, "workspace", repo),
        command: `atticus verify ${repo} --write`,
        now: new Date("2026-11-19T09:00:00Z"),
        // Step 2 (as the app's Apply runs it): the caches after the result, under the lock; the
        // next write waits for them in acquireLock, and the files are read once they are done.
        ...(off ? {} : { cachesAfterResult: true }),
      },
      quiet,
    );
    expect(w, `${shape}: the write of ${repo}`).toBeDefined();
    // The result came back with its caches still to write (step 2), or none (the way before).
    expect(afterResultPending(), "caches written after the result").toBe(off ? 0 : 1);
    outcomes.push([w?.written, w?.changes, w?.links, w?.questions, w?.map, w?.removed]);
  }
  await settleAfterResult();
  return { files: await tree(root), outcomes, kept: await keptBuild(root) };
}

describe("one repo's Apply with ADR 0205's steps on and off: the same bytes, the same words", () => {
  for (const shape of Object.keys(SHAPES))
    it(`${shape}: every file and every outcome of four writes`, async () => {
      // Step 1, both ways in the run with it on: the comparison over the changed files only, and
      // over the whole catalog, after every write.
      const both: [CatalogDiff, CatalogDiff][] = [];
      writeFactsHooks.onDiffs = (changed, whole) => both.push([changed, whole]);
      // Step 3, both ways: every kept facts parse is checked against a parse of its text.
      factsParseHooks.check = true;
      // Step 4, both ways: every kept text a build takes is checked against its serialization,
      // and every catalog parse a write's read takes from memory against its file's parse.
      buildCacheHooks.checkTexts = true;
      recordCacheHooks.checkMemory = true;
      // The addendum's step 1, both ways: each kept projection frozen, and compared with one
      // made now each time it is taken from memory.
      projectionHooks.check = true;
      const projectionsKept = projectionStats.kept;
      // Step 3b: the traces that share a start take one breadth-first part (on both estates).
      const tracesShared = traceStats.shared;
      const parsesFromMemory = recordCacheStats.fromMemory;
      const kept = factsParseStats.kept;
      const fromMemory = buildCacheStats().textsFromMemory;
      const hits = buildCacheStats().memoHits;
      const on = await applies(shape, false);
      delete writeFactsHooks.onDiffs;
      delete factsParseHooks.check;
      delete buildCacheHooks.checkTexts;
      delete recordCacheHooks.checkMemory;
      delete projectionHooks.check;
      // Every write after the first kept the projections of the repos it didn't change.
      expect(projectionStats.kept - projectionsKept, "projections kept").toBeGreaterThan(8);
      expect(traceStats.shared - tracesShared, "traces sharing a start").toBeGreaterThan(0);
      // Every write after the first read the catalog's parses from the server's memory.
      expect(
        recordCacheStats.fromMemory - parsesFromMemory,
        "parses from memory",
      ).toBeGreaterThanOrEqual(3);
      // Each write's build took the last build's texts from memory, but one whose inputs were the
      // last build's, which is that build whole, read from disk as before.
      const now = buildCacheStats();
      expect(now.textsFromMemory - fromMemory, "texts from memory").toBeGreaterThanOrEqual(3);
      expect(now.textsFromMemory - fromMemory + now.memoHits - hits).toBe(4);
      expect(factsParseStats.kept - kept, "facts parses kept and used").toBeGreaterThan(20);
      expect(both.length, "the comparison was made both ways").toBe(4);
      for (const [changed, whole] of both) expect(changed).toEqual(whole);
      // Something changed each time, so the comparison is of something.
      expect(both.some(([, w]) => w.changed.length + w.added.length + w.removed.length > 0)).toBe(
        true,
      );
      const off = await applies(shape, true);
      expect(on.outcomes).toEqual(off.outcomes);
      // Step 2: the cache written after the result is the one written before it.
      expect(on.kept).toBeDefined();
      expect(on.kept).toEqual(off.kept);
      expect([...on.files.keys()].sort()).toEqual([...off.files.keys()].sort());
      expect(on.files.size).toBeGreaterThan(300);
      for (const [p, text] of off.files) expect(on.files.get(p) === text, p).toBe(true);
    }, 600_000);
});
