import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import { runTask } from "../src/index.js";
import { CHANGE, git, speckitRoot } from "./helpers.js";

/**
 * Eighth UX walk: the stories stage writes a story's build line from the manifest as it was
 * then ("repos.manifest.yaml names no build command for <repo>"). A person sets the command
 * afterwards (the app's Repos screen, API 2.74.0), and the task prompt still carried the old line.
 * The task runner reads the manifest now: the story reaches the AI with today's command.
 */

const NOW = new Date("2026-11-08T09:00:00Z");
const STALE =
  "repos.manifest.yaml names no build command for forge-ledger: use the repo's own build and tests.";

describe("the task prompt says the repo's build command as the manifest has it now", () => {
  it("replaces a story's stale build line with the manifest's command", async () => {
    const { root } = await speckitRoot({ repos: ["forge-ledger"] });
    const story = join(root, "openspec/changes", CHANGE, "stories/s1-refuse-over-limit.md");
    const text = await readFile(story, "utf8");
    expect(text).toContain("ledger (forge-ledger)\n");
    await writeFile(
      story,
      text.replace("ledger (forge-ledger)\n", `ledger (forge-ledger)\n\n${STALE}\n`),
    );
    const seen: AiRequest[] = [];
    await runTask(root, CHANGE, "1.2", {
      level: "plan",
      by: "dev",
      runtime: new MockRuntime(
        (r) => {
          seen.push(r);
          return "## Steps\n\n1. Add TransferLimits.\n";
        },
        { now: () => NOW },
      ),
      git,
      now: () => NOW,
      commands: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });
    const prompt = seen[0]!.pack.prompt;
    expect(prompt).toContain('<atticus-data id="stories/s1-refuse-over-limit.md"');
    expect(prompt).not.toContain("names no build command");
    expect(prompt).toContain("Build and test with `forge build && forge test`.");
  }, 120_000);
});
