import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants as osConstants, tmpdir } from "node:os";
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
const runLog = JSON.stringify(pathToFileURL(join(HERE, "../dist/run-log.js")).href);

const made: string[] = [];
afterEach(async () => {
  for (const d of made.splice(0)) await rm(d, { recursive: true, force: true });
});

/** Ended, not yet reaped (a container's init may reap late): gone, as far as these tests go. */
const zombie = (pid: number) => {
  try {
    return /^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return !zombie(pid);
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

/**
 * A node that starts a tracked `sleep` in its own group, writes its pid, then does `then`;
 * `before` runs first (a library loaded, process.kill patched).
 */
async function parent(then: string, before = "", sh = "sleep 600 & wait") {
  const dir = await mkdtemp(join(tmpdir(), "atticus-trees-"));
  made.push(dir);
  const script = join(dir, "parent.mjs");
  const pidFile = join(dir, "pid");
  const tree =
    process.platform === "win32"
      ? `spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore" })`
      : `spawn("sh", ["-c", ${JSON.stringify(sh)}], { detached: true, stdio: "ignore" })`;
  await writeFile(
    script,
    `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
${before}
const { trackTree, onAtticusSignal, processTreeHooks } = await import(${mod});
const child = ${tree};
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
  return { pid, ended, dir };
}

/** A node running `body` with the built module's exports and `spawn`; how it ended. */
async function node(body: string) {
  const dir = await mkdtemp(join(tmpdir(), "atticus-trees-"));
  made.push(dir);
  const script = join(dir, "node.mjs");
  await writeFile(
    script,
    `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const { startTree, trackTree } = await import(${mod});
const pidFile = ${JSON.stringify(join(dir, "pid"))};
${body}
setTimeout(() => {}, 60_000);
`,
  );
  const p = spawn(process.execPath, [script], { stdio: "ignore" });
  const how = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) =>
    p.on("exit", (code, signal) => r({ code, signal })),
  );
  const pid = Number(await readFile(join(dir, "pid"), "utf8").catch(() => "0"));
  return { pid, how };
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

  /**
   * Beta.28.3 (the closed-terminal test CI had to run again): a child was kept only after it had
   * started, so a terminal closed in between ended Atticus by the signal's default, and the
   * child, in its own group, ran on. Here the signal comes at exactly that moment, every time.
   */
  it.runIf(posix)(
    "a terminal closed as a tree starts, before it is kept, still stops it",
    async () => {
      const { pid, how } = await node(
        `const { child, untrack } = startTree(() => {
  const c = spawn("sh", ["-c", "sleep 600 & wait"], { detached: true, stdio: "ignore" });
  writeFileSync(pidFile, String(c.pid));
  process.kill(process.pid, "SIGHUP");
  return c;
});
child.on("exit", untrack);`,
      );
      expect(pid).toBeGreaterThan(0);
      expect(how.signal).toBe("SIGHUP");
      await until(() => !alive(pid));
      expect(alive(pid)).toBe(false);
    },
    60_000,
  );

  it.runIf(posix)(
    "a tree started after the signal is stopped at once, and Atticus ends without waiting out the grace",
    async () => {
      const began = Date.now();
      const { pid, how } = await node(
        `const first = spawn("sh", ["-c", "sleep 600 & wait"], { detached: true, stdio: "ignore" });
first.on("exit", trackTree(first));
setTimeout(() => {
  process.emit("SIGHUP", "SIGHUP");
  const late = spawn("sh", ["-c", "sleep 600 & wait"], { detached: true, stdio: "ignore" });
  writeFileSync(pidFile, String(late.pid));
  late.on("exit", trackTree(late));
}, 300);`,
      );
      expect(pid).toBeGreaterThan(0);
      expect(how.signal).toBe("SIGHUP");
      expect(alive(pid)).toBe(false);
      expect(Date.now() - began).toBeLessThan(8_000);
    },
    60_000,
  );

  it.runIf(posix)(
    "a tree that ignores the stop is killed when the grace is over and Atticus ends by the signal",
    async () => {
      const { pid, ended } = await parent(
        `processTreeHooks.signalGraceMs = 400; process.kill(process.pid, "SIGHUP");`,
        "",
        "trap '' TERM; sleep 600 & wait",
      );
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
        `onAtticusSignal("SIGTERM", () => setTimeout(() => process.exit(3), 300), { once: true }); process.kill(process.pid, "SIGTERM");`,
      );
      const how = await ended;
      expect(how.code).toBe(3);
      await until(() => !alive(pid));
      expect(alive(pid)).toBe(false);
    },
    60_000,
  );
});

/**
 * Beta.27 re-review: signal-exit (which @inquirer/core loads, through OpenSpec) listens to every
 * signal and ends the process only when it alone listens; process-trees counted its listener as a
 * handler that ends Atticus, so neither did and Ctrl+C left Atticus running. Atticus's own
 * handlers are told by a registry (onAtticusSignal) now. With signal-exit itself when the
 * dependency tree has it, and a listener that behaves as it does either way.
 */
function signalExitModule(): string | undefined {
  const store = join(HERE, "../../../node_modules/.pnpm");
  try {
    for (const d of readdirSync(store)
      .filter((n) => n.startsWith("signal-exit@4"))
      .sort()) {
      const f = join(store, d, "node_modules/signal-exit/dist/mjs/index.js");
      if (existsSync(f)) return pathToFileURL(f).href;
    }
  } catch {
    // no store here
  }
  return undefined;
}
const SIGNAL_EXIT = signalExitModule();
/** Ends the process by the signal only when it alone listens, as signal-exit does. */
const FOREIGN = `for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) { const f = () => { if (process.listeners(s).length === 1) { process.off(s, f); process.kill(process.pid, s); } }; process.on(s, f); }`;
const libraries: [string, string][] = [
  ["a listener that behaves as signal-exit does", FOREIGN],
  ...(SIGNAL_EXIT
    ? [
        [
          "signal-exit itself",
          `const { onExit } = await import(${JSON.stringify(SIGNAL_EXIT)}); onExit(() => {});`,
        ] as [string, string],
      ]
    : []),
];

describe("a library listening for signals too (signal-exit)", () => {
  for (const [what, lib] of libraries) {
    it.runIf(posix)(
      `${what}: Ctrl+C still stops the tree and ends Atticus by the signal`,
      async () => {
        const { pid, ended } = await parent(`process.kill(process.pid, "SIGINT");`, lib);
        const how = await ended;
        expect(how.signal).toBe("SIGINT");
        await until(() => !alive(pid));
        expect(alive(pid)).toBe(false);
      },
      60_000,
    );

    it.runIf(posix)(
      `${what}: a terminal run's record (the run log's handler) ends it with 130`,
      async () => {
        const root = await mkdtemp(join(tmpdir(), "atticus-trees-root-"));
        made.push(root);
        await mkdir(join(root, "org-pack"));
        const { pid, ended } = await parent(
          `startTerminalRun(${JSON.stringify(root)}, { positionals: ["map", "forge-ledger"], flags: [], hookProcess: true }); process.kill(process.pid, "SIGINT");`,
          `${lib}\nconst { startTerminalRun } = await import(${runLog});`,
        );
        const how = await ended;
        expect(how.code).toBe(130);
        await until(() => !alive(pid));
        expect(alive(pid)).toBe(false);
      },
      60_000,
    );
  }

  it.runIf(posix)(
    "a terminal run's record waits for a task run holding the stop, then ends it with 130",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "atticus-trees-root-"));
      made.push(root);
      await mkdir(join(root, "org-pack"));
      const released = join(root, "released");
      const { ended } = await parent(
        `startTerminalRun(${JSON.stringify(root)}, { positionals: ["task", "run"], flags: [], hookProcess: true }); const release = holdStop(); process.kill(process.pid, "SIGINT"); setTimeout(() => { writeFileSync(${JSON.stringify(released)}, "1"); release(); }, 800);`,
        `${FOREIGN}\nconst { startTerminalRun } = await import(${runLog}); const { holdStop } = await import(${mod});`,
      );
      const how = await ended;
      expect(how.code).toBe(130);
      // It ended only once the run had let go of the stop.
      expect(existsSync(released)).toBe(true);
    },
    60_000,
  );

  it.runIf(posix && SIGNAL_EXIT !== undefined)(
    "signal-exit's own exit handler still runs when Atticus ends by the signal",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "atticus-trees-se-"));
      made.push(dir);
      const heard = join(dir, "heard");
      const { ended } = await parent(
        `process.kill(process.pid, "SIGTERM");`,
        `const { onExit } = await import(${JSON.stringify(SIGNAL_EXIT)}); onExit((c, s) => { writeFileSync(${JSON.stringify(heard)}, String(s)); });`,
      );
      const how = await ended;
      expect(how.signal).toBe("SIGTERM");
      expect(await readFile(heard, "utf8")).toBe("SIGTERM");
    },
    60_000,
  );
});

describe("a signal Windows can't send itself", () => {
  it("SIGHUP raised again throws (ENOSYS): Atticus ends with 128 + its number", async () => {
    const { ended } = await parent(
      `process.emit("SIGHUP", "SIGHUP");`,
      `const kill = process.kill.bind(process); process.kill = (p, s) => { if (p === process.pid && s === "SIGHUP") { const e = new Error("kill ENOSYS"); e.code = "ENOSYS"; throw e; } return kill(p, s); };`,
    );
    const how = await ended;
    expect(how.code).toBe(128 + osConstants.signals.SIGHUP);
  }, 60_000);
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
