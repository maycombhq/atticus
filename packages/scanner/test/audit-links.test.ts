import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  helperOn,
  joinConventions,
  joinFacts,
  loadOrgPack,
  parseFacts,
  type Fact,
  type OrgPack,
} from "@maycombhq/core";
import { auditLinkCandidates, estateJoinOf, joinReposOf, outsideSystems } from "../src/index.js";

/**
 * P3: the links a sample audit draws from, on the invented bank-shaped estate
 * (fixtures/link-estate): every call of the repo the estate join tied to an entry, with how it
 * was joined (ADR 0135's flags) and every line it rests on, the gateway hops included.
 */

const FIX = join(__dirname, "..", "..", "..", "fixtures", "link-estate");
const REPOS = [
  "forge-portal-bff",
  "forge-proxy-accounts-v1",
  "forge-proxy-payments-v1",
  "forge-proxy-northwind-v1",
  "forge-accounts",
  "forge-payments",
  "forge-cards",
  "forge-notifications",
  "forge-starter",
  "forge-deploy-config",
];
const factsOf = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(FIX, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};

let op: OrgPack;
beforeAll(async () => {
  op = await loadOrgPack(join(FIX, "org-pack"));
});

describe("auditLinkCandidates", () => {
  it("lists a repo's joined calls with how each was joined and the lines it rests on", () => {
    const repos = REPOS.map((repo) => ({ repo, facts: factsOf(repo) }));
    const join = estateJoinOf(op, repos);
    const portal = auditLinkCandidates(join, repos, "forge-portal-bff");
    expect(portal.length).toBeGreaterThan(0);
    for (const l of portal) {
      expect(l.kind).toBe("link");
      expect(l.id.startsWith("link:")).toBe(true);
      expect(l.cites[0]!.startsWith("forge-portal-bff ")).toBe(true);
      expect(l.fact).toBeTruthy();
      expect(l.to).toBeTruthy();
    }
    const accounts = portal.find((l) => l.to === "forge-accounts")!;
    expect(accounts.claim).toBe(
      "forge-portal-bff GET /forge/accounts/v1/accounts/{id} -> forge-accounts GET /accounts/{id} via forge-proxy-accounts-v1",
    );
    // The hop's route and forwarding call are cited between the caller and the callee.
    expect(accounts.cites.some((c) => c.startsWith("forge-proxy-accounts-v1 "))).toBe(true);
    expect(accounts.cites.at(-1)!.startsWith("forge-accounts ")).toBe(true);
    expect(accounts.of).toMatch(/^joined-by-/);

    // A guess says so: the cards service's relative call joined by path.
    const cards = auditLinkCandidates(join, repos, "forge-cards");
    expect(cards.map((l) => l.of)).toContain("joined-by-path");
    // Ids are unique and the list is in id order.
    const ids = repos.flatMap((r) => auditLinkCandidates(join, repos, r.repo).map((l) => l.id));
    for (const r of REPOS) {
      const own = auditLinkCandidates(join, repos, r).map((l) => l.id);
      expect(new Set(own).size).toBe(own.length);
      expect([...own].sort()).toEqual(own);
    }
    expect(ids.length).toBeGreaterThan(5);
  });
});

describe("estateJoinOf joins with the org pack's conventions, as the catalog does", () => {
  const DIR = join(__dirname, "..", "..", "..", "fixtures", "gateway-facts");
  const moved = (f: string) => f.replace("/apiproxy/", "/proxy-bundles/");
  const read = (repo: string, move?: (f: string) => string): Fact[] => {
    const r = parseFacts(readFileSync(join(DIR, "facts", `${repo}.jsonl`), "utf8"));
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    return move
      ? r.facts.map((f) => ({ ...f, cite: { ...f.cite, file: move(f.cite.file) } }))
      : r.facts;
  };
  const list = (move?: (f: string) => string) => [
    { repo: "forge-portal-api", facts: read("forge-portal-api") },
    { repo: "forge-gateway", facts: read("forge-gateway", move) },
    { repo: "forge-accounts", facts: read("forge-accounts") },
  ];
  /** The gateway untyped in the manifest, so only its bundle folder says its entries are routes. */
  async function pack(bundleFolders?: string[]): Promise<OrgPack> {
    const loaded = await loadOrgPack(join(DIR, "org-pack"));
    const profiles = loaded.profiles.map((p) => ({
      ...p,
      ...(p.repos
        ? {
            repos: {
              ...p.repos,
              repos: p.repos.repos.map((r) =>
                r.id === "forge-gateway" ? { ...r, type: "spring-boot" } : r,
              ),
            },
          }
        : {}),
    }));
    return {
      ...loaded,
      profiles,
      ...(bundleFolders
        ? {
            conventions: {
              ...loaded.conventions!,
              gatewayBundleFolders: bundleFolders,
            },
          }
        : {}),
    } as OrgPack;
  }
  const through = (o: OrgPack, l: ReturnType<typeof list>) =>
    auditLinkCandidates(estateJoinOf(o, l), l, "forge-portal-api").filter((x) =>
      x.claim.includes(" via "),
    ).length;
  /** The catalog's join (scan, verify --write): the same repos, outside systems and conventions. */
  const catalogThrough = (o: OrgPack, l: ReturnType<typeof list>) =>
    joinFacts({
      repos: joinReposOf(o, l),
      outside: outsideSystems(o),
      ...joinConventions(o),
      walkGateways: helperOn("gateway-walk"),
    }).joins.filter((j) => j.call.repo === "forge-portal-api" && j.gateway?.length).length;

  it("a custom bundle folder changes the audit's links as it changes the catalog's", async () => {
    const plain = await pack();
    const custom = await pack(["proxy-bundles"]);
    expect(through(plain, list())).toBeGreaterThan(0);
    expect(through(plain, list(moved))).toBe(0);
    expect(through(custom, list(moved))).toBe(through(plain, list()));
    expect(through(custom, list())).toBe(0);
    for (const o of [plain, custom])
      for (const l of [list(), list(moved)]) expect(through(o, l)).toBe(catalogThrough(o, l));
  });
});
