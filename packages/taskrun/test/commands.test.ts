import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { shellCommandRunner, tail } from "../src/commands.js";

/**
 * The runner of a repo's build command: a timeout stops what the shell started, not only the
 * shell, and the log keeps the end of a long output, saying how much was left out. A real
 * shell, no network.
 */
describe("the build command runner", () => {
  it("keeps the end of a long output and says how much was left out", () => {
    const t = tail(10);
    t.add("0123456789");
    expect(t.text).toBe("0123456789");
    t.add("abcde");
    expect(t.text).toBe("[5 characters of output left out]\n56789abcde");
  });

  it("stops a command that runs past its time, child processes too", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-cmd-"));
    const node = JSON.stringify(process.execPath);
    // The shell starts node, which outlives a kill of the shell alone.
    const started = Date.now();
    const r = await shellCommandRunner()(
      `${node} -e "setTimeout(() => console.log('late'), 20000)"`,
      dir,
      { timeoutMs: 500 },
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.stdout).not.toContain("late");
    expect(r.exitCode === null || r.exitCode !== 0).toBe(true);
  }, 20_000);

  it("gives a finished command's output and exit code", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-cmd-"));
    const node = JSON.stringify(process.execPath);
    const r = await shellCommandRunner()(`${node} -e "console.log('built')"`, dir);
    expect(r).toMatchObject({ exitCode: 0 });
    expect(r.stdout.trim()).toBe("built");
  });
});
