import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashCacheHooks } from "@maycombhq/core";
import { buildAndWrite, buildCacheHooks, buildPhases } from "@maycombhq/scanner";
import { writeFactsIntoCatalog } from "../src/map-render-commands.js";
import { bigRepoFacts, bigRepoId, writeBigRepo } from "./big-estate.js";
import { makeFieldEstate, type FieldEstate } from "./field-estate.js";

/**
 * Beta.28.5, the owner's field report of beta.28.4: "a single repo's map has been running for 2
 * hours", on 40 repos and 12,832 record files, a Windows laptop with antivirus. The map of one
 * repo ends with the estate join, which applies every repo with facts (`verify <repo> --write`),
 * and each of those forty applies cost 45 to 80 s there:
 *
 * - every apply opened and hashed every record file to check the build against the catalog on
 *   file (20 to 34 s under antivirus, where an open is slow), although the apply before it had
 *   just done so and changed a handful;
 * - an apply that raised, refreshed or retired a question made the next apply's build run every
 *   pass (the glossary, intake, the join) to write no file.
 *
 * The estate here has that shape (field-estate.ts). What is held: an apply straight after
 * another opens only the record files the one before wrote; the applies of the join that
 * change nothing run no pass of the build, whatever questions the one before raised; and the
 * files an estate is left with are the same bytes with the kept hashes and the kept build as
 * without them. Budgets are CPU time of this process, about three times what this machine
 * measured (2 shared CPUs): 2.3 CPU s an apply that changes nothing.
 */
const AGAIN_CPU_S = 8;
/** Longer than the timestamp grain the kept hashes allow for (RACY_MS), so files read as settled. */
const SETTLE_MS = 2_200;

const quiet = { out: () => undefined, err: () => undefined };
const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));

/** One repo applied with these facts; the files its check opened and whether its build ran. */
async function apply(e: FieldEstate, r: number, facts: Awaited<ReturnType<typeof writeBigRepo>>) {
  const repo = bigRepoId(r);
  let opened = 0;
  let built = false;
  hashCacheHooks.onHashed = (n) => (opened += n);
  buildPhases.on = (p) => {
    if (p === "build: files and build.json") built = true;
  };
  const c = process.cpuUsage();
  try {
    const w = await writeFactsIntoCatalog(
      e.root,
      repo,
      facts,
      {
        dir: join(e.root, "workspace", repo),
        command: `atticus verify ${repo} --write`,
        now: new Date("2026-11-17T09:00:00Z"),
      },
      quiet,
    );
    const used = process.cpuUsage(c);
    return { w, opened, built, cpu: (used.user + used.system) / 1e6 };
  } finally {
    delete hashCacheHooks.onHashed;
    buildPhases.on = undefined;
  }
}

describe("the applies of a map's estate join on an estate shaped as the owner's (beta.28.5)", () => {
  let dir: string;
  let estate: FieldEstate;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "atticus-map-loop-speed-"));
    estate = await makeFieldEstate(dir);
    const cold = await buildAndWrite(estate.root, { command: "atticus catalog build" });
    expect(cold.guard.refused).toBeUndefined();
    await settle();
  }, 600_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("an apply straight after another opens only the record files that one wrote, then none", async () => {
    // The repo just read: its facts changed, so its apply builds and writes some record files.
    const facts = await writeBigRepo(estate.root, 1, estate.options, 2, true, false);
    const first = await apply(estate, 1, facts);
    const files = (first.w?.written.written ?? 0) + (first.w?.written.unchanged ?? 0);
    expect(files).toBeGreaterThan(11_000);
    expect(first.built).toBe(true);
    const wrote = first.w!.written.written;
    expect(wrote).toBeGreaterThan(0);
    expect(wrote).toBeLessThan(200);
    await settle();
    // The same facts again, as the join applies the repo once more: nothing to build or write.
    const again = await apply(estate, 1, facts);
    console.log(
      `map-loop-speed apply again: ${again.cpu.toFixed(1)} CPU s, ${again.opened} of ${files} record files opened (${again.cpu < AGAIN_CPU_S ? "within" : "over"} budget, ${AGAIN_CPU_S} CPU s)`,
    );
    expect(again.w?.written).toMatchObject({ written: 0, removed: 0 });
    expect(again.built).toBe(false);
    // It was every record file, each time.
    expect(again.opened).toBeLessThanOrEqual(wrote);
    expect(again.cpu).toBeLessThan(AGAIN_CPU_S);
    const third = await apply(estate, 1, facts);
    expect(third.opened).toBe(0);
    expect(third.cpu).toBeLessThan(AGAIN_CPU_S);
  }, 600_000);

  it("the join's applies of repos nothing changed in run no pass of the build, whatever questions the one before raised", async () => {
    let raised = 0;
    for (const r of [0, 2, 3, 4]) {
      const a = await apply(estate, r, bigRepoFacts(r, estate.options, 0).facts);
      raised += a.w?.questions.length ?? 0;
      expect(a.w?.written, bigRepoId(r)).toMatchObject({ written: 0, removed: 0 });
      // It ran every pass after any apply that raised or refreshed a question.
      expect(a.built, bigRepoId(r)).toBe(false);
      expect(a.opened, bigRepoId(r)).toBeLessThan(200);
      expect(a.cpu, bigRepoId(r)).toBeLessThan(AGAIN_CPU_S);
    }
    // The case is the one meant: these applies did raise questions.
    expect(raised).toBeGreaterThan(0);
  }, 600_000);
});

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

describe("the files an estate is left with are the same bytes with the kept hashes and build as without (beta.28.5)", () => {
  it("applies a changed repo and three others, each way, to the same catalog, maps, specs and questions", async () => {
    const made: string[] = [];
    const run = async (kept: boolean) => {
      const d = await mkdtemp(join(tmpdir(), `atticus-map-loop-eq-${kept ? "kept" : "plain"}-`));
      made.push(d);
      const e = await makeFieldEstate(d, {
        services: 8,
        gateways: 4,
        entries: 40,
        calls: 30,
        fieldNames: 600,
        legacy: 2,
        questions: 30,
        links: 12,
        suppressed: 8,
        checkouts: 2,
      });
      buildCacheHooks.off = !kept;
      hashCacheHooks.off = !kept;
      try {
        const cold = await buildAndWrite(e.root, { command: "atticus catalog build" });
        expect(cold.guard.refused).toBeUndefined();
        const outcomes: unknown[] = [];
        const changed = await writeBigRepo(e.root, 1, e.options, 2, true, false);
        let passes = 0;
        for (const [r, facts] of [
          [1, changed],
          [0, bigRepoFacts(0, e.options, 0).facts],
          [1, changed],
          [2, bigRepoFacts(2, e.options, 0).facts],
          [3, bigRepoFacts(3, e.options, 0).facts],
        ] as const) {
          const a = await apply(e, r, [...facts]);
          if (a.built) passes++;
          outcomes.push([a.w?.written, a.w?.questions, a.w?.links, a.w?.map]);
        }
        return { files: await tree(e.root), outcomes, passes };
      } finally {
        buildCacheHooks.off = false;
        delete hashCacheHooks.off;
      }
    };
    try {
      const plain = await run(false);
      const kept = await run(true);
      // The comparison is of something: the plain way ran the passes for every apply, the kept
      // way for the one whose facts changed.
      expect(plain.passes).toBe(5);
      expect(kept.passes).toBe(1);
      expect(kept.outcomes).toEqual(plain.outcomes);
      expect([...kept.files.keys()].sort()).toEqual([...plain.files.keys()].sort());
      expect(kept.files.size).toBeGreaterThan(1_000);
      for (const [p, text] of plain.files) expect(kept.files.get(p) === text, p).toBe(true);
    } finally {
      await Promise.all(made.map((d) => rm(d, { recursive: true, force: true })));
    }
  }, 600_000);
});
