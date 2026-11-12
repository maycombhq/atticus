import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  loadOrgPack,
  parseFacts,
  type CatalogRecord,
  type Fact,
  type OrgPack,
} from "@maycombhq/core";
import { catalogWithFacts } from "../src/index.js";

/**
 * Beta.27 (a user's Map): an arrow out of a repo goes with that repo's call. Writing the caller
 * again took only its own lines off the arrow and kept the rest, so an arrow the join no longer
 * made stayed with its callee's line alone ("THE CALL: No line cited at this end"), still
 * verified. On the invented `fixtures/gateway-facts/policy-tokens/`: an earlier read of the proxy
 * path-guessed its forwarding calls to the services; the read again sets the token, and the
 * proxy's catalog written over the services' keeps no arrow from it into the estate.
 */
const DIR = join(__dirname, "..", "..", "..", "fixtures", "gateway-facts", "policy-tokens");
const PROXY = "northwind_pay_1-0";
const read = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(DIR, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
/** The proxy as an earlier read had it: forwarding calls whose lines write no target URL. */
const guessedProxy = (): Fact[] =>
  read(PROXY)
    .filter((f) => f.kind !== "config")
    .map((f) => {
      if (f.kind !== "call") return f;
      const { host: _h, ...rest } = f;
      return {
        ...rest,
        cite: {
          ...rest.cite,
          with: [{ file: "apiproxy/proxies/default.xml", line: 20, value: "TE-Vendor" }],
        },
      } as Fact;
    });
const SERVICES = ["forge-payments", "forge-refunds", "forge-checkout"];
type Iface = Extract<CatalogRecord, { kind: "Interface" }>;
const fromProxy = (rs: readonly CatalogRecord[]) =>
  rs.filter((r): r is Iface => r.kind === "Interface" && r.from === "northwind-pay-proxy");

let op: OrgPack;
beforeAll(async () => {
  op = await loadOrgPack(join(DIR, "org-pack"));
});

describe("an arrow goes with its caller's call (beta.27)", () => {
  it("drops an arrow the caller's write no longer joins, never keeping it on its callee's line", () => {
    // The services written with the guessing proxy in the estate: their catalog holds the arrows.
    let records: CatalogRecord[] = [];
    for (const repo of SERVICES) {
      records = catalogWithFacts({
        repo,
        facts: read(repo),
        existing: records,
        op,
        decisions: [],
        estate: [
          { repo: PROXY, facts: guessedProxy() },
          ...SERVICES.filter((s) => s !== repo).map((s) => ({ repo: s, facts: read(s) })),
        ],
      }).records;
    }
    const before = fromProxy(records);
    expect(before.map((i) => [i.to, i.normalizedPath]).sort()).toEqual([
      ["payments-api", "/payments"],
      ["payments-api", "/payments/{}"],
      ["refunds-api", "/refunds"],
      ["refunds-api", "/refunds/{}"],
    ]);
    // A guess by path is never verified, whatever line its callee has (beta.27).
    for (const i of before) expect(i.confidence).toBe("inferred");

    // The proxy read again (its token set), written over them.
    const after = catalogWithFacts({
      repo: PROXY,
      facts: read(PROXY),
      existing: records,
      op,
      decisions: [],
      estate: SERVICES.map((s) => ({ repo: s, facts: read(s) })),
    }).records;
    expect(fromProxy(after)).toEqual([]);
  });
});
