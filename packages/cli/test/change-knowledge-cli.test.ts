import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recordKnowledge, readKnowledgeApplies } from "@maycombhq/planner";
import { changeKnowledge } from "../src/knowledge-applies-commands.js";

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};

describe("atticus change knowledge <id> (ADR 0124, Part 5)", () => {
  it("lists what applies, confirms and excludes, and says what to run when there is no list", async () => {
    const root = mkdtempSync(join(tmpdir(), "atticus-ckn-"));
    mkdirSync(join(root, "org-pack"), { recursive: true });
    mkdirSync(join(root, "openspec", "changes", "add-limit"), { recursive: true });
    const none = io();
    expect(await changeKnowledge(root, "add-limit", {}, none.io)).toBe(2);
    expect(none.err[0]).toMatch(/atticus change feature add-limit/);
    await recordKnowledge(root, "add-limit", "feature", {
      engine: true,
      picked: [{ id: "pattern.a", kind: "Pattern", level: "full", score: 2, via: "named" }],
      leftOut: [{ id: "decision.c", kind: "Decision", score: 0.2 }],
      unknown: [],
    });
    const list = io();
    expect(await changeKnowledge(root, "add-limit", {}, list.io)).toBe(0);
    expect(list.out.join("\n")).toContain("Pattern pattern.a (suggested; feature; named)");
    const set = io();
    expect(
      await changeKnowledge(
        root,
        "add-limit",
        { confirm: "decision.c", exclude: "pattern.a" },
        set.io,
      ),
    ).toBe(0);
    const doc = (await readKnowledgeApplies(root, "add-limit"))!;
    expect(doc.items.map((i) => `${i.id}:${i.status}`)).toEqual([
      "decision.c:confirmed",
      "pattern.a:excluded",
    ]);
    const bad = io();
    expect(await changeKnowledge(root, "add-limit", { confirm: "nope" }, bad.io)).toBe(2);
  });
});
