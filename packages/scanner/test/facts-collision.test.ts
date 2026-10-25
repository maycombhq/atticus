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
import { catalogWithFacts, componentRenames, estateFromFacts } from "../src/index.js";

/**
 * Two repos with a component of the same name (B-fixes, problem 1): fastapi-template's and
 * microservices-demo's `frontend` became one Component owned by the repo written first. A
 * component id two repos use is qualified by each repo's id; every other id stays as it was.
 */

const DIR = join(__dirname, "..", "..", "..", "fixtures", "estate-facts", "collision");
const factsOf = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(DIR, `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const REPOS = ["forge-shop", "forge-admin"] as const;
const all = () => REPOS.map((repo) => ({ repo, facts: factsOf(repo) }));

let op: OrgPack;
beforeAll(async () => {
  op = await loadOrgPack(join(DIR, "org-pack"));
});

function writeAll(order: readonly string[], withEstate = true) {
  let records: CatalogRecord[] = [];
  const flows: Record<string, string[]> = {};
  for (const repo of order) {
    const out = catalogWithFacts({
      repo,
      facts: factsOf(repo),
      existing: records,
      op,
      decisions: [],
      ...(withEstate ? { estate: all().filter((x) => x.repo !== repo) } : {}),
    });
    expect(out.invalid).toEqual([]);
    records = out.records;
    flows[repo] = out.flows.map((f) => f.id);
  }
  return { records, flows };
}
const components = (rs: readonly CatalogRecord[]) =>
  rs
    .filter((r) => r.kind === "Component")
    .map((r) => `${r.id} ${(r as { repo?: string }).repo}`)
    .sort();

describe("componentRenames", () => {
  it("qualifies a component id two repos use, and nothing else", () => {
    expect(
      componentRenames(
        [
          { repo: "forge-shop", facts: factsOf("forge-shop") },
          { repo: "forge-admin", facts: factsOf("forge-admin") },
        ],
        op,
      ),
    ).toEqual({
      "forge-admin": { frontend: "forge-admin-frontend" },
      "forge-shop": { frontend: "forge-shop-frontend" },
    });
  });

  it("renames nothing when no two repos share a component", () => {
    expect(componentRenames([{ repo: "forge-admin", facts: factsOf("forge-admin") }], op)).toEqual(
      {},
    );
  });

  it("keeps a component named as its own repo, and qualifies the other repo's", () => {
    const shop = factsOf("forge-shop").map((f) => ({ ...f, component: "forge-admin" }) as Fact);
    const admin = factsOf("forge-admin").map((f) => {
      const { component: _c, ...rest } = f;
      return rest as Fact;
    });
    expect(
      componentRenames(
        [
          { repo: "forge-shop", facts: shop },
          { repo: "forge-admin", facts: admin },
        ],
        op,
      ),
    ).toEqual({ "forge-shop": { "forge-admin": "forge-shop-forge-admin" } });
  });
});

describe("catalogWithFacts: two repos' components with one id stay two records", () => {
  it("gives each repo its own component, endpoints and flows, whichever repo is written first", () => {
    const a = writeAll(REPOS);
    const b = writeAll([...REPOS].reverse());
    expect(components(a.records)).toEqual([
      "admin-api forge-admin",
      "forge-admin-frontend forge-admin",
      "forge-shop-frontend forge-shop",
    ]);
    const cart = a.records.find(
      (r) => r.kind === "Endpoint" && (r as { pathOrTopic?: string }).pathOrTopic === "/cart",
    ) as { id: string; component: string } | undefined;
    expect(cart).toMatchObject({ component: "forge-shop-frontend" });
    expect(cart!.id.startsWith("forge-shop-frontend.")).toBe(true);
    expect(a.flows["forge-shop"]).toEqual(["forge-shop-frontend.add-to-cart"]);
    // the component whose id nobody else has keeps it
    expect(
      a.records.some(
        (r) => r.kind === "Endpoint" && (r as { component?: string }).component === "admin-api",
      ),
    ).toBe(true);
    const text = (rs: CatalogRecord[]) => rs.map((r) => serializeRecord(r)).join("---\n");
    expect(text(b.records)).toBe(text(a.records));
  });

  it("without the estate, a component another repo's record already has is qualified", () => {
    const { records } = writeAll(REPOS, false);
    expect(components(records)).toEqual([
      "admin-api forge-admin",
      "forge-admin-frontend forge-admin",
      "frontend forge-shop",
    ]);
  });

  it("estateFromFacts writes the same catalog", () => {
    const out = estateFromFacts({ op, repos: all() });
    expect(components(out.records)).toEqual(components(writeAll(REPOS).records));
  });
});
