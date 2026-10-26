import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  joinFacts,
  joinRecords,
  parseFacts,
  projectFacts,
  type CatalogRecord,
  type Fact,
  type JoinRepo,
} from "@maycombhq/core";
import {
  bundleRootOf,
  codeLinkerFor,
  dirSource,
  policyElement,
  renderMap,
  verifyFacts,
} from "../src/index.js";

/**
 * The scopes a gateway route demands, checked like any other citation, and the policy an
 * `authCite` attaches checked for its kind (ADR 0124 addendum A-gateway2), on the invented
 * `fixtures/gateway-chain/` (an internal gateway with two scoped routes and one that forwards
 * into an external gateway with a scope of its own).
 */
const FIX = join(__dirname, "..", "..", "..", "fixtures", "gateway-chain");
const COMMITS: Record<string, string> = {
  "forge-shop-bff": "aaa1111",
  "forge-edge-gateway": "bbb2222",
  "forge-orders": "ccc3333",
  "forge-partner-gateway": "ddd4444",
  "northwind-pay-api": "eee5555",
  "forge-orders-sandbox": "fff6666",
};
const facts = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(FIX, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const run = (repo: string, fs: Fact[] = facts(repo)) =>
  verifyFacts({ facts: fs, source: dirSource(join(FIX, "repos", repo)), commit: COMMITS[repo] });
const edit = (repo: string, id: string, f: (x: Fact) => Record<string, unknown>) =>
  facts(repo).map((x) => (x.id === id ? ({ ...x, ...f(x) } as Fact) : x));
const EDGE = "forge-edge-gateway";
const P2 = "proxies/forge-orders-v2/apiproxy";
const P3 = "proxies/forge-pay-v1/apiproxy";
const DISPATCH = "entry.post.forge-v2-orders-id-dispatch";

describe("the hand-written facts of the two-gateway chain verify", () => {
  it.each(Object.keys(COMMITS))("%s: every fact kept, every auth cited", async (repo) => {
    const r = await run(repo);
    expect(r.rejected).toEqual([]);
    expect(r.accepted).toHaveLength(facts(repo).length);
    expect(r.authUncited).toEqual([]);
  });

  it("counts the scope policies it cites among the files read", async () => {
    const r = await run(EDGE);
    expect(r.coverage.read).toContain(`${P2}/policies/OAuth-VerifyRead.xml`);
    expect(r.coverage.read).toContain(`${P2}/policies/OAuth-VerifyDispatch.xml`);
    expect(r.coverage.read).toContain(`${P3}/policies/OAuth-VerifyPay.xml`);
    // What is left are the bundle descriptors and the dev TargetServers, which no fact rests on.
    expect(r.coverage.unknown).toEqual([
      "environments/dev/targetservers.json",
      "proxies/forge-loop-v1/apiproxy/forge-loop-v1.xml",
      "proxies/forge-orders-v2/apiproxy/forge-orders-v2.xml",
      "proxies/forge-pay-v1/apiproxy/forge-pay-v1.xml",
    ]);
  });
});

describe("a scope rests on the line that names it", () => {
  it("keeps two scopes a <Scope> list writes on one line", async () => {
    const kept = (await run(EDGE)).accepted.find((f) => f.id === DISPATCH)!;
    expect(kept.kind === "entry" && kept.scopes?.map((s) => s.value)).toEqual([
      "orders.dispatch",
      "orders.write",
    ]);
  });

  it("rejects a scope no line names (an invented one)", async () => {
    const r = await run(
      EDGE,
      edit(EDGE, DISPATCH, (x) => ({
        scopes: [
          ...(x.kind === "entry" ? (x.scopes ?? []) : []).slice(0, 1),
          {
            file: `${P2}/policies/OAuth-VerifyDispatch.xml`,
            line: 3,
            value: "orders.admin",
            quote: "<Scope>orders.dispatch orders.write</Scope>",
          },
        ],
      })),
    );
    expect(r.rejected.map((x) => [x.fact.id, x.code])).toEqual([
      ["call.post.dispatch", "ref-rejected"],
      [DISPATCH, "claim-not-on-line"],
    ]);
    expect(r.rejected[1]!.message).toContain('scope 2 ("orders.admin")');
  });

  it("rejects a scope cited on the wrong line of the right policy", async () => {
    const r = await run(
      EDGE,
      edit(EDGE, "entry.get.forge-v2-orders-id", () => ({
        scopes: [{ file: `${P2}/policies/OAuth-VerifyRead.xml`, line: 1, value: "orders.read" }],
      })),
    );
    expect(r.rejected.map((x) => [x.fact.id, x.code])).toEqual([
      ["call.get.orders-id", "ref-rejected"],
      ["entry.get.forge-v2-orders-id", "claim-not-on-line"],
    ]);
  });

  it("rejects a scope cited in a file that isn't in the repo", async () => {
    const r = await run(
      EDGE,
      edit(EDGE, "entry.get.forge-v2-orders-id", () => ({
        scopes: [{ file: `${P2}/policies/OAuth-Gone.xml`, line: 3, value: "orders.read" }],
      })),
    );
    expect(r.rejected.map((x) => x.code)).toContain("no-file");
  });
});

describe("an authCite's policy must be of the kind the auth claims", () => {
  it("reads the policy's root element out of the bundle the citation is in", () => {
    const lines = (p: string) => {
      try {
        return readFileSync(join(FIX, "repos", EDGE, p), "utf8").split("\n");
      } catch {
        return undefined;
      }
    };
    expect(bundleRootOf(`${P2}/proxies/default.xml`)).toBe(P2);
    expect(bundleRootOf("src/main/java/forge/orders/OrdersController.java")).toBeUndefined();
    expect(policyElement(`${P2}/proxies/default.xml`, "OAuth-VerifyDispatch", lines)).toEqual({
      path: `${P2}/policies/OAuth-VerifyDispatch.xml`,
      element: "OAuthV2",
    });
    expect(policyElement(`${P2}/proxies/default.xml`, "SA-Orders", lines)).toEqual({
      path: `${P2}/policies/SA-Orders.xml`,
      element: "SpikeArrest",
    });
    // Nothing to read: a line outside a bundle, or a policy the bundle hasn't got.
    expect(policyElement(`${P2}/proxies/default.xml`, "Not-There", lines)).toBeUndefined();
    expect(policyElement("src/app.ts", "OAuth-VerifyDispatch", lines)).toBeUndefined();
  });

  it("rejects oauth2 claimed on a line that attaches a SpikeArrest", async () => {
    const r = await run(
      EDGE,
      edit(EDGE, "entry.get.forge-v2-orders-id", () => ({
        authCite: { file: `${P2}/proxies/default.xml`, line: 6, value: "SA-Orders" },
      })),
    );
    expect(r.rejected.map((x) => [x.fact.id, x.code])).toEqual([
      ["call.get.orders-id", "ref-rejected"],
      ["entry.get.forge-v2-orders-id", "auth-policy-kind"],
    ]);
    expect(r.rejected[1]!.message).toContain("a SpikeArrest policy");
    expect(r.rejected[1]!.message).toContain("authenticates nobody");
  });

  it("rejects an auth of the wrong scheme for the policy that is there", async () => {
    // The shared flow of fixtures/gateway-facts: a VerifyAPIKey can't make an OAuth check.
    const GW = join(__dirname, "..", "..", "..", "fixtures", "gateway-facts");
    const parsed = parseFacts(readFileSync(join(GW, "facts", "forge-gateway.jsonl"), "utf8"));
    if (!parsed.ok) throw new Error("fixture");
    const fs = parsed.facts.map((x) =>
      x.id === "entry.get.forge-v1-accounts-id" ? ({ ...x, auth: "oauth2" } as Fact) : x,
    );
    const r = await verifyFacts({
      facts: fs,
      source: dirSource(join(GW, "repos", "forge-gateway")),
      commit: "7777aaa",
    });
    const bad = r.rejected.find((x) => x.fact.id === "entry.get.forge-v1-accounts-id")!;
    expect(bad.code).toBe("auth-policy-kind");
    expect(bad.message).toContain("a VerifyAPIKey policy");
    expect(bad.message).toContain("checks an API key, not an OAuth token");
  });

  it("judges no policy it doesn't know, and none outside a bundle", async () => {
    // A FlowCallout leads to a shared flow that may check anything: not this check's business.
    const GW = join(__dirname, "..", "..", "..", "fixtures", "gateway-facts");
    const parsed = parseFacts(readFileSync(join(GW, "facts", "forge-gateway.jsonl"), "utf8"));
    if (!parsed.ok) throw new Error("fixture");
    const P = "proxies/forge-accounts-v1/apiproxy";
    const fs = parsed.facts.map((x) =>
      x.id === "entry.get.forge-v1-accounts-id"
        ? ({
            ...x,
            authCite: { file: `${P}/proxies/default.xml`, line: 6, value: "FC-Security" },
          } as Fact)
        : x,
    );
    const r = await verifyFacts({
      facts: fs,
      source: dirSource(join(GW, "repos", "forge-gateway")),
      commit: "7777aaa",
    });
    expect(r.rejected).toEqual([]);
    // And a service's own entry, whose authCite is an annotation, is untouched.
    expect((await run("forge-orders")).rejected).toEqual([]);
  });
});

describe("map.md prints the whole path of a call through the gateways", () => {
  /** The chain's estate as the manifest lists it, for the join. */
  const estate = (): JoinRepo[] => [
    { repo: "forge-shop-bff", facts: facts("forge-shop-bff"), component: "shop-bff" },
    {
      repo: "forge-edge-gateway",
      facts: facts("forge-edge-gateway"),
      component: "edge-gateway",
      hosts: ["api.forge.example"],
      gateway: true,
    },
    {
      repo: "forge-orders",
      facts: facts("forge-orders"),
      component: "orders-api",
      hosts: ["orders.forge.internal"],
    },
    {
      repo: "forge-partner-gateway",
      facts: facts("forge-partner-gateway"),
      component: "partner-gateway",
      hosts: ["partner.forge.example"],
      gateway: true,
      facing: "external",
    },
    {
      repo: "northwind-pay-api",
      facts: facts("northwind-pay-api"),
      component: "northwind-pay-api",
      hosts: ["api.northwindpay.example"],
    },
  ];

  /** The whole estate's projected records plus the join's, as a scan would leave them. */
  const recordsOf = (repos: JoinRepo[]): CatalogRecord[] => [
    ...repos.flatMap(
      (r) =>
        projectFacts(
          r.facts.map((f) => ({ ...f, component: r.component }) as Fact),
          { system: r.component! },
        ).records,
    ),
    ...joinRecords(joinFacts({ repos }), repos),
  ];

  const mapOf = (repo: string, repos = estate()) =>
    renderMap({
      repo,
      records: recordsOf(repos),
      flows: [],
      paths: { map: `map/${repo}`, questions: "questions", specs: `specs/${repo}` },
      codeLink: codeLinkerFor({ url: `https://git.forge.example/forge/${repo}.git` }),
    })["map.md"]!;

  const callLines = (repo: string) =>
    mapOf(repo)
      .split("\n")
      .filter((l) => l.startsWith("- `"));

  it("names each hop, what it checks and the scopes it demands, in order", () => {
    const charge = callLines("forge-orders").find((l) => l.includes("/v2/charges"))!;
    expect(charge).toContain(
      "via forge-pay-v1 /forge/pay/v1 (OAuth-VerifyPay; scopes payments.charge) then northwind-pay-v1 /pay/v1 (OAuth-VerifyCharges; scopes northwind.charges.write)",
    );
    expect(charge).toContain("the caller meets oauth2");
  });

  it("names the one hop where there is one, and says when a route demands no scope", () => {
    const dispatch = callLines("forge-shop-bff").find((l) => l.includes("/dispatch"))!;
    expect(dispatch).toContain(
      "via forge-orders-v2 /forge/v2 (OAuth-VerifyDispatch; scopes orders.dispatch, orders.write)",
    );
    expect(dispatch).not.toContain(" then ");
    // A route with no scope fact says so, rather than saying nothing.
    const bare = estate().map((r) =>
      r.repo === "forge-edge-gateway"
        ? {
            ...r,
            facts: r.facts.map((f) => {
              if (f.kind !== "entry") return f;
              const { scopes: _s, ...rest } = f;
              return rest as Fact;
            }),
          }
        : r,
    );
    expect(mapOf("forge-shop-bff", bare)).toContain("(OAuth-VerifyDispatch; no scope)");
  });
});
