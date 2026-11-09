import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ManifestRepo, sharedLockFileOf } from "@maycombhq/core";
import { baseClonePath, createWorkspace, type GitRunner } from "../src/index.js";

/**
 * Review round 48: two syncs of one base clone at once (the app's Sync and a terminal's
 * `atticus workspace sync`, or two clicks) ran git in the same folder together: a second clone
 * into a folder half made, or two checkouts racing for index.lock. Git work on a base clone now
 * holds `<base clone>.lock` (withSharedFileLock, cross-process), so one waits for the other.
 */
describe("a base clone's git work", () => {
  it("holds the base clone's lock, so a second sync waits and then updates it", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-sync-lock-"));
    const repo = ManifestRepo.parse({
      id: "forge-ledger",
      url: "https://git.example.com/forge/forge-ledger.git",
      type: "service",
      owner: "team",
    });
    const dest = baseClonePath(root, repo.id);
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const seen: string[] = [];
    const git: GitRunner = async (args) => {
      seen.push(args[0]!);
      if (args[0] === "clone") {
        await mkdir(join(dest, ".git"), { recursive: true });
        await gate;
        await writeFile(join(dest, ".git", "HEAD"), "ref: refs/heads/main\n");
      }
      if (args[0] === "rev-parse")
        return { stdout: "0123456789abcdef0123456789abcdef01234567\n", stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const first = createWorkspace(root, git).sync([repo]);
    const second = createWorkspace(root, git).sync([repo]);
    await new Promise((r) => setTimeout(r, 200));
    // The first clone is still running: it holds the lock, and the second hasn't touched git.
    expect(existsSync(sharedLockFileOf(dest))).toBe(true);
    expect(seen.filter((c) => c === "clone")).toHaveLength(1);
    expect(seen.filter((c) => c === "fetch")).toHaveLength(0);
    open();
    const [a] = await first;
    const [b] = await second;
    // Whichever took the lock first cloned; the other saw the finished clone and brought it up
    // to date, never a second clone into it.
    expect([a!.action, b!.action].sort()).toEqual(["cloned", "updated"]);
    expect(seen.filter((c) => c === "clone")).toHaveLength(1);
    expect(existsSync(sharedLockFileOf(dest))).toBe(false);
  });

  // Review round 50: an app route waits for the base clone only briefly (lockWaitMs), and a
  // sync in another live process is never taken over for being old.
  it("gives up after a short wait for a sync another live process runs, running no git", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-sync-lock-"));
    const repo = ManifestRepo.parse({
      id: "forge-ledger",
      url: "https://git.example.com/forge/forge-ledger.git",
      type: "service",
      owner: "team",
    });
    const dest = baseClonePath(root, repo.id);
    await mkdir(join(dest, ".."), { recursive: true });
    // An hour-old lock of a live process on this machine (this test's parent): a long clone.
    await writeFile(
      sharedLockFileOf(dest),
      JSON.stringify({
        pid: process.ppid,
        host: hostname(),
        startedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
        what: "git work on the base clone of forge-ledger",
        token: "other",
      }),
    );
    const seen: string[] = [];
    const git: GitRunner = async (args) => {
      seen.push(args[0]!);
      return { stdout: "", stderr: "" };
    };
    const started = Date.now();
    await expect(createWorkspace(root, git, { lockWaitMs: 300 }).sync([repo])).rejects.toThrow(
      /base clone of forge-ledger/,
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(seen).toEqual([]);
    expect(existsSync(sharedLockFileOf(dest))).toBe(true);
  });
});
