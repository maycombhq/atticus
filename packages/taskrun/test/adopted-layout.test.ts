import { existsSync } from "node:fs";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { completeTaskHandoff, runTask } from "../src/index.js";
import { CHANGE, git, speckitRoot } from "./helpers.js";

const T = 120_000;
const NOW = new Date("2026-10-21T09:00:00Z");
const now = () => NOW;
const FILE = "src/main/java/forge/ledger/TransferLimits.java";
const ok = async () => ({ exitCode: 0, stdout: "BUILD OK", stderr: "" });

describe("Run with AI in a repo adopted in place", () => {
  it(
    "keeps the hand-off prompt and the build log under .atticus/.runs, not .runs at the root",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      // Adopted: the org pack lives in .atticus/org-pack and local state in .atticus/.
      await cp(join(root, "org-pack"), join(root, ".atticus/org-pack"), { recursive: true });
      await rm(join(root, "org-pack"), { recursive: true });

      const w = await runTask(root, CHANGE, "1.2", {
        level: "draft",
        mode: "hand-off",
        by: "dev",
        git,
        now,
        commands: ok,
      });
      expect(w.state).toBe("waiting");
      const runId = w.waiting!;
      const prompt = join(root, ".atticus/.runs", CHANGE, runId, "prompt.md");
      expect(await readFile(prompt, "utf8")).toContain(`atticus handoff done ${runId}`);

      await writeFile(join(root, w.worktree, FILE), "class TransferLimits { boolean ok; }\n");
      await writeFile(
        join(root, "openspec/changes", CHANGE, "tasks/1.2/report.md"),
        "Added TransferLimits.\n",
      );
      const done = await completeTaskHandoff(root, runId, { git, now, commands: ok });
      expect(done.state).toBe("built");
      expect(done.attempts[0]!.log).toBe(`.atticus/.runs/${CHANGE}/${runId}/build-1.log`);
      expect(existsSync(join(root, done.attempts[0]!.log))).toBe(true);
      expect(existsSync(join(root, ".runs"))).toBe(false);
    },
    T,
  );
});
