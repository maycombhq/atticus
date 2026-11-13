import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { catalogDirOf } from "@maycombhq/core";
import { buildAndWrite, buildCacheHooks, forgetSerializedTexts } from "@maycombhq/scanner";
import { writeFactsIntoCatalog } from "../src/map-render-commands.js";
import { bigRepoId, makeBigEstate, writeBigRepo } from "./big-estate.js";

/**
 * beta.28.1, field report 6: a write of one changed repo builds from the build cache (the last
 * build's record texts, kept on disk) and the texts this process keeps, and the build's passes
 * were made faster; none of it may change a byte. Over several generated estates and random
 * changes of one repo each, the catalog `verify <repo> --write` leaves (every record file and
 * build.json) is compared byte for byte with a build from scratch of a fresh copy of the same
 * slots and inputs, with the build cache off and no text kept in this process. The CS4 property
 * tests (test/properties) check the same equivalence over every command at a small size.
 */
const made: string[] = [];
afterAll(async () => {
  buildCacheHooks.off = false;
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true })));
});

/** Every file under a folder, by its path relative to it, with its bytes. */
async function filesOf(dir: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => []))
      if (e.isDirectory()) await walk(join(d, e.name));
      else
        out.set(
          relative(dir, join(d, e.name)).split(sep).join("/"),
          await readFile(join(d, e.name)),
        );
  };
  await walk(dir);
  return out;
}

/** The built catalog of a metarepo: its record files and build.json (not init's README). */
async function builtOf(root: string): Promise<Map<string, Buffer>> {
  const files = new Map(
    [...(await filesOf(join(catalogDirOf(root), "generated")))].filter(([p]) =>
      p.endsWith(".yaml"),
    ),
  );
  files.set("build.json", await readFile(join(catalogDirOf(root), "sources", "build.json")));
  return files;
}

/** The same metarepo built from scratch: its slots and inputs only, no catalog, no cache. */
async function fromScratch(root: string): Promise<Map<string, Buffer>> {
  const dir = await mkdtemp(join(tmpdir(), "atticus-big-scratch-"));
  made.push(dir);
  const fresh = join(dir, "forge");
  const generated = join(catalogDirOf(root), "generated");
  const manifest = join(catalogDirOf(root), "sources", "build.json");
  await cp(root, fresh, {
    recursive: true,
    filter: (src) =>
      src !== generated &&
      src !== manifest &&
      !src.startsWith(join(root, ".index")) &&
      !src.startsWith(join(root, ".atticus")) &&
      !src.startsWith(join(root, "workspace")),
  });
  buildCacheHooks.off = true;
  forgetSerializedTexts();
  try {
    const b = await buildAndWrite(fresh, { command: "atticus catalog build" });
    expect(b.guard.refused).toBeUndefined();
  } finally {
    buildCacheHooks.off = false;
  }
  return builtOf(fresh);
}

const differences = (a: Map<string, Buffer>, b: Map<string, Buffer>) =>
  [...new Set([...a.keys(), ...b.keys()])]
    .filter((p) => !a.get(p) || !b.get(p) || !a.get(p)!.equals(b.get(p)!))
    .sort();

describe("one repo changed: the catalog is the bytes a build from scratch makes (beta.28.1)", () => {
  for (const seed of [1, 2, 3])
    it(`estate ${seed}: three changes of one repo each`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "atticus-big-eq-"));
      made.push(dir);
      const repos = 4 + seed;
      const { root, options } = await makeBigEstate(dir, {
        repos,
        entries: 40 + 10 * seed,
        calls: 30,
        tables: 6,
        settings: 30,
        seed,
        checkouts: repos,
      });
      const cold = await buildAndWrite(root, { command: "atticus catalog build" });
      expect(cold.guard.refused).toBeUndefined();
      // Random, but the same every run: which repo changes, and how.
      let s = seed * 7919;
      const rnd = (n: number) => (s = (s * 48271) % 2147483647) % n;
      for (let step = 0; step < 3; step++) {
        const r = rnd(repos);
        const repo = bigRepoId(r);
        const facts = await writeBigRepo(root, r, options, 1 + rnd(90), true, false);
        const errs: string[] = [];
        const w = await writeFactsIntoCatalog(
          root,
          repo,
          facts,
          { dir: join(root, "workspace", repo), command: `atticus verify ${repo} --write` },
          { out: () => undefined, err: (l) => errs.push(l) },
        );
        expect(w, errs.join("\n")).toBeDefined();
        const now = await builtOf(root);
        const scratch = await fromScratch(root);
        expect(differences(now, scratch), `step ${step}, ${repo}`).toEqual([]);
        expect(now.size).toBeGreaterThan(100);
      }
    }, 600_000);
});
