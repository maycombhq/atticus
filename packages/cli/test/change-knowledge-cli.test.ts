import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { recordKnowledge, readKnowledgeApplies } from "@maycombhq/planner";
import { changeKnowledge } from "../src/knowledge-applies-commands.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

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
    // B2 (a): the feature stage is the first that picks the org's knowledge.
    expect(none.err[0]).toMatch(/atticus change feature add-limit/);
    expect(none.err[0]).not.toMatch(/the feature stage picks none/);
    await recordKnowledge(root, "add-limit", "feature", {
      engine: true,
      picked: [
        { id: "pattern.a", kind: "Pattern", level: "full", score: 2, via: "named" },
        {
          id: "forge-wiki/limits.md#Daily limits",
          kind: "WikiSection",
          level: "line",
          score: 1,
          name: "Limits › Daily limits",
          via: "search (words #1)",
        },
      ],
      leftOut: [{ id: "decision.c", kind: "Decision", score: 0.2 }],
      unknown: [],
    });
    const list = io();
    expect(await changeKnowledge(root, "add-limit", {}, list.io)).toBe(0);
    expect(list.out.join("\n")).toContain("Pattern pattern.a (suggested; feature; named)");
    // B2: the list says how to act on it.
    expect(list.out.at(-1)).toBe(
      "Confirm or exclude an item: atticus change knowledge add-limit --confirm <id> (or --exclude <id>); an excluded one stays out of later stages.",
    );
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
      "forge-wiki/limits.md#Daily limits:suggested",
      "pattern.a:excluded",
    ]);
    // B2: what changed, not the whole list again.
    expect(set.out).toEqual([
      "Confirmed decision.c (Decision): every later stage that takes it selects it.",
      "Excluded pattern.a (Pattern): every later stage leaves it out.",
      "Written to openspec/changes/add-limit/knowledge.yaml; commit it with the change's files.",
    ]);
    const bad = io();
    expect(await changeKnowledge(root, "add-limit", { confirm: "nope" }, bad.io)).toBe(2);
  });

  it("confirms a knowledge item the stages didn't list, and says only that", async () => {
    const root = mkdtempSync(join(tmpdir(), "atticus-ckn-"));
    mkdirSync(join(root, "org-pack"), { recursive: true });
    mkdirSync(join(root, "openspec", "changes", "add-limit"), { recursive: true });
    for (const r of parse(readFileSync(join(FIX, "stages/knowledge.yaml"), "utf8")) as unknown[]) {
      const p = parseRecord(r);
      if (!p.ok) throw new Error(JSON.stringify(p.issues));
      const f = join(root, "knowledge/items", recordPath(p.record));
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, serializeRecord(p.record));
    }
    await recordKnowledge(root, "add-limit", "feature", {
      engine: true,
      picked: [{ id: "pattern.a", kind: "Pattern", level: "full", score: 2, via: "named" }],
      leftOut: Array.from({ length: 20 }, (_, k) => ({
        id: `decision.n${k}`,
        kind: "Decision",
        score: 0.1,
      })),
      unknown: [],
    });
    const c = io();
    expect(
      await changeKnowledge(root, "add-limit", { confirm: "firewall-rule-request" }, c.io),
    ).toBe(0);
    expect(c.out).toEqual([
      "Confirmed firewall-rule-request (ProcessDefinition, Network firewall rule): every later stage that takes it selects it.",
      "Written to openspec/changes/add-limit/knowledge.yaml; commit it with the change's files.",
    ]);
    const doc = (await readKnowledgeApplies(root, "add-limit"))!;
    expect(doc.items.find((i) => i.id === "firewall-rule-request")?.status).toBe("confirmed");
  });
});
