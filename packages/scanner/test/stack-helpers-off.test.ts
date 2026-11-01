import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadOrgPack, parseFacts, type Fact, type OrgPack } from "@maycombhq/core";
import { dirSource, memorySource, verifyFacts } from "@maycombhq/verify";
import { measureLinks, parseLinkReference, type LinkReference } from "../src/index.js";

/**
 * G4: the stack helpers stay optional. The bank-shaped estate of fixtures/link-estate is
 * verified and joined with every helper off — the verifier's per-framework naming rules
 * (`derivedNames: false`), the OpenAPI reader (`readers: false`), the walk through gateways
 * (`walkGateways: false`) — and no framework model is in its org pack. Every fact is still kept;
 * every link still lands but two, which stop at the gateway route they reach (what the walk
 * adds). A table only an ORM's convention names is what the naming rules add.
 */

const FIX = join(__dirname, "..", "..", "..", "fixtures", "link-estate");
const COMMITS: Record<string, string> = {
  "forge-portal-bff": "a1a0001",
  "forge-proxy-accounts-v1": "b2b0002",
  "forge-proxy-payments-v1": "b2b0003",
  "forge-proxy-northwind-v1": "b2b0004",
  "forge-accounts": "c3c0005",
  "forge-payments": "c3c0006",
  "forge-cards": "c3c0007",
  "forge-notifications": "c3c0008",
  "forge-starter": "d4d0009",
  "forge-deploy-config": "e5e0010",
};
const factsOf = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(FIX, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const reference = (): LinkReference => {
  const r = parseLinkReference(readFileSync(join(FIX, "reference-links.yaml"), "utf8"));
  if (!r.ok) throw new Error(r.issues.join("\n"));
  return r.reference;
};

let op: OrgPack;
let kept: { repo: string; facts: Fact[] }[];
beforeAll(async () => {
  op = await loadOrgPack(join(FIX, "org-pack"));
  kept = [];
  for (const repo of Object.keys(COMMITS)) {
    const r = await verifyFacts({
      facts: factsOf(repo),
      source: dirSource(join(FIX, "repos", repo)),
      commit: COMMITS[repo],
      estate: {
        components: op.profiles.flatMap((p) =>
          (p.repos?.repos ?? []).flatMap((x) => [x.id, ...(x.component ? [x.component] : [])]),
        ),
      },
      derivedNames: false,
      readers: false,
    });
    expect(r.rejected, repo).toEqual([]);
    expect(r.accepted, repo).toHaveLength(factsOf(repo).length);
    expect(r.specOpsUncovered).toEqual([]);
    kept.push({ repo, facts: r.accepted });
  }
});

describe("the estate read with every stack helper off", () => {
  it("keeps every fact, with no framework model and no naming rule", () => {
    expect(op.frameworks).toEqual([]);
    expect(kept.reduce((n, r) => n + r.facts.length, 0)).toBe(52);
  });

  it("still lands the links but two, which stop at the gateway route they reach", () => {
    const on = measureLinks({ op, repos: kept, reference: reference(), walkGateways: true });
    const off = measureLinks({ op, repos: kept, reference: reference(), walkGateways: false });
    // With the helpers on, as pinned in measure-links.test.ts.
    expect(on.links).toMatchObject({ joined: 11, right: 10, precision: 0.909, recall: 0.769 });
    // Off: as many calls joined, as many asked and outside; two fewer right.
    expect(off.links).toMatchObject({
      joined: 11,
      right: 8,
      precision: 0.727,
      recall: 0.615,
      asked: 1,
      outside: { want: 4, got: 3, right: 3 },
    });
    const lost = off.calls.filter(
      (c) => !c.right && on.calls.find((x) => x.call === c.call && x.repo === c.repo)?.right,
    );
    expect(
      lost.map(
        (c) => `${c.repo} ${c.call} -> ${c.got.kind === "joined" ? c.got.repo : c.got.kind}`,
      ),
    ).toEqual([
      "forge-portal-bff GET /forge/accounts/v1/accounts/{id} -> forge-proxy-accounts-v1",
      "forge-portal-bff POST /forge/payments/v1/payments -> forge-proxy-payments-v1",
    ]);
    // The hop itself still lands: each proxy's forwarding call reaches its service on its own.
    for (const [proxy, service] of [
      ["forge-proxy-accounts-v1", "forge-accounts"],
      ["forge-proxy-payments-v1", "forge-payments"],
    ])
      expect(
        off.calls.some(
          (c) => c.repo === proxy && c.right && c.got.kind === "joined" && c.got.repo === service,
        ),
      ).toBe(true);
  });

  it("without the naming rules, a table only an ORM's convention names must be cited where it is written", async () => {
    const dir = "src/main/java/forge/ledger";
    const src = memorySource({
      [`${dir}/LedgerLine.java`]:
        "package forge.ledger;\n\n@Entity\npublic class LedgerLine {\n}\n",
      [`${dir}/Ledger.java`]:
        'package forge.ledger;\n\n@Entity\n@Table(name = "ledger")\npublic class Ledger {\n}\n',
    });
    const store = (id: string, name: string, file: string, line: number, value: string): Fact =>
      ({
        kind: "store",
        id,
        repo: "forge-ledger",
        commit: "0123abc",
        store: "forge-db",
        name,
        op: "read",
        cite: { file, line, value },
        verified: "none",
        by: "assistant",
        conf: "declared",
      }) as Fact;
    const facts = [
      store("s-line", "ledger_line", `${dir}/LedgerLine.java`, 3, "@Entity"),
      store("s-ledger", "ledger", `${dir}/Ledger.java`, 4, "ledger"),
    ];
    const on = await verifyFacts({ source: src, facts });
    const off = await verifyFacts({ source: src, facts, derivedNames: false });
    expect(on.accepted.map((f) => f.id).sort()).toEqual(["s-ledger", "s-line"]);
    expect(off.accepted.map((f) => f.id)).toEqual(["s-ledger"]);
    expect(off.rejected.map((r) => `${r.fact.id}:${r.code}`)).toEqual(["s-line:claim-not-on-line"]);
  });
});
