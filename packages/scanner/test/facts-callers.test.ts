import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  loadOrgPack,
  parseFacts,
  parseRecord,
  serializeRecord,
  type CatalogRecord,
  type Fact,
  type OrgPack,
} from "@maycombhq/core";
import { catalogWithFacts, estateFromFacts } from "../src/index.js";

/**
 * Who a gateway route lets in, in the catalog (ADR 0124 addendum A-callers), on the invented
 * `fixtures/gateway-chain/`: the consumers the edge gateway's forge-refunds-v1 routes name become
 * AccessGrants on their GatewayRoutes, and Harbor Desk, declared in the profile and never scanned,
 * becomes an asserted Interface from its System through the route to the refunds service.
 */

const DIR = join(__dirname, "..", "..", "..", "fixtures", "gateway-chain");
const REPOS = [
  "forge-shop-bff",
  "forge-edge-gateway",
  "forge-orders",
  "forge-partner-gateway",
  "northwind-pay-api",
  "forge-orders-sandbox",
  "forge-refunds",
] as const;
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

/** The org pack with Harbor Desk's declaration taken out, as a person would. */
const undeclared = (): OrgPack => ({
  ...op,
  profiles: op.profiles.map((p) => ({
    ...p,
    ...(p.profile
      ? {
          profile: {
            ...p.profile,
            systems: p.profile.systems.map(({ calls: _, ...s }) => s),
          },
        }
      : {}),
  })),
});

function writeAll(order: readonly string[], pack = op, start: CatalogRecord[] = []) {
  let records = start;
  for (const repo of order) {
    const out = catalogWithFacts({
      repo,
      facts: factsOf(repo),
      existing: records,
      op: pack,
      decisions: [],
      estate: all().filter((x) => x.repo !== repo),
    });
    expect(out.invalid).toEqual([]);
    records = out.records;
  }
  return records;
}

const of = <K extends CatalogRecord["kind"]>(rs: readonly CatalogRecord[], kind: K) =>
  rs.filter((r) => r.kind === kind) as Extract<CatalogRecord, { kind: K }>[];

describe("the callers of a gateway route, in the catalog", () => {
  it("loads the declaration from the profile", () => {
    const harbor = op.profiles[0]!.profile!.systems.find((s) => s.id === "harbor-desk")!;
    expect(harbor.calls).toEqual([{ as: "app", name: "harbor-desk-portal" }]);
  });

  it("records each named consumer as an AccessGrant on its route, and the route's API product", () => {
    const { records } = estateFromFacts({ op, repos: all() });
    expect(
      of(records, "AccessGrant").map((g) => `${g.resource} ${g.subjectKind} ${g.subject}`),
    ).toEqual([
      "gw-edge-gateway-get-forge-refunds-v1-refunds-id oauth-client forge-ops-console",
      "gw-edge-gateway-get-forge-refunds-v1-refunds-id oauth-client harbor-desk-portal",
      "gw-edge-gateway-get-forge-refunds-v1-refunds-id group forge-refunds",
      "gw-edge-gateway-post-forge-refunds-v1-refunds oauth-client forge-ops-console",
      "gw-edge-gateway-post-forge-refunds-v1-refunds oauth-client harbor-desk-portal",
      "gw-edge-gateway-post-forge-refunds-v1-refunds group forge-refunds",
    ]);
    const routes = of(records, "GatewayRoute").filter((r) => r.proxy === "forge-refunds-v1");
    expect(routes.map((r) => [r.id, r.product, r.target, r.scopes])).toEqual([
      [
        "gw-edge-gateway-get-forge-refunds-v1-refunds-id",
        "forge-refunds",
        "refunds-api",
        ["refunds.read"],
      ],
      [
        "gw-edge-gateway-post-forge-refunds-v1-refunds",
        "forge-refunds",
        "refunds-api",
        ["refunds.write"],
      ],
    ]);
    for (const r of records) expect(parseRecord(JSON.parse(JSON.stringify(r))).ok, r.id).toBe(true);
  });

  it("records the declared caller as the person's word: its System, and an asserted Interface through the route", () => {
    const { records } = estateFromFacts({ op, repos: all() });
    expect(of(records, "System").find((s) => s.id === "harbor-desk")).toMatchObject({
      name: "Harbor Desk",
      boundary: "internal",
      owner: "team-harbor",
      repos: [],
    });
    // No component is made up for a system nobody scans.
    expect(of(records, "Component").filter((c) => c.system === "harbor-desk")).toEqual([]);
    const declared = of(records, "Interface").filter((i) => i.from === "harbor-desk");
    expect(
      declared.map((i) => [i.to, i.method, i.normalizedPath, i.route, i.confidence, i.auth]),
    ).toEqual(
      expect.arrayContaining([
        [
          "refunds-api",
          "POST",
          "/refunds",
          "gw-edge-gateway-post-forge-refunds-v1-refunds",
          "asserted",
          "oauth2",
        ],
        [
          "refunds-api",
          "GET",
          "/refunds/{}",
          "gw-edge-gateway-get-forge-refunds-v1-refunds-id",
          "asserted",
          "oauth2",
        ],
      ]),
    );
    expect(declared).toHaveLength(2);
    for (const i of declared)
      expect(i.evidence[0]).toEqual({
        source: "manual",
        path: "profiles/forge/profile.yaml",
        by: "person",
      });
  });

  it("is the same whichever order the repos are written in", () => {
    const a = writeAll(REPOS);
    const b = writeAll([...REPOS].reverse());
    expect(text(of(b, "AccessGrant"))).toBe(text(of(a, "AccessGrant")));
    expect(text(of(b, "GatewayRoute"))).toBe(text(of(a, "GatewayRoute")));
    expect(text(of(b, "Interface").filter((i) => i.from === "harbor-desk"))).toBe(
      text(of(a, "Interface").filter((i) => i.from === "harbor-desk")),
    );
  });

  it("drops the declared Interface when the person takes the declaration back, and keeps what the code says", () => {
    const before = writeAll(REPOS);
    const after = writeAll(["forge-edge-gateway"], undeclared(), before);
    expect(of(after, "Interface").filter((i) => i.from === "harbor-desk")).toEqual([]);
    expect(of(after, "AccessGrant")).toHaveLength(6);
  });
});
