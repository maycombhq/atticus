import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFacts, type Fact } from "@maycombhq/core";
import { dirSource, fileKinds, kindsOf, verifyFacts } from "../src/index.js";

/**
 * An Apigee gateway read into facts (ADR 0124 addendum A-gateway): the verifier checks its
 * citations like any other's, XML lines and the parts in `cite.with` alike, on the invented
 * `fixtures/gateway-facts/` (a proxy with two conditional flows, a path rewrite, a TargetServer,
 * a VerifyAPIKey in a shared flow, an OAuthV2 check), and the portal and service either side.
 */
const FIX = join(__dirname, "..", "..", "..", "fixtures", "gateway-facts");
const COMMITS: Record<string, string> = {
  "forge-gateway": "7777aaa",
  "forge-portal-api": "8888bbb",
  "forge-accounts": "9999ccc",
};
const facts = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(FIX, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const run = (repo: string, fs: Fact[] = facts(repo)) =>
  verifyFacts({ facts: fs, source: dirSource(join(FIX, "repos", repo)), commit: COMMITS[repo] });
const edit = (id: string, f: (x: Fact) => Record<string, unknown>) =>
  facts("forge-gateway").map((x) => (x.id === id ? ({ ...x, ...f(x) } as Fact) : x));
const P = "proxies/forge-accounts-v1/apiproxy";

describe("the hand-written facts of the gateway, its caller and its service verify", () => {
  it.each(Object.keys(COMMITS))("%s: every fact kept, every auth cited", async (repo) => {
    const r = await run(repo);
    expect(r.rejected).toEqual([]);
    expect(r.accepted).toHaveLength(facts(repo).length);
    expect(r.authUncited).toEqual([]);
  });

  it("reads the proxy, the policies it cites, the shared flow and the TargetServer", async () => {
    const r = await run("forge-gateway");
    expect(r.coverage.read).toEqual([
      "environments/prod/targetservers.json",
      `${P}/policies/AM-RewriteTransfers.xml`,
      `${P}/policies/SA-Accounts.xml`,
      `${P}/proxies/default.xml`,
      `${P}/targets/accounts.xml`,
      "sharedflows/forge-security/sharedflowbundle/sharedflows/default.xml",
    ]);
    // The gateway's routes forward: no flow is asked of them.
    expect(r.entriesNoFlowFollows).toEqual([]);
    // The service's entries still are.
    expect((await run("forge-accounts")).entriesNoFlowFollows.map((e) => e.id)).toEqual([
      "entry.get.accounts-id",
      "entry.post.transfers",
    ]);
  });
});

describe("Apigee citations are checked like any other", () => {
  it("rejects a route whose base path part isn't the proxy's <BasePath>", async () => {
    const r = await run(
      "forge-gateway",
      edit("entry.get.forge-v1-accounts-id", (x) => ({
        path: "/forge/v2/accounts/{id}",
        cite: {
          ...x.cite,
          with: [{ file: `${P}/proxies/default.xml`, line: 30, value: "/forge/v2" }],
        },
      })),
    );
    expect(r.rejected.map((x) => [x.fact.id, x.code])).toEqual([
      // its forwarding call names it, so it waits for the rewrite
      ["call.get.accounts-id", "ref-rejected"],
      ["entry.get.forge-v1-accounts-id", "claim-not-on-line"],
    ]);
    expect(r.rejected[1]!.message).toContain('part 1 says "/forge/v2" is written at');
  });

  it("rejects a route cited on its condition without the base path in cite.with", async () => {
    const r = await run(
      "forge-gateway",
      edit("entry.get.forge-v1-accounts-id", (x) => {
        const { with: _w, ...cite } = x.cite;
        return { cite };
      }),
    );
    const route = r.rejected.find((x) => x.fact.id === "entry.get.forge-v1-accounts-id")!;
    expect(route.code).toBe("claim-not-on-line");
    expect(route.message).toContain("cite them in cite.with");
  });

  it("rejects an auth whose policy isn't attached on the cited line, and leaves out an uncited one", async () => {
    const wrong = await run(
      "forge-gateway",
      edit("entry.post.forge-v1-accounts-id-transfers", () => ({
        authCite: { file: `${P}/proxies/default.xml`, line: 20, value: "VAK-VerifyKey" },
      })),
    );
    expect(wrong.rejected.map((x) => [x.fact.id, x.code])).toEqual([
      ["call.post.transfers", "ref-rejected"],
      ["entry.post.forge-v1-accounts-id-transfers", "claim-not-on-line"],
    ]);
    expect(wrong.rejected[1]!.message).toContain("authCite (auth oauth2)");
    const uncited = await run(
      "forge-gateway",
      facts("forge-gateway").map((x) => {
        if (x.id !== "entry.get.forge-v1-accounts-id" || x.kind !== "entry") return x;
        const { authCite: _a, ...rest } = x;
        return rest as Fact;
      }),
    );
    expect(uncited.authUncited.map((a) => [a.id, a.auth])).toEqual([
      ["entry.get.forge-v1-accounts-id", "api-key"],
    ]);
  });

  it("rejects a forwarding call that keeps the base path the gateway drops", async () => {
    const r = await run(
      "forge-gateway",
      edit("call.get.accounts-id", () => ({ path: "/forge/v1/accounts/{id}" })),
    );
    expect(r.rejected.map((x) => [x.fact.id, x.code])).toEqual([
      ["call.get.accounts-id", "claim-not-on-line"],
    ]);
  });

  it("rejects a part cited on a line that doesn't write it (the rewrite's line moved)", async () => {
    const r = await run(
      "forge-gateway",
      edit("call.post.transfers", (x) => ({
        cite: {
          ...x.cite,
          with: [
            {
              file: `${P}/policies/AM-RewriteTransfers.xml`,
              line: 8,
              value: "target.copy.pathsuffix",
            },
          ],
        },
      })),
    );
    expect(r.rejected.map((x) => [x.fact.id, x.code])).toEqual([
      ["call.post.transfers", "claim-not-on-line"],
    ]);
  });
});

describe("a gateway's files are batched with the gateway's rules only (A-lean)", () => {
  it("gives an Apigee bundle's XML and JavaScript, TargetServers and KVMs the config and gateway kinds", () => {
    for (const p of [
      `${P}/proxies/default.xml`,
      `${P}/policies/AM-RewriteTransfers.xml`,
      `${P}/resources/jsc/rewrite.js`,
      "sharedflows/forge-security/sharedflowbundle/sharedflows/default.xml",
      "environments/prod/targetservers.json",
      "environments/prod/kvms.json",
      "resources/edge/env/prod/targetServers.json",
    ])
      expect(fileKinds(p), p).toEqual(["config", "gateway"]);
    expect(kindsOf([`${P}/proxies/default.xml`, "src/main/resources/application.yml"])).toEqual([
      "config",
      "gateway",
    ]);
  });

  it("never gives another file the gateway's rules", () => {
    for (const p of [
      "scripts/release.sh",
      "ops/kong.yaml",
      "src/main/java/forge/portal/AccountsGatewayClient.java",
      "src/app/api.gateway.ts",
      "k8s/gateway.yaml",
    ])
      expect(fileKinds(p), p).not.toContain("gateway");
  });
});
