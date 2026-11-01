import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  applyLinkEvidence,
  CONFIRMED_BY_CONTRACT,
  CONTRACT_DISAGREES,
  ContractsFile,
  joinFacts,
  joinRecords,
  linkEvidenceOf,
  parseFacts,
  parseRecord,
  readTrafficFile,
  SEEN_IN_TRAFFIC,
  stripLinkEvidence,
  trafficFileText,
  type CatalogRecord,
  type ContractsFileT,
  type Fact,
  type JoinRepo,
} from "../src/index.js";

/**
 * Links confirmed from outside the code (ADR 0151): a consumer's Pact files and the OpenAPI spec
 * it keeps (J3), and an imported gateway traffic aggregate (J4), over the gateway estate: the
 * portal's back end calls the accounts service through the gateway's forge-accounts-v1 proxy.
 */

const FIX = join(__dirname, "..", "..", "..", "fixtures");
const read = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(FIX, "gateway-facts", "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
/** A ledger the estate has, so a Pact naming it as provider names a component (invented). */
const ledger: Fact = {
  kind: "entry",
  id: "entry.post.ledger-postings",
  repo: "forge-ledger",
  commit: "5555eee",
  entryType: "rest",
  method: "POST",
  path: "/ledger/postings",
  cite: {
    file: "src/Postings.java",
    line: 9,
    value: "/ledger/postings",
    quote: '@PostMapping("/ledger/postings")',
  },
  verified: "line",
  by: "assistant",
  conf: "declared",
} as Fact;
const repos: JoinRepo[] = [
  { repo: "forge-portal-api", facts: read("forge-portal-api"), component: "portal-api" },
  {
    repo: "forge-gateway",
    facts: read("forge-gateway"),
    component: "api-gateway",
    hosts: ["api.forge.example"],
    gateway: true,
  },
  {
    repo: "forge-accounts",
    facts: read("forge-accounts"),
    component: "accounts-api",
    hosts: ["accounts.forge.internal"],
  },
  { repo: "forge-ledger", facts: [ledger], component: "ledger" },
];
const join0 = joinFacts({ repos });
const GET = join0.joins.find((j) => j.call.fact === "call.get.forge-v1-accounts-id")!.interface;
const POST = join0.joins.find(
  (j) => j.call.fact === "call.post.forge-v1-accounts-id-transfers",
)!.interface;

/** The portal's contract files as `atticus verify --write` reads them (intake's readers' golden). */
const contracts: ContractsFileT[] = [
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
const trafficText = readFileSync(
  join(FIX, "link-evidence", "expected", "apigee-2026-09-01-2026-09-30.yaml"),
  "utf8",
);
const traffic = () => {
  const r = readTrafficFile(REL, trafficText);
  if (!r.ok) throw new Error(r.message);
  return r.traffic;
};

describe("J3: contract files confirm a join from the consumer's end, or say where they disagree", () => {
  const r = linkEvidenceOf({ join: join0, repos, contracts });

  it("marks the link a Pact interaction and the consumer's OpenAPI operation both name", () => {
    expect(r.marks[GET]!.flags).toEqual([CONFIRMED_BY_CONTRACT]);
    expect(r.marks[GET]!.evidence).toEqual([
      {
        source: "spec",
        repo: "forge-portal-api",
        path: "clients/accounts-openapi.yaml",
        line: 9,
        commit: "8888bbb",
        side: "caller",
        extractor: "atticus-contract@1",
      },
      {
        source: "spec",
        repo: "forge-portal-api",
        path: "pacts/forge-portal-api-forge-accounts.json",
        line: 10,
        commit: "8888bbb",
        side: "caller",
        extractor: "atticus-contract@1",
      },
    ]);
    expect(r.contracts.confirmed.map((c) => c.interface)).toEqual([GET]);
  });

  it("lists a request with no link, another provider, and a provider the estate doesn't have", () => {
    expect(r.contracts.findings.map((f) => [f.reason, f.method, f.path, f.at])).toEqual([
      [
        "no-link",
        "DELETE",
        "/forge/v1/accounts/ACC-1001",
        "pacts/forge-portal-api-forge-accounts.json:22",
      ],
      [
        "unknown-provider",
        "GET",
        "/invoices/INV-77",
        "pacts/forge-portal-api-forge-billing.json:7",
      ],
      [
        "provider-differs",
        "POST",
        "/forge/v1/accounts/ACC-1001/transfers",
        "pacts/forge-portal-api-forge-ledger.json:10",
      ],
    ]);
    const differs = r.contracts.findings.find((f) => f.reason === "provider-differs")!;
    expect(differs.links.map((l) => [l.interface, l.to])).toEqual([[POST, "accounts-api"]]);
    expect(differs.message).toContain(
      "is with ledger, but the join links portal-api's call to accounts-api",
    );
    expect(r.marks[POST]!.flags).toEqual([CONTRACT_DISAGREES]);
  });

  it("says nothing of a consumer-side OpenAPI operation the consumer never calls", () => {
    expect(r.contracts.findings.some((f) => f.path.endsWith("/statements"))).toBe(false);
  });

  it("is the same whatever order the repos and files come in", () => {
    const again = linkEvidenceOf({
      join: joinFacts({ repos: [...repos].reverse() }),
      repos: [...repos].reverse(),
      contracts,
    });
    expect(again).toEqual(r);
  });
});

describe("J4: a traffic aggregate marks the links used, and lists missed and unseen links", () => {
  const r = linkEvidenceOf({ join: join0, repos, traffic: [traffic()] });

  it("marks the link the portal's traffic used, citing the aggregate's row", () => {
    expect(r.marks[GET]).toEqual({
      flags: [SEEN_IN_TRAFFIC],
      evidence: [{ source: "export", path: REL, line: 13, extractor: "atticus-traffic@1" }],
    });
    expect(r.traffic.seen).toEqual([
      expect.objectContaining({
        interface: GET,
        from: "portal-api",
        to: "accounts-api",
        count: 200,
        file: REL,
        range: { from: "2026-09-01", to: "2026-09-30" },
      }),
    ]);
  });

  it("lists an app named like no component, traffic no link carries, and a covered link nobody used", () => {
    expect(
      r.traffic.findings.map((f) => [f.reason, f.app ?? f.link?.interface, f.path ?? f.link?.path]),
    ).toEqual([
      ["unknown-app", "forge-mobile", "/forge/v1/accounts/{id}"],
      ["missed-link", "forge-portal-api", "/forge/v1/accounts/{id}/statements/{id}"],
      ["unseen-link", POST, "/transfers"],
    ]);
  });

  it("takes the component a person names for an app in the row", () => {
    const named = trafficText.replace(
      "app: forge-mobile\n",
      "app: forge-mobile\n    component: portal-api\n",
    );
    const t = readTrafficFile(REL, named);
    if (!t.ok) throw new Error(t.message);
    const again = linkEvidenceOf({ join: join0, repos, traffic: [t.traffic] });
    expect(again.traffic.findings.map((f) => f.reason)).toEqual(["missed-link", "unseen-link"]);
    expect(again.traffic.seen[0]!.count).toBe(215);
  });

  it("writes and reads the aggregate's canonical text unchanged", () => {
    expect(trafficFileText(traffic().file)).toBe(trafficText);
  });

  it("refuses a file that isn't an aggregate (a raw row field)", () => {
    const raw = trafficText.replace("count: 15", "count: 15\n    client_ip: 203.0.113.45");
    expect(readTrafficFile(REL, raw).ok).toBe(false);
  });
});

describe("the catalog: flags and evidence added, a guess never raised, and taken off again", () => {
  const records = joinRecords(join0, repos);
  const r = linkEvidenceOf({ join: join0, repos, contracts, traffic: [traffic()] });
  const marked = applyLinkEvidence(records, r.marks);

  it("adds the flags and evidence and leaves each confidence as the join gave it", () => {
    const get = marked.find((x) => x.id === GET)!;
    expect(get.flags).toEqual(expect.arrayContaining([CONFIRMED_BY_CONTRACT, SEEN_IN_TRAFFIC]));
    for (const x of marked)
      expect(x.confidence).toBe(records.find((y) => y.id === x.id)!.confidence);
    for (const x of marked) expect(parseRecord(x).ok).toBe(true);
  });

  it("never raises an inferred link: the evidence doesn't name the callee in code", () => {
    const guessed = records.map((x): CatalogRecord =>
      x.id === GET
        ? ({ ...x, confidence: "inferred", flags: ["joined-by-path"] } as CatalogRecord)
        : x,
    );
    const g = applyLinkEvidence(guessed, r.marks).find((x) => x.id === GET)!;
    expect(g.confidence).toBe("inferred");
    expect(g.flags).toEqual(["joined-by-path", CONFIRMED_BY_CONTRACT, SEEN_IN_TRAFFIC]);
  });

  it("is idempotent, and stripping gives back the join's records", () => {
    expect(applyLinkEvidence(marked, r.marks)).toEqual(marked);
    expect(stripLinkEvidence(marked)).toEqual(records);
  });
});
