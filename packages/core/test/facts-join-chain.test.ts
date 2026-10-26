import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  joinFacts,
  joinRecords,
  MAX_GATEWAY_HOPS,
  parseFacts,
  parseRecord,
  type Fact,
  type JoinRepo,
} from "../src/index.js";

/**
 * The join through a chain of gateways, with the scopes each route demands (ADR 0124 addendum
 * A-gateway2): a shop's back end calls the internal edge gateway, which forwards to the orders
 * service; the orders service calls Northwind Pay through the edge gateway, which forwards into
 * the external partner gateway, which forwards to the vendor. Two hops in one join, each with its
 * own auth, its scopes and whether it faces inside or out. Plus the cycle and the ambiguous host.
 */

const DIR = join(__dirname, "..", "..", "..", "fixtures", "gateway-chain");
const read = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(DIR, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const readCase = (name: string): Fact[] => {
  const r = parseFacts(readFileSync(join(DIR, "cases", `${name}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};

/** The six repos as org-pack/profiles/forge/repos.manifest.yaml lists them. */
const estate = (): JoinRepo[] => [
  { repo: "forge-shop-bff", facts: read("forge-shop-bff"), component: "shop-bff" },
  {
    repo: "forge-edge-gateway",
    facts: read("forge-edge-gateway"),
    component: "edge-gateway",
    hosts: ["api.forge.example"],
    gateway: true,
  },
  {
    repo: "forge-orders",
    facts: read("forge-orders"),
    component: "orders-api",
    hosts: ["orders.forge.internal"],
  },
  {
    repo: "forge-partner-gateway",
    facts: read("forge-partner-gateway"),
    component: "partner-gateway",
    hosts: ["partner.forge.example"],
    gateway: true,
    facing: "external",
  },
  {
    repo: "northwind-pay-api",
    facts: read("northwind-pay-api"),
    component: "northwind-pay-api",
    hosts: ["api.northwindpay.example"],
  },
  {
    repo: "forge-orders-sandbox",
    facts: read("forge-orders-sandbox"),
    component: "orders-sandbox-api",
    hosts: ["orders-sandbox.forge.internal"],
  },
];
const expected = () => parse(readFileSync(join(DIR, "expected", "join.yaml"), "utf8"));
const swap = (repos: JoinRepo[], repo: string, facts: (fs: Fact[]) => Fact[]): JoinRepo[] =>
  repos.map((r) => (r.repo === repo ? { ...r, facts: facts([...r.facts]) } : r));
const SHOP_DISPATCH = "call.post.forge-v2-orders-id-dispatch";
const ORDERS_CHARGE = "call.post.forge-pay-v1-charges";
const EDGE_CHARGE = "call.post.partner-pay-v1-charges";

describe("joinFacts through a chain of gateways", () => {
  it("gives the golden joins, asks and lineage", () => {
    expect(JSON.parse(JSON.stringify(joinFacts({ repos: estate() })))).toEqual(expected());
  });

  it("is the same whatever order the repos come in", () => {
    expect(joinFacts({ repos: [...estate()].reverse() })).toEqual(joinFacts({ repos: estate() }));
  });

  it("follows two hops: the orders service reaches the vendor through both gateways, in order", () => {
    const j = joinFacts({ repos: estate() }).joins.find((x) => x.call.fact === ORDERS_CHARGE)!;
    expect(j.entry).toMatchObject({
      repo: "northwind-pay-api",
      fact: "entry.post.v2-charges",
      component: "northwind-pay-api",
    });
    expect(j.path).toBe("/v2/charges");
    expect(j.method).toBe("POST");
    expect(j.gateway!.map((h) => [h.entry.component, h.auth, h.scopes, h.facing, h.route])).toEqual(
      [
        [
          "edge-gateway",
          "oauth2",
          ["payments.charge"],
          "internal",
          "gw-edge-gateway-post-forge-pay-v1-charges",
        ],
        [
          "partner-gateway",
          "oauth2",
          ["northwind.charges.write"],
          "external",
          "gw-partner-gateway-post-pay-v1-charges",
        ],
      ],
    );
    // Every hop's scopes, in the order the call meets them.
    expect(j.scopes).toEqual(["payments.charge", "northwind.charges.write"]);
    // And the fields cross the whole chain.
    const lineage = joinFacts({ repos: estate() }).lineage.filter(
      (l) => l.interface === j.interface,
    );
    expect(lineage.map((l) => [l.from.name, l.to.name])).toEqual([
      ["amount", "amount"],
      ["reference", "reference"],
    ]);
  });

  it("keeps one hop where there is one, with the route's scopes and the path it rewrites to", () => {
    const j = joinFacts({ repos: estate() }).joins.find((x) => x.call.fact === SHOP_DISPATCH)!;
    expect(j.path).toBe("/dispatch");
    expect(j.gateway).toHaveLength(1);
    expect(j.gateway![0]).toMatchObject({
      entry: { fact: "entry.post.forge-v2-orders-id-dispatch" },
      call: { fact: "call.post.dispatch" },
      tie: { fact: "config.targetserver.orders-backend" },
      auth: "oauth2",
      scopes: ["orders.dispatch", "orders.write"],
      facing: "internal",
    });
    expect(j.scopes).toEqual(["orders.dispatch", "orders.write"]);
  });

  it("marks a hop internal or external, and leaves it plain when nothing says", () => {
    // The edge gateway's manifest type is a plain `gateway`: its proxy's <VirtualHost> says.
    const noHost = swap(estate(), "forge-edge-gateway", (fs) =>
      fs.filter((f) => !f.id.startsWith("config.virtualhost.")),
    );
    const hops = (repos: JoinRepo[]) =>
      joinFacts({ repos }).joins.find((x) => x.call.fact === ORDERS_CHARGE)!.gateway!;
    expect(hops(noHost).map((h) => h.facing)).toEqual([undefined, "external"]);
    // A word neither list knows leaves the hop plain, rather than guessing from the basepath.
    const odd = swap(estate(), "forge-edge-gateway", (fs) =>
      fs.map((f) =>
        f.id === "config.virtualhost.forge-pay-v1" ? ({ ...f, value: "vh3" } as Fact) : f,
      ),
    );
    expect(hops(odd)[0]!.facing).toBeUndefined();
    // The words are the estate's: told that `vh3` is its outside, the hop is external.
    expect(
      joinFacts({
        repos: odd,
        facing: { internal: ["vh1"], external: ["vh3"] },
      }).joins.find((x) => x.call.fact === ORDERS_CHARGE)!.gateway![0]!.facing,
    ).toBe("external");
    // The manifest's type wins over the proxy's virtual host.
    const typed = estate().map((r) =>
      r.repo === "forge-edge-gateway" ? { ...r, facing: "external" as const } : r,
    );
    expect(hops(typed)[0]!.facing).toBe("external");
  });

  it("asks rather than loops when the routes lead back where they came from", () => {
    const out = joinFacts({ repos: estate() });
    const ring = out.asks.filter((a) => a.reason === "cycle");
    // One question per call into the ring, in the joins' own order (by the caller's repo).
    expect(ring.map((a) => a.call.fact)).toEqual([
      "call.get.pay-loop-ping",
      "call.get.forge-loop-ping",
    ]);
    expect(ring[0]!.question).toBe(
      "Where does GET /pay/loop/ping, which edge-gateway calls, end? Its gateway routes lead back into partner-gateway, which it has already been through, so the facts can't say.",
    );
    expect(ring[0]!.candidates.map((c) => c.fact)).toEqual([
      "entry.get.forge-loop-ping",
      "entry.get.pay-loop-ping",
    ]);
    // Each still joins the gateway route it does reach: only where it goes on is unknown.
    for (const a of ring)
      expect(out.joins.find((x) => x.call.fact === a.call.fact)!.gateway).toBeUndefined();
    expect(out.joins.find((j) => j.call.fact === "call.get.pay-loop-ping")!.entry.fact).toBe(
      "entry.get.pay-loop-ping",
    );
    // And no other join is lost to the ring.
    expect(out.joins.some((j) => j.call.fact === ORDERS_CHARGE)).toBe(true);
  });

  it("walks no further than the bound, so a long chain is a question, not a loop", () => {
    expect(MAX_GATEWAY_HOPS).toBe(4);
  });

  it("asks, never guesses, when a TargetServer's hosts are two repos'", () => {
    const repos = swap(estate(), "forge-edge-gateway", (fs) => [
      ...fs,
      ...readCase("ambiguous-host"),
    ]);
    const out = joinFacts({ repos });
    const asked = out.asks.find((a) => a.call.fact === "call.get.orders-id")!;
    expect(asked).toMatchObject({
      reason: "ambiguous",
      question:
        "Which repo or system answers GET /orders/{id}, which edge-gateway calls through orders-backend?",
    });
    expect(asked.candidates.map((c) => `${c.repo}/${c.fact}`)).toEqual([
      "forge-orders/entry.get.orders-id",
      "forge-orders-sandbox/entry.get.orders-id",
    ]);
    // Both of the shop's calls stop at the edge gateway's routes: both forwarding calls go
    // through the same TargetServer, so where either goes on is the question.
    const get = out.joins.find((x) => x.call.fact === "call.get.forge-v2-orders-id")!;
    expect(get.gateway).toBeUndefined();
    expect(get.entry.repo).toBe("forge-edge-gateway");
    expect(get.path).toBe("/forge/v2/orders/{id}");
    expect(out.joins.find((x) => x.call.fact === SHOP_DISPATCH)!.gateway).toBeUndefined();
    // The charge, whose TargetServer is not in doubt, still goes through both gateways.
    expect(out.joins.find((x) => x.call.fact === ORDERS_CHARGE)!.gateway).toHaveLength(2);
  });

  it("stops at the last gateway it can read when a later hop is in doubt", () => {
    // Nobody lists Northwind Pay's host: the partner gateway's own forwarding call is asked, so
    // the orders service's call stops at the edge gateway's route, the one hop the facts settle.
    const repos = estate().map((r) => (r.repo === "northwind-pay-api" ? { ...r, hosts: [] } : r));
    const out = joinFacts({ repos });
    const j = out.joins.find((x) => x.call.fact === ORDERS_CHARGE)!;
    expect(j.gateway).toHaveLength(1);
    expect(j.gateway![0]!.entry.component).toBe("edge-gateway");
    expect(j.entry.fact).toBe("entry.post.pay-v1-charges");
    expect(j.path).toBe("/pay/v1/charges");
    expect(out.asks.map((a) => [a.call.fact, a.reason])).toContainEqual([
      "call.post.v2-charges",
      "unknown-host",
    ]);
  });
});

describe("joinRecords through a chain of gateways", () => {
  const records = () => {
    const repos = estate();
    return joinRecords(joinFacts({ repos }), repos);
  };

  it("cites every hop on the Interface, in order, and names the first route", () => {
    const rs = records();
    const j = joinFacts({ repos: estate() }).joins.find((x) => x.call.fact === ORDERS_CHARGE)!;
    const iface = rs.find((r) => r.id === j.interface)!;
    expect(iface).toMatchObject({
      kind: "Interface",
      confidence: "verified",
      from: "orders-api",
      to: "northwind-pay-api",
      via: "gateway",
      route: "gw-edge-gateway-post-forge-pay-v1-charges",
      method: "POST",
      normalizedPath: "/v2/charges",
      auth: "oauth2",
    });
    expect(
      (iface.evidence as { source: string; side?: string; path?: string; line?: number }[]).map(
        (e) => `${e.source}/${e.side} ${e.path}:${e.line}`,
      ),
    ).toEqual([
      "code/caller src/main/java/forge/orders/PayGatewayClient.java:17",
      "config/caller src/main/resources/application.yml:3",
      "gateway/gateway proxies/forge-pay-v1/apiproxy/proxies/default.xml:13",
      "gateway/gateway proxies/forge-pay-v1/apiproxy/policies/AM-RewritePay.xml:8",
      "config/gateway environments/prod/targetservers.json:10",
      "gateway/gateway proxies/northwind-pay-v1/apiproxy/proxies/default.xml:10",
      "config/gateway environments/prod/targetservers.json:4",
      "code/callee src/main/java/northwind/pay/ChargesController.java:16",
    ]);
  });

  it("records a GatewayRoute per hop, its scopes filled from the facts, each forwarding on", () => {
    const rs = records();
    const routes = rs.filter((r) => r.kind === "GatewayRoute");
    expect(routes.map((r) => [r.id, r.proxy, r.basepath, r.target, r.policies, r.scopes])).toEqual([
      [
        "gw-edge-gateway-get-forge-v2-orders-id",
        "forge-orders-v2",
        "/forge/v2",
        "orders-api",
        ["OAuth-VerifyRead"],
        ["orders.read"],
      ],
      [
        "gw-edge-gateway-post-forge-pay-v1-charges",
        "forge-pay-v1",
        "/forge/pay/v1",
        // A middle hop forwards into the next gateway, not straight to the service.
        "partner-gateway",
        ["OAuth-VerifyPay"],
        ["payments.charge"],
      ],
      [
        "gw-edge-gateway-post-forge-v2-orders-id-dispatch",
        "forge-orders-v2",
        "/forge/v2",
        "orders-api",
        ["OAuth-VerifyDispatch"],
        ["orders.dispatch", "orders.write"],
      ],
      [
        "gw-partner-gateway-post-pay-v1-charges",
        "northwind-pay-v1",
        "/pay/v1",
        "northwind-pay-api",
        ["OAuth-VerifyCharges"],
        ["northwind.charges.write"],
      ],
    ]);
    // Each scope's own line is evidence for the route that demands it.
    const dispatch = routes.find((r) => r.id.endsWith("dispatch"))!;
    expect(
      (dispatch.evidence as { path?: string; line?: number }[]).map((e) => `${e.path}:${e.line}`),
    ).toEqual([
      "proxies/forge-orders-v2/apiproxy/proxies/default.xml:28",
      "proxies/forge-orders-v2/apiproxy/proxies/default.xml:22",
      "proxies/forge-orders-v2/apiproxy/policies/OAuth-VerifyDispatch.xml:3",
      "proxies/forge-orders-v2/apiproxy/policies/AM-RewriteDispatch.xml:8",
    ]);
    for (const r of rs) expect(parseRecord(JSON.parse(JSON.stringify(r))).ok, r.id).toBe(true);
  });
});
