import { cp, mkdtemp, readFile, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { catalogDirOf, mapDirOf } from "@maycombhq/core";
import {
  buildAndWrite,
  buildCacheHooks,
  buildUndoDirOf,
  factsSnapshotWrites,
  forgetSerializedTexts,
  readCatalog,
  readCatalogWithFiles,
} from "@maycombhq/scanner";
import { mapRenderCommand, writeFactsIntoCatalog } from "../src/map-render-commands.js";
import { BIG_COMMIT, bigRepoId, makeBigEstate, writeBigRepo } from "./big-estate.js";

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
        // Estates 2 and 3 with gateway proxies on one host, fronting some of the services.
        gateways: seed === 1 ? 0 : seed,
        routes: 20,
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
        // The map the write rendered from its own read is the map rendered from the files.
        const map = await filesOf(join(mapDirOf(root), repo));
        expect(map.size).toBeGreaterThan(0);
        const quiet = { out: () => undefined, err: () => undefined };
        expect(await mapRenderCommand(root, repo, {}, quiet)).toBe(0);
        expect(differences(map, await filesOf(join(mapDirOf(root), repo))), "map").toEqual([]);
      }
    }, 600_000);
});

/**
 * beta.28.1: a write reads the catalog once (`readCatalogWithFiles`), and `buildAndWrite` uses
 * that read for the guards and for the catalog it says the write left, where every file still
 * has the size and time the read found; where one doesn't, it reads the files again.
 */
describe("one read of the catalog a write (beta.28.1)", () => {
  it("guards the same, and says the catalog a read of the files gives", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-big-read-"));
    made.push(dir);
    const { root, options } = await makeBigEstate(dir, {
      repos: 4,
      entries: 40,
      calls: 30,
      tables: 6,
      settings: 30,
      checkouts: 4,
    });
    expect((await buildAndWrite(root, { command: "atticus catalog build" })).guard.refused).toBe(
      undefined,
    );
    const generated = join(catalogDirOf(root), "generated");
    const slotsFor = async (edit: number) => {
      const repo = bigRepoId(1);
      const facts = await writeBigRepo(root, 1, options, edit, true, false);
      return factsSnapshotWrites(root, repo, facts, { commit: BIG_COMMIT, contracts: null });
    };
    const command = "atticus verify forge-svc-01 --write";
    for (const edit of [3, 4]) {
      const slots = await slotsFor(edit);
      const read = await readCatalogWithFiles(generated, { cacheRoot: root });
      const withRead = await buildAndWrite(root, { command, slots, read, check: true });
      const without = await buildAndWrite(root, { command, slots, check: true });
      expect(withRead.guard).toEqual(without.guard);
      // A change of one repo removes some of its records: the guard read the last build's.
      expect(withRead.guard.removals.length).toBeGreaterThan(0);
      const manifest = join(catalogDirOf(root), "sources", "build.json");
      const before = await readFile(manifest);
      const w = await buildAndWrite(root, { command, slots, read });
      expect(w.guard.refused).toBeUndefined();
      expect(w.catalog).toBeDefined();
      // build.json is copied from the undo copy's next-build.json, and the undo copy keeps the
      // build.json before, copied by the system: both byte for byte.
      const copy = join(buildUndoDirOf(root), String(w.write!.undo));
      const after = await readFile(manifest);
      expect(after.equals(before)).toBe(false);
      expect((await readFile(join(copy, "next-build.json"))).equals(after)).toBe(true);
      expect(
        (await readFile(join(copy, "files", "catalog", "sources", "build.json"))).equals(before),
      ).toBe(true);
      expect(w.catalog).toEqual((await readCatalog(generated, { fresh: true })).records);
    }
    // A file touched after the read: nothing of the read is used, and the write says no catalog.
    const slots = await slotsFor(5);
    const read = await readCatalogWithFiles(generated, { cacheRoot: root });
    const [some] = [...read.files.keys()];
    const later = new Date(Date.now() + 5_000);
    await utimes(join(generated, ...some!.split("/")), later, later);
    const w = await buildAndWrite(root, { command, slots, read });
    expect(w.guard.refused).toBeUndefined();
    expect(w.catalog).toBeUndefined();
  }, 600_000);
});
