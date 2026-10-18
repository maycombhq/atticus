import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentDefinition } from "@maycombhq/core";
import { buildContextPack, HandoffRuntime, type AiRequest } from "../src/index.js";

/** The hand-off runtime asks for, and reads, the output where the layout keeps changes. */
describe("hand-off runtime on an adopted repo", () => {
  it("writes to .atticus/openspec/changes when the layout keeps OpenSpec there", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-handoff-layout-"));
    await mkdir(join(root, ".atticus/org-pack"), { recursive: true });
    await writeFile(
      join(root, ".atticus/org-pack/sources.yaml"),
      "schemaVersion: 1\nlayout:\n  openspec: .atticus/openspec\n  catalog: .atticus/catalog\n",
    );
    const change = join(root, ".atticus/openspec/changes/add-note-tags");
    await mkdir(change, { recursive: true });
    const now = new Date("2026-10-18T06:00:00Z");
    const agent = AgentDefinition.parse({
      schemaVersion: 1,
      id: "story-writer",
      role: "business-analyst",
      description: "Writes user stories.",
      inputs: ["proposal"],
      outputArtifact: "stories",
      checklist: "forge-architecture",
      tokenBudget: 2000,
      allowedRuntimes: ["hand-off"],
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
    const request: AiRequest = {
      agent,
      change: "add-note-tags",
      outputPath: "stories.md",
      pack,
    } as AiRequest;
    const rt = new HandoffRuntime({ root, validate: async () => [], now: () => now });
    const p = await rt.prepare(request);
    const prompt = await readFile(join(root, ".runs/add-note-tags", p.runId, "prompt.md"), "utf8");
    expect(prompt).toContain(
      "Write the result to .atticus/openspec/changes/add-note-tags/stories.md",
    );
    await rt.run(p.runId);
    await writeFile(join(change, "stories.md"), "# Stories\n");
    expect((await rt.done(p.runId)).state).toBe("validated");
  });
});
