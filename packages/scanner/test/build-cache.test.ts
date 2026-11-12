import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildAndWrite,
  buildCacheHooks,
  buildCacheStats,
  buildCatalog,
  forgetSerializedTexts,
  loadBuildInputs,
  parseReadersSlot,
  readersSlotPath,
  readersSlotRead,
  serializeBuildManifest,
  serializeReadersSlot,
} from "../src/index.js";

/**
 * The build cache of ADR 0195 point 9 (`.index/build-cache/`, local and git-ignored): the last
 * build kept whole, so a build whose every input is the same returns it without running the
 * passes; its records' texts, so a build with one slot changed writes YAML only for the records
 * that changed; and the readers slots already checked, so a slot read before isn't checked
 * again. The cache is never needed for a correct result: every build here is compared with the
 * same build made with the cache off.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const SLOTS = join(FORGE, "slots");
const T = 180_000;
const made: string[] = [];
afterAll(async () => {
  buildCacheHooks.off = false;
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true })));
});
beforeEach(() => {
  buildCacheHooks.off = false;
});

/** The Forge metarepo with every golden slot (readers, facts, legacy), its inputs and its wiki. */
async function forge(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-build-cache-"));
  made.push(root);
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  await writeFile(
    join(root, "org-pack/sources.yaml"),
    "schemaVersion: 1\nwikis:\n  - { id: forge-wiki, type: markdown-folder, location: ../wiki, owner: team-platform }\n",
  );
  await cp(join(FORGE, "inputs/wiki"), join(root, "wiki"), { recursive: true });
  await cp(join(FORGE, "inputs"), join(root, "inputs"), { recursive: true });
  for (const d of ["readers", "facts", "legacy"])
    await cp(join(SLOTS, d), join(root, "catalog/sources", d), { recursive: true });
  return root;
}

/**
 * Build until nothing changes: the first build of the Forge slots derives two legacy joins
 * again, so it writes joins.json, an input of the next build.
 */
async function settled(root: string) {
  let r = await buildAndWrite(root, { command: "atticus catalog build" });
  for (let n = 0; n < 3 && r.write && (r.write.written || r.write.slots.length); n++)
    r = await buildAndWrite(root, { command: "atticus catalog build" });
  expect(r.guard.refused).toBeUndefined();
  expect(r.write).toMatchObject({ written: 0, removed: 0, slots: [] });
  return r;
}

/** A build with the cache off: what every cached build must equal. */
async function uncached(root: string) {
  buildCacheHooks.off = true;
  try {
    return await buildCatalog(await loadBuildInputs(root));
  } finally {
    buildCacheHooks.off = false;
  }
}

async function tree(dir: string): Promise<Map<string, { text: string; mtime: number }>> {
  const out = new Map<string, { text: string; mtime: number }>();
  async function walk(d: string, rel: string) {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p, `${rel}${e.name}/`);
      else
        out.set(`${rel}${e.name}`, {
          text: await readFile(p, "utf8"),
          mtime: (await stat(p)).mtimeMs,
        });
    }
  }
  await walk(dir, "");
  return out;
}

const catalogOf = (root: string) => tree(join(root, "catalog"));

describe("the build cache (ADR 0195 point 9)", () => {
  it(
    "a build with every input the same returns the last build, equal in every field, without the passes",
    async () => {
      const root = await forge();
      const first = await settled(root);
      const before = await catalogOf(root);
      const s0 = buildCacheStats();
      const again = await buildCatalog(await loadBuildInputs(root));
      expect(buildCacheStats().memoHits).toBe(s0.memoHits + 1);
      // Equal in every field, Maps, Sets and left-out fields included.
      expect(again).toStrictEqual(first.build);
      expect(again).toStrictEqual(await uncached(root));
      // Building again writes no file of the catalog.
      const w = await buildAndWrite(root, { command: "atticus catalog build" });
      expect(w.write).toMatchObject({ written: 0, removed: 0, slots: [] });
      expect(await catalogOf(root)).toEqual(before);
    },
    T,
  );

  it(
    "any input changed (a slot, a wiki page, a curated decision, a proposal) misses it, and the build equals one without the cache",
    async () => {
      const root = await forge();
      await settled(root);
      const changes: [string, () => Promise<void>][] = [
        [
          "a readers slot",
          async () => {
            const path = readersSlotPath(root, "forge-portal-bff");
            const p = parseReadersSlot(await readFile(path, "utf8"), "forge-portal-bff");
            if (!p.ok) throw new Error("slot doesn't read");
            const set = p.slot.records.find((r) => r.kind === "Setting")!;
            await writeFile(
              path,
              serializeReadersSlot({
                ...p.slot,
                records: p.slot.records.map((r) =>
                  r === set ? ({ ...r, valueOrRef: "900ms" } as typeof r) : r,
                ),
              }),
            );
          },
        ],
        [
          "a wiki page",
          async () => {
            const page = join(root, "wiki/integration-patterns.md");
            await writeFile(
              page,
              `${await readFile(page, "utf8")}\n## Glossary\n\n**Sweep**: moving a balance at the end of a day.\n`,
            );
          },
        ],
        [
          "a curated decision",
          async () => {
            const dir = join(root, "catalog/curated/curateddecision");
            await rm(dir, { recursive: true, force: true });
            await mkdir(dir, { recursive: true });
            await writeFile(
              join(dir, "dec-suppress-bff-timeout.yaml"),
              [
                "schemaVersion: 2",
                "kind: CuratedDecision",
                "id: dec-suppress-bff-timeout",
                "status: current",
                "confidence: asserted",
                "evidence: []",
                "target: portal-bff.ledger-connect-timeout",
                "action: suppress",
                "value: null",
                "reason: test",
                "by: someone",
                "at: 2026-11-12T00:00:00Z",
                "",
              ].join("\n"),
            );
          },
        ],
        [
          "a feature proposal",
          async () => {
            const dir = join(root, "catalog/proposals/capability");
            await mkdir(dir, { recursive: true });
            await writeFile(join(dir, "README.md"), "a file the proposals folder holds\n");
          },
        ],
      ];
      for (const [what, change] of changes) {
        await change();
        const s0 = buildCacheStats();
        const b = await buildCatalog(await loadBuildInputs(root));
        expect(buildCacheStats().memoHits, what).toBe(s0.memoHits);
        expect(b, what).toStrictEqual(await uncached(root));
        const w = await buildAndWrite(root, { command: "atticus catalog build", allowRemovals: 0 });
        if (w.guard.refused?.allowRemovals !== undefined)
          await buildAndWrite(root, {
            command: "atticus catalog build",
            allowRemovals: w.guard.refused.allowRemovals,
          });
      }
    },
    T,
  );

  it(
    "with one slot changed, the records that didn't change keep their texts, and the files are a build's without the cache",
    async () => {
      const root = await forge();
      await settled(root);
      const path = readersSlotPath(root, "forge-portal-bff");
      const p = parseReadersSlot(await readFile(path, "utf8"), "forge-portal-bff");
      if (!p.ok) throw new Error("slot doesn't read");
      await writeFile(
        path,
        serializeReadersSlot({
          ...p.slot,
          records: p.slot.records.map((r) =>
            r.kind === "Setting" ? ({ ...r, valueOrRef: "777ms" } as typeof r) : r,
          ),
        }),
      );
      // A new process: no text kept in memory, only the cache's on disk.
      forgetSerializedTexts();
      const s0 = buildCacheStats();
      const r = await buildAndWrite(root, { command: "atticus catalog build" });
      const s1 = buildCacheStats();
      expect(s1.memoHits).toBe(s0.memoHits);
      expect(s1.textsReused - s0.textsReused).toBeGreaterThan(r.build.files.size / 2);
      const cold = await uncached(root);
      expect([...r.build.files]).toEqual([...cold.files]);
      expect(serializeBuildManifest(r.build.manifest)).toBe(serializeBuildManifest(cold.manifest));
    },
    T,
  );

  it(
    "is never needed: removed, or written over with what doesn't read, the build is the same",
    async () => {
      const root = await forge();
      const first = await settled(root);
      const cache = join(root, ".index", "build-cache");
      const files = [...(await tree(cache)).keys()];
      expect(files.length).toBeGreaterThan(1);
      for (const f of files) await writeFile(join(cache, f), "{ not what was written\n");
      expect(await buildCatalog(await loadBuildInputs(root))).toStrictEqual(first.build);
      await rm(cache, { recursive: true, force: true });
      expect(await buildCatalog(await loadBuildInputs(root))).toStrictEqual(first.build);
    },
    T,
  );

  it(
    "a readers slot checked once reads the same next time, unchecked",
    async () => {
      // Bytes no other test read (the same JSON, a space after it).
      const text = `${await readFile(join(SLOTS, "readers", "forge-ledger.json"), "utf8")} `;
      buildCacheHooks.off = true;
      const checked = readersSlotRead(text, "forge-ledger");
      buildCacheHooks.off = false;
      const s0 = buildCacheStats();
      const first = readersSlotRead(text, "forge-ledger");
      const second = readersSlotRead(text, "forge-ledger");
      expect(buildCacheStats().readersTrusted).toBe(s0.readersTrusted + 1);
      expect(first).toStrictEqual(checked);
      expect(second).toStrictEqual(checked);
      // Trust is for that text and that repo only: the same text under another name is checked.
      expect(readersSlotRead(text, "forge-portal-bff")).toStrictEqual(
        (() => {
          buildCacheHooks.off = true;
          const x = readersSlotRead(text, "forge-portal-bff");
          buildCacheHooks.off = false;
          return x;
        })(),
      );
    },
    T,
  );
});
