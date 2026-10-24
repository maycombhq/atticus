import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HeadlessClaudeCodeRuntime, type HeadlessInvocation } from "@maycombhq/ai";
import { runCritic } from "../src/index.js";
import { CHANGE, NOW, forgeChangeRoot } from "./helpers.js";

/**
 * The critic's lenses on headless Claude Code (the stage loop fails closed, so a lens that may
 * not run there would stop every headless stage). Each lens runs in its own run folder: the
 * only file it can write is its findings, never the draft it reviews.
 */
describe("the critic's lenses on headless Claude Code", () => {
  it("runs every lens, each in its run folder, and reads the findings it wrote there", async () => {
    const root = await forgeChangeRoot();
    // The built-in lens agents, as a metarepo whose org pack names none has (the fixture's own
    // critics are its choice of runtimes).
    const agents = join(root, "org-pack/agents");
    for (const f of await readdir(agents))
      if (f.endsWith("-critic.yaml")) await rm(join(agents, f));
    const seen: HeadlessInvocation[] = [];
    const runtime = new HeadlessClaudeCodeRuntime({
      root,
      now: () => new Date(NOW),
      runner: async (i) => {
        seen.push(i);
        const file = /Write the result to (findings-[a-z-]+\.yaml)\./.exec(i.prompt)![1]!;
        await writeFile(join(i.cwd, file), "findings: []\n", "utf8");
        return {
          exitCode: 0,
          stdout: JSON.stringify({ result: `Wrote ${file}`, is_error: false }),
          stderr: "",
        };
      },
      invocation: () => ({ cwd: root }),
    });
    const r = await runCritic(root, CHANGE, { now: NOW, runtime });
    const ran = r.lenses.filter((l) => l.state !== "skipped");
    expect(ran.length).toBeGreaterThan(0);
    expect(ran.map((l) => [l.lens, l.state, l.reason])).toEqual(
      ran.map((l) => [l.lens, "ran", undefined]),
    );
    expect(seen).toHaveLength(ran.length);
    for (const i of seen) {
      expect(i.cwd.startsWith(join(root, ".runs", CHANGE))).toBe(true);
      expect(await readFile(i.promptFile, "utf8")).not.toContain("atticus handoff done");
    }
  });
});
