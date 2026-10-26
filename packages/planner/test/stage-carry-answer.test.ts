import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { HandoffRuntime, MockRuntime, type AiRequest } from "@maycombhq/ai";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { architectureStage, EXPAND_AGENT, featureStage } from "../src/index.js";

/**
 * ADR 0115 addendum (2026-10-26), trial problem 6: after a deterministic finding the stage
 * prepared a new run, and `--resume` on it failed with "architecture-answer.yaml was not written"
 * because the answer the assistant had already written sat in the previous round's folder. The
 * stage now carries the last answer into the new run's folder, so the assistant edits what it
 * wrote instead of writing it out again, and nobody copies a file by hand.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const STAGES = join(HERE, "../../../fixtures/stages");
const FIX = join(HERE, "fixtures/context-flows");
const SPECS_CATALOG = join(HERE, "../../../fixtures/specs/catalog.yaml");
const NOW = new Date("2026-10-21T09:00:00Z");
const CHANGE = "add-fraud-check";
const OUTPUT = "architecture-answer.yaml";
const fixture = (f: string) => readFileSync(join(FIX, f), "utf8");

async function estateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-carry-answer-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  const rows = [
    ...(parse(readFileSync(SPECS_CATALOG, "utf8")) as unknown[]),
    ...(parse(readFileSync(join(STAGES, "catalog-extra.yaml"), "utf8")) as unknown[]),
  ];
  for (const r of rows) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  for (const r of parse(readFileSync(join(STAGES, "knowledge.yaml"), "utf8")) as unknown[]) {
    const p = parseRecord(r);
    if (!p.ok) throw new Error(`bad knowledge record: ${JSON.stringify(p.issues)}`);
    const f = join(root, "knowledge/items", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  await cp(join(STAGES, "specs"), join(root, "specs"), { recursive: true });
  await cp(join(FIX, "specs"), join(root, "specs"), { recursive: true });
  await cp(join(STAGES, "changes"), join(root, "openspec/changes"), { recursive: true });
  return root;
}

function mock(drafts: string[]) {
  let n = 0;
  return new MockRuntime(
    (req: AiRequest) => {
      if (req.agent.id.endsWith("-critic")) return "findings: []";
      if (req.agent.id === EXPAND_AGENT) return "terms: []\nnames: []\n";
      return drafts[Math.min(n++, drafts.length - 1)]!;
    },
    { now: () => NOW },
  );
}

/** The context expander is a hand-off of its own; these tests are about the draft's answer. */
const NO_EXPAND = { expand: false } as const;

const handoff = (root: string) =>
  new HandoffRuntime({ root, validate: async () => [], now: () => NOW });

const runFile = (root: string, runId: string) => join(root, ".runs", CHANGE, runId, OUTPUT);

describe("the answer is carried into the next round's run folder", () => {
  it("copies the last answer in and says so in the prompt, after a deterministic finding", async () => {
    const root = await estateRoot();
    expect(
      (
        await featureStage(root, CHANGE, {
          runtime: mock([fixture("feature-answer.yaml")]),
          now: NOW,
        })
      ).state,
    ).toBe("done");

    // Round 1: the assistant writes the answer the empty-delta check refuses.
    const first = await architectureStage(root, CHANGE, {
      runtime: handoff(root),
      now: NOW,
      context: NO_EXPAND,
    });
    expect(first.state).toBe("waiting");
    const run1 = first.waiting!.runId;
    const answer = fixture("architecture-empty-deltas.yaml");
    await writeFile(runFile(root, run1), answer);
    expect((await handoff(root).done(run1)).state).toBe("validated");

    // Round 2: the check finds the empty deltas, so a new run is handed off.
    const second = await architectureStage(root, CHANGE, {
      runtime: handoff(root),
      resume: run1,
      now: NOW,
      context: NO_EXPAND,
    });
    expect(second.state).toBe("waiting");
    const run2 = second.waiting!.runId;
    expect(run2).not.toBe(run1);
    // The answer is already there, so `handoff done <run2>` never says it wasn't written.
    expect(await readFile(runFile(root, run2), "utf8")).toBe(answer);
    expect((await handoff(root).done(run2)).state).toBe("validated");
    // And the prompt says the file holds the last answer, to be edited rather than rewritten.
    const prompt = await readFile(join(root, ".runs", CHANGE, run2, "prompt.md"), "utf8");
    expect(prompt).toContain(
      "The result file already holds your last answer: edit it in place, changing only what the problems below need.",
    );
    expect(second.notes).toContain(
      `Your last answer was copied to .runs/${CHANGE}/${run2}/${OUTPUT}: fix it there.`,
    );
  });

  it("carries nothing into the first run of a stage", async () => {
    const root = await estateRoot();
    await featureStage(root, CHANGE, { runtime: mock([fixture("feature-answer.yaml")]), now: NOW });
    const first = await architectureStage(root, CHANGE, {
      runtime: handoff(root),
      now: NOW,
      context: NO_EXPAND,
    });
    const run1 = first.waiting!.runId;
    await expect(readFile(runFile(root, run1), "utf8")).rejects.toThrow();
    const prompt = await readFile(join(root, ".runs", CHANGE, run1, "prompt.md"), "utf8");
    expect(prompt).not.toContain("already holds your last answer");
  });
});
