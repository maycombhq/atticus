import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentDefinition, RunSummary } from "@maycombhq/core";
import {
  buildContextPack,
  CopilotAcpRuntime,
  HandoffRuntime,
  MockModelProvider,
  ModelRuntime,
  type AiRequest,
} from "../src/index.js";

/**
 * Review round 46 (storage): two commands (each with its own runtime, as the CLI makes one per
 * command) that start a run in the same second never get the same run id, so neither overwrites
 * the other's run folder; the folder is claimed when the id is given.
 */

const NOW = new Date("2026-11-08T10:00:00.400Z");

function request(prompt: string): AiRequest {
  const agent = AgentDefinition.parse({
    schemaVersion: 1,
    id: "story-writer",
    role: "business-analyst",
    description: "Writes user stories.",
    inputs: ["proposal"],
    outputArtifact: "stories",
    checklist: "forge-architecture",
    tokenBudget: 100000,
    allowedRuntimes: ["model", "hand-off"],
  });
  const pack = buildContextPack({
    change: "forge-add-refunds",
    agent: "story-writer",
    budget: 100000,
    levels: ["public", "internal", "confidential", "restricted"],
    maxClassification: "confidential",
    now: NOW,
    sources: [
      {
        id: "instructions",
        kind: "instruction",
        origin: "org-pack/agents/story-writer.yaml",
        text: prompt,
        classification: "internal",
        trusted: true,
      },
    ],
  });
  return { agent, change: "forge-add-refunds", outputPath: "stories.md", pack } as AiRequest;
}

const RUN_ID = /^run-[0-9a-z-]+$/;

describe("model-mode run ids across processes", () => {
  it("gives two runtimes on one clock two ids, each run in its own folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-runid-"));
    const now = () => NOW;
    const a = new ModelRuntime(new MockModelProvider("m", () => "answer A"), { root, now });
    const b = new ModelRuntime(new MockModelProvider("m", () => "answer B"), { root, now });
    const ra = await a.prepare(request("prompt A"));
    const rb = await b.prepare(request("prompt B"));
    expect(ra.runId).not.toBe(rb.runId);
    // The clock is a test's: the ids stay deterministic.
    expect([ra.runId, rb.runId]).toEqual(["run-20261108100000-0001", "run-20261108100000-0002"]);
    await a.run(ra.runId);
    await b.run(rb.runId);
    const dir = join(root, ".runs", "forge-add-refunds");
    expect((await readdir(dir)).sort()).toEqual([ra.runId, rb.runId]);
    expect(await readFile(join(dir, ra.runId, "prompt.md"), "utf8")).toContain("prompt A");
    expect(await readFile(join(dir, rb.runId, "prompt.md"), "utf8")).toContain("prompt B");
  });

  it("ends an id with a random tail on the real clock, in the form a run record takes", async () => {
    const a = new ModelRuntime(new MockModelProvider("m", () => "x"));
    const b = new ModelRuntime(new MockModelProvider("m", () => "x"));
    const ra = await a.prepare(request("p"));
    const rb = await b.prepare(request("p"));
    expect(ra.runId).not.toBe(rb.runId);
    for (const id of [ra.runId, rb.runId]) {
      expect(id).toMatch(RUN_ID);
      expect(id).not.toMatch(/-0001$/);
    }
    expect(RunSummary.shape.runId.safeParse(ra.runId).success).toBe(true);
  });
});

describe("hand-off run ids", () => {
  it("claims the run folder, so two runtimes preparing at once never share one", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-runid-handoff-"));
    const now = () => NOW;
    const make = () => new HandoffRuntime({ root, now, validate: async () => [] });
    const runs = await Promise.all([make(), make(), make()].map((r) => r.prepare(request("p"))));
    expect(new Set(runs.map((r) => r.runId)).size).toBe(3);
    expect((await readdir(join(root, ".runs", "forge-add-refunds"))).sort()).toEqual(
      runs.map((r) => r.runId).sort(),
    );
  });
});

describe("copilot-acp run ids (review round 48)", () => {
  it("claims the run folder, so two runtimes on one clock never share one", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-runid-acp-"));
    const now = () => NOW;
    const make = () => new CopilotAcpRuntime({ root, command: "copilot", now });
    const runs = await Promise.all([make(), make()].map((r) => r.prepare(request("p"))));
    expect(new Set(runs.map((r) => r.runId)).size).toBe(2);
    expect((await readdir(join(root, ".runs", "forge-add-refunds"))).sort()).toEqual(
      runs.map((r) => r.runId).sort(),
    );
  });
});
