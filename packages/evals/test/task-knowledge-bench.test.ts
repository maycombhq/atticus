import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  renderTaskKnowledgeTable,
  runTaskKnowledgeBench,
  TASK_KNOWLEDGE_CASES,
} from "../src/index.js";

// ADR 0124 addendum B-task-knowledge: the knowledge each task lists, against what it needs, on the
// invented Forge fixtures, alone and with every other wiki item of the stages as distractors.

const FX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

describe("the task-knowledge bench", () => {
  it("lists every page a task needs and nothing else, and never does worse than before", async () => {
    const rows = await runTaskKnowledgeBench(FX);
    expect(rows).toHaveLength(TASK_KNOWLEDGE_CASES.length * 2);
    for (const c of TASK_KNOWLEDGE_CASES) {
      const at = (mode: string) => rows.find((r) => r.case === c.name && r.mode === mode)!;
      const now = at("per task");
      const before = at("before");
      expect(now.recall, c.name).toBe(1);
      expect(now.precision, c.name).toBe(1);
      expect(now.recall, c.name).toBeGreaterThanOrEqual(before.recall);
      expect(now.precision, c.name).toBeGreaterThanOrEqual(before.precision);
    }
    // The how-to the SSO task needs was missing before: a process isn't a pattern or decision.
    expect(rows.find((r) => r.case === "sso: add-sso" && r.mode === "before")!.missing).toEqual([
      "sso-setup",
    ]);
    expect(renderTaskKnowledgeTable(rows)).toContain(
      "| sso: add-sso | 1.1 | per task | 1.00 | 1.00 | 2 / 2 | none | none |",
    );
  }, 300_000);
});
