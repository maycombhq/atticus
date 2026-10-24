import { describe, expect, it } from "vitest";
import { candidateRef, openIndex, orderCandidates } from "../src/index.js";
import { retrievalRoot } from "./helpers.js";

// ADR 0116 phases 3 and 4, the index's side: a model's expansion of the input (checked by the
// planner) joins the selection as rankings, seeds and names; a model's order of the candidates
// runs the fit. Neither makes a link or changes a score.

describe("the model's expansion, in the selection", () => {
  it("each term is one more ranking, each id a seed, said so in its way in", async () => {
    const ix = await openIndex(await retrievalRoot({ distractors: true }), { embeddings: "off" });
    const input = {
      text: "Let customers set their own spending cap on what can leave an account each day.",
    };
    const plain = ix.selectContext(input, { budget: 600 });
    const helped = ix.selectContext(
      {
        ...input,
        expansion: { terms: ["daily limit amount"], ids: ["ledger-db.account"], unknown: [] },
      },
      { budget: 600 },
    );
    const at = (s: typeof plain) =>
      s.picked.findIndex((p) => p.id === "ledger-db.account.dailylimitamount");
    expect(at(helped)).toBeGreaterThanOrEqual(0);
    expect(at(plain) < 0 || at(helped) <= at(plain)).toBe(true);
    expect(helped.picked.some((p) => /the model's "daily limit amount" #\d/.test(p.via))).toBe(
      true,
    );
    expect(helped.picked.find((p) => p.id === "ledger-db.account")?.via).toBe(
      "named in the input (the model's reading, an id the index has)",
    );
    ix.close();
  });

  it("the gaps are the model's names the index has nothing for; without a model, only names the input marks", async () => {
    const ix = await openIndex(await retrievalRoot(), { embeddings: "off" });
    const text =
      "Send each transfer to Quillfeather Risk and `brambleford-ledger`, then to Northwind Pay.";
    expect(ix.selectContext({ text }, { budget: 2000 }).unknown).toEqual(["brambleford-ledger"]);
    const read = ix.selectContext(
      {
        text,
        expansion: {
          terms: [],
          ids: ["northwind-pay"],
          // The index checks each: Northwind Pay API is a known name with a generic word after it.
          unknown: ["Northwind Pay API", "Quillfeather Risk"],
        },
      },
      { budget: 2000 },
    );
    expect(read.unknown).toEqual(["Quillfeather Risk", "brambleford-ledger"]);
    ix.close();
  });
});

describe("the model's order of the candidates", () => {
  const cands = [
    { kind: "Column", id: "a", score: 0.9 },
    { kind: "Column", id: "b", score: 0.8 },
    { kind: "Table", id: "c", score: 0.7 },
    { kind: "System", id: "d", score: 0.6 },
  ];

  it("runs in the model's order; one it was shown and left off is dropped; one it wasn't shown follows", () => {
    const r = orderCandidates(cands, {
      shown: ["Column a", "Column b", "Table c"],
      refs: ["Table c", "Column a"],
    });
    expect(r.used).toBe(true);
    expect(r.candidates.map(candidateRef)).toEqual(["Table c", "Column a", "System d"]);
    expect(r.dropped.map(candidateRef)).toEqual(["Column b"]);
  });

  it("is ignored when it names one it wasn't shown, or one twice", () => {
    for (const refs of [["System d"], ["Column a", "Column a"], ["Column z"]]) {
      const r = orderCandidates(cands, { shown: ["Column a", "Column b"], refs });
      expect(r.used).toBe(false);
      expect(r.candidates).toEqual(cands);
    }
  });

  it("in a selection: the fit follows it, and a dropped candidate is left out with why", async () => {
    const ix = await openIndex(await retrievalRoot(), { embeddings: "off" });
    const input = { text: "the renamed timestamp on an account" };
    const plain = ix.selectContext(input, { budget: 400 });
    const all = [...plain.picked.map((p) => ({ kind: p.kind, id: p.id })), ...plain.leftOut];
    const shown = all.slice(0, 6).map(candidateRef);
    const keep = [shown[3]!, shown[0]!];
    const s = ix.selectContext(input, { budget: 400, order: { shown, refs: keep } });
    expect(s.picked.slice(0, 2).map(candidateRef)).toEqual(keep);
    const dropped = s.leftOut
      .filter((l) => l.why === "the model judged it not needed")
      .map(candidateRef);
    expect(dropped.sort()).toEqual(shown.filter((x) => !keep.includes(x)).sort());
    // The scores are the engine's.
    const score = new Map(plain.picked.map((p) => [p.id, p.score]));
    for (const p of s.picked) if (score.has(p.id)) expect(p.score).toBe(score.get(p.id));
    ix.close();
  });
});
