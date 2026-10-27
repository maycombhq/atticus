import { readFileSync } from "node:fs";
import { cp, mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  loadOrgPack,
  parseFacts,
  type CatalogRecord,
  type Fact,
  type OrgPack,
} from "@maycombhq/core";
import { catalogWithFacts, estateFacts, estateFromFacts, productionRepos } from "../src/index.js";

/**
 * A prototype is read but kept out of the production catalog (ADR 0133): the manifest types it
 * `prototype`, so its verified facts project nothing, its calls join nothing and ask nothing, and
 * the estate's own writes never see it.
 */

const DIR = join(__dirname, "..", "..", "..", "fixtures", "prototype-compare");
const PROTO = "forge-checkout-prototype";
const ESTATE = ["forge-shop-bff", "forge-billing", "forge-partner-gateway"] as const;
const factsOf = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(DIR, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const ids = (rs: readonly CatalogRecord[]) => rs.map((r) => `${r.kind}|${r.id}`).sort();

let op: OrgPack;
beforeAll(async () => {
  op = await loadOrgPack(join(DIR, "org-pack"));
});

describe("a prototype and the catalog", () => {
  it("leaves the prototype out of the estate's repos for the catalog", () => {
    expect(productionRepos(op).map((r) => r.id)).toEqual([...ESTATE]);
  });

  it("writes nothing into the catalog for the prototype's own facts, and asks nothing", () => {
    const estate = estateFromFacts({
      op,
      repos: ESTATE.map((repo) => ({ repo, facts: factsOf(repo) })),
    });
    const out = catalogWithFacts({
      repo: PROTO,
      facts: factsOf(PROTO),
      existing: estate.records,
      op,
      decisions: [],
      estate: ESTATE.map((repo) => ({ repo, facts: factsOf(repo) })),
    });
    expect(ids(out.records)).toEqual(ids(estate.records));
    expect(out.flows).toEqual([]);
    expect(out.unresolved).toEqual([]);
    expect(out.join).toBeUndefined();
    expect(out.notes).toEqual([
      `${PROTO} is a prototype: its facts are kept in facts/${PROTO}.jsonl and compared with the estate (atticus change attach <change> --prototype ${PROTO}), never written into the catalog.`,
    ]);
  });

  it("joins none of the prototype's calls when another repo is written, though its facts are there", () => {
    const all = [...ESTATE, PROTO].map((repo) => ({ repo, facts: factsOf(repo) }));
    const withProto = estateFromFacts({ op, repos: all });
    const without = estateFromFacts({
      op,
      repos: ESTATE.map((repo) => ({ repo, facts: factsOf(repo) })),
    });
    expect(ids(withProto.records)).toEqual(ids(without.records));
    expect(withProto.join.joins.some((j) => j.call.repo === PROTO || j.entry.repo === PROTO)).toBe(
      false,
    );
    const shop = catalogWithFacts({
      repo: "forge-shop-bff",
      facts: factsOf("forge-shop-bff"),
      existing: [],
      op,
      decisions: [],
      estate: all.filter((x) => x.repo !== "forge-shop-bff"),
    });
    expect(shop.records.some((r) => JSON.stringify(r.evidence).includes(PROTO))).toBe(false);
  });

  it("reads no prototype's facts into the estate join of a write", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-proto-"));
    await mkdir(join(root, "facts"));
    await cp(join(DIR, "facts"), join(root, "facts"), { recursive: true });
    const got = await estateFacts(root, op, "");
    expect(got.repos.map((r) => r.repo).sort()).toEqual([...ESTATE].sort());
  });
});
