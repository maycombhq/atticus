import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appMemory,
  appMemoryHeld,
  keepParses,
  readParsedFiles,
  recordCacheHooks,
  releaseAppMemory,
  startAppMemory,
  stopAppMemory,
  type KeptParses,
} from "../src/index.js";

/**
 * ADR 0205 step 4, the part the ADR first held back (the owner's decision of 2026-11-21: nothing
 * stays out of beta.30): in the app's server, a writer's read of the catalog keeps each file's
 * parse in memory between reads, so the next read neither reads the parse cache's file back nor
 * parses it. Each parse is still vouched for by its file, as on disk (its size and time, and its
 * hash while it is racy), so a change made outside the app is read again; what is kept is what
 * the cache on disk would give (its JSON), frozen, and handed out without a copy; it is let go by
 * the app's rule and kept only up to a size.
 */
const MB = 1024 * 1024;
const dirs: string[] = [];
// The machine's memory as roomy, whatever else runs on it: these tests are of what is kept.
beforeEach(() => {
  appMemory.system = () => ({ free: 64 * 2 ** 30, total: 64 * 2 ** 30 });
});
afterEach(async () => {
  while (appMemory.on) stopAppMemory();
  delete appMemory.system;
  delete recordCacheHooks.memoryMaxBytes;
  delete recordCacheHooks.now;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

interface Rec {
  id: string;
  n: number;
  gone?: undefined;
  tags: string[];
}

async function folder(n: number) {
  const root = await mkdtemp(join(tmpdir(), "atticus-cache-memory-"));
  dirs.push(root);
  await mkdir(join(root, "org-pack"), { recursive: true });
  const dir = join(root, "catalog");
  await mkdir(dir, { recursive: true });
  const files: string[] = [];
  for (let i = 0; i < n; i++) {
    files.push(`r${i}.yaml`);
    await writeFile(join(dir, `r${i}.yaml`), `id: r${i}\nn: ${i}\n`);
  }
  // Older than the racy grain, so a parse is vouched for by size and time alone.
  recordCacheHooks.now = () => Date.now() + 10_000;
  return { root, dir, files };
}

function reader(root: string, dir: string, files: string[], memory = true) {
  const parsed: string[] = [];
  let kept: KeptParses<Rec> | undefined;
  const read = () =>
    readParsedFiles<Rec>({
      dir,
      files,
      name: "catalog",
      version: "1",
      cacheRoot: root,
      withStats: true,
      memory,
      kept: (k) => (kept = k),
      parse: (text, rel) => {
        parsed.push(rel);
        const [, id, n] = /id: (\S+)\nn: (\d+)/.exec(text) ?? [];
        // A field set to undefined: the cache on disk (JSON) drops it.
        return { ok: true, value: { id: id!, n: Number(n), gone: undefined, tags: ["a"] } };
      },
    });
  return { parsed, read, kept: () => kept };
}

const memoFile = async (root: string) =>
  join(root, ".atticus", "cache", (await readdir(join(root, ".atticus", "cache")))[0]!);

describe("a writer's read of the catalog kept in the app's memory (ADR 0205 step 4)", () => {
  it("serves the next read from memory: no parse, the cache's file not read, what the file on disk would give, frozen", async () => {
    const { root, dir, files } = await folder(5);
    startAppMemory();
    const r = reader(root, dir, files);
    const first = await r.read();
    expect(r.parsed).toHaveLength(5);
    // The cache's file taken away: the next read doesn't read it.
    await rm(await memoFile(root));
    const second = await r.read();
    expect(r.parsed, "nothing parsed again").toHaveLength(5);
    expect(second.map((p) => p.value)).toEqual(first.map((p) => p.value));
    // As the cache on disk gives it: the field set to undefined isn't there.
    expect("gone" in second[0]!.value!).toBe(false);
    expect(Object.isFrozen(second[0]!.value)).toBe(true);
    expect(Object.isFrozen(second[0]!.value!.tags)).toBe(true);
    expect(appMemoryHeld()["the catalog's parses (a writer's read)"]).toBeGreaterThan(0);
    // The same as a read from the cache on disk, outside the app.
    stopAppMemory();
    const disk = reader(root, dir, files, true);
    await disk.read();
    const fromDisk = await disk.read();
    expect(disk.parsed).toHaveLength(5);
    expect(fromDisk.map((p) => p.value)).toEqual(second.map((p) => p.value));
    expect(Object.isFrozen(fromDisk[0]!.value)).toBe(false);
  });

  it("reads again a file changed outside the app: another size, or the same size within the grain", async () => {
    const { root, dir, files } = await folder(4);
    startAppMemory();
    const r = reader(root, dir, files);
    await r.read();
    await writeFile(join(dir, "r1.yaml"), "id: r1\nn: 1001\n");
    let again = await r.read();
    expect(r.parsed.slice(4)).toEqual(["r1.yaml"]);
    expect(again[1]!.value!.n).toBe(1001);
    // Racy: the read is kept as of now, the file's time within the grain; the same size edit
    // keeps its size, and its hash tells it.
    delete recordCacheHooks.now;
    await writeFile(join(dir, "r2.yaml"), "id: r2\nn: 7\n");
    await r.read();
    const t = (await stat(join(dir, "r2.yaml"))).mtime;
    await writeFile(join(dir, "r2.yaml"), "id: r2\nn: 8\n");
    const { utimes } = await import("node:fs/promises");
    await utimes(join(dir, "r2.yaml"), t, t);
    again = await r.read();
    expect(again[2]!.value!.n).toBe(8);
  });

  it("keeps a writer's own texts in memory as the cache on disk does (keepParses)", async () => {
    const { root, dir, files } = await folder(3);
    startAppMemory();
    const r = reader(root, dir, files);
    await r.read();
    await writeFile(join(dir, "r0.yaml"), "id: r0\nn: 500\n");
    const s = await stat(join(dir, "r0.yaml"));
    await keepParses(r.kept()!, {
      files: [
        {
          rel: "r0.yaml",
          value: { id: "r0", n: 500, gone: undefined, tags: ["b"] },
          // Kept as of a moment past the grain, so its size and time vouch for it alone.
          at: { size: s.size, mtimeMs: Math.floor(s.mtimeMs), writtenAt: Date.now() + 10_000 },
        },
      ],
      removed: [],
    });
    const next = await r.read();
    expect(r.parsed, "the writer's text not parsed again").toHaveLength(3);
    expect(next[0]!.value).toEqual({ id: "r0", n: 500, tags: ["b"] });
    expect(Object.isFrozen(next[0]!.value)).toBe(true);
  });

  it("a writer's keepParses neither freezes what its read handed out nor keeps it in place of its JSON (the review of cbab428f)", async () => {
    const { root, dir, files } = await folder(3);
    startAppMemory();
    const r = reader(root, dir, files);
    // Every file parsed now: handed to the reader as parsed, not frozen.
    const first = await r.read();
    const own = first[1]!.value!;
    expect(Object.isFrozen(own)).toBe(false);
    // The writer rewrites another file and keeps its parses.
    await writeFile(join(dir, "r0.yaml"), "id: r0\nn: 500\n");
    const s = await stat(join(dir, "r0.yaml"));
    await keepParses(r.kept()!, {
      files: [
        {
          rel: "r0.yaml",
          value: { id: "r0", n: 500, gone: undefined, tags: ["b"] },
          at: { size: s.size, mtimeMs: Math.floor(s.mtimeMs), writtenAt: Date.now() + 10_000 },
        },
      ],
      removed: [],
    });
    expect(Object.isFrozen(own), "the first read's own parse is still its own").toBe(false);
    const next = await r.read();
    expect(next[1]!.value, "memory keeps its JSON copy, not the reader's object").not.toBe(own);
    expect("gone" in next[1]!.value!, "as the cache on disk gives it").toBe(false);
    expect(Object.isFrozen(next[1]!.value)).toBe(true);
  });

  it("is let go by the app's rule, kept only up to its size, and not kept outside a server", async () => {
    const { root, dir, files } = await folder(4);
    // Outside a server: nothing kept in memory.
    const off = reader(root, dir, files);
    await off.read();
    expect(appMemoryHeld()["the catalog's parses (a writer's read)"] ?? 0).toBe(0);
    startAppMemory();
    const r = reader(root, dir, files);
    await r.read();
    expect(appMemoryHeld()["the catalog's parses (a writer's read)"]).toBeGreaterThan(0);
    releaseAppMemory();
    expect(appMemoryHeld()["the catalog's parses (a writer's read)"] ?? 0).toBe(0);
    await rm(await memoFile(root));
    await r.read();
    expect(r.parsed, "read from the files again once let go").toHaveLength(4);
    // Over the size: not kept.
    releaseAppMemory();
    recordCacheHooks.memoryMaxBytes = 10;
    await r.read();
    expect(appMemoryHeld()["the catalog's parses (a writer's read)"] ?? 0).toBe(0);
    expect(MB).toBeGreaterThan(0);
  });

  it("a read that doesn't ask (a page's, a preview's) is the cache on disk, as before", async () => {
    const { root, dir, files } = await folder(3);
    startAppMemory();
    const r = reader(root, dir, files, false);
    await r.read();
    const again = await r.read();
    expect(r.parsed).toHaveLength(3);
    expect(Object.isFrozen(again[0]!.value)).toBe(false);
    expect(appMemoryHeld()["the catalog's parses (a writer's read)"] ?? 0).toBe(0);
  });
});
