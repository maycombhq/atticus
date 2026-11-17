import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hashCacheHooks,
  hashFilesIn,
  hashFilesKept,
  RACY_MS,
  recordCacheHooks,
} from "../src/index.js";

/**
 * Hashes kept between runs (hash-cache.ts, beta.28.5): the owner's field report had every build
 * spend 20 to 34 s "reading the catalog's files to check the build" on a Windows laptop with
 * antivirus, 12,832 record files opened and hashed by every command although none had changed.
 * A file whose size and time are the ones its hash was kept by isn't opened again; one changed
 * since, or written within the timestamp's grain of when its hash was kept (racily clean), is.
 */

let dirs: string[] = [];
afterEach(async () => {
  delete recordCacheHooks.now;
  delete hashCacheHooks.onHashed;
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
});

async function folder(n = 5) {
  const root = await mkdtemp(join(tmpdir(), "atticus-hash-"));
  dirs.push(root);
  const dir = join(root, "catalog", "generated");
  await mkdir(join(dir, "component"), { recursive: true });
  const files = Array.from({ length: n }, (_, i) => `component/c${i}.yaml`);
  for (const f of files) await writeFile(join(dir, f), `id: ${f}\nname: one\n`);
  return { root, dir, files };
}

/** The files hashed by each call since. */
function counting() {
  const calls: number[] = [];
  hashCacheHooks.onHashed = (n) => calls.push(n);
  return calls;
}

/** The clock a hash is kept at: `ms` after now. */
const later = (ms: number) => {
  const at = Date.now() + ms;
  recordCacheHooks.now = () => at;
};

describe("hashes kept by size and time (hash-cache.ts)", () => {
  it("gives what hashFilesIn gives, and opens no file the second time", async () => {
    const { root, dir, files } = await folder();
    const calls = counting();
    later(10 * RACY_MS);
    const first = await hashFilesKept({ dir, files, cacheRoot: root });
    expect(first).toEqual(await hashFilesIn(dir, files));
    expect(calls).toEqual([5]);
    const second = await hashFilesKept({ dir, files, cacheRoot: root });
    expect(second).toEqual(first);
    expect(calls).toEqual([5, 0]);
  });

  it("hashes again a file whose size or time changed, and only that file", async () => {
    const { root, dir, files } = await folder();
    later(10 * RACY_MS);
    await hashFilesKept({ dir, files, cacheRoot: root });
    const calls = counting();
    // The same size, a later time: an edit in place.
    const at = new Date(Date.now() + 5_000);
    await writeFile(join(dir, files[2]!), `id: ${files[2]}\nname: two\n`);
    await utimes(join(dir, files[2]!), at, at);
    later(20 * RACY_MS);
    const now = await hashFilesKept({ dir, files, cacheRoot: root });
    expect(calls).toEqual([1]);
    expect(now).toEqual(await hashFilesIn(dir, files));
  });

  it("never serves the old hash of a same-size edit that kept the file's time (racily clean)", async () => {
    const { root, dir, files } = await folder();
    // Kept at the moment the files were written: their times are within the grain of it.
    const first = await hashFilesKept({ dir, files, cacheRoot: root });
    const s = await stat(join(dir, files[0]!));
    await writeFile(join(dir, files[0]!), `id: ${files[0]}\nname: two\n`);
    await utimes(join(dir, files[0]!), s.atime, s.mtime);
    expect((await stat(join(dir, files[0]!))).size).toBe(s.size);
    const calls = counting();
    const now = await hashFilesKept({ dir, files, cacheRoot: root });
    // Every file is racy still: each is hashed again, and the edit is seen.
    expect(calls).toEqual([5]);
    expect(now[0]!.sha).not.toBe(first[0]!.sha);
    expect(now).toEqual(await hashFilesIn(dir, files));
  });

  it("sees a same-size edit that put the file's time back, however long after (its change time)", async () => {
    const { root, dir, files } = await folder();
    // A time of whole milliseconds, which a Date puts back exactly.
    const whole = new Date(Date.now() - 60_000);
    await utimes(join(dir, files[3]!), whole, whole);
    later(10 * RACY_MS);
    const first = await hashFilesKept({ dir, files, cacheRoot: root });
    const calls = counting();
    expect(await hashFilesKept({ dir, files, cacheRoot: root })).toEqual(first);
    expect(calls).toEqual([0]);
    // Long after the hash was kept (nothing racy about it): the edit, then the time it had.
    await new Promise((r) => setTimeout(r, 30));
    const s = await stat(join(dir, files[3]!));
    await writeFile(join(dir, files[3]!), `id: ${files[3]}\nname: two\n`);
    await utimes(join(dir, files[3]!), s.atime, s.mtime);
    const after = await stat(join(dir, files[3]!));
    expect([after.size, Math.floor(after.mtimeMs)]).toEqual([s.size, Math.floor(s.mtimeMs)]);
    later(20 * RACY_MS);
    const now = await hashFilesKept({ dir, files, cacheRoot: root });
    expect(calls).toEqual([0, 1]);
    expect(now[3]!.sha).not.toBe(first[3]!.sha);
    expect(now).toEqual(await hashFilesIn(dir, files));
  });

  it("keeps a racy file's hash once a later read finds it old enough", async () => {
    const { root, dir, files } = await folder();
    await hashFilesKept({ dir, files, cacheRoot: root });
    const calls = counting();
    later(10 * RACY_MS);
    await hashFilesKept({ dir, files, cacheRoot: root });
    await hashFilesKept({ dir, files, cacheRoot: root });
    expect(calls).toEqual([5, 0]);
  });

  it("forgets a file that is gone and hashes a new one", async () => {
    const { root, dir, files } = await folder();
    later(10 * RACY_MS);
    await hashFilesKept({ dir, files, cacheRoot: root });
    await writeFile(join(dir, "component/new.yaml"), "id: new\n");
    const calls = counting();
    later(20 * RACY_MS);
    const list = [...files.slice(1), "component/new.yaml"];
    expect(await hashFilesKept({ dir, files: list, cacheRoot: root })).toEqual(
      await hashFilesIn(dir, list),
    );
    expect(calls).toEqual([1]);
  });

  it("writes nothing with no root, and nothing with keep false (a preview)", async () => {
    const { root, dir, files } = await folder();
    const calls = counting();
    later(10 * RACY_MS);
    await hashFilesKept({ dir, files });
    await hashFilesKept({ dir, files, cacheRoot: root, keep: false });
    expect(await readdir(root)).toEqual(["catalog"]);
    expect(calls).toEqual([5, 5]);
    // A preview reads what a write kept.
    await hashFilesKept({ dir, files, cacheRoot: root });
    await hashFilesKept({ dir, files, cacheRoot: root, keep: false });
    expect(calls).toEqual([5, 5, 5, 0]);
  });

  it("reads the files when the cache doesn't read", async () => {
    const { root, dir, files } = await folder();
    later(10 * RACY_MS);
    await hashFilesKept({ dir, files, cacheRoot: root });
    const cache = join(root, ".atticus", "cache");
    for (const n of await readdir(cache)) await writeFile(join(cache, n), "{ not json");
    const calls = counting();
    expect(await hashFilesKept({ dir, files, cacheRoot: root })).toEqual(
      await hashFilesIn(dir, files),
    );
    expect(calls).toEqual([5]);
  });

  // The review of beta.28.5: the file's identity (its inode, NTFS's file id) is in the key too,
  // so a file replaced by another of the same size and times is read; a platform that reports
  // none (0) is keyed without it.
  it("hashes again a file whose identity is another than the one its hash was kept by", async () => {
    const { root, dir, files } = await folder();
    later(10 * RACY_MS);
    await hashFilesKept({ dir, files, cacheRoot: root });
    const cache = join(root, ".atticus", "cache");
    const memo = join(cache, (await readdir(cache))[0]!);
    const kept = JSON.parse(await readFile(memo, "utf8")) as {
      entries: Record<string, (number | string)[]>;
    };
    const real = (await stat(join(dir, files[1]!))).ino;
    expect(Object.values(kept.entries).every((e) => e.length === 6)).toBe(true);
    expect(kept.entries[files[1]!]![3]).toBe(real);
    // As if kept of another file that was at this path.
    kept.entries[files[1]!]![3] = real + 1;
    // As kept where the platform reports no identity.
    kept.entries[files[2]!]![3] = 0;
    await writeFile(memo, JSON.stringify(kept));
    const calls = counting();
    expect(await hashFilesKept({ dir, files, cacheRoot: root })).toEqual(
      await hashFilesIn(dir, files),
    );
    expect(calls).toEqual([1]);
  });
});
