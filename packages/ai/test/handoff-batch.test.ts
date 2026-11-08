import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentDefinition, RunSummary } from "@maycombhq/core";
import { buildContextPack, HandoffRuntime, toRunSummary, type AiRequest } from "../src/index.js";

/**
 * ADR 0185: several hand-off runs of one step asked in one prompt (the critic's lenses on a
 * stage's draft). Each part keeps its own run, prompt, pack and answer file; the batch's answer
 * has one `=== <part>` section per part, and Done checks each section on its own with the part's
 * own check, so a missing or bad section fails only its part.
 */

const LEVELS = ["public", "internal", "confidential", "restricted"];
const NOW = new Date("2026-11-08T09:00:00Z");
const CHANGE = "lock-a-card";

const critic = (id: string) =>
  AgentDefinition.parse({
    schemaVersion: 1,
    id,
    role: "architect",
    description: `The ${id} lens.`,
    inputs: ["proposal"],
    outputArtifact: "findings",
    checklist: "forge-architecture",
    tokenBudget: 4000,
    allowedRuntimes: ["hand-off", "model"],
  });

const lensRequest = (lens: string): AiRequest => ({
  change: CHANGE,
  agent: critic(`${lens}-critic`),
  pack: buildContextPack({
    change: CHANGE,
    agent: `${lens}-critic`,
    budget: 4000,
    levels: LEVELS,
    maxClassification: "confidential",
    now: NOW,
    sources: [
      {
        id: "0-instructions",
        kind: "instruction",
        origin: "atticus/critic",
        text: `You are the ${lens} lens. Report each problem as YAML findings.`,
        classification: "public",
        trusted: true,
      },
      {
        id: "proposal.md",
        kind: "artifact",
        origin: `openspec/changes/${CHANGE}/proposal.md`,
        text: "1: Tellers lock a card from the teller app.",
        classification: "internal",
        priority: 10,
      },
    ],
  }),
  outputPath: `findings-${lens}.yaml`,
  outputIn: "run",
  stepClass: "critic",
});

/** A part's check: YAML with a findings list, as the critic's is. */
const findingsOnly = async (file: string): Promise<string[]> => {
  const t = await readFile(file, "utf8");
  return /^findings:/m.test(t) ? [] : ["the output has no findings list"];
};

async function setup(o: { batchMaxTokens?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "atticus-batch-"));
  const checked: string[] = [];
  const rt = new HandoffRuntime({
    root,
    validate: async (file, request) => {
      checked.push(request.outputPath);
      return findingsOnly(file);
    },
    now: () => NOW,
    batch: true,
    ...o,
  });
  const parts = [];
  for (const lens of ["complete", "safe", "ship"]) {
    const p = await rt.prepare(lensRequest(lens));
    await rt.run(p.runId);
    parts.push({ name: lens, runId: p.runId });
  }
  const batch = await rt.prepareBatch({
    change: CHANGE,
    agent: { ...critic("critic-lenses"), description: "The critic's lenses, in one answer." },
    parts,
    stepClass: "critic",
  });
  await rt.run(batch.runId);
  const dir = join(root, ".runs", CHANGE, batch.runId);
  return { root, rt, parts, batch, dir, checked };
}

const runJson = async (root: string, runId: string) =>
  JSON.parse(await readFile(join(root, ".runs", CHANGE, runId, "run.json"), "utf8")) as {
    state: string;
    batch?: string;
    parts?: { name: string; runId: string }[];
    errors: string[];
    model?: string;
  };

describe("a batched hand-off (ADR 0185)", () => {
  it("asks every part in one prompt, each in its own section, and links the runs both ways", async () => {
    const { root, rt, parts, batch, dir } = await setup();
    expect(batch.parts).toEqual(parts);
    const prompt = await readFile(join(dir, "prompt.md"), "utf8");
    expect(prompt).toContain(`# critic-lenses: 3 parts for change ${CHANGE}, in one answer`);
    expect(prompt).toContain(`Write the result to .runs/${CHANGE}/${batch.runId}/answers.md.`);
    // Each part's own prompt is in it, whole, under its name, in order.
    let at = 0;
    for (const p of parts) {
      const own = (await rt.result(p.runId)).request.pack.prompt;
      const head = prompt.indexOf(`Part ${parts.indexOf(p) + 1} of 3: ${p.name}`);
      expect(head, p.name).toBeGreaterThan(at);
      expect(prompt.indexOf(own.trimEnd(), head)).toBeGreaterThan(head);
      at = head;
    }
    expect(prompt).toContain("=== complete");
    expect(prompt.trimEnd().endsWith(`atticus handoff done ${batch.runId}`)).toBe(true);
    // The parts' own prompts are as they were: each can still be answered alone.
    const own = await readFile(join(root, ".runs", CHANGE, parts[0]!.runId, "prompt.md"), "utf8");
    expect(own).toContain(`atticus handoff done ${parts[0]!.runId}`);
    for (const p of parts) expect((await runJson(root, p.runId)).batch).toBe(batch.runId);
    expect((await runJson(root, batch.runId)).parts).toEqual(parts);
    // The batch's size is its parts' together.
    const sizes = await Promise.all(
      parts.map(async (p) => (await rt.result(p.runId)).request.pack.manifest.totalTokens),
    );
    expect(batch.request.pack.manifest.totalTokens).toBe(sizes.reduce((a, b) => a + b, 0));
    // The record says the same, at version 6.
    const s = RunSummary.parse(toRunSummary(await rt.result(batch.runId)));
    expect(s.parts).toEqual(parts);
    expect(s.stepClass).toBe("critic");
    expect(RunSummary.parse(toRunSummary(await rt.result(parts[1]!.runId))).batch).toBe(
      batch.runId,
    );
  });

  it("Done splits the answer and checks each section with its part's own check", async () => {
    const { root, rt, parts, batch, dir, checked } = await setup();
    await writeFile(
      join(dir, "answers.md"),
      [
        "=== safe",
        "findings: []",
        "=== complete",
        "```yaml",
        "findings:",
        "  - rule: complete.error-paths",
        "```",
        "=== ship",
        "findings: []",
        "",
      ].join("\n"),
    );
    const done = await rt.done(batch.runId, { model: "editor-model" });
    expect(done.state).toBe("validated");
    expect(checked.sort()).toEqual([
      "findings-complete.yaml",
      "findings-safe.yaml",
      "findings-ship.yaml",
    ]);
    for (const p of parts) {
      const r = await rt.result(p.runId);
      expect(r.state, p.name).toBe("validated");
      expect(r.model).toBe("editor-model");
      expect(
        await readFile(join(root, ".runs", CHANGE, p.runId, `findings-${p.name}.yaml`), "utf8"),
      ).toBe(r.output);
    }
    expect((await rt.result(parts[0]!.runId)).output).toBe(
      "```yaml\nfindings:\n  - rule: complete.error-paths\n```\n",
    );
    expect((await rt.result(parts[1]!.runId)).output).toBe("findings: []\n");
  });

  it("a missing or bad section fails only its part; Done again checks only what failed", async () => {
    const { root, rt, parts, batch, dir, checked } = await setup();
    await writeFile(
      join(dir, "answers.md"),
      "Here are the reviews.\n=== complete\nfindings: []\n=== safe\nLooks fine to me.\n",
    );
    const first = await rt.done(batch.runId);
    expect(first.state).toBe("failed");
    expect(first.errors).toEqual([
      "safe: the output has no findings list",
      `ship: the answer has no "=== ship" section. Add it, or answer that part alone: its prompt is .runs/${CHANGE}/${parts[2]!.runId}/prompt.md.`,
    ]);
    expect((await rt.result(parts[0]!.runId)).state).toBe("validated");
    expect(await rt.result(parts[1]!.runId)).toMatchObject({
      state: "failed",
      errors: ["the output has no findings list"],
    });
    expect(await rt.result(parts[2]!.runId)).toMatchObject({
      state: "failed",
      errors: [
        `The batched answer (run ${batch.runId}) has no "=== ship" section. Answer this part here.`,
      ],
    });

    // One part answered alone, the other fixed in the batch: each goes in on its own.
    await writeFile(
      join(root, ".runs", CHANGE, parts[2]!.runId, "findings-ship.yaml"),
      "findings: []\n",
    );
    expect((await rt.done(parts[2]!.runId)).state).toBe("validated");
    checked.length = 0;
    await writeFile(
      join(dir, "answers.md"),
      "=== complete\nfindings: []\n=== safe\nfindings: []\n",
    );
    const again = await rt.done(batch.runId);
    expect(again).toMatchObject({ state: "validated", attempt: 2, errors: [] });
    // Only the part still out was checked again; the ones in stay as they went in.
    expect(checked).toEqual(["findings-safe.yaml"]);
    for (const p of parts) expect((await rt.result(p.runId)).state, p.name).toBe("validated");
  });

  it("an answer with no section at all fails the batch and leaves every part waiting", async () => {
    const { rt, parts, batch, dir } = await setup();
    expect((await rt.done(batch.runId)).errors).toEqual(["answers.md was not written"]);
    await writeFile(join(dir, "answers.md"), "findings: []\n");
    const r = await rt.done(batch.runId);
    expect(r.state).toBe("failed");
    expect(r.errors).toEqual([
      'answers.md has no section of any part. Start each part\'s answer with its own line "=== <part>": === complete, === safe, === ship.',
    ]);
    for (const p of parts) expect((await rt.result(p.runId)).state).toBe("waiting");
  });

  it("a section named twice fails its part rather than pick one", async () => {
    const { rt, parts, batch, dir } = await setup();
    await writeFile(
      join(dir, "answers.md"),
      "=== complete\nfindings: []\n=== complete\nfindings: []\n=== safe\nfindings: []\n=== ship\nfindings: []\n",
    );
    const r = await rt.done(batch.runId);
    expect(r.errors).toEqual([
      `complete: the answer has two "=== complete" sections. Keep one, or answer that part alone: its prompt is .runs/${CHANGE}/${parts[0]!.runId}/prompt.md.`,
    ]);
    expect((await rt.result(parts[1]!.runId)).state).toBe("validated");
  });

  it("batches only when asked to, two parts or more, and within the size it may hold", async () => {
    const { rt } = await setup();
    expect(rt.canBatch(2, 1000)).toBe(true);
    expect(rt.canBatch(1, 1000)).toBe(false);
    expect(rt.canBatch(3, 60_001)).toBe(false);
    expect((await setup({ batchMaxTokens: 100 })).rt.canBatch(2, 101)).toBe(false);
    const plain = new HandoffRuntime({ root: tmpdir(), validate: async () => [] });
    expect(plain.canBatch(3, 1000)).toBe(false);
  });

  it("refuses parts that aren't waiting runs of the change, or share a name", async () => {
    const { rt, parts } = await setup();
    await expect(
      rt.prepareBatch({
        change: CHANGE,
        agent: critic("critic-lenses"),
        parts: [parts[0]!, { ...parts[1]!, name: "complete" }],
      }),
    ).rejects.toThrow(/two parts named complete/);
    await expect(
      rt.prepareBatch({
        change: "another-change",
        agent: critic("critic-lenses"),
        parts: parts.slice(0, 2),
      }),
    ).rejects.toThrow(/isn't a run of another-change/);
    await expect(
      rt.prepareBatch({ change: CHANGE, agent: critic("critic-lenses"), parts: parts.slice(0, 2) }),
    ).rejects.toThrow(/is already asked in run-/);
  });
});
