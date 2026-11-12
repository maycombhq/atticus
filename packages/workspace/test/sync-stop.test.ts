import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ManifestRepo, sharedLockFileOf } from "@maycombhq/core";
import {
  baseClonePath,
  createGit,
  createWorkspace,
  GitStoppedError,
  type GitRunner,
} from "../src/index.js";

/**
 * Beta.27 review (blocker): Stop on a sync answered 200 and the sync ran on, as nothing passed
 * the job's signal to git. The signal now reaches each git it starts: a stop kills git (and what
 * it started), takes away a clone it half made, gives the base clone's lock back, and starts no
 * other repo. No network: git is a fake that never finishes.
 */

const repo = (id: string) =>
  ManifestRepo.parse({
    id,
    url: `https://git.example.com/forge/${id}.git`,
    type: "service",
    owner: "team",
  });

/** A git whose clone makes the folder, then waits for good (until it is stopped). */
function hangingGit(root: string) {
  const seen: string[] = [];
  let started!: () => void;
  const cloning = new Promise<void>((r) => (started = r));
  const git: GitRunner = async (args, _cwd, o) => {
    seen.push(args[0]!);
    if (args[0] === "clone") {
      const dest = args.at(-1)!;
      await mkdir(join(dest, ".git"), { recursive: true });
      await writeFile(join(dest, "half-written.txt"), "half");
      started();
      await new Promise<void>((_, reject) => {
        const stop = () => reject(new GitStoppedError(args));
        if (o?.signal?.aborted) stop();
        o?.signal?.addEventListener("abort", stop, { once: true });
      });
    }
    return { stdout: "", stderr: "" };
  };
  void root;
  return { git, seen, cloning };
}

describe("stopping a sync", () => {
  it("stops git, takes away the half-made clone, gives the lock back and syncs no other repo", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-sync-stop-"));
    const { git, seen, cloning } = hangingGit(root);
    const stop = new AbortController();
    const ws = createWorkspace(root, git, { signal: stop.signal });
    const done = ws.sync([repo("forge-ledger"), repo("forge-portal")]);
    await cloning;
    const dest = baseClonePath(root, "forge-ledger");
    expect(existsSync(join(dest, "half-written.txt"))).toBe(true);
    expect(existsSync(sharedLockFileOf(dest))).toBe(true);
    stop.abort();
    const results = await done;
    expect(results.map((r) => [r.id, r.action])).toEqual([
      ["forge-ledger", "stopped"],
      ["forge-portal", "stopped"],
    ]);
    expect(results[0]!.reason).toMatch(/stopped/i);
    expect(results[1]!.reason).toMatch(/not started/i);
    // The half-made clone is gone (the next sync clones it again), and so is the lock.
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(sharedLockFileOf(dest))).toBe(false);
    // Nothing was started for the second repo.
    expect(seen.filter((c) => c === "clone")).toHaveLength(1);
    expect(existsSync(baseClonePath(root, "forge-portal"))).toBe(false);
  });

  it("a stop before the sync starts runs no git", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-sync-stop-"));
    const { git, seen } = hangingGit(root);
    const stop = new AbortController();
    stop.abort();
    const results = await createWorkspace(root, git, { signal: stop.signal }).sync([
      repo("forge-ledger"),
    ]);
    expect(results.map((r) => r.action)).toEqual(["stopped"]);
    expect(seen).toEqual([]);
  });

  it("a stop while an existing base clone is fetched keeps the clone and clears git's index lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-sync-stop-"));
    const dest = baseClonePath(root, "forge-ledger");
    await mkdir(join(dest, ".git"), { recursive: true });
    const stop = new AbortController();
    let fetching!: () => void;
    const fetched = new Promise<void>((r) => (fetching = r));
    const git: GitRunner = async (args, _cwd, o) => {
      if (args[0] === "status") return { stdout: "", stderr: "" };
      if (args[0] === "fetch") {
        // Killed half-way, as git can leave it.
        await writeFile(join(dest, ".git", "index.lock"), "");
        fetching();
        await new Promise<void>((_, reject) =>
          o?.signal?.addEventListener("abort", () => reject(new GitStoppedError(args)), {
            once: true,
          }),
        );
      }
      return { stdout: "0123456789abcdef0123456789abcdef01234567\n", stderr: "" };
    };
    const done = createWorkspace(root, git, { signal: stop.signal }).sync([repo("forge-ledger")]);
    await fetched;
    stop.abort();
    const [r] = await done;
    expect(r!.action).toBe("stopped");
    expect(existsSync(join(dest, ".git"))).toBe(true);
    expect(existsSync(join(dest, ".git", "index.lock"))).toBe(false);
    expect(existsSync(sharedLockFileOf(dest))).toBe(false);
  });
});

describe("the git runner, stopped", () => {
  // A fake git on PATH that starts a child of its own and never finishes: the stop kills both.
  it.skipIf(process.platform === "win32")(
    "kills git and what it started, and says it was stopped",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "atticus-fake-git-"));
      const pids = join(dir, "pids");
      await writeFile(
        join(dir, "git"),
        `#!/bin/sh\nsleep 600 &\necho $$ $! > "${pids}"\nwait\n`,
        "utf8",
      );
      await chmod(join(dir, "git"), 0o755);
      const git = createGit({ env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` } });
      const stop = new AbortController();
      const run = git(["clone", "--", "https://git.example.com/forge/x.git", "x"], dir, {
        signal: stop.signal,
      });
      let seen = "";
      for (let i = 0; i < 200 && !seen.trim(); i++) {
        await new Promise((r) => setTimeout(r, 25));
        seen = await readFile(pids, "utf8").catch(() => "");
      }
      const [shell, child] = seen.trim().split(" ").map(Number);
      expect(shell).toBeGreaterThan(0);
      stop.abort();
      await expect(run).rejects.toBeInstanceOf(GitStoppedError);
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      for (let i = 0; i < 100 && (alive(shell!) || alive(child!)); i++)
        await new Promise((r) => setTimeout(r, 20));
      expect(alive(shell!)).toBe(false);
      expect(alive(child!)).toBe(false);
    },
  );

  it("a signal stopped already runs nothing", async () => {
    const stop = new AbortController();
    stop.abort();
    await expect(createGit()(["status"], tmpdir(), { signal: stop.signal })).rejects.toBeInstanceOf(
      GitStoppedError,
    );
  });
});
