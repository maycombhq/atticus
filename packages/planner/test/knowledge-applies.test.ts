import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContextReport } from "../src/engine.js";
import {
  confirmedKnowledge,
  excludedKnowledge,
  knowledgeAppliesMarkdown,
  plainWhy,
  readKnowledgeApplies,
  recordKnowledge,
  setKnowledgeStatus,
} from "../src/stages/knowledge-applies.js";

/** A metarepo with one change folder (openspec/changes/<id>/ is where changesDirOf points). */
function metarepo(): string {
  const root = mkdtempSync(join(tmpdir(), "atticus-kn-"));
  mkdirSync(join(root, "org-pack"), { recursive: true });
  mkdirSync(join(root, "openspec", "changes", "add-limit"), { recursive: true });
  return root;
}

const report = (picked: ContextReport["picked"], leftOut: ContextReport["leftOut"] = []) =>
  ({ engine: true, picked, leftOut, unknown: [] }) as ContextReport;

describe("knowledge that applies to a change, listed (ADR 0124, Part 5)", () => {
  it("records the knowledge items a stage's selection picked, with why, and its near-misses", async () => {
    const root = metarepo();
    await recordKnowledge(
      root,
      "add-limit",
      "feature",
      report(
        [
          { id: "ledger-api", kind: "Component", level: "full", score: 3 },
          {
            id: "pattern.idempotent-posting",
            kind: "Pattern",
            level: "full",
            score: 2.5,
            file: "knowledge/items/pattern/pattern.idempotent-posting.yaml",
            via: "named",
          },
          {
            id: "wiki.limits-runbook.daily-limits",
            kind: "WikiSection",
            level: "line",
            score: 1.2,
            via: "search",
          },
        ],
        [
          { id: "decision.fx-cache", kind: "Decision", score: 0.4 },
          { id: "ledger-db.entry", kind: "Table", score: 0.3 },
        ],
      ),
    );
    const doc = await readKnowledgeApplies(root, "add-limit");
    expect(doc!.items.map((i) => i.id)).toEqual([
      "pattern.idempotent-posting",
      "wiki.limits-runbook.daily-limits",
    ]);
    expect(doc!.items[0]).toMatchObject({
      kind: "Pattern",
      status: "suggested",
      stages: ["feature"],
      why: "named",
      file: "knowledge/items/pattern/pattern.idempotent-posting.yaml",
    });
    expect(doc!.nearMisses).toEqual([
      { id: "decision.fx-cache", kind: "Decision", score: 0.4, stage: "feature" },
    ]);
  });

  it("merges later stages, keeps a person's confirm and exclude, and the excluded ids are listed", async () => {
    const root = metarepo();
    await recordKnowledge(
      root,
      "add-limit",
      "feature",
      report([{ id: "pattern.a", kind: "Pattern", level: "full", score: 2 }]),
    );
    await setKnowledgeStatus(root, "add-limit", "pattern.a", "confirmed");
    await recordKnowledge(
      root,
      "add-limit",
      "architecture",
      report([
        { id: "pattern.a", kind: "Pattern", level: "full", score: 3 },
        { id: "decision.b", kind: "Decision", level: "line", score: 1 },
      ]),
    );
    await setKnowledgeStatus(root, "add-limit", "decision.b", "excluded");
    const doc = (await readKnowledgeApplies(root, "add-limit"))!;
    expect(doc.items.find((i) => i.id === "pattern.a")).toMatchObject({
      status: "confirmed",
      stages: ["feature", "architecture"],
      score: 3,
    });
    expect(await excludedKnowledge(root, "add-limit")).toEqual(["decision.b"]);
    // B2: what a person confirmed, for the stages that take its kind.
    expect(await confirmedKnowledge(root, "add-limit")).toEqual(["pattern.a"]);
    expect(await confirmedKnowledge(root, "add-limit", ["Pattern"])).toEqual(["pattern.a"]);
    expect(await confirmedKnowledge(root, "add-limit", ["ProcessDefinition"])).toEqual([]);
    await expect(setKnowledgeStatus(root, "add-limit", "nope", "confirmed")).rejects.toThrow(
      /not in .*knowledge\.yaml/,
    );
  });

  // B2 (e): a person reads a title, not an index id, and why in words, not the search's internals.
  it("keeps each item's title, and says why in plain words", async () => {
    const root = metarepo();
    await recordKnowledge(
      root,
      "add-limit",
      "feature",
      report(
        [
          {
            id: "forge-wiki/limits.md#Daily limits",
            kind: "WikiSection",
            level: "full",
            score: 1.2,
            name: "Limits › Daily limits",
            via: 'search (words #2, the model\'s "transfer status" #5, title #1)',
          },
          {
            id: "vendor-onboarding",
            kind: "ProcessDefinition",
            level: "line",
            score: 1,
            name: "Vendor onboarding",
            via: "northwind-pay quoted-on vendor-onboarding (item page)",
          },
        ],
        [{ id: "decision.c", kind: "Decision", score: 0.2, name: "Freeze in December" }],
      ),
    );
    const doc = (await readKnowledgeApplies(root, "add-limit"))!;
    expect(doc.items.map((i) => i.title)).toEqual(["Limits › Daily limits", "Vendor onboarding"]);
    expect(doc.nearMisses[0]!.title).toBe("Freeze in December");
    expect(plainWhy(doc.items[0]!)).toBe(
      'Its words match the change\'s title and words, and "transfer status".',
    );
    expect(plainWhy(doc.items[1]!)).toBe("Linked to northwind-pay, which the change leads to.");
    expect(plainWhy({ id: "a", why: "named in the input" })).toBe("The change names it.");
    expect(
      plainWhy({
        id: "a",
        why: "named in the input (the model's reading, an id the index has)",
      }),
    ).toBe("The change names it.");
    expect(plainWhy({ id: "a", why: "a person" })).toBe("A person added it.");
    expect(plainWhy({ id: "a", why: "search (what is named #1, words #2)" })).toBe(
      "Its words match the change's words, and what the change names.",
    );
    expect(plainWhy({ id: "a", why: "search (similar in meaning #1 (cos 0.62))" })).toBe(
      "It is close in meaning to the change.",
    );
    expect(plainWhy({ id: "a" })).toBeUndefined();
    const md = knowledgeAppliesMarkdown(doc);
    expect(md).toContain(
      '- WikiSection Limits › Daily limits [forge-wiki/limits.md#Daily limits] (suggested; feature; Its words match the change\'s title and words, and "transfer status".)',
    );
  });

  it("writes nothing when the stage sent the whole lists, and renders the list for a PR", async () => {
    const root = metarepo();
    await recordKnowledge(root, "add-limit", "feature", { engine: false } as ContextReport);
    expect(await readKnowledgeApplies(root, "add-limit")).toBeUndefined();
    await recordKnowledge(
      root,
      "add-limit",
      "feature",
      report(
        [{ id: "pattern.a", kind: "Pattern", level: "full", score: 2, via: "named" }],
        [{ id: "decision.c", kind: "Decision", score: 0.2 }],
      ),
    );
    const text = readFileSync(
      join(root, "openspec", "changes", "add-limit", "knowledge.yaml"),
      "utf8",
    );
    expect(text).toMatch(/^schemaVersion: 1/);
    const md = knowledgeAppliesMarkdown((await readKnowledgeApplies(root, "add-limit"))!);
    expect(md).toContain("### Applies to this change");
    expect(md).toContain("- Pattern pattern.a (suggested; feature; named)");
    expect(md).toContain("Near-misses");
    expect(md).toContain("decision.c");
  });
});
