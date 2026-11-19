import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FileHeldError,
  forgetHeld,
  fsHooks,
  HELD_AGAIN_MS,
  HELD_WAIT_MS,
  writeFileAtomic,
} from "../src/index.js";

/**
 * Beta.30 (the plan's step 1): Windows itself, where fs-held.test.ts simulates it. A file is
 * really held by another process, opened there with no sharing as an editor or a virus scan
 * opens it, while writeFileAtomic writes it; and a process is really killed in the middle of a
 * write. Skipped everywhere else: only Windows refuses to replace a file another process has
 * open, and no other system has the open mode that asks for it.
 *
 * Each child is a node of its own, started with no shell. The second case's child uses the built
 * module (dist/fs.js), as process-trees.test.ts does.
 */

const WINDOWS = process.platform === "win32";
const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT = pathToFileURL(join(HERE, "../dist/fs.js")).href;

let dir: string;
const children: ChildProcess[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "atticus-held-win-"));
});
afterEach(async () => {
  for (const c of children.splice(0)) await ended(c);
  for (const k of Object.keys(fsHooks)) delete (fsHooks as Record<string, unknown>)[k];
  forgetHeld();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** Kill the child if it still runs, and wait until it is gone (its handles with it). */
function ended(c: ChildProcess): Promise<void> {
  if (c.exitCode !== null || c.signalCode !== null) return Promise.resolve();
  return new Promise((done) => {
    c.once("exit", () => done());
    c.kill();
  });
}

/** A node running `source` with `args`; resolves once it prints `ready` on a line of its own. */
async function child(source: string, args: string[]): Promise<ChildProcess> {
  const script = join(dir, `child-${children.length}.mjs`);
  await writeFile(script, source);
  const c = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "inherit"] });
  children.push(c);
  await new Promise<void>((ready, failed) => {
    let seen = "";
    c.stdout!.on("data", (d: Buffer) => {
      seen += d.toString("utf8");
      if (/^ready$/m.test(seen)) ready();
    });
    c.once("exit", (code) => failed(new Error(`the child ended (${code}) before it was ready`)));
    c.once("error", failed);
  });
  return c;
}

/**
 * Opens the file with no sharing (libuv's UV_FS_O_EXLOCK: on Windows, a share mode of none, so
 * no other process may read, write, delete or replace it), says so, and keeps it open for the
 * given time or until it is killed.
 */
const HOLDER = `import { constants, openSync, closeSync } from "node:fs";
const [path, ms] = process.argv.slice(2);
const fd = openSync(path, constants.O_RDWR | constants.UV_FS_O_EXLOCK);
console.log("ready");
setTimeout(() => closeSync(fd), Number(ms));
`;

/** Writes the file over and over with the built writeFileAtomic, each time all `a` or all `b`. */
const WRITER = `const { writeFileAtomic } = await import(${JSON.stringify(BUILT)});
const [path, size] = process.argv.slice(2);
const a = Buffer.alloc(Number(size), "a");
const b = Buffer.alloc(Number(size), "b");
console.log("ready");
for (let i = 0; ; i++) await writeFileAtomic(path, i % 2 ? b : a);
`;

const tmps = async () => (await readdir(dir)).filter((f) => f.endsWith(".tmp"));

describe("a file another process really holds, on Windows", () => {
  it.skipIf(!WINDOWS)(
    "waits for it, says so once, and writes it when the other process lets go",
    async () => {
      const path = join(dir, "facts.jsonl");
      await writeFile(path, "old\n");
      const said: string[] = [];
      fsHooks.say = (l) => said.push(l);
      await child(HOLDER, [path, "2500"]);

      const t = Date.now();
      await writeFileAtomic(path, "new\n");
      const took = Date.now() - t;

      // It waited, said so once it had waited a second, and went on once the holder closed
      // the file, long before the wait runs out.
      expect(took).toBeGreaterThan(1_000);
      expect(took).toBeLessThan(9_000);
      expect(said).toHaveLength(1);
      expect(said[0]).toContain(
        `${path} is open in another program (an editor, an assistant's session or a virus scan): waiting for it, up to ${HELD_WAIT_MS / 1000} s.`,
      );
      expect(await readFile(path, "utf8")).toBe("new\n");
      expect(await tmps()).toEqual([]);
    },
    20_000,
  );

  it.skipIf(!WINDOWS)(
    "fails with the documented words when it stays held, and the file is as it was",
    async () => {
      const path = join(dir, "facts.jsonl");
      await writeFile(path, "old\n");
      const holder = await child(HOLDER, [path, "60000"]);
      fsHooks.say = () => undefined;

      // The long wait on a clock that doesn't wait: every try is a real rename Windows refuses.
      let clock = 0;
      fsHooks.sleep = async (ms) => void (clock += ms);
      const first = await writeFileAtomic(path, "new\n").catch((e: unknown) => e);
      expect(first).toBeInstanceOf(FileHeldError);
      expect((first as FileHeldError).message).toBe(
        `${path} is open in another program (an editor, an assistant's session or a virus scan) or can't be written, and it stayed so for ${HELD_WAIT_MS / 1000} s. Nothing was lost: the file is as it was. Close it there, then run the command again.`,
      );
      expect(clock).toBeGreaterThanOrEqual(HELD_WAIT_MS);

      // Once a file stayed held, the next wait is the short one: on the real clock here.
      delete fsHooks.sleep;
      const t = Date.now();
      const second = await writeFileAtomic(path, "new\n").catch((e: unknown) => e);
      const took = Date.now() - t;
      expect(second).toBeInstanceOf(FileHeldError);
      expect((second as FileHeldError).message).toContain(
        `it stayed so for ${HELD_AGAIN_MS / 1000} s. Nothing was lost: the file is as it was.`,
      );
      expect(took).toBeGreaterThanOrEqual(HELD_AGAIN_MS - 100);
      expect(took).toBeLessThan(HELD_AGAIN_MS + 4_000);

      // Read once the holder is gone (while it holds the file nobody else may open it).
      await ended(holder);
      expect(await readFile(path, "utf8")).toBe("old\n");
      expect(await tmps()).toEqual([]);
    },
    20_000,
  );
});

describe("a process killed in the middle of a write, on Windows", () => {
  it.skipIf(!WINDOWS)(
    "leaves the file whole: the old bytes or the new, never part of each",
    async () => {
      const SIZE = 4 * 1024 * 1024;
      const path = join(dir, "catalog.yaml");
      await writeFile(path, Buffer.alloc(SIZE, "o"));
      // Kills at different moments of the writer's loop: each write of 4 MB takes a few
      // milliseconds, so some land inside one.
      for (const after of [5, 17, 40, 3, 71, 11, 29, 53]) {
        const writer = await child(WRITER, [path, String(SIZE)]);
        await new Promise((r) => setTimeout(r, after));
        await ended(writer);
        const bytes = await readFile(path);
        expect(bytes.length, `killed ${after} ms in`).toBe(SIZE);
        const letter = String.fromCharCode(bytes[0]!);
        expect(["o", "a", "b"], `killed ${after} ms in`).toContain(letter);
        expect(bytes.equals(Buffer.alloc(SIZE, letter)), `killed ${after} ms in`).toBe(true);
      }
    },
    20_000,
  );
});
