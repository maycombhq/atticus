import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildAndWrite } from "@maycombhq/scanner";
import { verifyCommand } from "../src/verify-commands.js";
import { BIG_COMMIT, bigRepoId, makeBigEstate, writeBigRepo } from "./big-estate.js";

/**
 * Beta.28.4, docs/design/apply-once.md: what a run of several repos' Apply leaves, measured, as
 * the ground for building once for them all (not built yet). Three repos of a generated Forge
 * estate change; one copy applies them in id order (as the app's run does), the other in the
 * reverse order. The catalog and its slots come out the same bytes either way, which is what one
 * build for the three would rest on. The files written per repo do not: a repo's verify report,
 * its map and the questions it raised say how the estate stood when that repo was applied, so a
 * repo applied before the repo it calls keeps a map of a link that is gone. This test holds the
 * first as a rule and pins where the second shows, so a change to either is seen.
 * Invented names only (CLAUDE.md rule 3); no network (rule 5).
 */
const made: string[] = [];
afterAll(async () => {
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true })));
});

/** Every file of a metarepo but its clones and this machine's state, by path, with its bytes. */
async function filesOf(dir: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      if (!e.isDirectory()) out.set(relative(dir, p).split(sep).join("/"), await readFile(p));
      else if (![".index", ".atticus", "workspace"].includes(e.name)) await walk(p);
    }
  };
  await walk(dir);
  return out;
}
const differences = (a: Map<string, Buffer>, b: Map<string, Buffer>) =>
  [...new Set([...a.keys(), ...b.keys()])]
    .filter((p) => !a.get(p) || !b.get(p) || !a.get(p)!.equals(b.get(p)!))
    .sort();

describe("several repos applied one after another (beta.28.4)", () => {
  it("leave the same catalog in either order, and per-repo files that depend on the order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-apply-order-"));
    made.push(dir);
    const { root, options } = await makeBigEstate(dir, {
      repos: 5,
      entries: 20,
      calls: 15,
      tables: 3,
      settings: 10,
      seed: 3,
      checkouts: 5,
    });
    const cold = await buildAndWrite(root, { command: "atticus catalog build" });
    expect(cold.guard.refused).toBeUndefined();
    // Three repos' code changed since their facts were applied: their Apply waits.
    for (const r of [0, 1, 2]) await writeBigRepo(root, r, options, 7 + r, true, false);
    const reversed = join(dir, "forge-reversed");
    await cp(root, reversed, { recursive: true });
    const now = () => new Date("2026-11-16T09:12:00Z");
    const apply = async (at: string, order: number[]) => {
      for (const r of order) {
        const said: string[] = [];
        const io = { out: (l: string) => said.push(l), err: (l: string) => said.push(l) };
        const code = await verifyCommand(
          at,
          bigRepoId(r),
          { write: true, commit: BIG_COMMIT, now },
          io,
        );
        expect(code, said.slice(-6).join("\n")).toBe(0);
      }
    };
    await apply(root, [0, 1, 2]);
    await apply(reversed, [2, 1, 0]);
    const differ = differences(await filesOf(root), await filesOf(reversed));
    // The catalog, its slots and build.json: the same bytes whatever the order.
    expect(differ.filter((p) => p.startsWith("catalog/"))).toEqual([]);
    // What each repo's own Apply wrote about the estate as it stood then: nothing else differs.
    const perRepo = /^(facts\/[^/]+\.verify\.yaml|map\/[^/]+\/.+|questions\/q-[^/]+\.yaml)$/;
    expect(differ.filter((p) => !perRepo.test(p))).toEqual([]);
    // And they do differ: forge-svc-02 calls an API forge-svc-01's change takes away. Applied
    // before forge-svc-01 (the reversed order), its map keeps the link; applied after, it has none.
    expect(differ).toContain("map/forge-svc-02/map.md");
    expect(differ).toContain("facts/forge-svc-02.verify.yaml");
  }, 600_000);
});
