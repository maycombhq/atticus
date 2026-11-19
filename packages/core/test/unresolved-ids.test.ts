import { describe, expect, it } from "vitest";
import { projectFacts, unresolvedIdsNow, type CatalogRecord, type Fact } from "../src/index.js";

/**
 * ADR 0124 addendum (E-ids, 2026-11-19): an Unresolved record's id carries its repo,
 * `unresolved.<repo>.<fact id>`, so two repos' loose calls with the same fact id are two records,
 * not one the catalog merge folds together.
 */

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const base = (repo: string) => ({
  repo,
  commit: COMMIT,
  verified: "line",
  by: "assistant",
  conf: "declared",
});
const entry = (repo: string): Fact =>
  ({
    ...base(repo),
    kind: "entry",
    id: "e-0",
    entryType: "rest",
    method: "GET",
    path: "/v1/accounts/{id}",
    handler: "get",
    cite: { file: "src/Web.java", line: 1, value: "/v1/accounts/{id}", quote: "@GetMapping" },
  }) as unknown as Fact;
/** A call to a deploy token nothing sets: no target, so a loose end. */
const loose = (repo: string, path: string): Fact =>
  ({
    ...base(repo),
    kind: "call",
    id: "c-1",
    callType: "rest",
    method: "GET",
    path,
    host: "@forgeTargetUrl@",
    from: "e-0",
    cite: { file: "src/Client.java", line: 3, value: path, quote: `rest.get("${path}")` },
  }) as unknown as Fact;

const ledger = [entry("forge-ledger"), loose("forge-ledger", "/v1/rates/{id}")];
const payments = [entry("forge-payments"), loose("forge-payments", "/v1/fx/{id}")];
const unresolvedOf = (rs: readonly CatalogRecord[]) =>
  rs.filter((r) => r.kind === "Unresolved") as (CatalogRecord & { raw: string })[];

describe("an Unresolved record's id carries its repo (ADR 0124 addendum E-ids)", () => {
  it("is unresolved.<repo>.<fact id>", () => {
    const out = projectFacts(ledger);
    expect(out.ids["c-1"]).toBe("unresolved.forge-ledger.c-1");
    expect(unresolvedOf(out.records).map((r) => r.id)).toEqual(["unresolved.forge-ledger.c-1"]);
  });

  it("gives the same fact id in two repos two records, not one", () => {
    const a = unresolvedOf(projectFacts(ledger).records);
    const b = unresolvedOf(projectFacts(payments).records);
    expect(a[0]!.id).not.toBe(b[0]!.id);
    // Projected together (the estate's facts at once), still two, each with its own call.
    const both = unresolvedOf(projectFacts([...ledger, ...payments]).records);
    expect(both.map((r) => [r.id, r.raw])).toEqual([
      ["unresolved.forge-ledger.c-1", "GET @forgeTargetUrl@ /v1/rates/{id}"],
      ["unresolved.forge-payments.c-1", "GET @forgeTargetUrl@ /v1/fx/{id}"],
    ]);
  });

  it("uses the repo's id as the other record ids do (a dotted repo id's dots made dashes)", () => {
    const dotted = [entry("forge.instruments.svc"), loose("forge.instruments.svc", "/v1/x")];
    expect(projectFacts(dotted).ids["c-1"]).toBe("unresolved.forge-instruments-svc.c-1");
  });

  it("an id of the old form is named again with its repo, once per repo its evidence names", () => {
    const rec = (id: string, repos: string[], kind = "call", owner = "ledger-api") =>
      ({
        kind: "Unresolved",
        schemaVersion: 5,
        id,
        status: "current",
        confidence: "inferred",
        unresolvedKind: kind,
        raw: "GET /x",
        owner,
        evidence: repos.map((repo) => ({ source: "code", repo, path: "a", line: 1 })),
      }) as unknown as CatalogRecord;
    // A call's old id: no repo; a collision's record names both repos.
    expect(unresolvedIdsNow(rec("unresolved.c-1", ["forge-ledger"]))).toEqual([
      "unresolved.forge-ledger.c-1",
    ]);
    expect(unresolvedIdsNow(rec("unresolved.c-1", ["forge-payments", "forge-ledger"]))).toEqual([
      "unresolved.forge-ledger.c-1",
      "unresolved.forge-payments.c-1",
    ]);
    // Already of the new form: itself.
    expect(unresolvedIdsNow(rec("unresolved.forge-ledger.c-1", ["forge-ledger"]))).toEqual([
      "unresolved.forge-ledger.c-1",
    ]);
    // A listener's old id is its Endpoint's (`<component>.<name>`); the new one adds the repo.
    const sub = (id: string) => rec(id, ["forge-notify"], "event-subscribe", "forge-notify");
    expect(unresolvedIdsNow(sub("unresolved.forge-notify.on-settled"))).toEqual([
      "unresolved.forge-notify.forge-notify.on-settled",
    ]);
    expect(unresolvedIdsNow(sub("unresolved.forge-notify.forge-notify.on-settled"))).toEqual([
      "unresolved.forge-notify.forge-notify.on-settled",
    ]);
    // A listener of a component whose id has a dot (a manifest module's): told by its owner.
    const dotted = (id: string) => rec(id, ["forge-notify"], "event-subscribe", "notify.api");
    expect(unresolvedIdsNow(dotted("unresolved.notify.api.on-settled"))).toEqual([
      "unresolved.forge-notify.notify.api.on-settled",
    ]);
    expect(unresolvedIdsNow(dotted("unresolved.forge-notify.notify.api.on-settled"))).toEqual([
      "unresolved.forge-notify.notify.api.on-settled",
    ]);
    // Not a loose end the facts projection makes (a built-in reader's), or no repo: none.
    expect(unresolvedIdsNow(rec("ledger-api.http-call.abc123", ["forge-ledger"]))).toEqual([]);
    expect(unresolvedIdsNow(rec("unresolved.c-1", []))).toEqual([]);
  });
});
