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

  it("takes the output from the file the prompt names, not Claude Code's closing summary", async () => {
    // The prompt says "Write the result to <file>"; Claude Code does, then answers with a
    // summary of what it wrote. The file is the output (found on the first live run).
    const root = await adoptedRoot();
    const summary = "I wrote the draft to the file and changed no other files.";
    for (const outputIn of ["run", "change"] as const) {
      const rt = new HeadlessClaudeCodeRuntime({
        root,
        now: () => now,
        runner: async (i) => {
          const where = /Write the result to (\S+)\. Change no other files\./.exec(i.prompt)![1]!;
          await mkdir(join(root, where, ".."), { recursive: true });
          await writeFile(join(root, where), `# Stories (${outputIn})\n`);
          return {
            exitCode: 0,
            stdout: JSON.stringify({ type: "result", result: summary, is_error: false }),
            stderr: "",
          };
        },
      });
      const p = await rt.prepare({ ...request(), outputIn });
      const run = await rt.run(p.runId);
      expect(run.output).toBe(`# Stories (${outputIn})\n`);
    }
    // No file written: the answer itself is the output, as before.
    const plain = new HeadlessClaudeCodeRuntime({
      root,
      now: () => now,
      runner: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ type: "result", result: "inline answer", is_error: false }),
        stderr: "",
      }),
    });
    const q = await plain.prepare({ ...request(), outputPath: "notes.md" });
    expect((await plain.run(q.runId)).output).toBe("inline answer");
  });

  it("never reuses a run id another process made in the same second (the counter starts again in each)", async () => {
    const root = await adoptedRoot();
    // Two runtimes stand for two atticus processes, with the clock on the same second.
    const first = await new HandoffRuntime({
      root,
      validate: async () => [],
      now: () => now,
    }).prepare(request());
    const second = await new HandoffRuntime({
      root,
      validate: async () => [],
      now: () => now,
    }).prepare(request());
    expect(second.runId).not.toBe(first.runId);
    expect(existsSync(join(root, ".atticus/.runs/add-note-tags", first.runId, "prompt.md"))).toBe(
      true,
    );
    expect(existsSync(join(root, ".atticus/.runs/add-note-tags", second.runId, "prompt.md"))).toBe(
      true,
    );
  });
});
