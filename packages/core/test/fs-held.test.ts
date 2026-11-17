import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CancelledError,
  FileHeldError,
  forgetHeld,
  fsHooks,
  HELD_AGAIN_MS,
  HELD_WAIT_MS,
  isFileSystemError,
  removeHeld,
  renameRetrying,
  setHeldWaitSignal,
  sweepStaleTmp,
  writeFileAtomic,
} from "../src/index.js";

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
  forgetHeld();
  setHeldWaitSignal(undefined);
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

  // The review of beta.28.5: the long wait must not multiply, and Stop must end it.
  it("waits only the quick tries where asked (a cache's write, a folder's rename), with the system's error", async () => {
    const file = join(dir, "hashes.json");
    failing(Infinity);
    const e = await writeFileAtomic(file, "{}", { quick: true }).catch((x: unknown) => x);
    expect(e).not.toBeInstanceOf(FileHeldError);
    expect((e as NodeJS.ErrnoException).code).toBe("EPERM");
    expect(waited).toBe(20 * (2 ** 8 - 1));
    expect(said.length).toBeLessThanOrEqual(1);
    expect(await readdir(dir)).toEqual([]);
    waited = 0;
    const r = await renameRetrying(join(dir, "a"), join(dir, "b"), { quick: true }).catch(
      (x: unknown) => x,
    );
    expect((r as NodeJS.ErrnoException).code).toBe("EPERM");
    expect(waited).toBe(20 * (2 ** 8 - 1));
  });

  it("after one file stayed held, later waits in the process are short: a cause that stays costs no 45 s a file", async () => {
    failing(Infinity);
    const first = await writeFileAtomic(join(dir, "a.yaml"), "a\n").catch((x: unknown) => x);
    expect(first).toBeInstanceOf(FileHeldError);
    waited = 0;
    said = [];
    const second = await writeFileAtomic(join(dir, "b.yaml"), "b\n").catch((x: unknown) => x);
    expect(second).toBeInstanceOf(FileHeldError);
    expect(waited).toBeGreaterThanOrEqual(HELD_AGAIN_MS);
    expect(waited).toBeLessThan(HELD_AGAIN_MS + 1_000);
    expect((second as Error).message).toContain(`stayed so for ${Math.round(waited / 1000)} s`);
    expect(said[0] ?? "").not.toContain("up to 45 s");
    expect(await readdir(dir)).toEqual([]);
  });

  it("a Stop ends the wait once it is a second in: CancelledError, the file as it was, no temporary file", async () => {
    const file = join(dir, "a.yaml");
    await writeFile(file, "old\n");
    failing(Infinity);
    const stop = new AbortController();
    setHeldWaitSignal(stop.signal);
    let sleeps = 0;
    fsHooks.sleep = async (ms) => {
      waited += ms;
      if (++sleeps === 3) stop.abort();
    };
    const e = await writeFileAtomic(file, "new\n").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CancelledError);
    // Not within the first second (a file held for a moment is written whatever was asked):
    // 20, 40, 80, 160, 320 and 640 ms, and the wait ends there.
    expect(sleeps).toBe(6);
    expect(await readFile(file, "utf8")).toBe("old\n");
    expect(await readdir(dir)).toEqual(["a.yaml"]);
  });

  it("a real wait is cut short by Stop too, not slept through", async () => {
    delete fsHooks.sleep;
    failing(Infinity);
    const stop = new AbortController();
    setHeldWaitSignal(stop.signal);
    setTimeout(() => stop.abort(), 30);
    const t = Date.now();
    const e = await writeFileAtomic(join(dir, "a.yaml"), "new\n").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CancelledError);
    expect(Date.now() - t).toBeLessThan(4_000);
  });

  it("removes a file that is held the way it writes one: waited for, then FileHeldError", async () => {
    const file = join(dir, "forge-svc-01.rejected.jsonl");
    await writeFile(file, "old\n");
    let n = 0;
    fsHooks.remove = async (p) => {
      if (n++ < 12)
        throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${p}'`), {
          code: "EBUSY",
        });
      await rm(p, { force: true });
    };
    await removeHeld(file);
    expect(await readdir(dir)).toEqual([]);
    expect(said.length).toBe(1);
    // One that isn't there is no error.
    delete fsHooks.remove;
    await removeHeld(file);
    await writeFile(file, "old\n");
    fsHooks.remove = async (p) => {
      throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${p}'`), {
        code: "EPERM",
      });
    };
    const e = await removeHeld(file).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(FileHeldError);
    expect((e as FileHeldError).path).toBe(file);
    expect(await readFile(file, "utf8")).toBe("old\n");
  });

  it("tells a file system's error (a held file, a full disk) from a bug", () => {
    expect(isFileSystemError(new FileHeldError("a", 1))).toBe(true);
    expect(
      isFileSystemError(
        Object.assign(new Error("EBUSY: busy, unlink 'a'"), { code: "EBUSY", syscall: "unlink" }),
      ),
    ).toBe(true);
    expect(
      isFileSystemError(Object.assign(new Error("ENOSPC"), { code: "ENOSPC", syscall: "write" })),
    ).toBe(true);
    expect(isFileSystemError(new TypeError("x is not a function"))).toBe(false);
    expect(isFileSystemError(new CancelledError())).toBe(false);
    expect(
      isFileSystemError(Object.assign(new Error("a module's"), { code: "ERR_MODULE_NOT_FOUND" })),
    ).toBe(false);
    expect(isFileSystemError("EPERM")).toBe(false);
  });

  it("sweeps the temporary files an earlier run left beside a file, old ones only, and nothing else", async () => {
    const long = new Date(Date.now() - 2 * 3_600_000);
    const stale = "forge-svc-01.rejected.jsonl.4242.0a1b2c3d.tmp";
    const fresh = "forge-svc-01.jsonl.4243.0a1b2c3e.tmp";
    const others = [
      "forge-svc-01.jsonl",
      "forge-svc-02.verify.yaml.1.0a1b2c3d.tmp",
      "forge-svc-01.notes.tmp",
    ];
    for (const n of [stale, fresh, ...others]) await writeFile(join(dir, n), "x");
    for (const n of [stale, ...others]) await utimes(join(dir, n), long, long);
    expect(await sweepStaleTmp(dir, "forge-svc-01.")).toEqual([stale]);
    expect((await readdir(dir)).sort()).toEqual([fresh, ...others].sort());
    // A folder that isn't there, or a removal that fails, is no error.
    expect(await sweepStaleTmp(join(dir, "none"), "x.")).toEqual([]);
  });

  it("a job's Stop, while its work may still be stopped, ends the wait a second in; once it is writing, the wait runs", async () => {
    const { withSignal, withCommit, commitCurrent } = await import("../src/index.js");
    failing(Infinity);
    const stop = new AbortController();
    stop.abort();
    const before = await withSignal(stop.signal, () =>
      writeFileAtomic(join(dir, "a.yaml"), "new\n").catch((x: unknown) => x),
    );
    expect(before).toBeInstanceOf(CancelledError);
    expect(waited).toBe(20 + 40 + 80 + 160 + 320 + 640);
    const during = await withSignal(stop.signal, () =>
      withCommit(
        () => undefined,
        async () => {
          commitCurrent();
          return writeFileAtomic(join(dir, "a.yaml"), "new\n").catch((x: unknown) => x);
        },
      ),
    );
    expect(during).toBeInstanceOf(FileHeldError);
    expect(await readdir(dir)).toEqual([]);
  });
});
