import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import type { CatalogRecord, Fact } from "@maycombhq/core";
import { buildAndWrite, factsSnapshotWrites, readCatalog } from "@maycombhq/scanner";
import { main } from "../../src/main.js";
import { candidatesOf } from "../../src/ui-api-links.js";
import { shapeArb, writeShapeEstate, type ShapeSketch } from "./estate.js";
import { SHAPE_INVARIANTS, type ShapeInvariant } from "./invariants.js";

/**
 * Beta.30 (slice 9, field-reliability-and-ease.md item 2): the estate's shape as a property.
 * Each run is a small invented Forge estate from `shapeArb` (estate.ts): hosts written as deploy
 * tokens nothing sets, an id with dots, a repo with no System, a gateway proxy whose target is a
 * token its deploy file sets, nested payload fields. It is built as `atticus catalog build`
 * builds it, and the shape invariants (invariants.ts, `SHAPE_INVARIANTS`) are checked:
 *
 * - every-call-accounted: every call is drawn (a record cites its line), listed loose (Connect
 *   lists it with no arrow, a loose end or a question), or asked; Connect lists each call once,
 *   and a call it says has an arrow has a record citing it.
 * - every-refusal-has-a-next-step: a build the guard refuses, a Connect panel with nothing to
 *   show and a command that exits non-zero each name the command to go on with.
 *
 * `pnpm check` runs a fixed seed (ATTICUS_SHAPE_SEED, default 30) for ATTICUS_SHAPE_RUNS runs
 * (default 6); the nightly (properties/nightly.mjs) runs 200 with a random seed. A failure prints
 * its seed and the shrunk sketch: `ATTICUS_SHAPE_SEED=<seed> ATTICUS_SHAPE_RUNS=<n>` replays it.
 * Invented names only (CLAUDE.md rule 3); no clone and no network (rule 5).
 */

const RUNS = Number(process.env.ATTICUS_SHAPE_RUNS || 6);
const SEED = process.env.ATTICUS_SHAPE_SEED
  ? Number(process.env.ATTICUS_SHAPE_SEED)
  : process.env.ATTICUS_SHAPE_RANDOM
    ? Math.floor(Math.random() * 2 ** 31)
    : 30;

const dirs: string[] = [];
/** With ATTICUS_SHAPE_VERBOSE=1: how often each kind of call had each status in Connect. */
const tally = new Map<string, number>();
afterAll(async () => {
  if (process.env.ATTICUS_SHAPE_VERBOSE)
    process.stdout.write(
      [...tally]
        .sort()
        .map(([k, n]) => `  ${k}: ${n}`)
        .join("\n") + "\n",
    );
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

class ShapeError extends Error {
  constructor(
    readonly invariant: ShapeInvariant,
    message: string,
  ) {
    super(`${invariant}: ${message}`);
  }
}
const fail = (inv: ShapeInvariant, message: string): never => {
  throw new ShapeError(inv, message);
};

/** The working facts file and the snapshot `verify --write` leaves. */
async function snapshot(
  root: string,
  repo: string,
  facts: Record<string, unknown>[],
  commit: string,
): Promise<void> {
  await mkdir(join(root, "facts"), { recursive: true });
  await writeFile(
    join(root, "facts", `${repo}.jsonl`),
    facts.map((f) => JSON.stringify(f)).join("\n") + (facts.length ? "\n" : ""),
  );
  for (const w of factsSnapshotWrites(root, repo, facts as unknown as Fact[], {
    commit,
    contracts: null,
  })) {
    await mkdir(dirname(w.path), { recursive: true });
    await writeFile(w.path, w.text!);
  }
}

/** A command's words name a next step: an atticus command, or the app's button for one. */
const NEXT = /\batticus [a-z]/;

async function run(args: string[]) {
  const lines: string[] = [];
  const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) };
  const code = await main(args, io, { quiet: true });
  return { code, said: lines.join("\n") };
}

/** A call's kind for the tally: how it is made, and a token's form. */
const k0 = (c: { via: string; host: string }) =>
  c.via === "token" ? `token(${c.host.startsWith("@") ? "@name@" : "${NAME}"})` : c.via;

/** One run: make the estate, build it, check both invariants. */
async function check(k: ShapeSketch): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "b30-fd-shape-"));
  dirs.push(root);
  const e = await writeShapeEstate(root, k, snapshot);
  const built = await buildAndWrite(root, { command: "atticus catalog build" });
  if (built.guard.refused) {
    const said = JSON.stringify(built.guard);
    if (!/--allow-removals/.test(said))
      fail("every-refusal-has-a-next-step", `a refused build names no count to confirm: ${said}`);
  }
  const records: CatalogRecord[] = (await readCatalog(join(root, "catalog", "generated"))).records;
  // What cites each line: an arrow (an Interface), or a loose end (an Unresolved record).
  const cites = new Map<string, Set<string>>();
  for (const r of records)
    for (const x of r.evidence as { repo?: string; path?: string; line?: number }[])
      if (x.repo && x.path) {
        const at = `${x.repo}\u0000${x.path}\u0000${x.line}`;
        if (!cites.has(at)) cites.set(at, new Set());
        cites.get(at)!.add(r.kind);
      }
  const questions = await readdir(join(root, "questions")).catch(() => [] as string[]);
  const asked = (
    await Promise.all(questions.map((q) => readFile(join(root, "questions", q), "utf8")))
  ).join("\n");

  for (const repo of e.repos) {
    const other = e.repos.find((r) => r !== repo)!;
    const { view } = await candidatesOf(root, repo, { repo: other });
    for (const r of [view.noCalls, view.noApis])
      if (r && !NEXT.test(r.command))
        fail("every-refusal-has-a-next-step", `${repo}'s Connect panel says ${JSON.stringify(r)}`);
    const mine = e.calls.filter((c) => c.repo === repo);
    for (const c of mine) {
      const listed = view.calls.filter((x) => x.fact === c.fact);
      if (listed.length !== 1)
        fail(
          "every-call-accounted",
          `${repo}'s call ${c.fact} (${c.via}) is listed ${listed.length} times by Connect`,
        );
      const l = listed[0]!;
      const kinds = cites.get(`${repo}\u0000${c.file}\u0000${c.line}`) ?? new Set<string>();
      const drawn = kinds.has("Interface");
      const looseEnd = kinds.has("Unresolved");
      if ((l.status === "joined" || l.status === "here") && !drawn)
        fail(
          "every-call-accounted",
          `${repo}'s call ${c.fact} (${c.via}) is "${l.status}" in Connect, and no record cites ${c.file}:${c.line}`,
        );
      const k = `${k0(c)} ${l.status}${drawn ? " drawn" : ""}${looseEnd ? " loose-end" : ""}`;
      tally.set(k, (tally.get(k) ?? 0) + 1);
      const loose =
        looseEnd || (l.status !== "joined" && l.status !== "here" && l.status !== "paired");
      const questioned = asked.includes(`${c.file}:${c.line}`) || l.status === "asked";
      if (!drawn && !(loose || questioned))
        fail(
          "every-call-accounted",
          `${repo}'s call ${c.fact} (${c.via}) is neither drawn, loose nor asked (Connect: ${l.status})`,
        );
    }
  }
  // A command that refuses here names the command to go on with: verify needs the clone.
  for (const repo of e.repos) {
    const r = await run(["verify", repo, "--root", root]);
    if (r.code !== 0 && !NEXT.test(r.said))
      fail("every-refusal-has-a-next-step", `atticus verify ${repo} exits ${r.code}: ${r.said}`);
  }
}

describe("the estate's shape: every call accounted for, every refusal with a next step", () => {
  it("lists the shape invariants", () => {
    expect([...SHAPE_INVARIANTS]).toEqual([
      "every-call-accounted",
      "every-refusal-has-a-next-step",
    ]);
  });

  it(
    `holds over ${RUNS} shaped estates (seed ${SEED})`,
    async () => {
      process.stdout.write(`shape properties: seed ${SEED}, ${RUNS} runs\n`);
      const out = await fc.check(fc.asyncProperty(shapeArb, check), {
        seed: SEED,
        numRuns: RUNS,
        endOnFailure: !!process.env.CI,
      });
      if (out.failed)
        throw new Error(
          `${String(out.errorInstance)}\nShrunk sketch: ${JSON.stringify(out.counterexample?.[0])}\nReplay: ATTICUS_SHAPE_SEED=${out.seed} ATTICUS_SHAPE_RUNS=${RUNS}${out.counterexamplePath ? ` (path ${out.counterexamplePath})` : ""}`,
        );
    },
    Math.max(300_000, RUNS * 60_000),
  );

  it("the shapes the generator makes each appear in a fixed seed's runs", () => {
    const seen = new Set<string>();
    for (const k of fc.sample(shapeArb, { seed: SEED, numRuns: RUNS })) {
      if (k.dotted) seen.add("dotted");
      if (k.noSystem) seen.add("noSystem");
      if (k.nested) seen.add("nested");
      seen.add(`proxy:${k.proxy}`);
      for (const c of k.calls) seen.add(`via:${c.via}`);
    }
    // Six runs of the default seed reach every kind of call and a proxy of each token form.
    if (SEED === 30 && RUNS >= 6)
      for (const want of [
        "dotted",
        "noSystem",
        "nested",
        "proxy:at",
        "proxy:dollar",
        "via:host",
        "via:proxy",
        "via:token",
        "via:outside",
      ])
        expect(seen, want).toContain(want);
  });
});
