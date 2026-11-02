import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadOrgPack, parseFacts, type Fact, type OrgPack } from "@maycombhq/core";
import { catalogWithFacts } from "../src/index.js";

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
