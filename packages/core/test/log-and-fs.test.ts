import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acquireLock,
  createLog,
  ensureLocalIgnore,
  LockHeldError,
  logFileOf,
  readLock,
  redact,
  redactText,
  writeFileAtomic,
} from "../src/index.js";

const temp = () => mkdtemp(join(tmpdir(), "atticus-core-"));

describe("redaction", () => {
  it("masks credentials in URLs, bearer tokens, key=value secrets and opaque keys", () => {
    const o = { home: "/home/pat", user: "pat" };
    expect(redactText("proxy http://pat:s3cret@proxy.example.com:8080", o)).toBe(
      "proxy http://***@proxy.example.com:8080",
    );
    expect(redactText("Authorization: Bearer abcdefghijklmnop1234", o)).not.toMatch(/abcdefghij/);
    expect(redactText("token=xyz123 password: hunter22", o)).toBe("token=*** password: ***");
    expect(redactText("key AKIAIOSFODNN7EXAMPLEaB3dE5fG7hJ9kL1mN3", o)).toBe("key ***");
    // Ids and hashes stay readable.
    const sha = "a".repeat(64);
    expect(redactText(`change add-transfer-limit-for-northwind-pay-velocity ${sha}`, o)).toBe(
      `change add-transfer-limit-for-northwind-pay-velocity ${sha}`,
    );
    expect(redactText("at /home/pat/work/meta/file.ts and C:\\Users\\pat\\x", o)).toBe(
      "at ~/work/meta/file.ts and C:\\Users\\<user>\\x",
    );
  });

  it("masks every value under a secret-named key", () => {
    expect(redact({ token: "abc", nested: { apiKey: "k", name: "ok" } })).toEqual({
      token: "***",
      nested: { apiKey: "***", name: "ok" },
    });
  });
});

describe("the local log", () => {
  it("writes redacted JSON lines, keeps itself out of Git, rotates, and never throws", async () => {
    const root = await temp();
    const log = createLog(root, { level: "info", maxBytes: 400, keep: 2 });
    log.debug("ignored");
    log.info("command", { command: "scan", url: "https://u:p@host/x" });
    log.error("crash", new Error("boom"), { command: "critic" });
    const lines = (await readFile(logFileOf(root), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.event)).toEqual(["command", "crash"]);
    expect(lines[0].url).toBe("https://***@host/x");
    expect(lines[1].error.message).toBe("boom");
    expect(await readFile(join(root, ".atticus/.gitignore"), "utf8")).toMatch(/^logs\/$/m);
    for (let i = 0; i < 20; i++) log.info("filler", { i });
    const files = (await readdir(join(root, ".atticus/logs"))).sort();
    expect(files).toEqual(["atticus.log", "atticus.log.1", "atticus.log.2"]);
    // A log that can't be written is skipped, not an error.
    const blocked = await temp();
    await writeFile(join(blocked, ".atticus"), "a file where a folder should be");
    expect(() => createLog(blocked).info("x")).not.toThrow();
  });
});

describe("whole files and locks", () => {
  it("writes atomically, leaving no temporary file behind", async () => {
    const dir = await temp();
    const f = join(dir, "a/b/record.yaml");
    await writeFileAtomic(f, "one\n");
    await writeFileAtomic(f, "two\n");
    expect(await readFile(f, "utf8")).toBe("two\n");
    expect(await readdir(join(dir, "a/b"))).toEqual(["record.yaml"]);
  });

  it("lets one scan run at a time and reports one that was cut short", async () => {
    const root = await temp();
    const first = await acquireLock(root, "scan", "scan");
    await expect(acquireLock(root, "scan", "scan")).rejects.toBeInstanceOf(LockHeldError);
    await first.release();
    expect(await readLock(root, "scan")).toBeUndefined();
    // A lock left by a process that is gone.
    await ensureLocalIgnore(root);
    await writeFile(
      join(root, ".atticus/locks/scan.json"),
      JSON.stringify({
        pid: 999999999,
        host: (await import("node:os")).hostname(),
        startedAt: "2026-10-19T08:00:00Z",
        what: "scan",
      }),
    );
    expect((await readLock(root, "scan"))!.stale).toBe(true);
    const next = await acquireLock(root, "scan", "scan");
    expect(next.interrupted).toMatchObject({ startedAt: "2026-10-19T08:00:00Z" });
    await next.release();
  });
});
