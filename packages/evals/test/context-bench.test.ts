import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENGINE_DEFAULT } from "@maycombhq/planner";
import { openIndex } from "@maycombhq/index";
import {
  engineSwitches,
  readRetrievalCases,
  retrievalSwitches,
  renderContextEval,
  retrievalForgeRoot,
  retrievalShopRoot,
  runContextEval,
  toolsHold,
  type ContextEval,
} from "../src/index.js";

// ADR 0107 point 6: the context engine's eval, on the Forge fixtures and their golden answers.

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const FX = join(REPO, "fixtures");

let evalRun: Promise<ContextEval> | undefined;
const theEval = () => (evalRun ??= runContextEval(FX));

describe("the retrieval cases (ADR 0116)", () => {
  it("has about sixty cases in every group, and every id a case needs is in its root", async () => {
    const cases = readRetrievalCases(FX);
    expect(cases.length).toBeGreaterThanOrEqual(60);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    expect([...new Set(cases.map((c) => c.group))].sort()).toEqual(
      [
        "distractor",
        "document",
        "exact",
        "identifier",
        "long-wiki",
        "multi-hop",
        "no-answer",
        "paraphrase",
        "synonym",
      ].sort(),
    );
    const parent = await mkdtemp(join(tmpdir(), "atticus-retrieval-cases-"));
    for (const [name, make] of [
      ["forge", retrievalForgeRoot],
      ["shop", retrievalShopRoot],
    ] as const) {
      const ix = await openIndex(await make(FX, join(parent, name)));
      expect(ix.problems).toEqual([]);
      for (const c of cases.filter((x) => x.root === name))
        for (const n of c.needed)
          if (typeof n === "string") expect(ix.nodes(n).length, `${c.id}: ${n}`).toBeGreaterThan(0);
      ix.close();
    }
  });

  it("scores every case in each mode built, and the switch rule holds", async () => {
    const e = await theEval();
    const cases = readRetrievalCases(FX);
    const lexical = e.retrieval.filter((r) => r.mode === "lexical");
    expect(lexical).toHaveLength(cases.length * 2);
    // An exact name is found by the lexical engine at once.
    for (const r of lexical.filter((x) => x.group === "exact" && x.budget === "normal"))
      expect(r.recall, r.case).toBe(1);
    // The miss the cases reproduce: the identifier's words find renamedAt near the top.
    const renamed = (mode: string) =>
      e.retrieval.find(
        (r) => r.case === "forge-show-renamed-time" && r.mode === mode && r.budget === "tight",
      )!;
    expect(renamed("lexical").rank).toBeGreaterThan(0);
    expect(renamed("lexical").rank).toBeLessThanOrEqual(3);
    expect(renamed("words").rank === 0 || renamed("words").rank > 3).toBe(true);
    // ADR 0116 phase 2: the local model's recorded vectors. Recall holds on every case, and
    // the paraphrases the words miss are found at the normal budget.
    const sw = retrievalSwitches(e.retrieval);
    expect(sw["+embeddings"]).toBe(true);
    const para = (mode: string) =>
      e.retrieval.filter(
        (r) => r.group === "paraphrase" && r.mode === mode && r.budget === "normal",
      );
    const mean = (rs: { recall: number }[]) => rs.reduce((n, r) => n + r.recall, 0) / rs.length;
    expect(mean(para("+embeddings"))).toBeGreaterThan(mean(para("lexical")) + 0.2);
    // ADR 0116 phase 3: the expansion (stand-in answers, replayed through the real step) finds
    // every paraphrase at the normal budget, and recall holds on every case.
    expect(sw["+expansion"]).toBe(true);
    expect(mean(para("+expansion"))).toBe(1);
  }, 900_000); // Windows CI scores every mode in ~7 min; the bar is the result, not the time.
});

describe("the context engine's eval", () => {
  it("scores each step with the whole lists and with the engine, and the checked-in table is up to date", async () => {
    const e = await theEval();
    const rows = e.steps;
    // Four steps, five cases, two budgets, three modes.
    expect(rows).toHaveLength(30);
    // The whole lists drop whole when the budget is tight; the engine fits what matters.
    const at = (step: string, c: string, budget: string, mode: string) =>
      rows.find((r) => r.step === step && r.case === c && r.budget === budget && r.mode === mode)!;
    expect(at("feature", "shop: add-fraud-check", "tight", "whole lists").recall).toBe(0);
    expect(at("feature", "shop: add-fraud-check", "tight", "engine").recall).toBe(1);
    // A step uses the engine by default only where its recall is at least the whole lists'.
    const sw = engineSwitches(rows);
    for (const r of rows.filter((x) => x.mode === "engine" && sw[x.step])) {
      const whole = at(r.step, r.case, r.budget, "whole lists");
      expect(r.recall, `${r.step} ${r.case} ${r.budget}`).toBeGreaterThanOrEqual(whole.recall);
    }
    expect(sw).toEqual(ENGINE_DEFAULT);
    // ADR 0107 addendum: with tools, the scripted model's calls run through the real context
    // tools; at the tight budget they bring back what the pack left out for room.
    const needsTight = at("needs", "shop: add-fraud-check", "tight", "engine");
    const needsTools = at("needs", "shop: add-fraud-check", "tight", "engine + tools");
    expect(needsTools.toolCalls).toBeGreaterThan(0);
    expect(needsTools.recall).toBeGreaterThan(needsTight.recall);
    for (const r of rows.filter((x) => x.mode === "engine + tools")) {
      const engine = at(r.step, r.case, r.budget, "engine");
      expect(r.recall, `${r.step} ${r.case} ${r.budget}`).toBeGreaterThanOrEqual(engine.recall);
    }
    expect(toolsHold(rows)).toEqual({
      needs: true,
      feature: true,
      architecture: true,
      stories: true,
    });
    const doc = readFileSync(join(REPO, "docs/evidence/context-eval.md"), "utf8");
    expect(doc, "run pnpm --filter @maycombhq/evals eval:context").toBe(renderContextEval(e));
  }, 900_000);
});
