import { describe, expect, it } from "vitest";
import type { CatalogRecord } from "@maycombhq/core";
import { renamedIdsOf, renamedLooseEnds, renamedWords } from "../src/build.js";

/**
 * ADR 0124 addendum E-ids (the owner, 2026-11-19): a loose end of the form before beta.30 that a
 * build removes while it adds its repo's id is a rename, counted toward no removal limit. A
 * listener is told by its owner (its component), whose id may have a dot of its own (a manifest
 * module's), never by counting dots (the review of 93ddfc5e).
 */
const loose = (id: string, repo: string, kind: string, owner: string) =>
  ({
    kind: "Unresolved",
    id,
    owner,
    unresolvedKind: kind,
    raw: "x",
    evidence: [{ source: "code", repo, path: "src/a.ts", line: 3 }],
  }) as unknown as CatalogRecord;

describe("a loose end named again with its repo is a rename", () => {
  it("a listener of a component whose id has a dot, and a call", () => {
    const oldListener = loose(
      "unresolved.notify.api.on-forge-payments-settled",
      "forge-notify",
      "event-subscribe",
      "notify.api",
    );
    const newListener = loose(
      "unresolved.forge-notify.notify.api.on-forge-payments-settled",
      "forge-notify",
      "event-subscribe",
      "notify.api",
    );
    const oldCall = loose("unresolved.c-1", "forge-ledger", "http-call", "forge-ledger");
    const newCall = loose(
      "unresolved.forge-ledger.c-1",
      "forge-ledger",
      "http-call",
      "forge-ledger",
    );
    expect(renamedLooseEnds([oldListener, oldCall], [newListener, newCall])).toEqual(
      new Map([
        [`Unresolved/${oldListener.id}`, [newListener.id]],
        ["Unresolved/unresolved.c-1", ["unresolved.forge-ledger.c-1"]],
      ]),
    );
    // A new-form listener removed is a loss, not a rename.
    expect(renamedLooseEnds([newListener], [oldListener]).size).toBe(0);
  });

  it("reads back the ids its words name, and nothing from other words", () => {
    const ids = ["unresolved.forge-ledger.c-1", "unresolved.forge-payments.c-1"];
    expect(renamedIdsOf(renamedWords(ids))).toEqual(ids);
    expect(renamedIdsOf(renamedWords([ids[0]!]))).toEqual([ids[0]]);
    expect(renamedIdsOf("the build changed (2.0.0-beta.28.1 to 2.0.0-beta.30)")).toBeUndefined();
  });
});
