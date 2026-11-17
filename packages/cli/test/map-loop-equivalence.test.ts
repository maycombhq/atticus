import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashCacheHooks, RACY_MS } from "@maycombhq/core";
import { buildAndWrite, buildCacheHooks } from "@maycombhq/scanner";
import { bigRepoFacts, writeBigRepo } from "./big-estate.js";
import { makeFieldEstate } from "./field-estate.js";
import { applyCounted } from "./map-loop-apply.js";

/**
 * Beta.28.5: what makes the applies of a map's estate join quick changes no byte. A small
 * estate of the field report's shape (field-estate.ts) is applied twice over, a changed repo
 * and three others as the join applies them: once with the hashes of the catalog's files kept
 * and the last build kept (as shipped), once with neither (every record file opened and hashed
 * by every apply, every build run pass by pass). Every file a person or a commit sees is the
 * same bytes, and the kept way did less: it ran the passes once and opened a part of the record
 * files. The CPU budgets on an estate of the owner's size are in map-loop-speed.test.ts
 * (`test:speed`).
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

describe("the files an estate is left with are the same bytes with the kept hashes and build as without (beta.28.5)", () => {
  it("applies a changed repo and three others, each way, to the same catalog, maps, specs and questions", async () => {
    const made: string[] = [];
    const run = async (kept: boolean) => {
      const d = await mkdtemp(join(tmpdir(), `atticus-map-loop-eq-${kept ? "kept" : "plain"}-`));
      made.push(d);
      const e = await makeFieldEstate(d, {
        services: 6,
        gateways: 3,
        entries: 24,
        calls: 16,
        fieldNames: 300,
        legacy: 2,
        questions: 20,
        links: 8,
        suppressed: 6,
        checkouts: 2,
      });
      buildCacheHooks.off = !kept;
      hashCacheHooks.off = !kept;
      try {
        const cold = await buildAndWrite(e.root, { command: "atticus catalog build" });
        expect(cold.guard.refused).toBeUndefined();
        // The kept way, as a person's next command finds the catalog: its files older than the
        // timestamp grain the kept hashes allow for (a file younger is read again, kept or not).
        if (kept) await new Promise((r) => setTimeout(r, RACY_MS + 200));
        const outcomes: unknown[] = [];
        const opened: number[] = [];
        const changed = await writeBigRepo(e.root, 1, e.options, 2, true, false);
        let passes = 0;
        let files = 0;
        for (const [r, facts] of [
          [1, changed],
          [0, bigRepoFacts(0, e.options, 0).facts],
          [1, changed],
          [2, bigRepoFacts(2, e.options, 0).facts],
          [3, bigRepoFacts(3, e.options, 0).facts],
        ] as const) {
          const a = await applyCounted(e, r, [...facts]);
          if (a.built) passes++;
          opened.push(a.opened);
          files = (a.w?.written.written ?? 0) + (a.w?.written.unchanged ?? 0);
          outcomes.push([a.w?.written, a.w?.questions, a.w?.links, a.w?.map]);
        }
        return { files: await tree(e.root), outcomes, passes, opened, records: files };
      } finally {
        buildCacheHooks.off = false;
        delete hashCacheHooks.off;
      }
    };
    try {
      const plain = await run(false);
      const kept = await run(true);
      // The comparison is of something: the plain way ran the passes for every apply and opened
      // every record file each time; the kept way ran them for the apply whose facts changed,
      // opened every file once (nothing was kept yet) and then fewer than there are.
      expect(plain.passes).toBe(5);
      expect(kept.passes).toBe(1);
      expect(kept.records).toBeGreaterThan(500);
      for (const n of plain.opened) expect(n).toBeGreaterThanOrEqual(kept.records - 50);
      expect(kept.opened[0]).toBeGreaterThanOrEqual(kept.records - 50);
      for (const n of kept.opened.slice(1)) expect(n).toBeLessThan(kept.records / 2);
      expect(kept.outcomes).toEqual(plain.outcomes);
      expect([...kept.files.keys()].sort()).toEqual([...plain.files.keys()].sort());
      expect(kept.files.size).toBeGreaterThan(500);
      for (const [p, text] of plain.files) expect(kept.files.get(p) === text, p).toBe(true);
    } finally {
      await Promise.all(made.map((d) => rm(d, { recursive: true, force: true })));
    }
  }, 300_000);
});
