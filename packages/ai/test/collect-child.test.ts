import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { collectChild, type ChildLike } from "../src/factory.js";

/** A child process made of emitters: what the runner sees of `claude`. */
function fakeChild() {
  const out = Object.assign(new EventEmitter(), {
    setEncoding() {
      return this;
    },
  });
  const err = Object.assign(new EventEmitter(), {
    setEncoding() {
      return this;
    },
  });
  const proc = new EventEmitter();
  const child = Object.assign(proc, {
    stdin: Object.assign(new EventEmitter(), { end: () => undefined }),
    stdout: out,
    stderr: err,
    kill: () => undefined,
  }) as unknown as ChildLike & EventEmitter;
  return child;
}

describe("running Claude Code to its end (ADR 0119: no crash on a pipe error)", () => {
  it("collects what it printed and its exit code", async () => {
    const c = fakeChild();
    const done = collectChild(() => c, "the prompt", 60_000);
    c.stdout.emit("data", '{"result":"ok"}');
    c.stderr.emit("data", "a warning");
    c.emit("close", 0);
    expect(await done).toEqual({ exitCode: 0, stdout: '{"result":"ok"}', stderr: "a warning" });
  });

  it("fails the run, with the reason, when a stream fails (Windows ENOTCONN)", async () => {
    const c = fakeChild();
    const done = collectChild(() => c, "the prompt", 60_000);
    c.stdout.emit("error", Object.assign(new Error("read ENOTCONN"), { code: "ENOTCONN" }));
    await expect(done).rejects.toThrow("Claude Code couldn't be run: read ENOTCONN");
    // A close after the failure changes nothing: the run settled once.
    c.emit("close", 0);
  });

  it("says Claude Code isn't installed when it can't be found", async () => {
    const c = fakeChild();
    const done = collectChild(() => c, "the prompt", 60_000);
    c.emit("error", Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }));
    await expect(done).rejects.toThrow("not on PATH");
  });

  it("fails the run when the process can't even start", async () => {
    await expect(
      collectChild(
        () => {
          throw new Error("spawn EPERM");
        },
        "the prompt",
        60_000,
      ),
    ).rejects.toThrow("Claude Code couldn't be run: spawn EPERM");
  });
});
