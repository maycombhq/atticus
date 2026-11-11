import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  forwardHostQuestion,
  ignoreOption,
  loadOrgPack,
  NO_TARGET,
  parseFacts,
  type Fact,
  type OrgPack,
  type Question,
} from "@maycombhq/core";
import {
  catalogWithFacts,
  targetQuestionDrafts,
  targetsFromAnswers,
  TARGETS_STEP,
} from "../src/index.js";

/**
 * Beta.24 review: an Ignore answer to a targets question (its option, or `Ignore: <reason>`)
 * reads as "None of these": the join leaves the call, and no record, box or arrow takes the
 * answer's words as a name. On the invented estate (fixtures/estate-facts).
 */

const ESTATE = join(__dirname, "..", "..", "..", "fixtures", "estate-facts");
const notes = (): Fact[] => {
  const r = parseFacts(readFileSync(join(ESTATE, "relative", "forge-notes.jsonl"), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};

let op: OrgPack;
beforeAll(async () => {
  op = await loadOrgPack(join(ESTATE, "org-pack"));
});

describe("an Ignore answer (beta.24 review)", () => {
  const ask = () => {
    const first = catalogWithFacts({
      repo: "forge-notes",
      facts: notes(),
      existing: [],
      op,
      decisions: [],
      estate: [],
    });
    return targetQuestionDrafts(notes(), first.records, op, first.join?.asks).find(
      (d) => d.factId === "c-archive",
    )!;
  };
  const answered = (answer: { option?: number; text?: string }, withIgnore: boolean) => {
    const q = ask();
    const options = withIgnore ? [...q.draft.options, ignoreOption()] : q.draft.options;
    return {
      id: q.id,
      state: "answered",
      question: q.draft.question,
      options,
      evidence: q.draft.evidence,
      answer: { ...answer, by: "pat", at: "2026-11-10T12:00:00.000Z" },
      askedBy: { step: TARGETS_STEP },
    } as unknown as Question;
  };

  for (const [what, q] of [
    ["the Ignore option", () => answered({ option: ask().draft.options.length + 1 }, true)],
    ["Ignore with a reason", () => answered({ text: "Ignore: its cicd related" }, false)],
  ] as const)
    it(`leaves the call, with ${what}, and draws no box for it`, () => {
      const targets = targetsFromAnswers("forge-notes", notes(), [q()]);
      expect(targets).toEqual({ "c-archive": NO_TARGET });
      const again = catalogWithFacts({
        repo: "forge-notes",
        facts: notes(),
        existing: [],
        op,
        decisions: [],
        estate: [],
        targets,
      });
      expect(again.invalid).toEqual([]);
      expect(again.join?.asks).toEqual([]);
      expect(again.join?.joins.some((j) => j.call.fact === "c-archive")).toBe(false);
      expect(again.join?.outside ?? []).toEqual([]);
      const text = JSON.stringify(again.records);
      expect(text).not.toMatch(/ignore|cicd/i);
    });

  it("reads the join's host question by its host's whole words, a `?` in the host and all (beta.25)", () => {
    // A call whose host is a token with a `?` in it: the join asks of it whole.
    for (const host of ["${PROD ? A_URL : B_URL}", "${A_URL ?? B_URL}", "{{ url }}?"]) {
      const facts = notes().map((f) => (f.id === "c-archive" ? ({ ...f, host } as Fact) : f));
      const q = {
        id: "q-join-host",
        repo: "forge-notes",
        state: "answered",
        question: forwardHostQuestion(host, "forge-notes"),
        options: [ignoreOption()],
        evidence: ["web/src/notes/notes-api.ts:99"],
        answer: { option: 1, by: "pat", at: "2026-11-10T12:00:00.000Z" },
        askedBy: { step: TARGETS_STEP },
      } as unknown as Question;
      expect(targetsFromAnswers("forge-notes", facts, [q]), host).toEqual({
        "c-archive": NO_TARGET,
      });
    }
  });
});
