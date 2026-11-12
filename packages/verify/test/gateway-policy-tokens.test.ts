import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFacts, type Fact } from "@maycombhq/core";
import { dirSource, verifyFacts } from "../src/index.js";

/**
 * Beta.27 (a user's estate, re-made with invented names): an Apigee proxy repo whose target URL
 * is the deploy token `@targetVendorUrl@`, set per environment by the deploy's `config.json` by
 * the token's name, `configurations[].policies[]` of `{ "name": "@targetVendorUrl@", "value":
 * "<URL>" }` (not the config plugin's XPath `tokens`). `fixtures/gateway-facts/policy-tokens/`:
 * what the map prompt asks a reader to record is what the verifier keeps. Each environment's
 * value is a `config` fact keyed by the token's name (with or without its marks), cited on the
 * `"value"` line, its `"name"` and configuration-name lines in `cite.with`; its `env` is the
 * configuration's name. `expected/verified.json` is the verifier's result per repo, by hand.
 */
const FIX = join(__dirname, "..", "..", "..", "fixtures", "gateway-facts", "policy-tokens");
const COMMITS: Record<string, string> = {
  "northwind_pay_1-0": "7777ccc",
  "forge-payments": "5555ddd",
  "forge-refunds": "6666eee",
  "forge-checkout": "4444fff",
};
const PROXY = "northwind_pay_1-0";
const facts = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(FIX, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const run = (repo: string, fs: Fact[] = facts(repo)) =>
  verifyFacts({ facts: fs, source: dirSource(join(FIX, "repos", repo)), commit: COMMITS[repo]! });
const withSetting = (id: string, change: (f: Fact) => Fact) =>
  facts(PROXY).map((f) => (f.id === id ? change(f) : f));
const rejectedOf = async (fs: Fact[]) =>
  (await run(PROXY, fs)).rejected.map((x) => [x.fact.id, x.code, x.message]);

describe("a proxy whose target URL config.json sets by the token's name, as read (beta.27)", () => {
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

  it("keeps the token's setting keyed without its marks", async () => {
    const fs = facts(PROXY).map((f) =>
      f.kind === "config" ? ({ ...f, key: "targetVendorUrl" } as Fact) : f,
    );
    expect(await rejectedOf(fs)).toEqual([]);
  });

  it("rejects a value given another configuration's env", async () => {
    const fs = withSetting("config.target-vendor-url-dv", (f) => ({ ...f, env: "qa" }) as Fact);
    expect(await rejectedOf(fs)).toEqual([
      [
        "config.target-vendor-url-dv",
        "claim-not-on-line",
        "config config.target-vendor-url-dv: the token at config.json:8 is in the dv configuration, not qa; give the env its configuration is named",
      ],
    ]);
  });

  it("rejects a value whose token is named otherwise", async () => {
    // A key the lines write (the member's name), but the token object is named
    // `@targetVendorUrl@`: the setting is that token's, keyed by its name, never another word.
    const fs = withSetting("config.target-vendor-url-dv", (f) => ({ ...f, key: "name" }) as Fact);
    expect(await rejectedOf(fs)).toEqual([
      [
        "config.target-vendor-url-dv",
        "claim-not-on-line",
        "config config.target-vendor-url-dv: the token at config.json:8 is named @targetVendorUrl@, not name; give the key the token's name",
      ],
    ]);
  });

  it("rejects a token's value cited on another token's line", async () => {
    const fs = withSetting(
      "config.target-vendor-url-dv",
      (f) => ({ ...f, value: "https://qaapi.northwind-pay.example/api/v1" }) as Fact,
    );
    const got = await rejectedOf(fs);
    expect(got.map((x) => x.slice(0, 2))).toEqual([
      ["config.target-vendor-url-dv", "claim-not-on-line"],
    ]);
  });
});
