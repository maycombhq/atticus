import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  callerRecords,
  chainText,
  declaredCallsOf,
  joinCallers,
  joinFacts,
  joinRecords,
  parseFacts,
  parseRecord,
  Profile,
  type CatalogRecord,
  type DeclaredCallInput,
  type Fact,
  type JoinRepo,
} from "../src/index.js";

/**
 * Who a gateway route lets in (ADR 0124 addendum A-callers), on the invented
 * `fixtures/gateway-chain/`: the edge gateway's forge-refunds-v1 proxy names its consumers (the
 * API product forge-refunds and the two developer apps subscribed to it), and Harbor Desk, another
 * team's product whose repo is never scanned, is declared by a person in the profile as the app
 * harbor-desk-portal. The join reads the chain from Harbor Desk through the internal gateway, the
 * refunds service and the external gateway to Northwind Pay.
 */

const DIR = join(__dirname, "..", "..", "..", "fixtures", "gateway-chain");
const read = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(DIR, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
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
  {
    repo: "forge-refunds",
    facts: read("forge-refunds"),
    component: "refunds-api",
    hosts: ["refunds.forge.internal"],
  },
];
const profile = () => {
  const p = Profile.safeParse(
    parse(readFileSync(join(DIR, "org-pack", "profiles", "forge", "profile.yaml"), "utf8")),
  );
  if (!p.success) throw new Error(p.error.message);
  return p.data;
};
const declared = () => declaredCallsOf([{ platform: "forge", profile: profile() }]);
const run = (repos = estate(), d: readonly DeclaredCallInput[] = declared()) =>
  joinCallers({ repos, join: joinFacts({ repos }), declared: d });
const expected = () => parse(readFileSync(join(DIR, "expected", "callers.yaml"), "utf8"));
const swap = (repos: JoinRepo[], repo: string, facts: (fs: Fact[]) => Fact[]): JoinRepo[] =>
  repos.map((r) => (r.repo === repo ? { ...r, facts: facts([...r.facts]) } : r));
const withoutCallers = (fs: Fact[]) =>
  fs.map((f) => {
    if (f.kind !== "entry") return f;
    const { callers: _, ...rest } = f;
    return rest as Fact;
  });
const REFUND_POST = "entry.post.forge-refunds-v1-refunds";

describe("a person declares a caller Atticus can't scan", () => {
  it("reads the profile's declaration as the person's word", () => {
    expect(declared()).toEqual([
      {
        system: "harbor-desk",
        name: "Harbor Desk",
        boundary: "internal",
        owner: "team-harbor",
        as: "app",
        identity: "harbor-desk-portal",
        source: "profiles/forge/profile.yaml",
      },
    ]);
  });

  it("refuses a declaration that names neither an identity nor a route, or half an identity", () => {
    const sys = { id: "x", name: "X", boundary: "internal" };
    const bad = (calls: unknown[]) =>
      Profile.safeParse({
        schemaVersion: 1,
        platform: "p",
        name: "P",
        systems: [{ ...sys, calls }],
      }).success;
    expect(bad([{}])).toBe(false);
    expect(bad([{ as: "app" }])).toBe(false);
    expect(bad([{ name: "x-portal" }])).toBe(false);
    expect(bad([{ as: "app", name: "x-portal" }])).toBe(true);
    expect(bad([{ route: "forge-refunds-v1/CreateRefund" }])).toBe(true);
  });
});

describe("joinCallers on the gateway chain", () => {
  it("gives the golden callers of every route and the declared caller's chains", () => {
    const r = run();
    expect(JSON.parse(JSON.stringify(r.routes))).toEqual(expected().routes);
    expect(r.chains.map(chainText)).toEqual(expected().chains);
    expect(r.problems).toEqual(expected().problems);
  });

  it("is the same whatever order the repos come in", () => {
    const repos = estate();
    const a = joinCallers({ repos, join: joinFacts({ repos }), declared: declared() });
    const rev = [...repos].reverse();
    expect(
      joinCallers({ repos: rev, join: joinFacts({ repos: rev }), declared: declared() }),
    ).toEqual(a);
  });

  it("walks the chain hop by hop: internal gateway, service, external gateway, vendor", () => {
    const c = run().chains.find(
      (x) => x.route === "gw-edge-gateway-post-forge-refunds-v1-refunds",
    )!;
    expect(c.steps.map((s) => [s.kind, "component" in s ? s.component : s.system])).toEqual([
      ["declared", "harbor-desk"],
      ["gateway", "edge-gateway"],
      ["service", "refunds-api"],
      ["gateway", "partner-gateway"],
      ["service", "northwind-pay-api"],
    ]);
    expect(c.steps[0]).toMatchObject({ linked: true });
    expect(c.steps[1]).toMatchObject({
      auth: "oauth2",
      scopes: ["refunds.write"],
      facing: "internal",
    });
    expect(c.steps[3]).toMatchObject({ scopes: ["northwind.refunds.write"], facing: "external" });
  });

  it("says callers unknown where nothing names, declares or calls a route", () => {
    const r = run(swap(estate(), "forge-edge-gateway", withoutCallers), []);
    const unknown = r.routes.filter((x) => x.unknown).map((x) => x.gatewayRoute);
    expect(unknown).toEqual([
      "gw-edge-gateway-get-forge-refunds-v1-refunds-id",
      "gw-edge-gateway-post-forge-refunds-v1-refunds",
    ]);
    expect(r.chains).toEqual([]);
  });

  it("a declaration alone (nothing named) still makes the route's callers known, as a person's word", () => {
    const r = run(swap(estate(), "forge-edge-gateway", withoutCallers), [
      {
        ...declared()[0]!,
        as: undefined,
        identity: undefined,
        route: "forge-refunds-v1/CreateRefund",
      },
    ]);
    const post = r.routes.find((x) => x.route.fact === REFUND_POST)!;
    expect(post.unknown).toBeUndefined();
    expect(post.named).toEqual([]);
    expect(post.declared).toEqual([
      expect.objectContaining({
        system: "harbor-desk",
        route: "forge-refunds-v1/CreateRefund",
        by: "person",
      }),
    ]);
    expect(post.declared[0]!.linked).toBeUndefined();
    // Only the route the person named: the GET route is still unknown.
    expect(
      r.routes.find((x) => x.route.fact === "entry.get.forge-refunds-v1-refunds-id")!.unknown,
    ).toBe(true);
    expect(r.chains.map(chainText)).toEqual([
      "Harbor Desk (declared) → edge-gateway forge-refunds-v1 (oauth2; scopes refunds.write; internal) → refunds-api POST /refunds → partner-gateway northwind-refunds-v1 (oauth2; scopes northwind.refunds.write; external) → northwind-pay-api POST /v2/refunds",
    ]);
  });

  it("matches a route named as METHOD /path too", () => {
    const r = run(estate(), [
      {
        ...declared()[0]!,
        as: undefined,
        identity: undefined,
        route: "get /forge/refunds/v1/refunds/{id}",
      },
    ]);
    expect(r.routes.filter((x) => x.declared.length).map((x) => x.gatewayRoute)).toEqual([
      "gw-edge-gateway-get-forge-refunds-v1-refunds-id",
    ]);
  });

  it("never lets a declaration override the code: an identity the files don't name stays unlinked", () => {
    const r = run(estate(), [
      { ...declared()[0]!, identity: "harbor-desk-batch", route: "forge-refunds-v1/CreateRefund" },
    ]);
    const post = r.routes.find((x) => x.route.fact === REFUND_POST)!;
    // The cited consumers are as the code says; the declaration sits beside them, unlinked.
    expect(post.named.map((n) => n.name)).toEqual([
      "forge-refunds",
      "harbor-desk-portal",
      "forge-ops-console",
    ]);
    expect(post.declared).toHaveLength(1);
    expect(post.declared[0]!.linked).toBeUndefined();
    expect(chainText(r.chains[0]!)).toMatch(
      /^Harbor Desk \(declared; app harbor-desk-batch, which the gateway's files don't name\) → /,
    );
  });

  it("reports a declaration no route can be placed on, and places it nowhere", () => {
    const r = run(estate(), [{ ...declared()[0]!, identity: "harbor-desk-batch" }]);
    expect(r.routes.some((x) => x.declared.length)).toBe(false);
    expect(r.problems).toEqual([
      {
        system: "harbor-desk",
        source: "profiles/forge/profile.yaml",
        message:
          "Harbor Desk is declared to call as app harbor-desk-batch, and no gateway route the facts hold names that app",
      },
    ]);
  });
});

describe("callerRecords: the callers as C1 records", () => {
  const records = (): CatalogRecord[] => {
    const repos = estate();
    const join = joinFacts({ repos });
    return callerRecords(joinCallers({ repos, join, declared: declared() }), repos, join, {
      only: ["forge-edge-gateway"],
      existing: joinRecords(join, repos),
    });
  };

  it("are valid C1 records, without a schema change", () => {
    for (const r of records()) expect(parseRecord(r).ok, `${r.kind} ${r.id}`).toBe(true);
  });

  it("an AccessGrant per consumer a route names, cited on the line that names it", () => {
    const grants = records().filter((r) => r.kind === "AccessGrant");
    expect(
      grants.map((g) =>
        g.kind === "AccessGrant"
          ? [g.subjectKind, g.subject, g.resource, g.scopesOrPermissions.join(" "), g.flags]
          : [],
      ),
    ).toEqual([
      [
        "oauth-client",
        "forge-ops-console",
        "gw-edge-gateway-get-forge-refunds-v1-refunds-id",
        "refunds.read",
        ["caller:app"],
      ],
      [
        "oauth-client",
        "harbor-desk-portal",
        "gw-edge-gateway-get-forge-refunds-v1-refunds-id",
        "refunds.read",
        ["caller:app"],
      ],
      [
        "group",
        "forge-refunds",
        "gw-edge-gateway-get-forge-refunds-v1-refunds-id",
        "refunds.read",
        ["caller:product"],
      ],
      [
        "oauth-client",
        "forge-ops-console",
        "gw-edge-gateway-post-forge-refunds-v1-refunds",
        "refunds.write",
        ["caller:app"],
      ],
      [
        "oauth-client",
        "harbor-desk-portal",
        "gw-edge-gateway-post-forge-refunds-v1-refunds",
        "refunds.write",
        ["caller:app"],
      ],
      [
        "group",
        "forge-refunds",
        "gw-edge-gateway-post-forge-refunds-v1-refunds",
        "refunds.write",
        ["caller:product"],
      ],
    ]);
    const portal = grants.find(
      (g) =>
        g.kind === "AccessGrant" &&
        g.subject === "harbor-desk-portal" &&
        g.resource.includes("post"),
    )!;
    expect(portal.confidence).toBe("verified");
    expect(portal.evidence.map((e) => `${e.path}:${e.line}`)).toEqual([
      "resources/edge/org/developerApps.json:4",
      "resources/edge/org/developerApps.json:5",
    ]);
  });

  it("a GatewayRoute for every route no join through it records, with its API product", () => {
    const routes = records().filter((r) => r.kind === "GatewayRoute");
    expect(
      routes.map((r) =>
        r.kind === "GatewayRoute" ? [r.id, r.proxy, r.basepath, r.target, r.product, r.scopes] : [],
      ),
    ).toEqual([
      // The loop proxy's route: the calls into it are a ring (asked), so no join through it writes
      // its record; it is still a route of the gateway, forwarding to the partner gateway.
      [
        "gw-edge-gateway-get-forge-loop-ping",
        "forge-loop-v1",
        "/forge/loop",
        "partner-gateway",
        undefined,
        [],
      ],
      [
        "gw-edge-gateway-get-forge-refunds-v1-refunds-id",
        "forge-refunds-v1",
        "/forge/refunds/v1",
        "refunds-api",
        "forge-refunds",
        ["refunds.read"],
      ],
      [
        "gw-edge-gateway-post-forge-refunds-v1-refunds",
        "forge-refunds-v1",
        "/forge/refunds/v1",
        "refunds-api",
        "forge-refunds",
        ["refunds.write"],
      ],
    ]);
  });

  it("an Interface from the declared System, asserted, the person's word beside the cited lines", () => {
    const ifs = records().filter((r) => r.kind === "Interface");
    expect(
      ifs.map((i) =>
        i.kind === "Interface"
          ? [i.from, i.to, i.via, i.route, i.method, i.normalizedPath, i.auth, i.confidence]
          : [],
      ),
    ).toEqual(
      expect.arrayContaining([
        [
          "harbor-desk",
          "refunds-api",
          "gateway",
          "gw-edge-gateway-post-forge-refunds-v1-refunds",
          "POST",
          "/refunds",
          "oauth2",
          "asserted",
        ],
        [
          "harbor-desk",
          "refunds-api",
          "gateway",
          "gw-edge-gateway-get-forge-refunds-v1-refunds-id",
          "GET",
          "/refunds/{}",
          "oauth2",
          "asserted",
        ],
      ]),
    );
    expect(ifs).toHaveLength(2);
    const post = ifs.find((i) => i.kind === "Interface" && i.method === "POST")!;
    expect(post.evidence).toEqual([
      { source: "manual", path: "profiles/forge/profile.yaml", by: "person" },
      expect.objectContaining({
        source: "gateway",
        repo: "forge-edge-gateway",
        path: "proxies/forge-refunds-v1/apiproxy/proxies/default.xml",
        line: 10,
      }),
      expect.objectContaining({ path: "resources/edge/org/developerApps.json", line: 4 }),
    ]);
  });

  it("writes nothing for a repo not asked for", () => {
    const repos = estate();
    const join = joinFacts({ repos });
    expect(
      callerRecords(joinCallers({ repos, join, declared: declared() }), repos, join, {
        only: ["forge-refunds"],
      }),
    ).toEqual([]);
  });
});
