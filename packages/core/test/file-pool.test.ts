import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, stat, utimes, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  CancelledError,
  commitCurrent,
  filePoolHooks,
  hashFilesIn,
  sha256Of,
  statFilesIn,
  stoppableSignal,
  textShaOf,
  withSignal,
} from "../src/index.js";

/**
 * beta.28.2: the catalog's record files are read and hashed off the main thread, in a few worker
 * threads that each read one file at a time (sync reads: 100,000 files took 13 s through the
 * promise API). Whichever way they are read (in this thread, or in 1 to 4 workers), each file's
 * hash is the hash of its text with its line endings made LF, exactly `sha256Of` of that text, and
 * its size and time are the ones `stat` gives; the results are in the order of the paths.
 */
const made: string[] = [];
afterAll(async () => {
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true })));
});
afterEach(() => {
  delete filePoolHooks.workers;
  delete filePoolHooks.minFiles;
});

/** The hash every way of reading must give: the text's, read as UTF-8, its line endings LF. */
const expectedSha = (b: Buffer) => sha256Of(b.toString("utf8").replace(/\r\n?/g, "\n"));

const ODD: Record<string, Buffer> = {
  "a/lf.yaml": Buffer.from("kind: Endpoint\nid: forge-orders.get\n", "utf8"),
  "a/crlf.yaml": Buffer.from("kind: Endpoint\r\nid: forge-orders.post\r\n", "utf8"),
  "a/lone-cr.yaml": Buffer.from("kind: Table\rid: orders\r", "utf8"),
  "a/bom.yaml": Buffer.from("﻿kind: Table\nid: Northwind Pay\n", "utf8"),
  "a/accents.yaml": Buffer.from("name: Café Forge ✓ 🚀\n", "utf8"),
  // Latin-1 é (0xE9) is not UTF-8: it reads as U+FFFD, as readFile(…, "utf8") reads it.
  "b/latin1.yaml": Buffer.from("name: Caf\xe9 Forge\n", "latin1"),
  "b/cut-short.yaml": Buffer.from([0x6b, 0x3a, 0x20, 0xe2, 0x82]),
  "b/empty.yaml": Buffer.alloc(0),
  "b/nul.yaml": Buffer.from([0x00, 0x0d, 0x0a, 0x41]),
};

async function folder(files: Record<string, Buffer>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "atticus-file-pool-"));
  made.push(dir);
  for (const [rel, bytes] of Object.entries(files)) {
    await mkdir(join(dir, ...rel.split("/").slice(0, -1)), { recursive: true });
    await writeFile(join(dir, ...rel.split("/")), bytes);
  }
  return dir;
}

/** In this thread, and in 1, 2 and 3 workers (from any number of files). */
const WAYS = [
  { name: "in this thread", workers: 0 },
  { name: "1 worker", workers: 1 },
  { name: "2 workers", workers: 2 },
  { name: "3 workers", workers: 3 },
] as const;

describe("hashing a folder's files, in this thread or in workers (beta.28.2)", () => {
  for (const way of WAYS)
    it(`${way.name}: each file's LF text hash, size and time, in the paths' order`, async () => {
      filePoolHooks.workers = way.workers;
      filePoolHooks.minFiles = 0;
      const dir = await folder(ODD);
      const rels = Object.keys(ODD).reverse();
      const got = await hashFilesIn(dir, rels);
      expect(got).toHaveLength(rels.length);
      for (const [k, rel] of rels.entries()) {
        const s = await stat(join(dir, ...rel.split("/")));
        expect(got[k], rel).toEqual({
          sha: expectedSha(ODD[rel]!),
          size: s.size,
          mtimeMs: Math.floor(s.mtimeMs),
        });
        expect(textShaOf(ODD[rel]!), rel).toBe(expectedSha(ODD[rel]!));
      }
    });

  it("many files across the batches keep their order, whatever the number of workers", async () => {
    const files: Record<string, Buffer> = {};
    for (let i = 0; i < 1_300; i++)
      files[`k${i % 7}/forge-svc-${String(i).padStart(4, "0")}.yaml`] = Buffer.from(
        `kind: Endpoint\r\nid: forge-svc.${i}\n${"x".repeat(i % 97)}\n`,
        "utf8",
      );
    const dir = await folder(files);
    const rels = Object.keys(files);
    const want = rels.map((r) => expectedSha(files[r]!));
    for (const way of WAYS) {
      filePoolHooks.workers = way.workers;
      filePoolHooks.minFiles = 0;
      expect(
        (await hashFilesIn(dir, rels)).map((h) => h.sha),
        way.name,
      ).toEqual(want);
    }
  });

  it("a change that keeps the size and the time is seen: every byte is read", async () => {
    const dir = await folder({ "c/forge.yaml": Buffer.from("owner: forge-team\n", "utf8") });
    const path = join(dir, "c", "forge.yaml");
    const before = await stat(path);
    for (const way of WAYS) {
      filePoolHooks.workers = way.workers;
      filePoolHooks.minFiles = 0;
      await writeFile(path, "owner: forge-team\n");
      await utimes(path, before.atime, before.mtime);
      const [was] = await hashFilesIn(dir, ["c/forge.yaml"]);
      await writeFile(path, "owner: forge-tean\n");
      await utimes(path, before.atime, before.mtime);
      const [now] = await hashFilesIn(dir, ["c/forge.yaml"]);
      expect(now!.size, way.name).toBe(was!.size);
      expect(now!.mtimeMs, way.name).toBe(was!.mtimeMs);
      expect(now!.sha, way.name).not.toBe(was!.sha);
      expect(now!.sha, way.name).toBe(expectedSha(await readFile(path)));
    }
  });

  for (const way of WAYS)
    it(`${way.name}: a file gone since the paths were listed fails the read, as opening it does`, async () => {
      filePoolHooks.workers = way.workers;
      filePoolHooks.minFiles = 0;
      const dir = await folder(ODD);
      await expect(hashFilesIn(dir, ["a/lf.yaml", "a/gone.yaml"])).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

  it("a worker that can't start (it fails before its first answer) leaves the read to this thread", async () => {
    filePoolHooks.workers = 2;
    filePoolHooks.minFiles = 0;
    filePoolHooks.failStart = true;
    try {
      const dir = await folder(ODD);
      const rels = Object.keys(ODD);
      expect((await hashFilesIn(dir, rels)).map((h) => h.sha)).toEqual(
        rels.map((r) => expectedSha(ODD[r]!)),
      );
      expect((await statFilesIn(dir, rels)).every((s) => s !== undefined)).toBe(true);
      // A file that can't be read still fails the read, from this thread.
      await expect(hashFilesIn(dir, ["a/lf.yaml", "a/gone.yaml"])).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      delete filePoolHooks.failStart;
    }
  });

  it("a worker that never says it is ready is stopped after the start-up wait, and this thread reads", async () => {
    // The final review of beta.28.2: a worker that neither answered nor failed hung the build.
    filePoolHooks.workers = 2;
    filePoolHooks.minFiles = 0;
    filePoolHooks.neverReady = true;
    filePoolHooks.startTimeoutMs = 200;
    try {
      const dir = await folder(ODD);
      const rels = Object.keys(ODD);
      const t0 = Date.now();
      expect((await hashFilesIn(dir, rels)).map((h) => h.sha)).toEqual(
        rels.map((r) => expectedSha(ODD[r]!)),
      );
      expect((await statFilesIn(dir, rels)).every((s) => s !== undefined)).toBe(true);
      expect(Date.now() - t0).toBeLessThan(5_000);
    } finally {
      delete filePoolHooks.neverReady;
      delete filePoolHooks.startTimeoutMs;
    }
  });

  for (const way of WAYS)
    it(`${way.name}: with raw, the hash of the bytes as they are (CR and all)`, async () => {
      filePoolHooks.workers = way.workers;
      filePoolHooks.minFiles = 0;
      const dir = await folder(ODD);
      const rels = Object.keys(ODD);
      const got = await hashFilesIn(dir, rels, { raw: true });
      expect(got.map((h) => h.sha)).toEqual(
        rels.map((r) => createHash("sha256").update(ODD[r]!).digest("hex")),
      );
    });

  it("no files: nothing read, no worker started", async () => {
    filePoolHooks.workers = 2;
    filePoolHooks.minFiles = 0;
    expect(await hashFilesIn(tmpdir(), [])).toEqual([]);
  });
});

describe("stat of a folder's files, in this thread or in workers (beta.28.2)", () => {
  for (const way of WAYS)
    it(`${way.name}: each file's size and time (ms, floored); none for a file not there`, async () => {
      filePoolHooks.workers = way.workers;
      filePoolHooks.minFiles = 0;
      const dir = await folder(ODD);
      const rels = [...Object.keys(ODD), "a/not-there.yaml"];
      const got = await statFilesIn(dir, rels);
      for (const [k, rel] of rels.entries()) {
        const s = await stat(join(dir, ...rel.split("/"))).catch(() => undefined);
        expect(got[k], rel).toEqual(
          s ? { size: s.size, mtimeMs: Math.floor(s.mtimeMs) } : undefined,
        );
      }
    });
});

/**
 * Beta.28.3: Stop during the read. A job's Stop was heard only between steps, so the read of
 * every file of a large catalog (the first one on a machine, with nothing in the page cache) ran
 * to its end first. The read takes the job's signal now: the workers are stopped where they are,
 * this thread's read between two files, the wait for workers that never start at once; the call
 * fails with CancelledError, and no reader is left running. Over 20,000 generated files.
 */
describe("Stop during the read of a large folder (beta.28.3)", () => {
  const MANY = 20_000;
  let big: { dir: string; rels: string[] } | undefined;
  /** 20,000 small record files in 100 folders, made once. */
  async function estate() {
    if (big) return big;
    const dir = await mkdtemp(join(tmpdir(), "atticus-file-pool-big-"));
    made.push(dir);
    const rels: string[] = [];
    for (let f = 0; f < 100; f++) {
      mkdirSync(join(dir, `forge-${f}`));
      for (let i = 0; i < MANY / 100; i++) {
        const rel = `forge-${f}/endpoint-${i}.yaml`;
        writeFileSync(
          join(dir, `forge-${f}`, `endpoint-${i}.yaml`),
          `kind: Endpoint\nid: forge-${f}.endpoint-${i}\nname: GET /forge/${f}/orders/${i}\n${"# ledger line\n".repeat(40)}`,
        );
        rels.push(rel);
      }
    }
    return (big = { dir, rels });
  }
  afterEach(() => {
    delete filePoolHooks.onRead;
    delete filePoolHooks.neverReady;
    delete filePoolHooks.failStart;
    delete filePoolHooks.startTimeoutMs;
  });

  /** Stop once some of the files are read, and none of the rest: how long the stop took, and how far it got. */
  async function stoppedMidRead(read: (o: { signal: AbortSignal }) => Promise<unknown>) {
    const stop = new AbortController();
    let at = 0;
    let readAtStop = 0;
    let readInAll = 0;
    filePoolHooks.onRead = (n) => {
      readInAll = Math.max(readInAll, n);
      if (n >= 1_000 && !stop.signal.aborted) {
        readAtStop = n;
        at = Date.now();
        stop.abort();
      }
    };
    await expect(read({ signal: stop.signal })).rejects.toBeInstanceOf(CancelledError);
    const took = Date.now() - at;
    // What was under way when the stop came may still be counted; nothing is started after it.
    await new Promise((r) => setTimeout(r, 200));
    return { took, readAtStop, readInAll };
  }

  for (const way of WAYS)
    it(`${way.name}: a Stop mid-read ends the hash within a second, most files unread`, async () => {
      const { dir, rels } = await estate();
      filePoolHooks.workers = way.workers;
      const r = await stoppedMidRead((o) => hashFilesIn(dir, rels, o));
      expect(r.readAtStop).toBeGreaterThanOrEqual(1_000);
      expect(r.took).toBeLessThan(1_000);
      expect(r.readInAll).toBeLessThan(MANY / 2);
    }, 120_000);

  for (const way of [WAYS[0], WAYS[2]])
    it(`${way.name}: a Stop mid-read ends the read of sizes and times too`, async () => {
      const { dir, rels } = await estate();
      filePoolHooks.workers = way.workers;
      const r = await stoppedMidRead((o) => statFilesIn(dir, rels, o));
      expect(r.took).toBeLessThan(1_000);
      expect(r.readInAll).toBeLessThan(MANY);
    }, 120_000);

  it("workers that never start: a Stop during the wait for them ends the read at once, not after the wait", async () => {
    const { dir, rels } = await estate();
    filePoolHooks.workers = 2;
    filePoolHooks.neverReady = true;
    filePoolHooks.startTimeoutMs = 30_000;
    const stop = new AbortController();
    const t0 = Date.now();
    setTimeout(() => stop.abort(), 100);
    await expect(hashFilesIn(dir, rels, { signal: stop.signal })).rejects.toBeInstanceOf(
      CancelledError,
    );
    expect(Date.now() - t0).toBeLessThan(2_000);
  }, 120_000);

  for (const how of ["neverReady", "failStart"] as const)
    it(`workers that never start (${how}): this thread's read in their place hears the Stop too`, async () => {
      const { dir, rels } = await estate();
      filePoolHooks.workers = 2;
      filePoolHooks[how] = true;
      filePoolHooks.startTimeoutMs = 100;
      const r = await stoppedMidRead((o) => hashFilesIn(dir, rels, o));
      expect(r.took).toBeLessThan(1_000);
      expect(r.readInAll).toBeLessThan(MANY / 2);
    }, 120_000);

  it("a signal stopped already reads nothing", async () => {
    const { dir, rels } = await estate();
    const stop = new AbortController();
    stop.abort();
    let read = 0;
    filePoolHooks.onRead = (n) => (read = n);
    for (const workers of [0, 2]) {
      filePoolHooks.workers = workers;
      await expect(hashFilesIn(dir, rels, { signal: stop.signal })).rejects.toBeInstanceOf(
        CancelledError,
      );
    }
    expect(read).toBe(0);
  }, 120_000);

  it("with no signal, or one never stopped, every file is read as before", async () => {
    const { dir, rels } = await estate();
    filePoolHooks.workers = 2;
    const plain = await hashFilesIn(dir, rels);
    const withOne = await hashFilesIn(dir, rels, { signal: new AbortController().signal });
    expect(withOne).toEqual(plain);
    expect(plain).toHaveLength(MANY);
  }, 120_000);

  it("the job's signal is one a read may stop on until the job says it is writing", async () => {
    expect(stoppableSignal()).toBeUndefined();
    const stop = new AbortController();
    await withSignal(stop.signal, async () => {
      expect(stoppableSignal()).toBe(stop.signal);
      // The write has started: a Stop is too late, and no read of the write is cut short.
      commitCurrent();
      expect(stoppableSignal()).toBeUndefined();
    });
  });
});
