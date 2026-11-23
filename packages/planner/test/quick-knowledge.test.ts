import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import {
  knowledgeAppliesMarkdown,
  readKnowledgeApplies,
  recordQuickKnowledge,
} from "../src/stages/knowledge-applies.js";

/**
 * v31 (WP-05): a quick change runs no stage, so no selection listed its knowledge. Its plan
 * hand-off selects it from the ids it cites and its words, with no model, and writes
 * knowledge.yaml; with no knowledge in the metarepo the list says nothing was found.
 */

const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

function metarepo(items: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "atticus-qk-"));
  mkdirSync(join(root, "org-pack"), { recursive: true });
  mkdirSync(join(root, "openspec", "changes", "shipped-orders"), { recursive: true });
  if (items)
    for (const r of parse(readFileSync(join(FIX, "stages/knowledge.yaml"), "utf8")) as unknown[]) {
      const p = parseRecord(r);
      if (!p.ok) throw new Error(JSON.stringify(p.issues));
      const f = join(root, "knowledge/items", recordPath(p.record));
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, serializeRecord(p.record));
    }
  return root;
}

const INPUT = {
  title: "Shipped-orders event",
  ids: ["forge-orders", "forge.orders.shipped"],
  text: "forge-orders will publish to a topic that does not exist yet: forge.orders.shipped.",
};

describe("a quick change's knowledge list", () => {
  it("lists the knowledge its ids and words lead to, picked by the quick path", async () => {
    const root = metarepo(true);
    const r = await recordQuickKnowledge(root, "shipped-orders", INPUT);
    expect(r.found).toBeGreaterThan(0);
    const doc = await readKnowledgeApplies(root, "shipped-orders");
    expect(doc?.items.find((i) => i.id === "broker-topic-request")).toMatchObject({
      kind: "ProcessDefinition",
      status: "suggested",
      stages: ["quick"],
      title: "Broker topic",
    });
  });

  it("writes an empty list that says nothing was found, when the metarepo has no knowledge", async () => {
    const root = metarepo(false);
    const r = await recordQuickKnowledge(root, "shipped-orders", INPUT);
    expect(r.found).toBe(0);
    const doc = await readKnowledgeApplies(root, "shipped-orders");
    expect(doc).toEqual({ schemaVersion: 1, change: "shipped-orders", items: [], nearMisses: [] });
    expect(knowledgeAppliesMarkdown(doc!)).toContain(
      "Nothing in the org's knowledge was picked for this change.",
    );
  });

  it("doesn't count a glossary term the map generated (term.*) as the org's knowledge", async () => {
    const root = metarepo(false);
    const term = join(root, "catalog/generated/glossaryterm/term.account.yaml");
    mkdirSync(dirname(term), { recursive: true });
    writeFileSync(
      term,
      readFileSync(
        join(
          FIX,
          "upgrade-b30/unresolved-ids/metarepo/catalog/generated/glossaryterm/term.account.yaml",
        ),
      ),
    );
    const r = await recordQuickKnowledge(root, "shipped-orders", {
      ...INPUT,
      text: `${INPUT.text} The account is posted.`,
      ids: [...INPUT.ids, "term.account"],
    });
    expect(r.found).toBe(0);
    expect((await readKnowledgeApplies(root, "shipped-orders"))?.items).toEqual([]);
  });

  it("writes why when the index can't be read, and never fails", async () => {
    const root = metarepo(true);
    const r = await recordQuickKnowledge(root, "shipped-orders", INPUT, {
      open: async () => {
        throw new Error("the index is locked\nmore");
      },
    });
    expect(r).toEqual({ found: 0, note: "the index couldn't be read (the index is locked)" });
    const doc = await readKnowledgeApplies(root, "shipped-orders");
    expect(doc?.note).toBe("the index couldn't be read (the index is locked)");
    expect(knowledgeAppliesMarkdown(doc!)).toContain(
      "Not listed: the index couldn't be read (the index is locked).",
    );
  });

  it("keeps a person's status when it runs again", async () => {
    const root = metarepo(true);
    await recordQuickKnowledge(root, "shipped-orders", INPUT);
    const { setKnowledgeStatus } = await import("../src/stages/knowledge-applies.js");
    await setKnowledgeStatus(root, "shipped-orders", "broker-topic-request", "excluded");
    await recordQuickKnowledge(root, "shipped-orders", INPUT);
    const doc = await readKnowledgeApplies(root, "shipped-orders");
    expect(doc?.items.find((i) => i.id === "broker-topic-request")?.status).toBe("excluded");
  });
});
