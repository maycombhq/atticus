import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockGitHost } from "@maycombhq/adapters";
import { HandoffRuntime } from "@maycombhq/ai";
import { completeHandUpLens, handDown, handUp, handUpLensTask } from "../src/index.js";
import { CHANGE, git, NOW, speckitRoot, worktree } from "./helpers.js";

/**
 * A hand-up started in hand-off mode leaves the code-and-test lens waiting on the person's
 * assistant. When the assistant has written its answer and `atticus handoff done` validated
 * the run, the answer is parsed and written as the hand-up round, as a model run would be.
 */

const T = 120_000;
const TASKS = `# Tasks: Check the limit in the transfer transaction

## Phase 1: User Story 1 - Refuse transfers over the daily limit (P1)

- [x] T001 [US1] Refuse over-limit transfers in src/main/java/forge/ledger/LedgerEndpoints.java
- [ ] T002 [US1] Test the limit in src/test/java/forge/ledger/TransferLimitsTest.java
`;
const ANSWER = `findings:
  - rule: plan-tests-first
    artifact: tasks/1.2/evidence/tasks.md
    locator: { line: 5 }
    summary: The limit check comes before its test
    why: A behaviour change without an earlier test can ship untested.
    fix: Move T002 before T001.
    evidence:
      - { path: tasks/1.2/evidence/tasks.md, line: 5, quote: "T001 [US1] Refuse over-limit transfers" }
`;

describe("hand-up in hand-off mode", () => {
  it(
    "parses the lens answer and writes the hand-up round when the run is done",
    async () => {
      const { root } = await speckitRoot({ repos: ["forge-ledger"] });
      await handDown(root, CHANGE, "1.2", { git });
      await writeFile(join(worktree(root, "forge-ledger"), "specs/1.2/tasks.md"), TASKS);
      const host = new MockGitHost([{ repo: "forge-ledger" }]);
      const pr = await host.createPullRequest(
        {
          repo: "forge-ledger",
          head: "task/add-transfer-limit/1.2",
          base: "change/add-transfer-limit",
          title: "1.2",
          body: "",
        },
        { by: "dev", at: NOW, ref: "task 1.2" },
      );
      const runtime = new HandoffRuntime({ root, validate: async () => [] });
      const up = await handUp(root, CHANGE, "1.2", {
        by: "dev",
        now: NOW,
        gitHost: host,
        runtime,
        git,
      });
      expect(up.lens.state).toBe("waiting");
      const runId = up.lens.runId!;
      const waiting = await runtime.result(runId);
      expect(handUpLensTask(waiting.request.outputPath)).toBe("1.2");

      await writeFile(
        join(root, "openspec/changes", CHANGE, "tasks/1.2/review-code-and-test.yaml"),
        ANSWER,
      );
      const done = await runtime.done(runId);
      expect(done.state).toBe("validated");
      const r = await completeHandUpLens(root, done, { now: NOW });
      expect(r.lens).toMatchObject({ state: "ran", runId, agent: "code-and-test-critic" });
      expect(r.lens.discarded).toEqual([]);
      expect(r.review?.round).toBe(1);
      expect(r.review?.findings.map((f) => [f.finding.id, f.finding.rule])).toEqual([
        ["t1-2-plan-tests-first-tasks-l5", "plan-tests-first"],
      ]);
      expect(
        existsSync(join(root, "openspec/changes", CHANGE, "review/hand-up/1/meta/round.yaml")),
      ).toBe(true);
      expect(
        existsSync(join(root, "openspec/changes", CHANGE, `tasks/1.2/runs/${runId}.yaml`)),
      ).toBe(true);
      expect(pr.number).toBeGreaterThan(0);
    },
    T,
  );
});
