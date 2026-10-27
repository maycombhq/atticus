import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFacts, type Fact } from "@maycombhq/core";
import { dirSource, verifyFacts } from "../src/index.js";

/**
 * A prototype's facts are verified like any repo's (ADR 0133): the screens' calls, the BFF's
 * routes with the auth and scopes its sign-on configuration gives them, the BFF's calls, and the
 * mocks (an MSW handler, a WireMock mapping) with the fields they accept and return, each on its
 * line. The estate the prototype is compared with verifies too. Fixture:
 * fixtures/prototype-compare (invented).
 */
const FIX = join(__dirname, "..", "..", "..", "fixtures", "prototype-compare");
const COMMITS: Record<string, string> = {
  "forge-checkout-prototype": "ccc3333",
  "forge-shop-bff": "aaa1111",
  "forge-billing": "bbb2222",
  "forge-partner-gateway": "eee5555",
};
const facts = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(FIX, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};

describe("the prototype-compare fixture's facts verify", () => {
  it.each(Object.keys(COMMITS))("%s: every fact kept, every auth cited", async (repo) => {
    const r = await verifyFacts({
      facts: facts(repo),
      source: dirSource(join(FIX, "repos", repo)),
      commit: COMMITS[repo],
    });
    expect(r.rejected).toEqual([]);
    expect(r.accepted).toHaveLength(facts(repo).length);
    expect(r.authUncited).toEqual([]);
  });

  it("rejects a scope the sign-on configuration doesn't name, and the call under that route", async () => {
    const repo = "forge-checkout-prototype";
    const edited = facts(repo).map((f): Fact => {
      if (f.id === "entry.bff.get.loyalty-summary" && f.kind === "entry")
        return { ...f, scopes: [{ ...f.scopes![0]!, value: "shop.rewards" }] };
      return f;
    });
    const r = await verifyFacts({
      facts: edited,
      source: dirSource(join(FIX, "repos", repo)),
      commit: COMMITS[repo],
    });
    // The BFF's call under the rejected route goes with it.
    expect(r.rejected.map((x) => x.fact.id).sort()).toEqual([
      "call.bff.get.loyalty-sub-balance",
      "entry.bff.get.loyalty-summary",
    ]);
  });
});
