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

  it("gives a finished command's output and exit code", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-cmd-"));
    const r = await shellCommandRunner()(`${node} -e "console.log('built')"`, dir);
    expect(r).toMatchObject({ exitCode: 0 });
    expect(r.stdout.trim()).toBe("built");
  });
});
