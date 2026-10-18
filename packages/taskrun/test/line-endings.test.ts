import { describe, expect, it } from "vitest";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import { createGit } from "@maycombhq/workspace";
import { runTask } from "../src/index.js";
import { CHANGE, speckitRoot } from "./helpers.js";

/**
 * On Windows, Git's default `core.autocrlf=true` checks the task worktree out with CRLF line
 * endings, so the files the task runner reads from it (the handed-down Spec Kit feature) used
 * to reach the context pack with `\r\n` and give a different prompt hash than on Linux: a
 * replayed recording was not found and the run failed. The pack is the same whatever Git does
 * to line endings.
 */

const T = 120_000;
const NOW = new Date("2026-10-21T09:00:00Z");
const now = () => NOW;

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_TERMINAL_PROMPT: "0",
};

async function packOf(env: NodeJS.ProcessEnv) {
  const { root } = await speckitRoot({ repos: ["forge-ledger"] });
  const seen: AiRequest[] = [];
  const runtime = new MockRuntime(
    (r) => {
      seen.push(r);
      return "## Steps\n\n1. Add TransferLimits.\n";
    },
    { now },
  );
  await runTask(root, CHANGE, "1.2", {
    level: "plan",
    by: "dev",
    runtime,
    git: createGit({ env }),
    now,
  });
  return seen[0]!.pack;
}

describe("the task runner's context pack", () => {
  it(
    "is the same when Git checks files out with CRLF (Windows autocrlf) as when it does not",
    async () => {
      const lf = await packOf({
        ...ENV,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.autocrlf",
        GIT_CONFIG_VALUE_0: "false",
      });
      const crlf = await packOf({
        ...ENV,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.autocrlf",
        GIT_CONFIG_VALUE_0: "true",
      });
      // The spec files really are in the pack, and no carriage return is.
      expect(lf.manifest.sources.some((s) => s.id.startsWith("repo:specs/1.2/"))).toBe(true);
      expect(crlf.prompt).not.toContain("\r");
      expect(crlf.manifest.promptSha256).toBe(lf.manifest.promptSha256);
    },
    T,
  );
});
