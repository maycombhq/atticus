import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  BUILD_MANIFEST_VERSION,
  buildAndWrite,
  buildManifestPath,
  factsSlotPaths,
  listUndo,
  newerAtticusWords,
  newerCatalogFiles,
  newerInUndoPlan,
  newerVersionsIn,
  parseReadersSlot,
  planUndo,
  readersSlotPath,
  refusalCommands,
  serializeReadersSlot,
  undoDirOf,
} from "../src/index.js";

/**
 * Beta.28.1.1 (ADR 0197, "beta.28.1 and older reading version 2"): beta.28.2 writes build.json
 * version 2. This Atticus refuses a catalog a newer one wrote, in its own words (upgrade Atticus,
 * never `atticus upgrade`), writes nothing and takes no undo copy; a version 1 build.json builds
 * as before. Invented Forge estate (CLAUDE.md rule 3).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const SLOTS = join(FORGE, "slots");
const T = 180_000;
const made: string[] = [];
afterAll(async () => {
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true })));
});

/** build.json version 2 as ADR 0197 draws it: one table of sources, sets by content. */
const V2 = `${JSON.stringify(
  {
    version: 2,
    buildVersion: "2.0.0-beta.28.2",
    sources: { "catalog/sources/readers/forge-ledger.json": "a".repeat(64) },
    sourceSets: { "0123456789abcdef": ["catalog/sources/readers/forge-ledger.json"] },
    files: [
      {
        path: "catalog/generated/system/forge.yaml",
        sha256: "b".repeat(64),
        sources: "0123456789abcdef",
      },
    ],
  },
  null,
  2,
)}\n`;
/** A newer build.json of a shape nobody knows yet, its version not even first. */
const UNKNOWN = `${JSON.stringify({ shards: ["x"], version: 3 }, null, 2)}\n`;

const MESSAGE = (n: number) =>
  `This metarepo's catalog was built by a newer Atticus (build.json version ${n}; this Atticus reads up to 1): upgrade Atticus (npm i -g @maycombhq/atticus@beta), don't run \`atticus upgrade\`.`;

/** The Forge golden slots, built once (build.json version 1 and an undo copy). */
async function built(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-newer-"));
  made.push(root);
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  await cp(join(SLOTS, "readers"), join(root, "catalog/sources/readers"), { recursive: true });
  const r = await buildAndWrite(root, { command: "atticus catalog build" });
  expect(r.guard.refused).toBeUndefined();
  return root;
}

/** Every file under the metarepo but this machine's build cache, with its bytes. */
async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(d: string, rel: string) {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const r = `${rel}${e.name}`;
      if (r === ".index/build-cache" || r === ".index/build-report.json") continue;
      if (e.isDirectory()) await walk(join(d, e.name), `${r}/`);
      else out[r] = await readFile(join(d, e.name), "utf8");
    }
  }
  await walk(dir, "");
  return out;
}

describe("a version a newer Atticus wrote is known by its first bytes, or its whole text", () => {
  it("says nothing of this Atticus's own versions", () => {
    const v1 = `{\n  "version": ${BUILD_MANIFEST_VERSION},\n  "buildVersion": "x",\n  "files": []\n}\n`;
    expect(newerVersionsIn(v1, { field: "version", reads: 1 })).toEqual([]);
    expect(newerVersionsIn('{\n  "slotVersion": 1,\n', { field: "slotVersion", reads: 1 })).toEqual(
      [],
    );
  });
  it("finds version 2 first, and version 3 of an unknown shape anywhere", () => {
    expect(newerVersionsIn(V2, { field: "version", reads: 1 })).toEqual([
      { field: "version", version: 2, reads: 1 },
    ]);
    expect(newerVersionsIn(UNKNOWN, { field: "version", reads: 1 })).toEqual([
      { field: "version", version: 3, reads: 1 },
    ]);
    // Not JSON at all, or no number: unreadable as before, not newer.
    expect(newerVersionsIn("{ not json", { field: "version", reads: 1 })).toEqual([]);
    expect(newerVersionsIn('{"version":"2"}', { field: "version", reads: 1 })).toEqual([]);
  });
  it("says what to run: upgrade Atticus, never atticus upgrade", () => {
    expect(
      newerAtticusWords([
        {
          path: "catalog/sources/build.json",
          name: "build.json",
          field: "version",
          version: 2,
          reads: 1,
        },
      ]),
    ).toBe(MESSAGE(2));
    expect(
      refusalCommands({ reasons: ["newer-atticus"], message: "" }, "atticus catalog build"),
    ).toEqual(["npm i -g @maycombhq/atticus@beta"]);
  });
});

describe("the build refuses a catalog a newer Atticus wrote, and writes nothing (ADR 0197)", () => {
  for (const [what, text, n] of [
    ["build.json version 2", V2, 2],
    ["a build.json of an unknown shape at version 3", UNKNOWN, 3],
  ] as const)
    it(
      `${what}: refused as newer-atticus, never not-upgraded; no undo copy, no file changed`,
      async () => {
        const root = await built();
        await writeFile(buildManifestPath(root), text);
        const undoDir = await undoDirOf(root);
        const copies = (await listUndo(undoDir)).length;
        const before = await tree(root);
        for (const o of [{}, { discardEdits: 1 }, { allowRemovals: 1 }, { check: true }]) {
          const r = await buildAndWrite(root, { command: "atticus catalog build", ...o });
          expect(r.guard.refused?.reasons).toEqual(["newer-atticus"]);
          expect(r.guard.refused!.message.split("\n")).toEqual([
            "Nothing written: catalog/generated and every slot are as they were.",
            MESSAGE(n),
          ]);
          expect(r.write).toBeUndefined();
        }
        expect(await tree(root)).toEqual(before);
        expect((await listUndo(undoDir)).length).toBe(copies);
      },
      T,
    );

  it(
    "with no catalog/generated at all, it still refuses (no first build over a newer build.json)",
    async () => {
      const root = await built();
      await rm(join(root, "catalog/generated"), { recursive: true });
      await writeFile(buildManifestPath(root), V2);
      const r = await buildAndWrite(root, { command: "atticus catalog build" });
      expect(r.guard.refused?.reasons).toEqual(["newer-atticus"]);
      await expect(stat(join(root, "catalog/generated"))).rejects.toThrow();
    },
    T,
  );

  it(
    "a slot a newer Atticus wrote (readers slotVersion, a facts meta's versions, the joins slot) refuses the same way",
    async () => {
      const root = await built();
      const path = readersSlotPath(root, "forge-ledger");
      const text = await readFile(path, "utf8");
      await writeFile(path, text.replace(/^\{\n {2}"slotVersion": 1,/, '{\n  "slotVersion": 2,'));
      const before = await tree(root);
      const r = await buildAndWrite(root, { command: "atticus catalog build" });
      expect(r.guard.refused?.reasons).toEqual(["newer-atticus"]);
      expect(r.guard.refused!.message).toContain(
        "(catalog/sources/readers/forge-ledger.json slotVersion 2; this Atticus reads up to 1)",
      );
      expect(await tree(root)).toEqual(before);
      await writeFile(path, text);
      // A facts meta at this slot version, of facts a newer Atticus's schema wrote.
      const meta = factsSlotPaths(root, "forge-ledger").meta;
      await mkdir(dirname(meta), { recursive: true });
      await writeFile(
        meta,
        `${JSON.stringify({ slotVersion: 1, kind: "facts", repo: "forge-ledger", commit: "0123abc", factsSchemaVersion: 99, factsHash: "c".repeat(64), contracts: null }, null, 2)}\n`,
      );
      expect((await newerCatalogFiles(root)).map((f) => [f.path, f.field, f.version])).toEqual([
        ["catalog/sources/facts/forge-ledger.meta.json", "factsSchemaVersion", 99],
      ]);
      await rm(meta);
      await mkdir(join(root, "catalog/sources/legacy"), { recursive: true });
      await writeFile(
        join(root, "catalog/sources/legacy/joins.json"),
        '{\n  "slotVersion": 2,\n  "kind": "legacy-joins"\n}\n',
      );
      expect((await newerCatalogFiles(root)).map((f) => f.path)).toEqual([
        "catalog/sources/legacy/joins.json",
      ]);
    },
    T,
  );

  it(
    "a newer Atticus's build cut short (its undo copy's next-build.json) refuses, not not-upgraded",
    async () => {
      const root = await built();
      const undoDir = await undoDirOf(root);
      const latest = (await listUndo(undoDir))[0]!;
      await writeFile(join(undoDir, String(latest.n), "next-build.json"), V2);
      await rm(buildManifestPath(root));
      const r = await buildAndWrite(root, { command: "atticus catalog build" });
      expect(r.guard.refused?.reasons).toEqual(["newer-atticus"]);
      expect(r.guard.refused!.message).toContain(`(the build.json of undo copy ${latest.n}`);
    },
    T,
  );

  it(
    "an undo that would put back a newer Atticus's build.json is known before it runs",
    async () => {
      const root = await built();
      const undoDir = await undoDirOf(root);
      // A second build, so its copy holds the first build's build.json; that one made newer.
      const path = readersSlotPath(root, "forge-ledger");
      const p = parseReadersSlot(await readFile(path, "utf8"), "forge-ledger");
      if (!p.ok) throw new Error("slot");
      const drop = p.slot.records.find((x) => x.kind !== "Component" && x.kind !== "System")!;
      await writeFile(
        path,
        serializeReadersSlot({ ...p.slot, records: p.slot.records.filter((x) => x !== drop) }),
      );
      const second = await buildAndWrite(root, { command: "atticus catalog build" });
      expect(second.guard.refused).toBeUndefined();
      const plan = await planUndo(undoDir);
      if ("problem" in plan) throw new Error(plan.problem);
      expect(await newerInUndoPlan(undoDir, plan)).toEqual([]);
      const c = plan.files.find((f) => f.path === "catalog/sources/build.json")!;
      expect(c.to).toBe("file");
      await writeFile(join(undoDir, String(c.from), "files", ...c.path.split("/")), V2);
      expect((await newerInUndoPlan(undoDir, plan)).map((f) => [f.path, f.version])).toEqual([
        ["catalog/sources/build.json", 2],
      ]);
    },
    T,
  );

  it(
    "a version 1 build.json builds exactly as before: nothing refused, nothing changed",
    async () => {
      const root = await built();
      const before = await tree(root);
      const r = await buildAndWrite(root, { command: "atticus catalog build" });
      expect(r.guard.refused).toBeUndefined();
      expect(r.write).toMatchObject({ written: 0, removed: 0 });
      expect(await tree(root)).toEqual(before);
      expect(await newerCatalogFiles(root, { undoDir: await undoDirOf(root) })).toEqual([]);
    },
    T,
  );
});
