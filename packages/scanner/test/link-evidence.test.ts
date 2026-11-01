import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  CONFIRMED_BY_CONTRACT,
  ContractsFile,
  loadOrgPack,
  parseFacts,
  readTrafficFile,
  SEEN_IN_TRAFFIC,
  serializeRecord,
  type CatalogRecord,
  type Fact,
  type OrgPack,
} from "@maycombhq/core";
import { catalogWithFacts } from "../src/index.js";

/**
 * ADR 0151 in the catalog: every repo's write marks the same links from the contract files and
 * traffic on file, whatever order the repos are written in, and a write without them takes the
 * marks off again. The gateway estate; the portal keeps the contract files.
 */

const FIX = join(__dirname, "..", "..", "..", "fixtures");
const DIR = join(FIX, "gateway-facts");
const REPOS = ["forge-portal-api", "forge-gateway", "forge-accounts"] as const;
const factsOf = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(DIR, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const all = () => REPOS.map((repo) => ({ repo, facts: factsOf(repo) }));
const text = (rs: readonly CatalogRecord[]) => rs.map((r) => serializeRecord(r)).join("---\n");
const contracts = [
  ContractsFile.parse(
    parse(
      readFileSync(
        join(FIX, "link-evidence", "expected", "forge-portal-api.contracts.yaml"),
        "utf8",
      ),
    ),
  ),
];
const REL = "evidence/traffic/apigee-2026-09-01-2026-09-30.yaml";
const traffic = () => {
  const r = readTrafficFile(
    REL,
    readFileSync(
      join(FIX, "link-evidence", "expected", "apigee-2026-09-01-2026-09-30.yaml"),
      "utf8",
    ),
  );
  if (!r.ok) throw new Error(r.message);
  return [r.traffic];
};

let op: OrgPack;
beforeAll(async () => {
  op = await loadOrgPack(join(DIR, "org-pack"));
});

function writeAll(order: readonly string[], withEvidence = true, start: CatalogRecord[] = []) {
  let records = start;
  let last;
  for (const repo of order) {
    last = catalogWithFacts({
      repo,
      facts: factsOf(repo),
      existing: records,
      op,
      decisions: [],
      estate: all().filter((x) => x.repo !== repo),
      ...(withEvidence ? { linkEvidence: { contracts, traffic: traffic() } } : {}),
    });
    expect(last.invalid).toEqual([]);
    records = last.records;
  }
  return { records, last: last! };
}

const portalGet = (rs: readonly CatalogRecord[]) =>
  rs.find(
    (r) =>
      r.kind === "Interface" &&
      r.from === "portal-api" &&
      r.method === "GET" &&
      r.via === "gateway",
  ) as Extract<CatalogRecord, { kind: "Interface" }>;

describe("the catalog with contract files and traffic as evidence (ADR 0151)", () => {
  it("flags the portal's GET confirmed by contract and seen in traffic, its confidence as the join gave it", () => {
    const plain = portalGet(writeAll(REPOS, false).records);
    const got = portalGet(writeAll(REPOS).records);
    expect(got.flags).toEqual([...(plain.flags ?? []), CONFIRMED_BY_CONTRACT, SEEN_IN_TRAFFIC]);
    expect(got.confidence).toBe(plain.confidence);
    expect(got.evidence.filter((e) => e.extractor)).toEqual([
      expect.objectContaining({ source: "spec", path: "clients/accounts-openapi.yaml", line: 9 }),
      expect.objectContaining({
        source: "spec",
        path: "pacts/forge-portal-api-forge-accounts.json",
        line: 10,
      }),
      { source: "export", path: REL, line: 13, extractor: "atticus-traffic@1" },
    ]);
  });

  it("gives the same catalog whatever order the repos are written in", () => {
    expect(text(writeAll([...REPOS].reverse()).records)).toBe(text(writeAll(REPOS).records));
  });

  it("lists the findings with the write", () => {
    const { last } = writeAll(REPOS);
    expect(last.linkEvidence!.contracts.findings.map((f) => f.reason)).toEqual([
      "no-link",
      "unknown-provider",
      "unknown-provider",
    ]);
    expect(last.linkEvidence!.traffic.findings.map((f) => f.reason)).toEqual([
      "unknown-app",
      "missed-link",
      "unseen-link",
    ]);
  });

  it("takes the marks off when the evidence is gone, leaving the catalog the join alone writes", () => {
    const marked = writeAll(REPOS).records;
    expect(text(writeAll(REPOS, false, marked).records)).toBe(text(writeAll(REPOS, false).records));
  });
});
