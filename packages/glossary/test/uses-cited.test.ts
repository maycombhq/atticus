import { describe, expect, it } from "vitest";
import { usesCited } from "../src/index.js";

/**
 * ADR 0195 (CS2), CLAUDE.md rule 6: a term made from several repos' code cites each of them, so
 * a change to one repo changes only records with its evidence. Invented Forge repos.
 */
const use = (record: string, repo?: string) => ({
  record,
  evidence: repo
    ? { source: "code" as const, repo, path: `${record}.ts`, line: 1 }
    : { source: "document" as const, path: `${record}.md`, line: 1 },
});

describe("the uses a code term cites", () => {
  it("are each repo's first use by record id, by repo id, then further uses up to five", () => {
    const uses = [
      use("a-ledger-1", "forge-ledger"),
      use("b-ledger-2", "forge-ledger"),
      use("c-ledger-3", "forge-ledger"),
      use("d-ledger-4", "forge-ledger"),
      use("e-ledger-5", "forge-ledger"),
      use("f-ledger-6", "forge-ledger"),
      use("z-orders-1", "forge-orders"),
    ];
    expect(usesCited(uses).map((u) => u.record)).toEqual([
      "a-ledger-1",
      "z-orders-1",
      "b-ledger-2",
      "c-ledger-3",
      "d-ledger-4",
    ]);
  });

  it("cite every repo even past five, and are the same whatever order the uses came in", () => {
    const repos = ["forge-a", "forge-b", "forge-c", "forge-d", "forge-e", "forge-f"];
    const uses = repos.flatMap((r) => [use(`${r}-2`, r), use(`${r}-1`, r)]).reverse();
    const cited = usesCited(uses).map((u) => u.record);
    expect(cited).toEqual(repos.map((r) => `${r}-1`));
    expect(usesCited([...uses].reverse()).map((u) => u.record)).toEqual(cited);
  });

  it("count a use with no repo as a further use", () => {
    expect(usesCited([use("doc"), use("x", "forge-ledger")]).map((u) => u.record)).toEqual([
      "x",
      "doc",
    ]);
  });
});
