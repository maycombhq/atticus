import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import {
  architectureStage,
  EXPAND_AGENT,
  featureStage,
  readKnowledgeApplies,
  storiesStage,
} from "../src/index.js";
import { SECTION_SHARE, SECTION_TOKENS } from "../src/stages/estate-context.js";

/**
 * B2, the knowledge walk's design gaps (a) to (c): the feature stage lists the knowledge that
 * applies and sends it to the drafter; every stage also picks the wiki and document sections,
 * vendors and terms its own input leads to (BM25 over the index), lists them with why and sends
 * the top few; the architecture prompt carries a pattern's rules and the stories prompt the
 * standards. The estate is the stage tests' shop with the wiki snapshot of fixtures/stages/wiki.
 */

const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const NOW = new Date("2026-10-21T09:00:00Z");
const CHANGE = "add-fraud-check";

async function shop(o: { wiki?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-stage-kn-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  const write = async (dir: string, file: string) => {
    for (const r of parse(readFileSync(file, "utf8")) as unknown[]) {
      const p = parseRecord(r);
      if (!p.ok) throw new Error(JSON.stringify(p.issues));
      const f = join(root, dir, recordPath(p.record));
      await mkdir(dirname(f), { recursive: true });
      await writeFile(f, serializeRecord(p.record));
    }
  };
  await write("catalog/generated", join(FIX, "specs/catalog.yaml"));
  await write("catalog/generated", join(FIX, "stages/catalog-extra.yaml"));
  await write("knowledge/items", join(FIX, "stages/knowledge.yaml"));
  if (o.wiki !== false) {
    await write("knowledge/items", join(FIX, "stages/wiki/knowledge.yaml"));
    await cp(join(FIX, "stages/wiki/snapshots"), join(root, "knowledge/snapshots"), {
      recursive: true,
    });
  }
  await cp(join(FIX, "stages/specs"), join(root, "specs"), { recursive: true });
  await cp(join(FIX, "stages/changes"), join(root, "openspec/changes"), { recursive: true });
  return root;
}

const EXPANSION = `terms: [fraud screen, place order, reserve stock]
names:
  - { name: Northwind Pay, id: northwind-pay, quote: screened by Northwind Pay }
`;

function assistant(answer: string, seen: string[]) {
  return new MockRuntime(
    (req: AiRequest) => {
      if (req.agent.id.endsWith("-critic")) return "findings: []";
      if (req.agent.id === EXPAND_AGENT) return EXPANSION;
      seen.push(req.pack.prompt);
      return answer;
    },
    { now: () => NOW },
  );
}

const ANSWERS = join(FIX, "stages/corrections/answers");
const PLACED = readFileSync(join(ANSWERS, "feature.yaml"), "utf8");
const DELTAS = readFileSync(join(ANSWERS, "architecture.yaml"), "utf8");
const STORIES = readFileSync(join(ANSWERS, "stories.yaml"), "utf8");

const SCREEN = "forge-wiki/northwind-pay-fraud-screen.md";

describe("the knowledge that applies, from the feature stage on (B2 a)", () => {
  it("feature: lists the items and wiki sections the brief leads to, with titles and why, and sends them", async () => {
    const root = await shop();
    const seen: string[] = [];
    const r = await featureStage(root, CHANGE, { runtime: assistant(PLACED, seen), now: NOW });
    expect(r.state).toBe("done");
    const prompt = seen[0]!;
    // The items: in the stage's own lines, as the later stages write them.
    expect(prompt).toContain('process vendor-onboarding "Vendor onboarding": applies when');
    expect(prompt).toContain(
      "The organisation's knowledge that may apply to this change, from its wikis and documents",
    );
    // A section no item covers reaches the drafter in the wiki's own words.
    expect(prompt).toContain("Call it with a 2 second timeout and one retry.");
    const doc = (await readKnowledgeApplies(root, CHANGE))!;
    const item = doc.items.find((i) => i.id === "vendor-onboarding")!;
    expect(item).toMatchObject({ kind: "ProcessDefinition", stages: ["feature"] });
    expect(item.title).toBe("Vendor onboarding");
    const sections = doc.items.filter((i) => i.kind === "WikiSection");
    expect(sections.map((s) => s.id)).toContain(`${SCREEN}#Timeouts and retries`);
    const timeouts = sections.find((s) => s.id === `${SCREEN}#Timeouts and retries`)!;
    expect(timeouts).toMatchObject({ stages: ["feature"], status: "suggested" });
    expect(timeouts.title).toBe("Northwind Pay fraud screen › Timeouts and retries");
    expect(timeouts.why).toMatch(/^search \(/);
    expect(timeouts.file).toBe(
      "knowledge/snapshots/forge-wiki/2026-10-01/northwind-pay-fraud-screen.md",
    );
  });

  it("feature: an excluded section stays out of the next run, and the prompt is as it was without a wiki", async () => {
    const root = await shop();
    const first: string[] = [];
    await featureStage(root, CHANGE, { runtime: assistant(PLACED, first), now: NOW });
    const { setKnowledgeStatus } = await import("../src/index.js");
    await setKnowledgeStatus(root, CHANGE, `${SCREEN}#Timeouts and retries`, "excluded");
    const again: string[] = [];
    await featureStage(root, CHANGE, {
      runtime: assistant(PLACED, again),
      now: NOW,
      force: true,
    });
    expect(first[0]).toContain("Call it with a 2 second timeout and one retry.");
    expect(again[0]).not.toContain("Call it with a 2 second timeout and one retry.");
    // No wiki, no sections: nothing is said about them.
    const bare: string[] = [];
    await featureStage(await shop({ wiki: false }), CHANGE, {
      runtime: assistant(PLACED, bare),
      now: NOW,
    });
    expect(bare[0]).not.toContain("from its wikis and documents");
  });
});

describe("sections, vendors and terms in every stage (B2 b)", () => {
  it("sends only the top few sections, within the stage's room for them", async () => {
    const root = await shop();
    const seen: string[] = [];
    await featureStage(root, CHANGE, { runtime: assistant(PLACED, seen), now: NOW });
    const block = /<atticus-data id="org-knowledge"[^>]*>([\s\S]*?)<\/atticus-data>/.exec(seen[0]!);
    expect(block).not.toBeNull();
    const text = block![1]!;
    expect(Math.ceil(text.length / 4)).toBeLessThanOrEqual(SECTION_TOKENS);
    expect(SECTION_SHARE).toBeLessThan(0.5);
    // Each section in full names where it is read from, so the drafter can cite it.
    expect(text).toContain(
      "knowledge/snapshots/forge-wiki/2026-10-01/northwind-pay-fraud-screen.md:",
    );
  });

  it("writes a vendor or a term in one line, never as its record, and leaves out a term nothing defines", async () => {
    const root = await shop();
    const term = async (id: string, name: string, definition: string, flags: string[] = []) => {
      const p = parseRecord({
        kind: "GlossaryTerm",
        schemaVersion: 2,
        id,
        status: "current",
        confidence: "asserted",
        evidence: [{ source: "manual", by: "forge-architecture" }],
        term: name,
        definition,
        ...(flags.length ? { flags } : {}),
      });
      if (!p.ok) throw new Error(JSON.stringify(p.issues));
      const f = join(root, "catalog/generated", recordPath(p.record));
      await mkdir(dirname(f), { recursive: true });
      await writeFile(f, serializeRecord(p.record));
    };
    await term(
      "term.fraud-screen",
      "Fraud screen",
      "Northwind Pay's check of an order before stock is reserved: approve, review or reject.",
    );
    await term("term.order", "Order", "Not defined yet. Found in code: forge-orders.post-orders.", [
      "undefined",
    ]);
    const seen: string[] = [];
    await featureStage(root, CHANGE, { runtime: assistant(PLACED, seen), now: NOW });
    const block = /<atticus-data id="org-knowledge"[^>]*>([\s\S]*?)<\/atticus-data>/.exec(
      seen[0]!,
    )![1]!;
    expect(block).toContain(
      'term term.fraud-screen "Fraud screen": Northwind Pay\'s check of an order before stock is reserved: approve, review or reject.',
    );
    expect(block).not.toMatch(/^kind: GlossaryTerm/m);
    expect(block).not.toContain("term.order");
    const doc = (await readKnowledgeApplies(root, CHANGE))!;
    expect(doc.items.find((i) => i.id === "term.fraud-screen")).toMatchObject({
      kind: "GlossaryTerm",
      title: "Fraud screen",
    });
    expect(doc.items.some((i) => i.id === "term.order")).toBe(false);
  });

  it("architecture and stories list the sections their own input leads to", async () => {
    const root = await shop();
    await featureStage(root, CHANGE, { runtime: assistant(PLACED, []), now: NOW });
    await architectureStage(root, CHANGE, { runtime: assistant(DELTAS, []), now: NOW });
    await storiesStage(root, CHANGE, { runtime: assistant(STORIES, []), now: NOW });
    const doc = (await readKnowledgeApplies(root, CHANGE))!;
    const stagesOf = (id: string) => doc.items.find((i) => i.id === id)?.stages ?? [];
    expect(stagesOf(`${SCREEN}#Timeouts and retries`)).toEqual(
      expect.arrayContaining(["feature", "architecture"]),
    );
    expect(doc.items.some((i) => i.kind === "WikiSection" && i.stages.includes("stories"))).toBe(
      true,
    );
  });
});

describe("the rules in the prompts (B2 c)", () => {
  it("architecture: a pattern or standard picked in full carries its rules", async () => {
    const root = await shop();
    await featureStage(root, CHANGE, { runtime: assistant(PLACED, []), now: NOW });
    const seen: string[] = [];
    await architectureStage(root, CHANGE, { runtime: assistant(DELTAS, seen), now: NOW });
    // The change calls a vendor: the gateway pattern applies, and its rules go with it.
    expect(seen[0]).toContain(
      "Pattern vendor-partner-gateway: Vendor calls through the partner gateway. Applies when: A service calls a vendor. (integration-standards.md). Rules: Calls to a vendor go through the partner gateway, never straight to the vendor's host. The gateway holds the vendor's credentials; a service never keeps them.",
    );
    // A batch-file pattern shares no words with it and stays out.
    expect(seen[0]).not.toContain("managed-file-transfer");
  });

  it("stories: the standards that apply, with their rules, beside the processes; no integration pattern", async () => {
    const root = await shop();
    await featureStage(root, CHANGE, { runtime: assistant(PLACED, []), now: NOW });
    await architectureStage(root, CHANGE, { runtime: assistant(DELTAS, []), now: NOW });
    const seen: string[] = [];
    await storiesStage(root, CHANGE, { runtime: assistant(STORIES, seen), now: NOW });
    expect(seen[0]).toContain(
      'standard outbound-call-timeouts "Outbound calls state their timeouts": applies when',
    );
    expect(seen[0]).toContain("Every call to another service or a vendor states its timeout");
    expect(seen[0]).toContain('process vendor-onboarding "Vendor onboarding": applies when');
    expect(seen[0]).not.toMatch(/Pattern vendor-partner-gateway|standard vendor-partner-gateway/);
    expect(seen[0]).not.toContain("managed-file-transfer:");
  });
});
