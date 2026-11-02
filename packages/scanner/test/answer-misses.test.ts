import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  loadOrgPack,
  parseFacts,
  questionId,
  type Fact,
  type OrgPack,
  type Question,
} from "@maycombhq/core";
import {
  answeredQuestionOfCall,
  answerReconfirmed,
  catalogWithFacts,
  targetQuestionFor,
  TARGETS_STEP,
} from "../src/index.js";

/**
 * ADR 0162 (F8): a call a person's answer sends to a repo that is read, where no route of it
 * serves the call, is said on the write of the caller and of the repo named, so its question opens
 * again. On the invented bank-shaped estate (fixtures/link-estate).
 */

const FIX = join(__dirname, "..", "..", "..", "fixtures", "link-estate");
const factsOf = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(FIX, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const REPOS = ["forge-accounts", "forge-payments", "forge-cards", "forge-notifications"];
let op: OrgPack;
beforeAll(async () => {
  op = await loadOrgPack(join(FIX, "org-pack"));
});

const write = (repo: string, answers: Record<string, Record<string, string>>) =>
  catalogWithFacts({
    repo,
    facts: factsOf(repo),
    existing: [],
    op,
    decisions: [],
    targets: answers[repo] ?? {},
    estate: REPOS.filter((r) => r !== repo).map((r) => ({ repo: r, facts: factsOf(r) })),
    estateTargets: Object.fromEntries(Object.entries(answers).filter(([r]) => r !== repo)),
  });

describe("answerMisses (ADR 0162)", () => {
  it("says an answer naming a read repo that serves no such route, on both writes", () => {
    const wrong = { "forge-payments": { "call.get.limits-id": "forge-notifications" } };
    const caller = write("forge-payments", wrong);
    expect(caller.answerMisses?.map((m) => [m.call.fact, m.target])).toEqual([
      ["call.get.limits-id", "forge-notifications"],
    ]);
    const named = write("forge-notifications", wrong);
    expect(named.answerMisses?.map((m) => m.call.fact)).toEqual(["call.get.limits-id"]);
    // Another repo's write says nothing of it.
    expect(write("forge-accounts", wrong).answerMisses).toBeUndefined();
  });

  it("says nothing when the repo named serves the call", () => {
    const right = { "forge-payments": { "call.get.limits-id": "forge-cards" } };
    expect(write("forge-payments", right).answerMisses).toBeUndefined();
    expect(write("forge-cards", right).answerMisses).toBeUndefined();
  });
});

describe("answeredQuestionOfCall (ADR 0162)", () => {
  const AT = "2026-11-01T12:00:00.000Z";
  const facts = factsOf("forge-payments");
  const q = (match?: string) => {
    const own = targetQuestionFor(facts.find((f) => f.id === "call.get.limits-id")!)!;
    return {
      schemaVersion: 4,
      id: questionId({ step: TARGETS_STEP, repo: "forge-payments", ...own }),
      repo: "forge-payments",
      state: "answered",
      question: own.question,
      evidence: own.evidence,
      options: [{ label: "forge-notifications", means: "m", changes: "c" }],
      answer: {
        option: 1,
        by: "pat",
        at: AT,
        scope: { level: "repo", id: "forge-payments" },
        ...(match ? { match } : {}),
      },
      askedBy: { step: TARGETS_STEP, command: "atticus verify", at: AT },
    } as unknown as Question;
  };

  it("finds the call's own answered question", () => {
    expect(answeredQuestionOfCall("forge-payments", facts, [q()], "call.get.limits-id")?.id).toBe(
      q().id,
    );
  });

  it("never names a question answered by rule (Q2): one call doesn't reopen a rule", () => {
    expect(
      answeredQuestionOfCall("forge-payments", facts, [q("/limits/**")], "call.get.limits-id"),
    ).toBeUndefined();
  });
});

describe("answerReconfirmed (review item 2)", () => {
  const AT = "2026-11-01T12:00:00.000Z";
  const base = {
    state: "answered",
    options: [
      { label: "notify-api", means: "m", changes: "c" },
      { label: "northwind-fx", means: "m", changes: "c" },
    ],
  };
  const a = (x: { option?: number; text?: string }) => ({
    ...x,
    by: "pat",
    at: AT,
    scope: { level: "repo", id: "forge-ledger" },
  });
  const q = (now: { option?: number; text?: string }, was?: { option?: number; text?: string }) =>
    ({
      ...base,
      answer: a(now),
      ...(was ? { reopened: { at: AT, why: "w", answer: a(was) } } : {}),
    }) as unknown as Question;

  it("is the answer it had when it reopened, by option or in the same words", () => {
    expect(answerReconfirmed(q({ option: 1 }, { option: 1 }))).toBe(true);
    expect(answerReconfirmed(q({ text: "Notify API" }, { option: 1 }))).toBe(true);
  });
  it("isn't a question that never reopened, or a different answer", () => {
    expect(answerReconfirmed(q({ option: 1 }))).toBe(false);
    expect(answerReconfirmed(q({ option: 2 }, { option: 1 }))).toBe(false);
  });
});
