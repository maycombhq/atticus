import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  loadOrgPack,
  parseFacts,
  serializeRecord,
  type CatalogRecord,
  type Fact,
  type OrgPack,
} from "@maycombhq/core";
import { catalogWithFacts, estateFromFacts, joinReposOf } from "../src/index.js";

/**
 * The estate through an Apigee gateway (ADR 0124 addendum A-gateway): the manifest types the
 * gateway's repo `gateway`, so the join follows its routes, and the catalog says the portal's
 * API calls the accounts service via the gateway, at the path the service receives.
 */

const DIR = join(__dirname, "..", "..", "..", "fixtures", "gateway-facts");
const REPOS = ["forge-portal-api", "forge-gateway", "forge-accounts"] as const;
const factsOf = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(DIR, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const all = () => REPOS.map((repo) => ({ repo, facts: factsOf(repo) }));
const text = (rs: readonly CatalogRecord[]) => rs.map((r) => serializeRecord(r)).join("---\n");

let op: OrgPack;
beforeAll(async () => {
  op = await loadOrgPack(join(DIR, "org-pack"));
});

function writeAll(order: readonly string[]): CatalogRecord[] {
  let records: CatalogRecord[] = [];
  for (const repo of order) {
    const out = catalogWithFacts({
      repo,
      facts: factsOf(repo),
      existing: records,
      op,
      decisions: [],
      estate: all().filter((x) => x.repo !== repo),
    });
    expect(out.invalid).toEqual([]);
    records = out.records;
  }
  return records;
}

describe("the estate through a gateway, from facts", () => {
  it("reads the manifest's gateway type for the join", () => {
    expect(joinReposOf(op, all()).map((r) => [r.repo, r.gateway ?? false])).toEqual([
      ["forge-portal-api", false],
      ["forge-gateway", true],
      ["forge-accounts", false],
    ]);
  });

  it("passes each repo's base path to the join, and a module's on the repo's hosts when it lists none (ADR 0134)", () => {
    const withBase: OrgPack = {
      ...op,
      profiles: op.profiles.map((p) => ({
        ...p,
        repos: p.repos && {
          ...p.repos,
          repos: p.repos.repos.map((r) =>
            r.id === "forge-accounts"
              ? {
                  ...r,
                  basePath: "/forge/accounts",
                  modules: [
                    {
                      path: "ledger",
                      component: "ledger-api",
                      hosts: [],
                      basePath: "/forge/ledger",
                    },
                  ],
                }
              : r,
          ),
        },
      })),
    };
    const accounts = joinReposOf(withBase, all()).find((r) => r.repo === "forge-accounts")!;
    expect(accounts.basePath).toBe("/forge/accounts");
    expect(accounts.modules).toEqual([
      { component: "ledger-api", hosts: accounts.hosts, basePath: "/forge/ledger" },
    ]);
  });

  it("records the portal to the service via the gateway's route, with the route's auth", () => {
    const { records } = estateFromFacts({ op, repos: all() });
    const via = records.filter((r) => r.kind === "Interface" && r.via === "gateway");
    expect(
      via.map(
        (r) =>
          r.kind === "Interface" && [r.from, r.to, r.method, r.normalizedPath, r.auth, r.route],
      ),
    ).toEqual([
      [
        "portal-api",
        "accounts-api",
        "POST",
        "/transfers",
        "oauth2",
        "gw-api-gateway-post-forge-v1-accounts-id-transfers",
      ],
      [
        "portal-api",
        "accounts-api",
        "GET",
        "/accounts/{}",
        "api-key",
        "gw-api-gateway-get-forge-v1-accounts-id",
      ],
    ]);
    expect(records.filter((r) => r.kind === "GatewayRoute").map((r) => r.id)).toEqual([
      "gw-api-gateway-get-forge-v1-accounts-id",
      "gw-api-gateway-post-forge-v1-accounts-id-transfers",
    ]);
    // The portal's calls are no longer loose ends at the gateway's host.
    expect(records.filter((r) => r.kind === "Unresolved")).toEqual([]);
  });

  it("is the same catalog whichever repo is written first", () => {
    const one = text(writeAll(REPOS));
    expect(text(writeAll([...REPOS].reverse()))).toBe(one);
    expect(text(writeAll(["forge-gateway", "forge-accounts", "forge-portal-api"]))).toBe(one);
    expect(text(estateFromFacts({ op, repos: all() }).records)).toBe(one);
  });
});
