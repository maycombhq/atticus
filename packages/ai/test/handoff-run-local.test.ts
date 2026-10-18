import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentDefinition } from "@maycombhq/core";
import { buildContextPack, HandoffRuntime, type AiRequest } from "../src/index.js";

const now = new Date("2026-10-18T06:00:00Z");

function request(o: Partial<AiRequest> = {}): AiRequest {
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
    change: "add-transfer-limit",
    agent: "story-writer",
    budget: 2000,
    levels: ["public", "internal", "confidential", "restricted"],
    maxClassification: "confidential",
    now,
    sources: [
      {
        id: "instructions",
        kind: "instruction",
        origin: "atticus",
        text: "Write the prose.",
        classification: "internal",
        trusted: true,
      },
    ],
  });
  return { agent, change: "add-transfer-limit", outputPath: "stories.md", pack, ...o };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "atticus-handoff-local-"));
  await mkdir(join(root, "openspec/changes/add-transfer-limit"), { recursive: true });
  return { root, rt: new HandoffRuntime({ root, validate: async () => [], now: () => now }) };
}

describe("a hand-off answer that lives in the run folder", () => {
  it("asks for the answer under .runs/<change>/<run>/, not in the change folder", async () => {
    const { root, rt } = await setup();
    const p = await rt.prepare(request({ outputPath: "answer.yaml", outputIn: "run" }));
    const dir = join(root, ".runs/add-transfer-limit", p.runId);
    const prompt = await readFile(join(dir, "prompt.md"), "utf8");
    expect(prompt).toContain(
      `Write the result to .runs/add-transfer-limit/${p.runId}/answer.yaml.`,
    );
    expect(prompt).not.toContain("openspec/changes/add-transfer-limit/answer.yaml");
    expect(prompt.trimEnd().endsWith(`atticus handoff done ${p.runId}`)).toBe(true);
  });

  it("reads it from there on done, and leaves the change folder alone", async () => {
    const { root, rt } = await setup();
    const p = await rt.prepare(request({ outputPath: "answer.yaml", outputIn: "run" }));
    await rt.run(p.runId);
    // Nothing written yet.
    expect(await rt.done(p.runId)).toMatchObject({
      state: "failed",
      errors: ["answer.yaml was not written"],
    });
    await rt.retry(p.runId);
    await rt.run(p.runId);
    // A file of that name in the change folder is not the answer.
    await writeFile(join(root, "openspec/changes/add-transfer-limit/answer.yaml"), "stories: []\n");
    expect((await rt.done(p.runId)).state).toBe("failed");
    await rt.retry(p.runId);
    await rt.run(p.runId);
    await writeFile(
      join(root, ".runs/add-transfer-limit", p.runId, "answer.yaml"),
      "stories: [a]\n",
    );
    const done = await rt.done(p.runId);
    expect(done).toMatchObject({ state: "validated", output: "stories: [a]\n" });
    await expect(
      stat(join(root, "openspec/changes/add-transfer-limit/stories.md")),
    ).rejects.toThrow();
  });

  it("can be claimed done again after a first try failed: fix the file, run `handoff done` again", async () => {
    const { root, rt } = await setup();
    const p = await rt.prepare(request({ outputPath: "answer.yaml", outputIn: "run" }));
    await rt.run(p.runId);
    expect((await rt.done(p.runId)).state).toBe("failed");
    // Still not written: the same answer again, not a crash.
    expect(await rt.done(p.runId)).toMatchObject({
      state: "failed",
      errors: ["answer.yaml was not written"],
    });
    await writeFile(
      join(root, ".runs/add-transfer-limit", p.runId, "answer.yaml"),
      "stories: [a]\n",
    );
    expect(await rt.done(p.runId)).toMatchObject({ state: "validated", attempt: 3, errors: [] });
  });

  it("the watcher finds it there too, and the validator is given that file", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-handoff-local-"));
    const seen: string[] = [];
    let clock = Date.now();
    const rt = new HandoffRuntime({
      root,
      validate: async (file) => {
        seen.push(file);
        return [];
      },
      now: () => new Date(clock),
      stableMs: 0,
    });
    const p = await rt.prepare(request({ outputPath: "answer.yaml", outputIn: "run" }));
    await rt.run(p.runId);
    const file = join(root, ".runs/add-transfer-limit", p.runId, "answer.yaml");
    await writeFile(file, "stories: []\n");
    clock += 60_000;
    expect((await rt.poll(p.runId)).state).toBe("validated");
    expect(seen).toEqual([file]);
  });

  it("keeps the old place for a request that doesn't ask for the run folder", async () => {
    const { root, rt } = await setup();
    const p = await rt.prepare(request());
    const prompt = await readFile(
      join(root, ".runs/add-transfer-limit", p.runId, "prompt.md"),
      "utf8",
    );
    expect(prompt).toContain("Write the result to openspec/changes/add-transfer-limit/stories.md");
  });

  it("uses .atticus/.runs on an adopted repo", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-handoff-local-"));
    await mkdir(join(root, ".atticus/org-pack"), { recursive: true });
    await writeFile(
      join(root, ".atticus/org-pack/sources.yaml"),
      "schemaVersion: 1\nlayout:\n  openspec: .atticus/openspec\n  catalog: .atticus/catalog\n",
    );
    const rt = new HandoffRuntime({ root, validate: async () => [], now: () => now });
    const p = await rt.prepare(request({ outputPath: "answer.yaml", outputIn: "run" }));
    const prompt = await readFile(
      join(root, ".atticus/.runs/add-transfer-limit", p.runId, "prompt.md"),
      "utf8",
    );
    expect(prompt).toContain(
      `Write the result to .atticus/.runs/add-transfer-limit/${p.runId}/answer.yaml.`,
    );
  });
});
