import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { MockGitHost } from "@maycombhq/adapters";
import { HandoffRuntime, MockRuntime, type AiRequest } from "@maycombhq/ai";
import { handDown, handUp } from "../src/index.js";
import { CHANGE, git, NOW, speckitRoot, worktree } from "./helpers.js";

const T = 120_000;
const TASKS = `# Tasks: Check the limit in the transfer transaction

## Phase 1: User Story 1 - Refuse transfers over the daily limit (P1)

- [x] T001 [US1] Refuse over-limit transfers in src/main/java/forge/ledger/LedgerEndpoints.java
- [ ] T002 [US1] Test the limit in src/test/java/forge/ledger/TransferLimitsTest.java
`;

const TEST_FILE = `package forge.ledger;

class TransferLimitsTest {
  @Test void refusesOverTheLimit() {}
}
`;

const LENS_ANSWER = `findings:
  - rule: plan-tests-first
    artifact: tasks/1.2/evidence/tasks.md
    locator: { line: 5 }
    summary: The limit check comes before its test
    why: A behaviour change without an earlier test can ship untested.
    fix: Move T002 before T001.
    evidence:
      - { path: tasks/1.2/evidence/tasks.md, line: 5, quote: "T001 [US1] Refuse over-limit transfers" }
  - rule: no-such-rule
    artifact: tasks/1.2/evidence/plan.md
    summary: Made up
    why: Made up.
    evidence:
      - { path: tasks/1.2/evidence/plan.md, line: 1, quote: "Implementation Plan" }
`;

async function ready() {
  const { root } = await speckitRoot({ repos: ["forge-ledger"] });
  await handDown(root, CHANGE, "1.2", { git });
  await writeFile(join(worktree(root, "forge-ledger"), "specs/1.2/tasks.md"), TASKS);
  // The developer's test, committed on the change branch: hand-up attaches it for the lens.
  const wt = worktree(root, "forge-ledger");
  await mkdir(join(wt, "src/test/java/forge/ledger"), { recursive: true });
  await writeFile(join(wt, "src/test/java/forge/ledger/TransferLimitsTest.java"), TEST_FILE);
  await git(["add", "src/test/java/forge/ledger/TransferLimitsTest.java"], wt);
  await git(["commit", "-q", "-m", "Test the limit"], wt);
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
  return { root, host, pr };
}

describe("hand-up", () => {
  it(
    "marks the task done, attaches plan.md and tasks.md, runs the complete lens and the drift check",
    async () => {
      const { root, host, pr } = await ready();
      const seen: AiRequest[] = [];
      const runtime = new MockRuntime((req) => {
        seen.push(req);
        return LENS_ANSWER;
      });
      const r = await handUp(root, CHANGE, "1.2", {
        by: "dev",
        now: NOW,
        gitHost: host,
        runtime,
        git,
      });
      expect(r.pr).toEqual({
        number: pr.number,
        url: pr.url,
        state: "open",
        head: "task/add-transfer-limit/1.2",
      });
      expect(r.markedDone).toBe(true);
      const tasks = await readFile(join(root, "openspec/changes", CHANGE, "tasks.md"), "utf8");
      expect(tasks).toContain(
        "- [x] 1.2 Check the limit in the transfer transaction, with tests (story s1-refuse-over-limit)",
      );
      expect(tasks).toContain("- [ ] 1.1 Add V3__add_daily_limit.sql");
      expect(r.evidence).toEqual([
        "tasks/1.2/evidence/plan.md",
        "tasks/1.2/evidence/tasks.md",
        "tasks/1.2/evidence/spec.md",
        "tasks/1.2/evidence/tests/src__test__java__forge__ledger__TransferLimitsTest.java",
      ]);
      expect(
        await readFile(
          join(root, "openspec/changes", CHANGE, "tasks/1.2/evidence/tasks.md"),
          "utf8",
        ),
      ).toBe(TASKS);
      const source = parse(
        await readFile(
          join(root, "openspec/changes", CHANGE, "tasks/1.2/evidence/source.yaml"),
          "utf8",
        ),
      );
      expect(source).toMatchObject({
        repo: "forge-ledger",
        branch: "task/add-transfer-limit/1.2",
        by: "dev",
        pr: { number: pr.number },
        tests: ["tasks/1.2/evidence/tests/src__test__java__forge__ledger__TransferLimitsTest.java"],
      });

      // The complete question's lens (the product owner's decision of 2026-10-24) saw the
      // evidence as data, with the rules of the org and the owning team that review a task's
      // code and tests: those written for the old code-and-test lens, and complete rules that read
      // code or tests. The team's other complete rules read the brief, specs and stories.
      expect(r.lens).toMatchObject({ state: "ran", agent: "complete-critic" });
      expect(r.lens.rules.sort()).toEqual(["plan-tests-first", "tests-cover-scenarios"]);
      expect(seen[0]!.agent.id).toBe("complete-critic");
      expect(seen[0]!.outputPath).toBe("tasks/1.2/review-complete.yaml");
      expect(seen[0]!.pack.prompt).toContain(
        "# Critic: the complete lens (Is it complete?), at hand-up",
      );
      expect(seen[0]!.pack.prompt).not.toContain("code-and-test");
      expect(seen[0]!.pack.prompt).toContain('<atticus-data id="tasks/1.2/evidence/tasks.md"');
      expect(seen[0]!.pack.prompt).toContain("refusesOverTheLimit");
      expect(r.lens.discarded.map((d) => d.reason)).toEqual([
        "it names rule no-such-rule, which this lens wasn't asked to apply",
      ]);
      expect(r.review?.round).toBe(1);
      expect(
        r.review?.findings.map((f) => [
          f.finding.id,
          f.finding.gate,
          f.finding.rule,
          f.finding.severity,
        ]),
      ).toEqual([["t1-2-plan-tests-first-tasks-l5", "hand-up", "plan-tests-first", "risk"]]);
      expect(
        existsSync(join(root, "openspec/changes", CHANGE, `tasks/1.2/runs/${r.lens.runId}.yaml`)),
      ).toBe(true);
      expect(r.drift.found).toEqual([]);
    },
    T,
  );

  it(
    "refuses before the PR is raised, and takes a PR a person recorded when no Git host is connected",
    async () => {
      const { root } = await ready();
      await expect(
        handUp(root, CHANGE, "1.2", {
          by: "dev",
          now: NOW,
          gitHost: new MockGitHost([{ repo: "forge-ledger" }]),
        }),
      ).rejects.toThrow(/The pull request for task 1.2 isn't raised yet/);
      const r = await handUp(root, CHANGE, "1.2", {
        by: "dev",
        now: NOW,
        pr: { number: 7, url: "https://git.example.com/forge/forge-ledger/pull/7" },
        git,
      });
      expect(r.pr.number).toBe(7);
      expect(r.lens).toMatchObject({
        state: "skipped",
        reason: "no AI runtime was given; review plan.md and tasks.md by hand",
      });
    },
    T,
  );

  it(
    "takes a complete rule written for the question that reads tests, and an org pack's old code-and-test agent",
    async () => {
      const { root, host } = await ready();
      // No complete-critic in this org pack: the hand-up's lens is made of the old
      // code-and-test-critic it still defines, as the gate lenses are (ADR 0124 addendum, Part 4).
      await rm(join(root, "org-pack/agents/complete-critic.yaml"));
      await writeFile(
        join(root, "org-pack/checklists/tests.yaml"),
        stringify({
          schemaVersion: 1,
          name: "tests",
          version: "1.0.0",
          rules: [
            {
              id: "error-paths-tested",
              title: "Each error path has a test",
              layer: "org",
              lens: "complete",
              appliesTo: { artifacts: ["tests", "specs"] },
              severity: "risk",
              check: {
                type: "ai",
                prompt: "For each error scenario, find its test; report one with none, quoting it.",
              },
              waivable: false,
              source: "test",
            },
          ],
        }),
      );
      const seen: AiRequest[] = [];
      const runtime = new MockRuntime((req) => {
        seen.push(req);
        return "findings: []\n";
      });
      const r = await handUp(root, CHANGE, "1.2", {
        by: "dev",
        now: NOW,
        gitHost: host,
        runtime,
        git,
      });
      expect(r.lens.state).toBe("ran");
      expect(r.lens.rules.sort()).toEqual([
        "error-paths-tested",
        "plan-tests-first",
        "tests-cover-scenarios",
      ]);
      expect(r.lens.agent).toBe("complete-critic");
      expect(seen[0]!.agent.description).toMatch(
        /Made from the org pack's code-and-test-critic\.$/,
      );
      expect(seen[0]!.agent.allowedRuntimes).toEqual(["hand-off", "mock", "replay"]);
    },
    T,
  );

  it(
    "hands the lens to the person's assistant in hand-off mode and waits",
    async () => {
      const { root, host } = await ready();
      const runtime = new HandoffRuntime({ root, validate: async () => [] });
      const r = await handUp(root, CHANGE, "1.2", {
        by: "dev",
        now: NOW,
        gitHost: host,
        runtime,
        git,
      });
      expect(r.lens.state).toBe("waiting");
      expect(r.lens.reason).toMatch(
        /^handed to your assistant; finish with atticus handoff done run-/,
      );
      expect(existsSync(join(root, ".runs", CHANGE, r.lens.runId!, "prompt.md"))).toBe(true);
    },
    T,
  );
});
