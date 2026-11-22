/** Facts and claims made in memory for the review tests of ADR 0206; no file, no model, no network. */
import type { Fact } from "@maycombhq/core";
import { conformClaims, type Claim, type ClaimsInput } from "../src/index.js";

export const OPS = "target-flows/_operations.yaml";
export const fact = (x: Record<string, unknown>): Fact =>
  ({
    repo: "forge-ledger",
    commit: "bbbbbbb",
    verified: "line",
    by: "assistant",
    conf: "declared",
    ...x,
  }) as unknown as Fact;
export const claim = (
  check: Claim["check"],
  expect: Claim["expect"],
  x: Partial<Claim> = {},
): Claim => ({
  repo: "forge-ledger",
  check,
  expect,
  words: "w",
  from: { file: OPS, line: 8, operation: "op-1" },
  ...x,
});
export const PLAIN = ["plain", "literal", "word"].join("");
export const run = (
  claims: Claim[],
  after: Fact[],
  lines: Record<string, string[]>,
  o: Partial<ClaimsInput> = {},
) =>
  conformClaims({
    change: "move-orders-to-anvil",
    changesRel: "openspec/changes",
    repo: "forge-ledger",
    claims,
    before: [],
    after,
    files: [],
    basis: { from: "facts", unread: [] },
    lineAt: (p, l) => lines[p]?.[l - 1],
    ...o,
  });
