import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { glossaryBuildHooks } from "@maycombhq/glossary";
import {
  buildAndWrite,
  buildCacheHooks,
  buildCatalog,
  buildPhases,
  loadBuildInputs,
} from "@maycombhq/scanner";
import { writeFactsIntoCatalog } from "../src/map-render-commands.js";
import { verifyWritePreview } from "../src/verify-preview.js";
import { bigFieldShortens, bigRepoId, writeBigRepo } from "./big-estate.js";
import { makeFieldEstate, termOfField, type FieldEstate } from "./field-estate.js";
import { steadyWriteCpu } from "./write-cpu.js";

/**
 * beta.28.4, the owner's field report of beta.28.3: `verify <repo> --write` of one repo, and the
 * preview of it, took over ten minutes on an estate of 40 repos and 12,846 records, with no line
 * said after "pass 3 of 8". The estate here has that shape (field-estate.ts): 40 repos, about
 * 14,000 records, 6,000 of them glossary terms from the payloads' field names, 15 proxies
 * sharing an access file of 90 values, legacy services, 240 open questions, calls paired by
 * hand and arrows suppressed.
 *
 * What was slow: a build's glossary asked for a naming hint once per two-word term, and each
 * hint read every term, so the time grew with the square of the estate's vocabulary (measured on
 * this build machine, 2 shared CPUs: 1.2 s at 1,000 names, 4.7 s at 2,000, 18 s at 4,000, 46 s
 * at 6,000, each build; big-estate.ts has two dozen terms at any size, so its budgets never saw
 * it). The terms are read once now: 0.25 s at 4,000 names, 0.5 s at 8,000, 1 s at 16,000.
 *
 * The budgets are CPU time of this process, as big-estate-speed's, and about three times what
 * this machine measured, for a slow Windows runner: with the hints as they were, each build here
 * takes about 46 CPU s more, past every budget below.
 */
const WRITE_CPU_S = 30;
const PREVIEW_CPU_S = 20;
/** The glossary's stage of one build (the time on buildPhases' clock). */
const GLOSSARY_S = 8;

let dir: string;
let estate: FieldEstate;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "atticus-field-speed-"));
  estate = await makeFieldEstate(dir);
  const cold = await buildAndWrite(estate.root, { command: "atticus catalog build" });
  expect(cold.guard.refused).toBeUndefined();
}, 600_000);
afterAll(async () => {
  delete glossaryBuildHooks.everyTerm;
  buildCacheHooks.off = false;
  await rm(dir, { recursive: true, force: true });
});

/** The CPU seconds `run` takes, said with the time on the clock and its budget. */
async function cpu<T>(
  label: string,
  budget: number,
  run: () => Promise<T>,
): Promise<{ s: number; value: T }> {
  const c = process.cpuUsage();
  const t = performance.now();
  const value = await run();
  const used = process.cpuUsage(c);
  const s = (used.user + used.system) / 1e6;
  console.log(
    `field-estate-speed ${label}: ${s.toFixed(1)} CPU s, ${((performance.now() - t) / 1000).toFixed(1)} s (${s < budget ? "within" : "over"} budget, ${budget} CPU s)`,
  );
  return { s, value };
}

const repo = bigRepoId(1);
const quiet = { out: () => undefined, err: () => undefined };

describe("one repo changed on an estate shaped as the owner's (beta.28.4)", () => {
  it("has the shape: its size, its terms, its shared values, its legacy services", async () => {
    buildCacheHooks.off = true;
    try {
      const b = await buildCatalog(await loadBuildInputs(estate.root));
      const count = (kind: string) => b.records.filter((r) => r.kind === kind).length;
      console.log(
        `field-estate-speed estate: ${b.records.length} records, ${count("GlossaryTerm")} glossary terms, ${b.terms?.possible.length ?? 0} shared values, ${b.sources.filter((s) => s.source === "legacy").length} legacy repos`,
      );
      expect(b.sources.length).toBe(40);
      expect(b.records.length).toBeGreaterThan(11_000);
      expect(b.records.length).toBeLessThan(17_000);
      expect(count("GlossaryTerm")).toBeGreaterThan(5_000);
      // 90 values, each written in the 15 proxies at the same lines: 90 possible links.
      expect(b.terms?.possible.length).toBe(90);
      expect(b.terms?.possible.every((p) => p.seen.length === 15)).toBe(true);
      expect(b.sources.filter((s) => s.source === "legacy").map((s) => s.repo)).toEqual(
        estate.legacy,
      );
      expect(estate.links).toBeGreaterThan(20);
      expect(b.curated.suppressed.length).toBe(estate.suppressed.length);
    } finally {
      buildCacheHooks.off = false;
    }
  }, 600_000);

  it("writes the catalog inside the budget, the glossary's stage inside its own", async () => {
    let glossary = 0;
    buildPhases.on = (p, ms) => {
      if (p === "build: 3 federation and glossary") glossary += ms / 1000;
    };
    const facts = await writeBigRepo(estate.root, 1, estate.options, 2, true, false);
    const { s, value } = await cpu("verify --write", WRITE_CPU_S, () =>
      writeFactsIntoCatalog(
        estate.root,
        repo,
        facts,
        {
          dir: join(estate.root, "workspace", repo),
          command: `atticus verify ${repo} --write`,
        },
        quiet,
      ),
    ).finally(() => {
      buildPhases.on = undefined;
    });
    console.log(
      `field-estate-speed the glossary's stage: ${glossary.toFixed(2)} s (${glossary < GLOSSARY_S ? "within" : "over"} budget, ${GLOSSARY_S} s)`,
    );
    expect(value?.written.written).toBeGreaterThan(0);
    expect(value?.written.unchanged).toBeGreaterThan(8_000);
    expect(s).toBeLessThan(WRITE_CPU_S);
    // The stage was timed at all (the phase is found by its name).
    expect(glossary).toBeGreaterThan(0);
    expect(glossary).toBeLessThan(GLOSSARY_S);
  }, 600_000);

  it("previews the next write inside the budget", async () => {
    await writeBigRepo(estate.root, 1, estate.options, 3, true, false);
    const p = await cpu("preview of the write", PREVIEW_CPU_S, () =>
      verifyWritePreview(estate.root, repo),
    );
    expect(p.value?.preview?.catalog?.files.length).toBeGreaterThan(0);
    expect(p.s).toBeLessThan(PREVIEW_CPU_S);
  }, 600_000);
});

/**
 * The fix changes no byte: the same estate at a size the old way still builds quickly (12 repos,
 * 1,200 field names, legacy services, questions, pairings and suppressed arrows), built with the
 * naming hints as they were (every term read for each, `glossaryBuildHooks.everyTerm`) and as
 * they are: the same record files and the same build.json.
 */
const FIELD_NAMES = 1200;

describe("the build of that shape is the one before the fix, byte for byte (beta.28.4)", () => {
  it("builds the same files with the naming hints read the old way and the new", async () => {
    const small = await mkdtemp(join(tmpdir(), "atticus-field-eq-"));
    try {
      const e = await makeFieldEstate(small, {
        services: 8,
        gateways: 4,
        entries: 40,
        calls: 30,
        fieldNames: FIELD_NAMES,
        legacy: 2,
        questions: 30,
        links: 12,
        suppressed: 8,
        checkouts: 0,
      });
      buildCacheHooks.off = true;
      const build = async (everyTerm: boolean) => {
        if (everyTerm) glossaryBuildHooks.everyTerm = true;
        else delete glossaryBuildHooks.everyTerm;
        try {
          return await buildCatalog(await loadBuildInputs(e.root));
        } finally {
          delete glossaryBuildHooks.everyTerm;
        }
      };
      const was = await build(true);
      const now = await build(false);
      expect(was.records.filter((r) => r.kind === "GlossaryTerm").length).toBeGreaterThan(1_000);
      // The hints did something in the build as it was: every field name that shortens the one
      // before it is no term (its hint, an abbreviation), while the name it shortens is one; and
      // the name a person's alias gives to another term is no term either.
      const terms = new Set(was.records.filter((r) => r.kind === "GlossaryTerm").map((r) => r.id));
      const shortened = Array.from({ length: FIELD_NAMES }, (_, v) => v).filter(bigFieldShortens);
      expect(shortened.length).toBeGreaterThan(20);
      for (const v of shortened) {
        expect(terms.has(termOfField(v - 1)), `the name ${v} shortens`).toBe(true);
        expect(terms.has(termOfField(v)), `the shortened name ${v}`).toBe(false);
      }
      expect(terms.has(termOfField(0))).toBe(true);
      expect(terms.has(termOfField(1))).toBe(false);
      // With no hint asked at all, each shortened name would be a term: the hints are what the
      // two builds must agree on.
      expect(terms.has(termOfField(2))).toBe(true);
      expect(was.sources.filter((s) => s.source === "legacy").length).toBe(2);
      expect([...now.files.keys()]).toEqual([...was.files.keys()]);
      for (const [path, text] of was.files) expect(now.files.get(path), path).toBe(text);
      expect(now.manifest).toEqual(was.manifest);
      expect(now.retired).toEqual(was.retired);
      expect(now.notes).toEqual(was.notes);
    } finally {
      buildCacheHooks.off = false;
      await rm(small, { recursive: true, force: true });
    }
  }, 600_000);
});

/**
 * ADR 0205: one repo's write on the field-shaped estate at 60 repos in all, 3 in 8 of them
 * gateway proxies (the owner's shape at the size the 15 s budget is for). A CPU budget of the
 * median of three steady writes, about three times what ADR 0205 measured on this build machine
 * after its steps, for a slow runner. Only with ATTICUS_BENCH=1 (ATTICUS_BENCH_REPOS for another
 * size): the nightly's wall-clock budget (apply-budget.test.ts) is the one CI keeps.
 */
const BENCH = !!process.env.ATTICUS_BENCH;
const BENCH_REPOS = Number(process.env.ATTICUS_BENCH_REPOS ?? 60);
const FIELD_60_WRITE_CPU_S = 15;

describe.skipIf(!BENCH)(`one repo's write at ${BENCH_REPOS} repos (ADR 0205's budget)`, () => {
  it(`takes under ${FIELD_60_WRITE_CPU_S} CPU s, the median of three`, async () => {
    const at = await mkdtemp(join(tmpdir(), "atticus-field-budget-"));
    try {
      const gateways = Math.round((BENCH_REPOS * 3) / 8);
      const e = await makeFieldEstate(at, { services: BENCH_REPOS - gateways, gateways });
      const cold = await buildAndWrite(e.root, { command: "atticus catalog build" });
      expect(cold.guard.refused).toBeUndefined();
      const { median } = await steadyWriteCpu(e.root, e.options, "field-estate-speed");
      console.log(
        `field-estate-speed at ${BENCH_REPOS} repos: ${median.toFixed(1)} CPU s, the median (budget ${FIELD_60_WRITE_CPU_S})`,
      );
      expect(median).toBeLessThan(FIELD_60_WRITE_CPU_S);
    } finally {
      await rm(at, { recursive: true, force: true });
    }
  }, 3_600_000);
});
