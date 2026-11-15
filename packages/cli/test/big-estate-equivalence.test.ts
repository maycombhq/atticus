import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  catalogDirOf,
  deserializeRecord,
  filePoolHooks,
  mapDirOf,
  parseRecord,
  recordPath,
  serializeRecord,
} from "@maycombhq/core";
import {
  BuildCrash,
  buildAndWrite,
  buildCacheHooks,
  buildWriteHooks,
  buildUndoDirOf,
  factsSnapshotWrites,
  forgetSerializedTexts,
  readCatalog,
  readCatalogWithFiles,
  refusalCommands,
  undoDirOf,
} from "@maycombhq/scanner";
import { refusalHint } from "../src/catalog-build-commands.js";
import { mapRenderCommand, writeFactsIntoCatalog } from "../src/map-render-commands.js";
import { repoRename } from "../src/repo-rename.js";
import { BIG_COMMIT, bigRepoId, makeBigEstate, writeBigRepo } from "./big-estate.js";
import { asBeta281, v1Of } from "./build-json-v1.js";

/** The built CLI (`pnpm build`), as a person runs it. */
const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

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
  delete filePoolHooks.workers;
  delete filePoolHooks.minFiles;
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
  // beta.28.2: the catalog's files hashed and their times read in 2 worker threads (estate 1),
  // in this thread (estate 2), and as a run decides by the folder's size (estate 3).
  const ways = { 1: { workers: 2, minFiles: 0 }, 2: { workers: 0, minFiles: 0 }, 3: {} } as const;
  for (const seed of [1, 2, 3] as const)
    it(`estate ${seed}: three changes of one repo each`, async () => {
      delete filePoolHooks.workers;
      delete filePoolHooks.minFiles;
      Object.assign(filePoolHooks, ways[seed]);
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
        // Estate 3 in two clusters: several features, so a change moves entry points between them.
        clusters: seed === 3 ? 2 : 1,
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
 * beta.28.2 (ADR 0195 point 9, the passes of a write): over more generated estates (in clusters,
 * with gateway proxies), random changes of one repo of every kind, each written as its command
 * writes it: its code changed (`verify <repo> --write`), a repo added to the manifests, taken out
 * of them, archived, renamed (`atticus repo rename`), and a person's curated alias of one feature
 * to another and suppress of an endpoint (then `catalog build`). After each, the catalog on disk
 * (every record file and build.json; the map after a verify) is the bytes a build from scratch of
 * the same slots and inputs makes, with the build cache off and no text kept in this process.
 */
describe("one repo's change of any kind: the bytes a build from scratch makes (beta.28.2)", () => {
  type Kind = "code" | "add" | "remove" | "archive" | "rename" | "alias" | "suppress";
  const plans: [number, Kind[]][] = [
    [4, ["code", "suppress", "archive", "add", "code"]],
    [5, ["alias", "rename", "code", "remove", "suppress"]],
    [6, ["add", "code", "rename", "alias", "archive"]],
  ];
  const quiet = { out: () => undefined, err: () => undefined };
  const manifestOf = (root: string) =>
    join(root, "org-pack", "profiles", "github", "repos.manifest.yaml");
  type Entry = Record<string, unknown> & { id: string };
  const editManifest = async (root: string, edit: (repos: Entry[]) => Entry[]) => {
    const m = parse(await readFile(manifestOf(root), "utf8")) as { repos: Entry[] };
    m.repos = edit(m.repos);
    await writeFile(manifestOf(root), stringify(m));
  };
  /** A build as `catalog build` runs it, its removals confirmed when it lists them. */
  const buildConfirmed = async (root: string) => {
    const command = "atticus catalog build";
    let b = await buildAndWrite(root, { command });
    const n = b.guard.refused?.allowRemovals;
    if (n !== undefined) b = await buildAndWrite(root, { command, allowRemovals: n });
    expect(b.guard.refused?.message).toBeUndefined();
  };
  const generatedOf = async (root: string) =>
    [...(await filesOf(join(catalogDirOf(root), "generated")))]
      .filter(([p]) => p.endsWith(".yaml"))
      .flatMap(([p, b]) => {
        const r = deserializeRecord(b.toString("utf8"));
        return r.ok ? [[p, r.record] as const] : [];
      })
      .sort(([a], [b]) => (a < b ? -1 : 1));
  const decide = async (root: string, d: Record<string, unknown>) => {
    const p = parseRecord({
      kind: "CuratedDecision",
      schemaVersion: 2,
      status: "current",
      confidence: "asserted",
      reason: "A person's decision in the equivalence test.",
      by: "forge.dev",
      at: "2026-11-15T09:00:00Z",
      evidence: [{ source: "manual", by: "forge.dev" }],
      ...d,
    });
    if (!p.ok) throw new Error(`a bad decision: ${JSON.stringify(p.issues)}`);
    const file = join(catalogDirOf(root), "curated", ...recordPath(p.record).split("/"));
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, serializeRecord(p.record));
  };

  for (const [seed, kinds] of plans)
    it(`estate ${seed}: ${kinds.join(", ")}`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "atticus-big-kinds-"));
      made.push(dir);
      const repos = 4 + (seed % 3);
      const { root, options } = await makeBigEstate(dir, {
        repos,
        entries: 30 + 5 * seed,
        calls: 25,
        tables: 5,
        settings: 20,
        seed,
        checkouts: repos,
        gateways: seed === 6 ? 2 : 0,
        routes: 10,
        // Two clusters: two features at least, so a person can alias one to the other.
        clusters: seed === 4 ? 1 : 2,
      });
      await buildConfirmed(root);
      let s = seed * 104729;
      const rnd = (n: number) => (s = (s * 48271) % 2147483647) % n;
      /** The repos the manifests list (not archived), by their place in the generator. */
      const live = new Map(Array.from({ length: repos }, (_, r) => [bigRepoId(r), r]));
      let next = repos;
      let before = await builtOf(root);
      for (const [step, kind] of kinds.entries()) {
        const ids = [...live.keys()].sort();
        const pick = ids[rnd(ids.length)]!;
        const at = `step ${step} (${kind})`;
        if (kind === "code") {
          const r = live.get(pick)!;
          const facts = await writeBigRepo(root, r, options, 1 + rnd(90), true, false);
          // A renamed repo's facts carry its id now.
          const mine = facts.map((f) => ({ ...f, repo: pick }));
          const errs: string[] = [];
          const w = await writeFactsIntoCatalog(
            root,
            pick,
            mine,
            {
              dir: join(root, "workspace", bigRepoId(r)),
              command: `atticus verify ${pick} --write`,
            },
            { out: () => undefined, err: (l) => errs.push(l) },
          );
          expect(w, `${at}: ${errs.join("\n")}`).toBeDefined();
          const map = await filesOf(join(mapDirOf(root), pick));
          expect(map.size, at).toBeGreaterThan(0);
          expect(await mapRenderCommand(root, pick, {}, quiet)).toBe(0);
          expect(differences(map, await filesOf(join(mapDirOf(root), pick))), at).toEqual([]);
        } else if (kind === "add") {
          const r = next++;
          const id = bigRepoId(r);
          await editManifest(root, (rs) => [
            ...rs,
            {
              id,
              url: `https://git.example.test/forge/${id}.git`,
              type: "spring-boot",
              owner: "team-forge",
              system: id,
              hosts: [`${id}.forge.example`],
            },
          ]);
          await writeBigRepo(root, r, options, 0, false, true);
          live.set(id, r);
          await buildConfirmed(root);
        } else if (kind === "remove" || kind === "archive") {
          await editManifest(root, (rs) =>
            kind === "remove"
              ? rs.filter((x) => x.id !== pick)
              : rs.map((x) => (x.id === pick ? { ...x, archived: true } : x)),
          );
          live.delete(pick);
          await buildConfirmed(root);
        } else if (kind === "rename") {
          const to = `${pick}-renamed`;
          const said: string[] = [];
          const io = { out: (l: string) => said.push(l), err: (l: string) => said.push(l) };
          let code = await repoRename(root, pick, to, io);
          const n = /--allow-removals (\d+)/.exec(said.join("\n"))?.[1];
          if (code !== 0 && n) code = await repoRename(root, pick, to, io, { allowRemovals: +n });
          expect(code, `${at}: ${said.join("\n")}`).toBe(0);
          live.set(to, live.get(pick)!);
          live.delete(pick);
        } else if (kind === "alias") {
          const feats = (await generatedOf(root)).filter(
            ([, r]) => r.kind === "Capability" && r.id.startsWith("feature."),
          );
          expect(feats.length, `${at}: features to alias`).toBeGreaterThan(1);
          const [, a] = feats[rnd(feats.length)]!;
          const [, b] = feats.find(([, x]) => x.id !== a.id)!;
          await decide(root, {
            id: `cd-alias-${a.id}`,
            target: a.id,
            action: "alias",
            value: [b.id],
          });
          await buildConfirmed(root);
        } else {
          const eps = (await generatedOf(root)).filter(
            ([, r]) => r.kind === "Endpoint" && r.endpointType === "rest",
          );
          const [, e] = eps[rnd(eps.length)]!;
          await decide(root, {
            id: `cd-suppress-${e.id}`,
            target: e.id,
            action: "suppress",
            value: null,
          });
          await buildConfirmed(root);
        }
        const now = await builtOf(root);
        expect(now.size, at).toBeGreaterThan(50);
        // Each change changed the catalog (so the comparison has something to find).
        expect(differences(before, now).length, `${at}: files changed`).toBeGreaterThan(0);
        expect(differences(now, await fromScratch(root)), at).toEqual([]);
        before = now;
      }
    }, 900_000);
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
      // beta.28.2: the write kept the parses of what it wrote, so the next read parses nothing
      // and reads what a read of every file gives. Its cache file keeps every entry's size, time
      // and parse; a read past the timestamp's grain (RACY_MS) may only date an entry checked by
      // its hash (`at`, dropping `sha`), so those two are left out of the comparison.
      const cache = join(root, ".atticus", "cache");
      const memo = join(
        cache,
        (await readdir(cache)).find((f) => f.startsWith("catalog-"))!,
      );
      const kept = await readFile(memo);
      const next = await readCatalogWithFiles(generated, { cacheRoot: root });
      const parses = (b: Buffer) =>
        Object.fromEntries(
          Object.entries(
            (JSON.parse(String(b)) as { entries: Record<string, Record<string, unknown>> }).entries,
          ).map(([k, { at: _at, sha: _sha, ...e }]) => [k, e]),
        );
      expect(parses(await readFile(memo))).toEqual(parses(kept));
      expect(next.records).toEqual((await readCatalog(generated, { fresh: true })).records);
      expect(next.problems).toEqual([]);
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

/**
 * ADR 0197: build.json of version 1 (a metarepo beta.28.1 built, `asBeta281`) and of version 2
 * mean the same to the guards; a build cut short whose undo copy holds version 1 is caught up;
 * a later version is refused, a newer Atticus wrote it.
 */
describe("build.json of version 1 and of version 2 (ADR 0197)", () => {
  const estate = async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-big-v1-"));
    made.push(dir);
    const made_ = await makeBigEstate(dir, {
      repos: 4,
      entries: 40,
      calls: 30,
      tables: 6,
      settings: 30,
      gateways: 1,
      routes: 10,
      checkouts: 4,
    });
    const b = await buildAndWrite(made_.root, { command: "atticus catalog build" });
    expect(b.guard.refused).toBeUndefined();
    return made_;
  };
  const slotsOf = async (
    root: string,
    options: Awaited<ReturnType<typeof makeBigEstate>>["options"],
    edit: number,
  ) => {
    const facts = await writeBigRepo(root, 1, options, edit, true, false);
    return factsSnapshotWrites(root, bigRepoId(1), facts, { commit: BIG_COMMIT, contracts: null });
  };
  const command = "atticus verify forge-svc-01 --write";

  it("the guards give the same over either version: removals, a hand edit, the counts", async () => {
    const { root, options } = await estate();
    // A hand edit, and a change of one repo that removes some of its records.
    const generated = join(catalogDirOf(root), "generated");
    const [one] = (await readCatalogWithFiles(generated)).files.keys();
    const edited = join(generated, ...one!.split("/"));
    await writeFile(edited, (await readFile(edited, "utf8")) + "# by hand\n");
    const slots = await slotsOf(root, options, 7);
    const v2 = await buildAndWrite(root, { command, slots, check: true });
    expect(v2.guard.edits.length).toBe(1);
    expect(v2.guard.removals.length).toBeGreaterThan(0);
    await asBeta281(root);
    const manifest = await readFile(join(catalogDirOf(root), "sources", "build.json"), "utf8");
    expect((JSON.parse(manifest) as { version: number }).version).toBe(1);
    const v1 = await buildAndWrite(root, { command, slots, check: true });
    expect(v1.guard).toEqual(v2.guard);
    // Confirmed as listed, the write over version 1 goes through and writes version 2.
    const w = await buildAndWrite(root, {
      command,
      slots,
      discardEdits: 1,
      allowRemovals: v2.guard.removals.length,
    });
    expect(w.guard.refused).toBeUndefined();
    const after = await readFile(join(catalogDirOf(root), "sources", "build.json"), "utf8");
    expect((JSON.parse(after) as { version: number }).version).toBe(2);
    expect(v1Of(after)).not.toBe(after);
  }, 600_000);

  it("a build cut short over version 1 is caught up, its undo copy's next-build.json read", async () => {
    const { root, options } = await estate();
    const slots = await slotsOf(root, options, 3);
    buildWriteHooks.crash = "mid-records";
    await expect(buildAndWrite(root, { command, slots })).rejects.toThrow(BuildCrash);
    // As if beta.28.1 had been cut short there: its undo copy's next-build.json of version 1.
    await asBeta281(root);
    const next = await buildAndWrite(root, { command, slots });
    expect(next.guard.refused).toBeUndefined();
    expect(next.guard.edits).toEqual([]);
    expect(await builtOf(root)).toEqual(await fromScratch(root));
  }, 600_000);

  it("refuses a build.json of a later version: upgrade Atticus, and nothing is written", async () => {
    const { root } = await estate();
    const path = join(catalogDirOf(root), "sources", "build.json");
    const m = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...m, version: 3 }, null, 2) + "\n");
    const before = await builtOf(root);
    const words =
      "This metarepo's catalog was built by a newer Atticus (build.json version 3; this Atticus reads up to 2): upgrade Atticus (npm i -g @maycombhq/atticus@beta), don't run `atticus upgrade`.";
    // The guard's newer-atticus refusal (C4, Local API 3.15.0), checked before build.json is
    // parsed: not NewerBuildManifestError, which is only a last resort.
    const b = await buildAndWrite(root, { command: "atticus catalog build" });
    expect(b.guard.refused?.reasons).toEqual(["newer-atticus"]);
    expect(b.guard.refused?.message).toContain(words);
    // The command says so, never "run atticus upgrade", and exits 1.
    const r = spawnSync(process.execPath, [BIN, "catalog", "build", "--root", root], {
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain(words);
    expect(r.stdout + r.stderr).not.toContain("upgrade Atticus to build here");
    expect(await builtOf(root)).toEqual(before);
  }, 600_000);

  it("a version 1 edited or merged by hand (a source at two hashes) says so, and building again writes version 2", async () => {
    const { root } = await estate();
    const path = join(catalogDirOf(root), "sources", "build.json");
    const v1 = JSON.parse(v1Of(await readFile(path, "utf8"))) as {
      files: { sources: { path: string; sha256: string }[] }[];
    };
    // A merge that joined two builds' lines: the same source at two hashes.
    const f = v1.files.find((x) => x.sources.length > 0)!;
    f.sources[0]!.sha256 = "f".repeat(64);
    await writeFile(path, JSON.stringify(v1, null, 2) + "\n");
    // In another clone of the metarepo (undo copies aren't committed): with an undo copy whose
    // manifest still names every file, the build catches up from it instead.
    await rm(await undoDirOf(root), { recursive: true, force: true });
    const before = await builtOf(root);
    const r = await buildAndWrite(root, { command: "atticus catalog build" });
    expect(r.guard.refused?.reasons).toEqual(["hand-edits"]);
    const n = r.guard.refused?.discardEdits ?? 0;
    expect(n).toBeGreaterThan(100);
    expect(r.guard.refused?.message).toContain(
      "catalog/sources/build.json doesn't read (build.json was edited or merged by hand: build again)",
    );
    expect(r.guard.refused?.message).toContain(`atticus catalog build --discard-edits ${n}`);
    // Not the advice for a catalog from before the slots: atticus upgrade does nothing here.
    expect(r.guard.refused?.message).not.toContain("atticus upgrade");
    expect(await builtOf(root)).toEqual(before);
    // The refusal says it is build.json (C4 3.15.0 `unreadableManifest`): the only way on offered
    // is to build again over every record file, never to make them curated.
    expect(r.guard.refused?.unreadableManifest).toBe(true);
    expect(refusalCommands(r.guard.refused!, "atticus catalog build")).toEqual([
      `atticus catalog build --discard-edits ${n}`,
    ]);
    expect(refusalHint(r.guard.refused!, "atticus catalog build")).toBe(
      `catalog/sources/build.json doesn't read (edited or merged by hand): build again, replacing every record file with this build: atticus catalog build --discard-edits ${n}.`,
    );
    const curatedBefore = await filesOf(join(catalogDirOf(root), "curated"));
    const cli = (...a: string[]) =>
      spawnSync(process.execPath, [BIN, ...a, "--root", root], { encoding: "utf8" });
    const j = cli("catalog", "build", "--json");
    expect(j.status).toBe(1);
    const jr = (JSON.parse(j.stdout) as { refused: Record<string, unknown> }).refused;
    expect(jr).toMatchObject({
      reasons: ["hand-edits"],
      unreadableManifest: true,
      discardEdits: n,
    });
    expect(j.stderr).not.toContain("--curate");
    // catalog edits --curate (and the app's Make them curated, which runs it) refuses: no file
    // is one to curate, and it says to build again.
    const c = cli("catalog", "edits", "--curate", "--json");
    expect(c.status).toBe(1);
    expect(JSON.parse(c.stdout)).toMatchObject({
      edits: [],
      decisions: [],
      refused: { reasons: ["hand-edits"], unreadableManifest: true, discardEdits: n },
    });
    expect(c.stderr).toContain(`atticus catalog build --discard-edits ${n}`);
    expect(await filesOf(join(catalogDirOf(root), "curated"))).toEqual(curatedBefore);
    expect(await builtOf(root)).toEqual(before);
    const again = await buildAndWrite(root, { command: "atticus catalog build", discardEdits: n });
    expect(again.guard.refused).toBeUndefined();
    const after = await readFile(path, "utf8");
    expect((JSON.parse(after) as { version: number }).version).toBe(2);
    expect(await builtOf(root)).toEqual(await fromScratch(root));
  }, 600_000);

  it("a branch's build.json of version 1 (catalog/branches/<b>/sources) reads as version 2", async () => {
    const { root, options } = await estate();
    const branch = join(catalogDirOf(root), "branches", "develop");
    const target = {
      generated: join(branch, "generated"),
      manifest: join(branch, "sources", "build.json"),
    };
    const first = await buildAndWrite(root, { command: "atticus catalog build", target });
    expect(first.guard.refused).toBeUndefined();
    const v2 = await readFile(target.manifest, "utf8");
    expect((JSON.parse(v2) as { version: number }).version).toBe(2);
    expect(JSON.parse(v2).files[0].path).toMatch(/^catalog\/branches\/develop\/generated\//);
    // The branch as beta.28.1 built it: its build.json of version 1, the same build.
    const v1 = v1Of(v2);
    await writeFile(target.manifest, v1);
    const slots = await slotsOf(root, options, 5);
    const c1 = await buildAndWrite(root, { command, slots, target, check: true });
    await writeFile(target.manifest, v2);
    const c2 = await buildAndWrite(root, { command, slots, target, check: true });
    expect(c1.guard).toEqual(c2.guard);
    expect(c1.guard.refused?.reasons ?? []).not.toContain("not-upgraded");
    // Written over version 1, it writes version 2, and the undo copy keeps version 1's bytes.
    await writeFile(target.manifest, v1);
    const w = await buildAndWrite(root, {
      command,
      slots,
      target,
      allowRemovals: c1.guard.refused?.allowRemovals,
    });
    expect(w.guard.refused).toBeUndefined();
    const after = await readFile(target.manifest, "utf8");
    expect((JSON.parse(after) as { version: number }).version).toBe(2);
    const undo = await undoDirOf(root);
    const latest = (await readdir(undo)).map(Number).sort((a, b) => b - a)[0]!;
    const kept = join(undo, String(latest), "files", ...relative(root, target.manifest).split(sep));
    expect(await readFile(kept, "utf8")).toBe(v1);
  }, 600_000);
});
