import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { shellCommandRunner, tail } from "../src/commands.js";

/**
 * The runner of a repo's build command: a timeout stops what the shell started, not only the
 * shell; Ctrl+C on Atticus stops the build too; the log keeps the end of a long output. A real
 * shell, no network.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const posix = process.platform !== "win32";
const node = JSON.stringify(process.execPath);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (ok: () => boolean, ms = 8000) => {
  const t = Date.now();
  while (!ok() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 50));
};

describe("the build command runner", () => {
  it("keeps the end of a long output and says how much was left out", () => {
    const t = tail(10);
    t.add("0123456789");
    expect(t.text).toBe("0123456789");
    t.add("abcde");
    expect(t.text).toBe("[5 characters of output left out]\n56789abcde");
  });

  it("stops a command that runs past its time, its grandchild too", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-cmd-"));
    // The shell stays the parent (`; true`), so killing the shell alone would leave node running.
    const started = Date.now();
    const r = await shellCommandRunner()(
      `${node} -e "require('fs').writeFileSync('pid', String(process.pid)); setTimeout(() => {}, 20000)"; true`,
      dir,
      { timeoutMs: 700 },
    );
    expect(Date.now() - started).toBeLessThan(12_000);
    const pid = Number(await readFile(join(dir, "pid"), "utf8"));
    await until(() => !alive(pid));
    expect(alive(pid)).toBe(false);
    expect(r.exitCode === null || r.exitCode !== 0).toBe(true);
  }, 30_000);

  it.runIf(posix)(
    "stops the build when Atticus gets Ctrl+C, and Atticus still ends",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "atticus-cmd-"));
      const script = join(dir, "parent.mjs");
      // The built runner, in a node of its own (the test's own node would die with the signal).
      const runner = JSON.stringify(pathToFileURL(join(HERE, "../dist/commands.js")).href);
      await writeFile(
        script,
        `const { shellCommandRunner } = await import(${runner});
shellCommandRunner()(${JSON.stringify(`sleep 3; echo survived > ${join(dir, "f")}`)}, ${JSON.stringify(dir)});
setTimeout(() => process.kill(process.pid, "SIGINT"), 800);
`,
      );
      const p = spawn(process.execPath, [script], {
        cwd: join(HERE, ".."),
        stdio: "ignore",
      });
      const code = await new Promise<number | null>((r) =>
        p.on("exit", (c, sig) => r(sig ? -1 : c)),
      );
      expect(code).toBe(-1);
      await new Promise((r) => setTimeout(r, 3500));
      expect(existsSync(join(dir, "f"))).toBe(false);
    },
    30_000,
  );

  it.runIf(posix)(
    "stops the build and leaves Atticus to stop itself when it listens with once (atticus ui)",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "atticus-cmd-"));
      const script = join(dir, "parent.mjs");
      const runner = JSON.stringify(pathToFileURL(join(HERE, "../dist/commands.js")).href);
      // As atticus ui does: process.once, which Node removes before calling it.
      await writeFile(
        script,
        `process.once("SIGINT", () => setTimeout(() => { console.log("Stopped."); process.exit(0); }, 200));
const { shellCommandRunner } = await import(${runner});
shellCommandRunner()(${JSON.stringify(`sleep 3; echo survived > ${join(dir, "f")}`)}, ${JSON.stringify(dir)});
setTimeout(() => process.kill(process.pid, "SIGINT"), 800);
`,
      );
      const p = spawn(process.execPath, [script], { cwd: join(HERE, ".."), stdio: "pipe" });
      let out = "";
      p.stdout!.on("data", (d: Buffer) => (out += d.toString()));
      const code = await new Promise<number | null>((r) =>
        p.on("exit", (c, sig) => r(sig ? -1 : c)),
      );
      expect(code).toBe(0);
      expect(out).toContain("Stopped.");
      await new Promise((r) => setTimeout(r, 3500));
      expect(existsSync(join(dir, "f"))).toBe(false);
    },
    30_000,
  );

  it.runIf(posix)(
    "a build stopped by Ctrl+C says it was stopped, while Atticus stops itself (atticus ui)",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "atticus-cmd-"));
      const script = join(dir, "parent.mjs");
      const runner = JSON.stringify(pathToFileURL(join(HERE, "../dist/commands.js")).href);
      // As atticus ui does: a once listener that doesn't exit; what the build said is printed.
      await writeFile(
        script,
        `process.once("SIGINT", () => console.log("Stopped."));
const { shellCommandRunner, stopRequested } = await import(${runner});
const run = shellCommandRunner();
const r = await run("sleep 3", ${JSON.stringify(dir)});
console.log("first", JSON.stringify({ stopped: r.stopped === true, asked: stopRequested() }));
`,
      );
      const p = spawn(process.execPath, [script], { cwd: join(HERE, ".."), stdio: "pipe" });
      let out = "";
      p.stdout!.on("data", (d: Buffer) => (out += d.toString()));
      setTimeout(() => p.kill("SIGINT"), 800);
      const code = await new Promise<number | null>((r) =>
        p.on("exit", (c, sig) => r(sig ? -1 : c)),
      );
      expect(code).toBe(0);
      expect(out).toContain("Stopped.");
      expect(out).toContain('first {"stopped":true,"asked":true}');
    },
    30_000,
  );

  it.runIf(posix)(
    "ends Atticus by the signal when the listener that was there has gone (VS Code's stdin closed)",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "atticus-cmd-"));
      const script = join(dir, "parent.mjs");
      const runner = JSON.stringify(pathToFileURL(join(HERE, "../dist/commands.js")).href);
      await writeFile(
        script,
        `const stop = () => console.log("Stopped.");
process.once("SIGTERM", stop);
const { shellCommandRunner } = await import(${runner});
shellCommandRunner()("sleep 5", ${JSON.stringify(dir)});
setTimeout(() => process.off("SIGTERM", stop), 300);
setTimeout(() => process.kill(process.pid, "SIGTERM"), 800);
`,
      );
      const p = spawn(process.execPath, [script], { cwd: join(HERE, ".."), stdio: "ignore" });
      const code = await new Promise<number | null>((r) =>
        p.on("exit", (c, sig) => r(sig ? -1 : c)),
      );
      expect(code).toBe(-1);
    },
    30_000,
  );

  it("stopAllBuilds stops what runs and says so in its result", async () => {
    // Its own module copy would share state with the other tests: run it in a child instead.
    const dir = await mkdtemp(join(tmpdir(), "atticus-cmd-"));
    const script = join(dir, "parent.mjs");
    const runner = JSON.stringify(pathToFileURL(join(HERE, "../dist/commands.js")).href);
    await writeFile(
      script,
      `const { shellCommandRunner, stopAllBuilds } = await import(${runner});
const p = shellCommandRunner()(${JSON.stringify(`${process.execPath} -e "setTimeout(() => {}, 20000)"`)}, ${JSON.stringify(dir)});
setTimeout(stopAllBuilds, 500);
const r = await p;
console.log(JSON.stringify({ stopped: r.stopped === true, passed: r.exitCode === 0 }));
`,
    );
    const p = spawn(process.execPath, [script], { cwd: join(HERE, ".."), stdio: "pipe" });
    let out = "";
    p.stdout!.on("data", (d: Buffer) => (out += d.toString()));
    await new Promise((r) => p.on("exit", r));
    expect(out).toContain('{"stopped":true,"passed":false}');
  }, 30_000);

  it("gives a finished command's output and exit code", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-cmd-"));
    const r = await shellCommandRunner()(`${node} -e "console.log('built')"`, dir);
    expect(r).toMatchObject({ exitCode: 0 });
    expect(r.stdout.trim()).toBe("built");
  });
});
