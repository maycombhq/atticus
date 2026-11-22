import { describe, expect, it } from "vitest";
import { oldLooseEndId, type CatalogRecord } from "@maycombhq/core";
import { oldIdsNamedOf } from "../src/build.js";

/**
 * ADR 0124 addendum E-ids, its dated part of 2026-11-22 (the owner: one deterministic rule): a
 * build that would name a loose end of the old form again with its repo while an input still
 * names the old id refuses, so `atticus upgrade` renames it and carries the input in one write.
 * `oldIdsNamedOf` is what the build tells that by: from its records before the decisions apply
 * and the ids its inputs name, never from this machine's files.
 */
const loose = (id: string, repo: string, extra: Record<string, unknown> = {}) =>
  ({
    kind: "Unresolved",
    id,
    owner: repo,
    unresolvedKind: "http-call",
    raw: "GET http://@forgeTargetUrl@/v1/x",
    evidence: [{ source: "code", repo, path: "src/a.ts", line: 3 }],
    ...extra,
  }) as unknown as CatalogRecord;
/** A listener of a component whose id has a dot (a manifest module's). */
const dotted = loose("unresolved.forge-notify.forge-notify.jobs.on-settled", "forge-notify", {
  owner: "forge-notify.jobs",
  unresolvedKind: "event-subscribe",
  raw: "subscribe settled",
});
const records = [
  loose("unresolved.forge-ledger.c-1", "forge-ledger"),
  loose("unresolved.forge-payments.c-1", "forge-payments"),
  loose("unresolved.forge-payments.c-9", "forge-payments"),
  dotted,
];
const DEC = "catalog/curated/curateddecision/d1.yaml";
const CHANGE = "openspec/changes/x/change.yaml";

describe("a build tells the old ids its inputs name that it would name again with their repo", () => {
  it("lists each, with the ids it has under its repos and the inputs that name it", () => {
    const named = new Map([
      ["unresolved.c-1", [DEC]],
      ["unresolved.forge-notify.jobs.on-settled", [CHANGE]],
      // An id of the new form, and an old one no loose end of this build has: none.
      ["unresolved.forge-payments.c-9", [CHANGE]],
      ["unresolved.c-404", [DEC]],
    ]);
    expect(oldIdsNamedOf(records, named)).toEqual([
      {
        old: "unresolved.c-1",
        ids: ["unresolved.forge-ledger.c-1", "unresolved.forge-payments.c-1"],
        inputs: [DEC],
      },
      {
        old: "unresolved.forge-notify.jobs.on-settled",
        ids: ["unresolved.forge-notify.forge-notify.jobs.on-settled"],
        inputs: [CHANGE],
      },
    ]);
  });

  it("tells a listener of a dotted component by its record, where the id alone can't (I1)", () => {
    // The words-only test misses it: three parts after the prefix.
    expect(oldLooseEndId("unresolved.forge-notify.jobs.on-settled")).toBe(false);
    expect(
      oldIdsNamedOf([dotted], new Map([["unresolved.forge-notify.jobs.on-settled", [CHANGE]]])),
    ).toHaveLength(1);
  });

  it("lists none where the build keeps the old id as a record (a legacy repo's, kept as adopted)", () => {
    const legacy = loose("unresolved.c-1", "forge-payments");
    expect(oldIdsNamedOf([...records, legacy], new Map([["unresolved.c-1", [DEC]]]))).toEqual([]);
  });

  it("lists none when nothing names an old id: a normal build renames them", () => {
    expect(oldIdsNamedOf(records, new Map())).toEqual([]);
  });
});
