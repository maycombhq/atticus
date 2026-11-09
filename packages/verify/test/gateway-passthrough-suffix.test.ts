import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFacts, type Fact } from "@maycombhq/core";
import { dirSource, verifyFacts } from "../src/index.js";

/**
 * An Apigee proxy and the Spring Boot service it forwards to (`fixtures/gateway-facts/
 * passthrough-suffix/`, invented): what the map prompt asks a reader to record on both sides is
 * what the verifier keeps. The proxy's target `<URL>` path, its conditional flows and its
 * `<BasePath>/**` pass-through; `target.copy.pathsuffix` set false by a JavaScript policy, as a
 * setting; and the service's `server.servlet.context-path`, as a setting, and an OpenShift Route's
 * path, as an exposure. `expected/verified.json` is the verifier's result per repo, by hand.
 */
const FIX = join(__dirname, "..", "..", "..", "fixtures", "gateway-facts", "passthrough-suffix");
const COMMITS: Record<string, string> = {
  "forge-billing-bff": "1111aaa",
  "forge-fees-proxy": "2222bbb",
  "forge-edge": "3333ccc",
  "forge-fees": "4444ddd",
  "forge-rates": "5555eee",
  "forge-limits": "6666fff",
  "forge-refunds": "7777abc",
};
const facts = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(FIX, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const run = (repo: string, fs: Fact[] = facts(repo)) =>
  verifyFacts({ facts: fs, source: dirSource(join(FIX, "repos", repo)), commit: COMMITS[repo]! });

describe("an Apigee proxy and the service behind it, as the map prompt asks them read", () => {
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
    expect(got).toEqual(JSON.parse(readFileSync(join(FIX, "expected", "verified.json"), "utf8")));
  });

  it("rejects a context path the cited line doesn't set", async () => {
    const r = await run(
      "forge-fees",
      facts("forge-fees").map((f) =>
        f.id === "config.context-path"
          ? ({
              ...f,
              cite: {
                ...f.cite,
                file: "src/main/java/forge/fees/FeesController.java",
                line: 6,
                quote: '@RequestMapping("/fees")',
              },
            } as Fact)
          : f,
      ),
    );
    expect(r.rejected.map((x) => [x.fact.id, x.code])).toEqual([
      ["config.context-path", "claim-not-on-line"],
    ]);
  });

  it("rejects target.copy.pathsuffix cited on a line that doesn't set it", async () => {
    const r = await run(
      "forge-edge",
      facts("forge-edge").map((f) =>
        f.id === "config.refunds-copy-pathsuffix"
          ? ({
              ...f,
              cite: {
                ...f.cite,
                file: "proxies/forge-refunds-v1/apiproxy/policies/JS-NoSuffix.xml",
                line: 2,
                quote: "<ResourceURL>jsc://no-suffix.js</ResourceURL>",
              },
            } as Fact)
          : f,
      ),
    );
    expect(r.rejected.map((x) => [x.fact.id, x.code])).toEqual([
      ["config.refunds-copy-pathsuffix", "claim-not-on-line"],
    ]);
  });
});
