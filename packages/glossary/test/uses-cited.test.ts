import { describe, expect, it } from "vitest";
import { usesCited } from "../src/index.js";

/**
 * ADR 0195 (CS2), CLAUDE.md rule 6: a term made from several repos' code cites each of them, so
 * a change to one repo changes only records with its evidence. Invented Forge repos.
 */
const use = (record: string, repo?: string) => ({
  record,
  evidence: repo
    ? { source: "code" as const, repo, path: record, line: 1 }
    : { source: "document" as const, path: record, line: 1 },
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
    expect(usesCited(uses).map((e) => e.path)).toEqual([
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
    const cited = usesCited(uses).map((e) => e.path);
    expect(cited).toEqual(repos.map((r) => `${r}-1`));
    expect(usesCited([...uses].reverse()).map((e) => e.path)).toEqual(cited);
  });

  it("cite a join's evidence of each repo it joins", () => {
    const join = {
      record: "if-ledger-orders",
      evidence: { source: "code" as const, repo: "forge-ledger", path: "pub", line: 1 },
      all: [
        { source: "code" as const, repo: "forge-ledger", path: "pub", line: 1 },
        { source: "code" as const, repo: "forge-orders", path: "sub", line: 2 },
      ],
    };
    expect(usesCited([join]).map((e) => e.path)).toEqual(["pub", "sub"]);
  });

  it("count a use with no repo as a further use", () => {
    expect(usesCited([use("doc"), use("x", "forge-ledger")]).map((e) => e.path)).toEqual([
      "x",
      "doc",
    ]);
  });
});
