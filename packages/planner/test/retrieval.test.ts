import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { HandoffRuntime, MockRuntime, type AiRequest } from "@maycombhq/ai";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { openIndex } from "@maycombhq/index";
import {
  checkExpansion,
  checkRerank,
  EXPAND_AGENT,
  expandFor,
  fileJudgments,
  featureStage,
  findNeeds,
  RERANK_AGENT,
} from "../src/index.js";

/**
 * ADR 0116 phases 3 and 4: the model's expansion of a step's input before its selection, and its
 * rerank of the candidates when they don't fit, each one recorded call, checked, kept in the
 * judgments store and in the step's run record, and a hand-off of its own in hand-off mode.
 * Every model here is a mock; nothing reaches a network.
 */

const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const NOW = new Date("2026-10-21T09:00:00Z");
const CHANGE = "add-fraud-check";

async function shop(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-retrieval-"));
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
  await cp(join(FIX, "stages/specs"), join(root, "specs"), { recursive: true });
  await cp(join(FIX, "stages/changes"), join(root, "openspec/changes"), { recursive: true });
  const brief = join(root, "openspec/changes", CHANGE, "brief.md");
  await writeFile(
    brief,
    `${await readFile(brief, "utf8")}\nEvery order is also scored by Quillfeather Risk.\n`,
  );
  return root;
}

const EXPANDED = `terms: [fraud screen, order risk score]
names:
  - { name: Northwind Pay, id: northwind-pay, quote: Northwind Pay }
  - { name: Quillfeather Risk, quote: scored by Quillfeather Risk }
  - { name: Ledger, id: ledgr, quote: Northwind Pay }
  - { name: Stockpile, quote: not in the brief at all }
`;
const PLACED = `summary: Every new order is screened by Northwind Pay before stock is reserved.
features:
  - { id: cap-ordering, why: Placing an order gains the screen. }
flows:
  - { id: forge-orders.place-order, how: changed, why: The screen runs before stock is reserved. }
`;

function mock(calls: string[], answers: Record<string, string> = {}) {
  return new MockRuntime(
    (req: AiRequest) => {
      calls.push(req.agent.id);
      if (req.agent.id.endsWith("-critic")) return "findings: []";
      if (req.agent.id === EXPAND_AGENT) return answers[EXPAND_AGENT] ?? EXPANDED;
      if (req.agent.id === RERANK_AGENT) return answers[RERANK_AGENT] ?? "keep: []";
      return answers[req.agent.id] ?? PLACED;
    },
    { now: () => NOW },
  );
}

describe("the model's expansion, checked", () => {
  it("keeps what the input says, drops an id the index hasn't and a name whose words aren't in the input, and says why", async () => {
    const root = await shop();
    const ix = await openIndex(root, { embeddings: "off" });
    const brief = await readFile(join(root, "openspec/changes", CHANGE, "brief.md"), "utf8");
    const c = checkExpansion(EXPANDED, { text: brief }, ix);
    ix.close();
    expect("problem" in c).toBe(false);
    if ("problem" in c) return;
    expect(c.terms).toEqual(["fraud screen", "order risk score"]);
    expect(c.names).toEqual([
      { name: "Northwind Pay", id: "northwind-pay", quote: "Northwind Pay" },
      { name: "Quillfeather Risk", quote: "scored by Quillfeather Risk" },
    ]);
    expect(c.dropped).toEqual([
      { name: "Ledger", why: "the input doesn't use the name" },
      { name: "Stockpile", why: "its words aren't in the input" },
    ]);
    expect(checkExpansion("not: [yaml", { text: "x" }, { nodes: () => [] })).toEqual({
      problem: "the expansion isn't YAML with terms and names",
    });
  });

  it("a rerank must name only candidates it was shown, each once", () => {
    expect(checkRerank("keep: [System a, Table b]", ["System a", "Table b", "Column c"])).toEqual({
      shown: ["System a", "Table b", "Column c"],
      refs: ["System a", "Table b"],
      used: true,
    });
    expect(checkRerank("keep: [System z]", ["System a"])).toMatchObject({ used: false });
    expect(checkRerank("keep: [System a, System a]", ["System a"])).toMatchObject({ used: false });
  });
});

describe("expansion and rerank in a step", () => {
  it("off by default: no model call before the step's own", async () => {
    const root = await shop();
    const calls: string[] = [];
    const r = await featureStage(root, CHANGE, { runtime: mock(calls), now: NOW });
    expect(calls.filter((c) => c === EXPAND_AGENT || c === RERANK_AGENT)).toEqual([]);
    expect(r.runs.every((x) => x.retrieval === undefined)).toBe(true);
    // With no model to read the brief, its prose names aren't asked about.
    expect(r.context?.gaps ?? []).toEqual([]);
  });

  it("on: one call before the selection, recorded in the step's run record and kept for the next run", async () => {
    const root = await shop();
    const calls: string[] = [];
    const r = await featureStage(root, CHANGE, {
      runtime: mock(calls),
      now: NOW,
      context: { expand: true },
    });
    expect(calls.filter((c) => c === EXPAND_AGENT)).toHaveLength(1);
    const main = r.runs.find((x) => x.agent === "feature-placer")!;
    expect(main.schemaVersion).toBe(3);
    expect(main.retrieval?.expansion).toMatchObject({
      cached: false,
      terms: ["fraud screen", "order risk score"],
      dropped: [
        { name: "Ledger", why: "the input doesn't use the name" },
        { name: "Stockpile", why: "its words aren't in the input" },
      ],
    });
    expect(r.context?.gaps?.map((g) => g.name)).toEqual(["Quillfeather Risk"]);
  });

  it("the same input, index version and model get the stored answer, with no call", async () => {
    const root = await shop();
    const input = { text: "Every order is also scored by Quillfeather Risk; Northwind Pay too." };
    const ask = async (calls: string[]) =>
      expandFor(root, CHANGE, input, {
        runtime: mock(calls),
        now: NOW,
        store: fileJudgments(root),
        levels: ["public", "internal"],
        step: "test",
      });
    const one: string[] = [];
    const a = await ask(one);
    const two: string[] = [];
    const b = await ask(two);
    expect(one).toEqual([EXPAND_AGENT]);
    expect(two).toEqual([]);
    expect("record" in a && a.record.cached).toBe(false);
    expect("record" in b && b.record.cached).toBe(true);
    expect("expansion" in b && b.expansion.names.map((n) => n.name)).toEqual([
      "Northwind Pay",
      "Quillfeather Risk",
    ]);
  });

  it("in hand-off mode: the expansion is a hand-off of its own; resumed with it, the step hands off its own prompt", async () => {
    const root = await shop();
    const rt = new HandoffRuntime({ root, validate: async () => [], now: () => NOW });
    const first = await featureStage(root, CHANGE, {
      runtime: rt,
      now: NOW,
      context: { expand: true },
    });
    expect(first.state).toBe("waiting");
    const runId = first.waiting!.runId;
    const run = JSON.parse(
      await readFile(join(root, ".runs", CHANGE, runId, "run.json"), "utf8"),
    ) as {
      request: { agent: { id: string }; outputPath: string };
    };
    expect(run.request.agent.id).toBe(EXPAND_AGENT);
    await writeFile(join(root, ".runs", CHANGE, runId, run.request.outputPath), EXPANDED);
    expect((await rt.done(runId)).state).toBe("validated");
    const second = await featureStage(root, CHANGE, {
      runtime: new HandoffRuntime({ root, validate: async () => [], now: () => NOW }),
      now: NOW,
      resume: runId,
      context: { expand: true },
    });
    expect(second.state).toBe("waiting");
    expect(second.waiting!.runId).not.toBe(runId);
    const main = JSON.parse(
      await readFile(join(root, ".runs", CHANGE, second.waiting!.runId, "run.json"), "utf8"),
    ) as { request: { agent: { id: string }; retrieval?: { expansion?: { run?: string } } } };
    expect(main.request.agent.id).toBe("feature-placer");
    expect(main.request.retrieval?.expansion?.run).toBe(runId);
  });

  it("rerank: asked only when the candidates don't fit; the fit runs in its order, and an answer naming an unseen candidate is ignored", async () => {
    const root = await shop();
    const calls: string[] = [];
    const r = await findNeeds(root, CHANGE, {
      runtime: mock(calls, {
        [RERANK_AGENT]: "keep: [ProcessDefinition vendor-onboarding]",
        "needs-finder": "needs: []\nnot_needed: []\n",
      }),
      now: NOW,
      maxAttempts: 1,
      context: { rerank: true, tokens: 120 },
    });
    expect(calls).toContain(RERANK_AGENT);
    expect(r.context?.retrieval?.rerank).toMatchObject({
      used: true,
      order: ["ProcessDefinition vendor-onboarding"],
    });
    expect(r.context?.picked[0]?.id).toBe("vendor-onboarding");
    expect(r.context?.leftOut.some((l) => l.why === "the model judged it not needed")).toBe(true);

    const bad: string[] = [];
    const r2 = await findNeeds(await shop(), CHANGE, {
      runtime: mock(bad, {
        [RERANK_AGENT]: "keep: [System nowhere]",
        "needs-finder": "needs: []\nnot_needed: []\n",
      }),
      now: NOW,
      maxAttempts: 1,
      context: { rerank: true, tokens: 120 },
    });
    expect(r2.context?.retrieval?.rerank).toMatchObject({ used: false, order: [] });

    const roomy: string[] = [];
    await findNeeds(await shop(), CHANGE, {
      runtime: mock(roomy, { "needs-finder": "needs: []\nnot_needed: []\n" }),
      now: NOW,
      maxAttempts: 1,
      context: { rerank: true },
    });
    expect(roomy).not.toContain(RERANK_AGENT);
  });
});
