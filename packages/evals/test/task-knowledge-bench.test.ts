import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RecordedEmbedder, type RecordedVectors } from "@maycombhq/ai";
import {
  renderTaskKnowledgeTable,
  runTaskKnowledgeBench,
  TASK_KNOWLEDGE_CASES,
} from "../src/index.js";

// ADR 0124 addendum B-task-knowledge: the knowledge each task lists, against what it needs, on the
// invented Forge fixtures, alone and with every other wiki item of the stages as distractors.

const FX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const ACRONYM = "sso acronym: sign-in-to-order";

/** The vectors the pinned model gave the benches' texts (ADR 0132 addendum), replayed. */
const recorded = () =>
  new RecordedEmbedder(
    JSON.parse(
      readFileSync(join(FX, "retrieval/vectors/benches/all-minilm-l6-v2.json"), "utf8"),
    ) as RecordedVectors,
  );

describe("the task-knowledge bench", () => {
  it("lists every page a task needs and nothing else, and never does worse than before", async () => {
    const rows = await runTaskKnowledgeBench(FX);
    expect(rows).toHaveLength(TASK_KNOWLEDGE_CASES.length * 2);
    for (const c of TASK_KNOWLEDGE_CASES.filter((x) => x.name !== ACRONYM)) {
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
    // Words alone (no meaning model): the acronym case's how-to shares no word with the task and
    // is missed; the item sharing one common word is listed.
    expect(rows.find((r) => r.case === ACRONYM && r.mode === "per task")).toMatchObject({
      missing: ["sso-login-gate"],
      extra: ["order-history-years"],
    });
    expect(renderTaskKnowledgeTable(rows)).toContain(
      "| sso: add-sso | 1.1 | per task | 1.00 | 1.00 | 2 / 2 | none | none |",
    );
  }, 300_000);

  it("with the pinned model (its recorded vectors), keeps by words and meaning: nothing needed is lost, the common-word item drops (ADR 0132 addendum)", async () => {
    const rows = await runTaskKnowledgeBench(FX, { embeddings: recorded() });
    for (const c of TASK_KNOWLEDGE_CASES.filter((x) => x.name !== ACRONYM)) {
      const now = rows.find((r) => r.case === c.name && r.mode === "per task")!;
      expect(now.recall, c.name).toBe(1);
      expect(now.precision, c.name).toBe(1);
    }
    // The model rates "SSO" against "single sign-on" too low to keep the how-to by meaning alone
    // (measured, not hidden): it is still missed, but the common-word item no longer attaches.
    expect(rows.find((r) => r.case === ACRONYM && r.mode === "per task")).toMatchObject({
      missing: ["sso-login-gate"],
      extra: [],
    });
    // The same files give the same list.
    const again = await runTaskKnowledgeBench(FX, { embeddings: recorded() });
    expect(again).toEqual(rows);
  }, 300_000);
});
