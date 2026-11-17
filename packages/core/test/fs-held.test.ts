import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileHeldError, fsHooks, HELD_WAIT_MS, writeFileAtomic } from "../src/index.js";

/**
 * Beta.28.5, the owner's field report: a run over forty repos ended on "EPERM: operation not
 * permitted, rename '…\facts\<repo>.rejected.jsonl.<pid>.<hex>.tmp' -> '…\<repo>.rejected.jsonl'".
 * On Windows a file open in another program (an editor, an assistant's session reading it)
 * can't be replaced; the wait was 5 s, the error a raw one, and it ended the whole run. Windows
 * is simulated here: an injected rename that fails with EPERM, and a clock that doesn't wait.
 */

let dir: string;
let waited: number;
let said: string[];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "atticus-held-"));
  waited = 0;
  said = [];
  fsHooks.sleep = async (ms) => void (waited += ms);
  fsHooks.platform = "win32";
  fsHooks.say = (l) => said.push(l);
});
afterEach(async () => {
  for (const k of Object.keys(fsHooks)) delete (fsHooks as Record<string, unknown>)[k];
  await rm(dir, { recursive: true, force: true });
});

/** A rename that fails `times` times with `code`, then renames. */
function failing(times: number, code = "EPERM") {
  let n = 0;
  fsHooks.rename = async (from, to) => {
    if (n++ < times) {
      const e = new Error(
        `${code}: operation not permitted, rename '${from}' -> '${to}'`,
      ) as NodeJS.ErrnoException;
      e.code = code;
      throw e;
    }
    const { rename } = await import("node:fs/promises");
    await rename(from, to);
  };
  return () => n;
}

describe("a file another program holds (Windows)", () => {
  it("is written without a word when it is held for a moment only", async () => {
    const file = join(dir, "forge-svc-01.rejected.jsonl");
    await writeFile(file, "old\n");
    failing(3);
    await writeFileAtomic(file, "new\n");
    expect(await readFile(file, "utf8")).toBe("new\n");
    expect(said).toEqual([]);
    expect(waited).toBeLessThan(1_000);
  });

  it("says once that it waits, naming the file, and writes when the file is let go", async () => {
    const file = join(dir, "forge-svc-01.rejected.jsonl");
    await writeFile(file, "old\n");
    failing(20);
    await writeFileAtomic(file, "new\n");
    expect(await readFile(file, "utf8")).toBe("new\n");
    expect(said).toEqual([
      `${file} is open in another program (an editor, an assistant's session or a virus scan): waiting for it, up to ${HELD_WAIT_MS / 1000} s. Close it there to go on.`,
    ]);
    expect(waited).toBeGreaterThan(5_000);
    expect(waited).toBeLessThanOrEqual(HELD_WAIT_MS);
  });

  it("gives up after the wait in plain words, the file as it was and no temporary file left", async () => {
    const file = join(dir, "forge-svc-01.rejected.jsonl");
    await writeFile(file, "old\n");
    const tries = failing(Infinity);
    const e = await writeFileAtomic(file, "new\n").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(FileHeldError);
    expect((e as FileHeldError).path).toBe(file);
    expect((e as Error).message).toBe(
      `${file} is open in another program (an editor, an assistant's session or a virus scan) or can't be written, and it stayed so for ${HELD_WAIT_MS / 1000} s. Nothing was lost: the file is as it was. Close it there, then run the command again.`,
    );
    expect((e as Error).message).not.toMatch(/EPERM|\.tmp/);
    expect(await readFile(file, "utf8")).toBe("old\n");
    expect(await readdir(dir)).toEqual(["forge-svc-01.rejected.jsonl"]);
    expect(said.length).toBe(1);
    expect(waited).toBeGreaterThanOrEqual(HELD_WAIT_MS);
    expect(waited).toBeLessThan(HELD_WAIT_MS + 2_000);
    expect(tries()).toBeGreaterThan(20);
  });

  it("fails at once, as before, on an error that isn't a held file", async () => {
    const file = join(dir, "a.yaml");
    failing(Infinity, "ENOSPC");
    const e = await writeFileAtomic(file, "new\n").catch((x: unknown) => x);
    expect((e as NodeJS.ErrnoException).code).toBe("ENOSPC");
    expect(waited).toBe(0);
    expect(await readdir(dir)).toEqual([]);
  });

  it("off Windows waits as before (about 5 s) and gives the system's error", async () => {
    fsHooks.platform = "linux";
    const file = join(dir, "a.yaml");
    failing(Infinity, "EACCES");
    const e = await writeFileAtomic(file, "new\n").catch((x: unknown) => x);
    expect(e).not.toBeInstanceOf(FileHeldError);
    expect((e as NodeJS.ErrnoException).code).toBe("EACCES");
    expect(waited).toBe(20 * (2 ** 8 - 1));
    expect(said).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });

  it("leaves the temporary file's removal failing out of the error", async () => {
    const file = join(dir, "a.yaml");
    failing(Infinity, "ENOSPC");
    fsHooks.rm = async () => {
      throw Object.assign(new Error("EPERM: operation not permitted, unlink"), { code: "EPERM" });
    };
    const e = await writeFileAtomic(file, "new\n").catch((x: unknown) => x);
    expect((e as NodeJS.ErrnoException).code).toBe("ENOSPC");
  });
});
