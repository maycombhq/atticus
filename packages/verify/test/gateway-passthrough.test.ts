import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFacts, type Fact } from "@maycombhq/core";
import { dirSource, verifyFacts } from "../src/index.js";

/**
 * Review round 49 (end to end): an Apigee proxy with no conditional flow passes everything under
 * its base path to its target. As the map prompt asks, it is one `ANY` entry at `<BasePath>/**`
 * cited on the `<BasePath>` line, and a forwarding call whose path is the pass-through `/**` (or
 * `/`), cited on the target's `<URL>` line or the proxy's `<RouteRule>` line. The invented
 * `fixtures/gateway-facts/passthrough/` has both (forge-ledger-v1 to a URL, forge-rates-v1 to a
 * TargetServer); `expected/verified.json` is the verifier's result, written by hand.
 */
const FIX = join(__dirname, "..", "..", "..", "fixtures", "gateway-facts", "passthrough");
const facts = (): Fact[] => {
  const r = parseFacts(readFileSync(join(FIX, "facts", "forge-gateway.jsonl"), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const run = (fs: Fact[] = facts()) =>
  verifyFacts({
    facts: fs,
    source: dirSource(join(FIX, "repos", "forge-gateway")),
    commit: "7777aaa",
  });
const edit = (id: string, f: (x: Fact) => Record<string, unknown>) =>
  facts().map((x) => (x.id === id ? ({ ...x, ...f(x) } as Fact) : x));
const L = "proxies/forge-ledger-v1/apiproxy";

describe("an Apigee proxy with no conditional flow", () => {
  it("keeps its <BasePath>/** entry and its pass-through forwarding call (golden)", async () => {
    const r = await run();
    expect({
      accepted: r.accepted.map((f) => f.id).sort(),
      rejected: r.rejected.map((x) => ({ id: x.fact.id, code: x.code, message: x.message })),
      authUncited: r.authUncited,
      entriesNoFlowFollows: r.entriesNoFlowFollows,
    }).toEqual(JSON.parse(readFileSync(join(FIX, "expected", "verified.json"), "utf8")));
  });

  it("rejects a base path the <BasePath> line doesn't write", async () => {
    const r = await run(edit("entry.any.forge-ledger-v1", () => ({ path: "/forge/ledger/v2/**" })));
    expect(r.rejected.map((x) => [x.fact.id, x.code])).toEqual([
      ["call.any.ledger", "ref-rejected"],
      ["entry.any.forge-ledger-v1", "claim-not-on-line"],
    ]);
  });

  it("rejects a pass-through path cited away from the target's <URL> or <RouteRule>", async () => {
    const r = await run(
      edit("call.any.ledger", (x) => ({
        cite: {
          file: `${L}/proxies/default.xml`,
          line: 11,
          value: "secure",
          quote: "<VirtualHost>secure</VirtualHost>",
        },
        host: (x as { host?: string }).host,
      })),
    );
    expect(r.rejected.map((x) => [x.fact.id, x.code])).toEqual([
      ["call.any.ledger", "claim-not-on-line"],
    ]);
  });

  it("rejects a path under the target that the <URL> line doesn't write", async () => {
    const r = await run(edit("call.any.ledger", () => ({ path: "/ledger/**" })));
    expect(r.rejected.map((x) => [x.fact.id, x.code])).toEqual([
      ["call.any.ledger", "claim-not-on-line"],
    ]);
  });

  it("doesn't take a pass-through path on a <URL> line for an entry", async () => {
    const r = await run(
      edit("entry.any.forge-rates-v1", () => ({
        path: "/**",
        cite: {
          file: `${L}/targets/ledger.xml`,
          line: 3,
          value: "https://ledger.forge.internal",
          quote: "<URL>https://ledger.forge.internal</URL>",
        },
      })),
    );
    expect(r.rejected.map((x) => [x.fact.id, x.code])).toEqual([
      ["call.any.rates", "ref-rejected"],
      ["entry.any.forge-rates-v1", "claim-not-on-line"],
    ]);
  });
});
