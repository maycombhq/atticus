import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFacts, type Fact } from "@maycombhq/core";
import { dirSource, verifyFacts } from "../src/index.js";

/**
 * An Apigee proxy that fronts an outside vendor, and two services that wrap the vendor and call
 * it through the gateway (`fixtures/gateway-facts/vendor-proxy/`, invented): what the map prompt
 * asks a reader to record is what the verifier keeps. The proxy's flows and their forwarding
 * calls, whose target `<URL>` is a build token; the Maven config plugin's `config.json` token for
 * that `<URL>` per environment, as a setting; the callers' paths written as settings beside a
 * host setting (a `uris` map in YAML, a `vendor.paths.*` list in properties). A live-looking
 * secret in a config file is never a fact: it is a finding on the repo (`secrets`), its file and
 * line, never its value. `expected/verified.json` is the verifier's result per repo, by hand.
 */
const FIX = join(__dirname, "..", "..", "..", "fixtures", "gateway-facts", "vendor-proxy");
const COMMITS: Record<string, string> = {
  "northwind_wallets_1-0": "8888aaa",
  "forge-wallets": "9999bbb",
  "forge-accounts": "aaaa111",
};
const facts = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(FIX, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const run = (repo: string, fs: Fact[] = facts(repo)) =>
  verifyFacts({ facts: fs, source: dirSource(join(FIX, "repos", repo)), commit: COMMITS[repo]! });

describe("an Apigee proxy to an outside vendor and the services that call it, as read", () => {
  it("covers every repo of the fixture", () => {
    expect(
      readdirSync(join(FIX, "facts"))
        .map((f) => f.replace(/\.jsonl$/, ""))
        .sort(),
    ).toEqual(Object.keys(COMMITS).sort());
  });

  it("keeps every fact of every repo (golden)", async () => {
    const got: Record<string, unknown> = {};
    for (const repo of Object.keys(COMMITS).sort()) {
      const r = await run(repo);
      got[repo] = {
        accepted: r.accepted.map((f) => f.id).sort(),
        rejected: r.rejected.map((x) => ({ id: x.fact.id, code: x.code, message: x.message })),
      };
    }
    // UPDATE_GOLDEN=1 writes what the verifier gives now, to be checked by hand before it's committed.
    if (process.env.UPDATE_GOLDEN)
      writeFileSync(join(FIX, "expected", "verified.json"), `${JSON.stringify(got, null, 2)}\n`);
    expect(got).toEqual(JSON.parse(readFileSync(join(FIX, "expected", "verified.json"), "utf8")));
  });

  it("rejects a config.json token cited on a line that doesn't name its XPath", async () => {
    const r = await run(
      "northwind_wallets_1-0",
      facts("northwind_wallets_1-0").map((f) =>
        f.id === "config.northwind-url-prod" ? ({ ...f, cite: { ...f.cite, line: 5 } } as Fact) : f,
      ),
    );
    expect(r.rejected.map((x) => x.fact.id)).toEqual(["config.northwind-url-prod"]);
  });
});
