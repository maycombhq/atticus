import { describe, expect, it } from "vitest";
import type { CatalogRecord } from "@maycombhq/core";
import { carriedTargets } from "../src/build.js";

/**
 * ADR 0124 addendum E-ids, its dated part of 2026-11-21 (the owner: every gap closed): a change
 * of yours that still names a loose end's id from before beta.30 applies, in the build's memory,
 * to the loose end the build names again with its repo, by the upgrade step's rule.
 */
const loose = (id: string, repo: string) =>
  ({
    kind: "Unresolved",
    id,
    owner: repo,
    unresolvedKind: "http-call",
    raw: "GET http://@forgeTargetUrl@/v1/x",
    evidence: [{ source: "code", repo, path: "src/a.ts", line: 3 }],
  }) as unknown as CatalogRecord;
const suppress = (id: string, target: string) =>
  ({
    kind: "CuratedDecision",
    id,
    status: "current",
    action: "suppress",
    target,
    value: null,
  }) as unknown as CatalogRecord;
const records = [
  loose("unresolved.forge-ledger.c-1", "forge-ledger"),
  loose("unresolved.forge-payments.c-1", "forge-payments"),
  loose("unresolved.forge-payments.c-9", "forge-payments"),
];
const targetOf = (r: { decisions: CatalogRecord[] }, id: string) =>
  (r.decisions.find((d) => d.id === id) as { target: string }).target;

describe("a change of an old loose end's id applies to the one the build renamed", () => {
  it("to the repo the old record cited, else the first by id; never onto a named id", () => {
    const first = carriedTargets(records, [suppress("d1", "unresolved.c-1")], {});
    expect(targetOf(first, "d1")).toBe("unresolved.forge-ledger.c-1");
    expect(first.carried).toEqual([
      { decision: "d1", from: "unresolved.c-1", to: "unresolved.forge-ledger.c-1" },
    ]);
    const cited = carriedTargets(records, [suppress("d1", "unresolved.c-1")], {
      "unresolved.c-1": ["forge-payments"],
    });
    expect(targetOf(cited, "d1")).toBe("unresolved.forge-payments.c-1");
    // The cited repo has no such loose end now: left as it is (the build says it waits).
    const gone = carriedTargets(records, [suppress("d1", "unresolved.c-1")], {
      "unresolved.c-1": ["forge-notify"],
    });
    expect(targetOf(gone, "d1")).toBe("unresolved.c-1");
    expect(gone.carried).toEqual([]);
    // Another change names the new id already: neither decides over the other unsaid.
    const named = carriedTargets(
      records,
      [suppress("d1", "unresolved.c-1"), suppress("d2", "unresolved.forge-ledger.c-1")],
      {},
    );
    expect(targetOf(named, "d1")).toBe("unresolved.c-1");
    // A target of the new form, or one in the build, is as it was.
    const asIs = carriedTargets(records, [suppress("d3", "unresolved.forge-payments.c-9")], {});
    expect(asIs.carried).toEqual([]);
  });
});
