import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Beta.27 re-review: a process Atticus starts in a group of its own (a build, a git a sync may
 * stop) no longer hears the terminal, so closing the terminal under `atticus ui` mid-sync left
 * git running outside the base clone's lock. Core keeps them (trackTree): a SIGINT, SIGTERM or
 * SIGHUP stops them and still ends Atticus, and what still runs when Atticus exits is killed.
 * Each case runs in a node of its own (the test's node would die with the signal), with the
 * built module.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const posix = process.platform !== "win32";
const mod = JSON.stringify(pathToFileURL(join(HERE, "../dist/process-trees.js")).href);

const made: string[] = [];
afterEach(async () => {
  for (const d of made.splice(0)) await rm(d, { recursive: true, force: true });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (ok: () => boolean | Promise<boolean>, ms = 15_000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
};

/** A node that starts a tracked `sleep` in its own group, writes its pid, then does `then`. */
async function parent(then: string) {
  const dir = await mkdtemp(join(tmpdir(), "atticus-trees-"));
  made.push(dir);
  const script = join(dir, "parent.mjs");
  const pidFile = join(dir, "pid");
  await writeFile(
    script,
    `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const { trackTree } = await import(${mod});
const child = spawn("sh", ["-c", "sleep 600 & wait"], { detached: true, stdio: "ignore" });
const untrack = trackTree(child);
child.on("exit", untrack);
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
setTimeout(() => { ${then} }, 300);
setTimeout(() => {}, 60_000);
`,
  );
  const p = spawn(process.execPath, [script], { stdio: "ignore" });
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) =>
    p.on("exit", (code, signal) => r({ code, signal })),
  );
  await until(() => existsSync(pidFile));
  const pid = Number(await readFile(pidFile, "utf8"));
  return { pid, ended };
}

describe("trees Atticus started, when Atticus stops", () => {
  it.runIf(posix)(
    "a closed terminal (SIGHUP) stops the tree and still ends Atticus by the signal",
    async () => {
      const { pid, ended } = await parent(`process.kill(process.pid, "SIGHUP");`);
      expect(alive(pid)).toBe(true);
      const how = await ended;
      expect(how.signal).toBe("SIGHUP");
      await until(() => !alive(pid));
      expect(alive(pid)).toBe(false);
    },
    60_000,
  );

  it.runIf(posix)(
    "Atticus exiting with the tree still running kills it",
    async () => {
      const { pid, ended } = await parent(`process.exit(0);`);
      const how = await ended;
      expect(how.code).toBe(0);
      await until(() => !alive(pid));
      expect(alive(pid)).toBe(false);
    },
    60_000,
  );

  it.runIf(posix)(
    "with a handler of its own (atticus ui), the signal is that handler's: the tree stops, Atticus decides",
    async () => {
      const { pid, ended } = await parent(
        `process.once("SIGTERM", () => setTimeout(() => process.exit(3), 300)); process.kill(process.pid, "SIGTERM");`,
      );
      const how = await ended;
      expect(how.code).toBe(3);
      await until(() => !alive(pid));
      expect(alive(pid)).toBe(false);
    },
    60_000,
  );
});

describe("processDescendants", () => {
  it.runIf(posix)("reads the tree without blocking, with when each started", async () => {
    const { processDescendants } = await import("../src/process-trees.js");
    const child = spawn("sh", ["-c", "sleep 30 & wait"], { stdio: "ignore" });
    try {
      let tree = new Map<number, string>();
      await until(async () => {
        tree = await processDescendants(child.pid!);
        return tree.size > 0;
      });
      expect(tree.size).toBeGreaterThan(0);
      for (const start of tree.values()) expect(start).not.toBe("");
    } finally {
      for (const p of (await processDescendants(child.pid!)).keys()) process.kill(p, "SIGKILL");
      process.kill(child.pid!, "SIGKILL");
    }
  });
});
