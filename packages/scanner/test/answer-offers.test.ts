import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFacts, questionId, type Fact, type Question } from "@maycombhq/core";
import { answerRuleOffers, targetQuestionFor, TARGETS_STEP } from "../src/index.js";

/**
 * ADR 0162 (F8): an answer given the same way in several repos (the same target for calls through
 * the same config key, or on the same host) offers to become one rule (Q2) for the repo type. Never
 * a note: a note saying where calls go is a routing claim no code backs (review item 8). On the
 * invented bank-shaped estate (fixtures/link-estate).
 */

const FIX = join(__dirname, "..", "..", "..", "fixtures", "link-estate");
const factsOf = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(FIX, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const AT = "2026-11-01T12:00:00.000Z";

/** Each repo's one call through forge.limits.base-url, under /limits. */
const payments = factsOf("forge-payments").map((f) =>
  f.id === "call.get.limits-id" ? { ...f, base: "forge.limits.base-url" } : f,
);
const cards = factsOf("forge-cards").map((f) =>
  f.id === "call.get.accounts-id"
    ? { ...f, path: "/limits/{id}/history", base: "forge.limits.base-url" }
    : f,
);

const answered = (repo: string, facts: Fact[], id: string, label: string, match?: string) => {
  const q = targetQuestionFor(facts.find((f) => f.id === id)!)!;
  return {
    id: questionId({ step: TARGETS_STEP, repo, ...q }),
    repo,
    state: "answered",
    question: q.question,
    evidence: q.evidence,
    options: [
      { label: "forge-accounts", means: "m", changes: "c" },
      { label: "forge-cards", means: "m", changes: "c" },
    ],
    answer: {
      option: label === "forge-accounts" ? 1 : 2,
      by: "pat",
      at: AT,
      scope: { level: "repo", id: repo },
      ...(match ? { match } : {}),
    },
    askedBy: { step: TARGETS_STEP, command: "atticus verify", at: AT },
  } as unknown as Question;
};

const repos = [
  { repo: "forge-payments", facts: payments, type: "spring-boot" },
  { repo: "forge-cards", facts: cards, type: "spring-boot" },
];

describe("answerRuleOffers (ADR 0162)", () => {
  it("offers one rule for the repo type for the same answer in two repos, and no note", () => {
    const qs = [
      answered("forge-payments", payments, "call.get.limits-id", "forge-cards"),
      answered("forge-cards", cards, "call.get.accounts-id", "forge-cards"),
    ];
    const [o, ...rest] = answerRuleOffers({ repos, questions: qs });
    expect(rest).toEqual([]);
    const first = [...qs].sort((a, b) => a.id.localeCompare(b.id))[0]!;
    expect(o).toMatchObject({
      via: "through forge.limits.base-url",
      label: "forge-cards",
      repos: ["forge-cards", "forge-payments"],
      match: "/limits/**",
      type: "spring-boot",
      command: `atticus questions answer ${first.id} --option 2 --match "/limits/**" --scope repo-type --type spring-boot`,
    });
    expect(o).not.toHaveProperty("note");
    expect(o!.line).toContain(
      "2 repos (forge-cards, forge-payments) answer the calls through forge.limits.base-url the same way, forge-cards",
    );
    expect(o!.line).toContain(`As a rule: ${o!.command}.`);
    expect(o!.line).not.toMatch(/notes?:|type\.yaml|go to forge-cards/);
  });

  it("offers nothing when the repos share no type, so no rule can cover them", () => {
    const qs = [
      answered("forge-payments", payments, "call.get.limits-id", "forge-cards"),
      answered("forge-cards", cards, "call.get.accounts-id", "forge-cards"),
    ];
    expect(
      answerRuleOffers({
        repos: [
          { repo: "forge-payments", facts: payments, type: "spring-boot" },
          { repo: "forge-cards", facts: cards, type: "node-service" },
        ],
        questions: qs,
      }),
    ).toEqual([]);
  });

  it("offers nothing when the answers differ, for one repo alone, or when a rule says it already", () => {
    expect(
      answerRuleOffers({
        repos,
        questions: [
          answered("forge-payments", payments, "call.get.limits-id", "forge-cards"),
          answered("forge-cards", cards, "call.get.accounts-id", "forge-accounts"),
        ],
      }),
    ).toEqual([]);
    expect(
      answerRuleOffers({
        repos: repos.slice(0, 1),
        questions: [answered("forge-payments", payments, "call.get.limits-id", "forge-cards")],
      }),
    ).toEqual([]);
    expect(
      answerRuleOffers({
        repos,
        questions: [
          answered("forge-payments", payments, "call.get.limits-id", "forge-cards"),
          answered("forge-cards", cards, "call.get.accounts-id", "forge-cards"),
          {
            ...answered(
              "forge-starter",
              payments,
              "call.get.limits-id",
              "forge-cards",
              "/limits/**",
            ),
            id: "q-0000000000aa",
          },
        ],
      }),
    ).toEqual([]);
  });
});
