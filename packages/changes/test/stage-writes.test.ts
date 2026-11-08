import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CHANGE_POLICY, draftedPath, stageFiles, stagePathOf } from "../src/index.js";

/**
 * Sixth UX walk: the plan hand-off left out what the stories stage itself writes (the OpenSpec
 * specs, the proposal naming them, needs.yaml and needs.md, the task prompts). They stayed local
 * edits and main never got the specs. Each stage's built-in write list now names every file its
 * writer writes (writeStories, writeTargetFlows, writeFeature in @maycombhq/planner).
 */

const step = (name: string) => stagePathOf(DEFAULT_CHANGE_POLICY).find((s) => s.stage === name)!;

async function folder(files: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "stage-writes-"));
  for (const f of files) {
    await mkdir(dirname(join(dir, f)), { recursive: true });
    await writeFile(join(dir, f), "x\n");
  }
  return dir;
}

describe("the files a stage's hand-off carries", () => {
  it("are, for the stories stage, its specs, proposal, needs and task prompts too, not a task's runs", async () => {
    const dir = await folder([
      "stage/stories.yaml",
      "stage/stories-answer.yaml",
      "requests.md",
      "proposal.md",
      "needs.yaml",
      "needs.md",
      "specs/forge-ledger-core-answer-account-status/spec.md",
      "tasks/1.1.prompt.md",
      "tasks/2.1.prompt.md",
      "tasks/1.1/task-run.yaml",
      "tasks/1.1/report.md",
    ]);
    expect(await stageFiles(dir, step("stories"))).toEqual([
      "needs.md",
      "needs.yaml",
      "proposal.md",
      "requests.md",
      "specs/forge-ledger-core-answer-account-status/spec.md",
      "stage/stories-answer.yaml",
      "stage/stories.yaml",
      "tasks/1.1.prompt.md",
      "tasks/2.1.prompt.md",
    ]);
  });

  it("are, for the architecture stage, its deploy order and the flows it only reads", async () => {
    const dir = await folder([
      "stage/architecture.yaml",
      "stage/architecture-deploy.yaml",
      "stage/architecture-reads.yaml",
      "target-flows/ledger.post-transfer.yaml",
    ]);
    expect(await stageFiles(dir, step("architecture"))).toEqual([
      "stage/architecture-deploy.yaml",
      "stage/architecture-reads.yaml",
      "stage/architecture.yaml",
      "target-flows/ledger.post-transfer.yaml",
    ]);
  });

  it("are, for the feature stage, the proposal it writes from the brief", async () => {
    const dir = await folder(["stage/feature.yaml", "feature.yaml", "feature.md", "proposal.md"]);
    expect(await stageFiles(dir, step("feature"))).toEqual([
      "feature.md",
      "feature.yaml",
      "proposal.md",
      "stage/feature.yaml",
    ]);
  });

  it("count a task prompt as drafted by the stories stage, and a task's run not", () => {
    const s = step("stories");
    expect(draftedPath("tasks/1.1.prompt.md", s, [])).toBe(true);
    expect(draftedPath("specs/forge-ledger-core-answer-account-status/spec.md", s, [])).toBe(true);
    expect(draftedPath("tasks/1.1/task-run.yaml", s, [])).toBe(false);
  });
});
