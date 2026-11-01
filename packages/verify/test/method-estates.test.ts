import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFacts } from "@maycombhq/core";
import { dirSource, verifyFacts } from "../src/index.js";

/**
 * P2, measured (ADR 0157): the method note over every fixture estate that has its source. Before
 * the chain and the forwarding route were read, 7 of the 78 entries and calls that claim a method
 * were noted, every one a false note: 2 fluent clients whose `http.post()` opens the chain above
 * the cited `.uri(...)` line, and 5 gateway forwards whose method is the route's, written on its
 * `<Condition>`. None was a reader's slip. The counts are pinned so a change to the check, or to
 * a fixture, that makes a note shows here.
 */

const FIXTURES = join(__dirname, "..", "..", "..", "fixtures");
const estates: [name: string, facts: string, repo: string][] = [];
for (const est of ["link-estate", "gateway-facts", "gateway-chain"])
  for (const f of readdirSync(join(FIXTURES, est, "facts")).sort()) {
    const repo = f.replace(/\.jsonl$/, "");
    if (f.endsWith(".jsonl") && existsSync(join(FIXTURES, est, "repos", repo)))
      estates.push([
        `${est}/${repo}`,
        join(FIXTURES, est, "facts", f),
        join(FIXTURES, est, "repos", repo),
      ]);
  }
estates.push(
  [
    "verify-read/forge-limits",
    join(FIXTURES, "verify-read", "forge-limits.facts.jsonl"),
    join(FIXTURES, "verify-read", "repo"),
  ],
  [
    "verify-skipped/forge-wallet",
    join(FIXTURES, "verify-skipped", "forge-wallet.facts.jsonl"),
    join(FIXTURES, "verify-skipped", "repo"),
  ],
  [
    "verify/test/fixtures/forge-ledger",
    join(__dirname, "fixtures", "forge-ledger.facts.jsonl"),
    join(__dirname, "fixtures", "repo"),
  ],
);

/** Per repo: the kept entries and calls that claim a method, and how many of them are noted. */
const PINNED: Record<string, [claimed: number, unseen: number]> = {
  "link-estate/forge-accounts": [5, 0],
  "link-estate/forge-cards": [4, 0],
  "link-estate/forge-deploy-config": [0, 0],
  "link-estate/forge-notifications": [4, 0],
  "link-estate/forge-payments": [6, 0],
  "link-estate/forge-portal-bff": [5, 0],
  "link-estate/forge-proxy-accounts-v1": [2, 0],
  "link-estate/forge-proxy-northwind-v1": [2, 0],
  "link-estate/forge-proxy-payments-v1": [2, 0],
  "link-estate/forge-starter": [1, 0],
  "gateway-facts/forge-accounts": [2, 0],
  "gateway-facts/forge-gateway": [4, 0],
  "gateway-facts/forge-portal-api": [2, 0],
  "gateway-chain/forge-edge-gateway": [12, 0],
  "gateway-chain/forge-orders": [3, 0],
  "gateway-chain/forge-orders-sandbox": [1, 0],
  "gateway-chain/forge-partner-gateway": [6, 0],
  "gateway-chain/forge-refunds": [3, 0],
  "gateway-chain/forge-shop-bff": [2, 0],
  "gateway-chain/northwind-pay-api": [2, 0],
  "verify-read/forge-limits": [2, 0],
  "verify-skipped/forge-wallet": [4, 0],
  "verify/test/fixtures/forge-ledger": [4, 0],
};

describe("the method note over the fixture estates (P2, measured)", () => {
  it("reads every estate with source", () => {
    expect(estates.map(([n]) => n).sort()).toEqual(Object.keys(PINNED).sort());
  });

  for (const [name, factsFile, repo] of estates)
    it(`notes ${PINNED[name]?.[1]} of ${name}'s methods`, async () => {
      const r = parseFacts(readFileSync(factsFile, "utf8"));
      if (!r.ok) throw new Error(JSON.stringify(r.issues));
      const report = await verifyFacts({
        facts: r.facts,
        source: dirSource(repo),
        ...(r.facts[0] ? { commit: r.facts[0].commit } : {}),
      });
      const claimed = report.accepted.filter(
        (f) => (f.kind === "entry" || f.kind === "call") && f.method,
      ).length;
      expect([claimed, report.methodUnseen.length], JSON.stringify(report.methodUnseen)).toEqual(
        PINNED[name],
      );
    });
});
