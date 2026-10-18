import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentDefinition } from "@maycombhq/core";
import {
  buildContextPack,
  HandoffRuntime,
  HeadlessClaudeCodeRuntime,
  pruneRuns,
  type AiRequest,
} from "../src/index.js";

const now = new Date("2026-10-18T06:00:00Z");

/** A repo adopted in place: the org pack in .atticus/, OpenSpec kept in .atticus/openspec. */
async function adoptedRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-handoff-layout-"));
  await mkdir(join(root, ".atticus/org-pack"), { recursive: true });
  await writeFile(
    join(root, ".atticus/org-pack/sources.yaml"),
    "schemaVersion: 1\nlayout:\n  openspec: .atticus/openspec\n  catalog: .atticus/catalog\n",
  );
  await mkdir(join(root, ".atticus/openspec/changes/add-note-tags"), { recursive: true });
  return root;
}

function request(): AiRequest {
  const agent = AgentDefinition.parse({
    schemaVersion: 1,
    id: "story-writer",
    role: "business-analyst",
    description: "Writes user stories.",
    inputs: ["proposal"],
    outputArtifact: "stories",
    checklist: "forge-architecture",
    tokenBudget: 2000,
    allowedRuntimes: ["hand-off", "headless-claude-code"],
  });
  const pack = buildContextPack({
    change: "add-note-tags",
    agent: "story-writer",
    budget: 2000,
    levels: ["public", "internal", "confidential", "restricted"],
    maxClassification: "confidential",
    now,
    sources: [
      {
        id: "instructions",
        kind: "instruction",
        origin: "org-pack/agents/story-writer.yaml",
        text: "Write stories.",
        classification: "internal",
        trusted: true,
      },
    ],
  });
  return { agent, change: "add-note-tags", outputPath: "stories.md", pack } as AiRequest;
}

/** The hand-off runtime asks for, and reads, the output where the layout keeps changes. */
describe("hand-off runtime on an adopted repo", () => {
  it("writes to .atticus/openspec/changes when the layout keeps OpenSpec there", async () => {
    const root = await adoptedRoot();
    const change = join(root, ".atticus/openspec/changes/add-note-tags");
    const rt = new HandoffRuntime({ root, validate: async () => [], now: () => now });
    const p = await rt.prepare(request());
    const prompt = await readFile(
      join(root, ".atticus/.runs/add-note-tags", p.runId, "prompt.md"),
      "utf8",
    );
    expect(prompt).toContain(
      "Write the result to .atticus/openspec/changes/add-note-tags/stories.md",
    );
    await rt.run(p.runId);
    await writeFile(join(change, "stories.md"), "# Stories\n");
    expect((await rt.done(p.runId)).state).toBe("validated");
  });

  it("keeps run folders in .atticus/.runs, finds them again and prunes them there", async () => {
    const root = await adoptedRoot();
    let clock = now.getTime();
    const rt = new HandoffRuntime({ root, validate: async () => [], now: () => new Date(clock) });
    const old = await rt.prepare(request());
    await rt.run(old.runId);
    clock += 40 * 86_400_000;
    const fresh = await rt.prepare(request());
    // A new process finds the run on disk.
    const again = new HandoffRuntime({ root, validate: async () => [] });
    expect((await again.result(old.runId)).state).toBe("waiting");
    const removed = await pruneRuns(root, 30, new Date(clock));
    expect(removed).toEqual([`add-note-tags/${old.runId}`]);
    expect(existsSync(join(root, ".atticus/.runs/add-note-tags", old.runId))).toBe(false);
    expect(existsSync(join(root, ".atticus/.runs/add-note-tags", fresh.runId))).toBe(true);
    // Nothing is written at the repo root.
    expect(existsSync(join(root, ".runs"))).toBe(false);
  });

  it("writes headless Claude Code's prompt file under .atticus/.runs", async () => {
    const root = await adoptedRoot();
    const seen: string[] = [];
    const rt = new HeadlessClaudeCodeRuntime({
      root,
      now: () => now,
      runner: async (i) => {
        seen.push(i.promptFile);
        return {
          exitCode: 0,
          stdout: JSON.stringify({ type: "result", result: "ok", is_error: false }),
          stderr: "",
        };
      },
    });
    const p = await rt.prepare(request());
    expect((await rt.run(p.runId)).state).toBe("validated");
    expect(seen).toEqual([join(root, ".atticus/.runs/add-note-tags", p.runId, "prompt.md")]);
    expect(existsSync(seen[0]!)).toBe(true);
    expect(existsSync(join(root, ".runs"))).toBe(false);
  });
});
