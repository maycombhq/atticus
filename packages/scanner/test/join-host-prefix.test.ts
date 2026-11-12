import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  forwardHostQuestion,
  joinFacts,
  joinHostOfQuestion,
  parseFacts,
  TARGETS_STEP_ID,
  type Fact,
} from "@maycombhq/core";
import { joinHostQuestionDrafts } from "../src/index.js";

/**
 * Beta.27: the join's question about a gateway's token target URL nothing sets is asked once per
 * token and path prefix, as the targets questions group (Q1, ADR 0168): one question when the
 * token's calls share a prefix, in the join's words as before; one per prefix otherwise, each
 * naming the routes it is about and citing only their lines. On the invented
 * `fixtures/gateway-facts/policy-tokens/` proxy, its token's settings taken out.
 */
const DIR = join(__dirname, "..", "..", "..", "fixtures", "gateway-facts", "policy-tokens");
const PROXY = "northwind_pay_1-0";
const TOKEN = "@targetVendorUrl@";
const proxyFacts = (): Fact[] => {
  const r = parseFacts(readFileSync(join(DIR, "facts", `${PROXY}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts.filter((f) => f.kind !== "config");
};
const draftsOf = (facts: Fact[]) => {
  const join = joinFacts({
    repos: [{ repo: PROXY, component: "northwind-pay-proxy", gateway: true, facts }],
  });
  return joinHostQuestionDrafts({ repo: PROXY, facts, asks: join.asks, records: [], repos: [] });
};

describe("a token's question, once per path prefix (beta.27)", () => {
  it("asks one question per prefix, each citing its routes' lines", () => {
    const drafts = draftsOf(proxyFacts());
    expect(drafts.map((d) => [d.step, d.host, d.factIds, d.draft.evidence])).toEqual([
      [
        TARGETS_STEP_ID,
        TOKEN,
        ["call.get.payments-id", "call.post.payments"],
        ["apiproxy/proxies/default.xml:4", "apiproxy/proxies/default.xml:7"],
      ],
      [
        TARGETS_STEP_ID,
        TOKEN,
        ["call.get.refunds-id", "call.post.refunds"],
        ["apiproxy/proxies/default.xml:10", "apiproxy/proxies/default.xml:13"],
      ],
    ]);
    expect(drafts.map((d) => d.draft.question)).toEqual([
      forwardHostQuestion(TOKEN, PROXY, "/payments"),
      forwardHostQuestion(TOKEN, PROXY, "/refunds"),
    ]);
    expect(drafts[0]!.draft.question).toMatch(
      /target URL for the routes under \/payments\/\*\* is/,
    );
    // Each still reads back as a question about the token (its answer names its calls' target).
    for (const d of drafts) expect(joinHostOfQuestion(d.draft)).toBe(TOKEN);
  });

  it("asks once, in the join's words as before, when the token's calls share a prefix", () => {
    const facts = proxyFacts().filter(
      (f) => f.kind !== "call" || f.id === "call.get.payments-id" || f.id === "call.post.payments",
    );
    const drafts = draftsOf(facts);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.draft.question).toBe(forwardHostQuestion(TOKEN, PROXY));
    expect(drafts[0]!.factIds).toEqual(["call.get.payments-id", "call.post.payments"]);
  });
});
