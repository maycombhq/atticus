import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  joinFacts,
  joinRecords,
  parseFacts,
  parseRecord,
  type Fact,
  type JoinRepo,
} from "../src/index.js";

/**
 * The join through a gateway (ADR 0124 addendum A-gateway): a UI's back end calls an Apigee
 * proxy, and each call lands on the service the proxy forwards to, at the path the service
 * receives after the gateway's rewrite, with the route's auth on the Interface.
 */

const DIR = join(__dirname, "..", "..", "..", "fixtures", "gateway-facts");
const read = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(DIR, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
/** The three repos as the manifest lists them: the gateway typed `gateway`, two hosts. */
const estate = (o: { gateway?: boolean } = {}): JoinRepo[] => [
  { repo: "forge-portal-api", facts: read("forge-portal-api"), component: "portal-api" },
  {
    repo: "forge-gateway",
    facts: read("forge-gateway"),
    component: "api-gateway",
    hosts: ["api.forge.example"],
    ...(o.gateway === false ? {} : { gateway: true }),
  },
  {
    repo: "forge-accounts",
    facts: read("forge-accounts"),
    component: "accounts-api",
    hosts: ["accounts.forge.internal"],
  },
];
const expected = () => parse(readFileSync(join(DIR, "expected", "join.yaml"), "utf8"));
const swap = (repos: JoinRepo[], repo: string, facts: (fs: Fact[]) => Fact[]): JoinRepo[] =>
  repos.map((r) => (r.repo === repo ? { ...r, facts: facts([...r.facts]) } : r));
const PORTAL_GET = "call.get.forge-v1-accounts-id";
const PORTAL_POST = "call.post.forge-v1-accounts-id-transfers";

describe("joinFacts through a gateway: the caller joins the service the route forwards to", () => {
  it("gives the golden joins: BFF call, gateway route, forwarding call, service entry", () => {
    expect(JSON.parse(JSON.stringify(joinFacts({ repos: estate() })))).toEqual(expected());
  });

  it("is the same whatever order the repos come in", () => {
    expect(joinFacts({ repos: [...estate()].reverse() })).toEqual(joinFacts({ repos: estate() }));
  });

  it("follows an Apigee bundle's routes even when the manifest doesn't type the repo a gateway", () => {
    expect(joinFacts({ repos: estate({ gateway: false }) })).toEqual(
      joinFacts({ repos: estate() }),
    );
  });

  it("follows the rewrite: /forge/v1/accounts/{id}/transfers lands on /transfers", () => {
    const post = joinFacts({ repos: estate() }).joins.find((j) => j.call.fact === PORTAL_POST)!;
    expect(post).toMatchObject({
      entry: { repo: "forge-accounts", fact: "entry.post.transfers" },
      method: "POST",
      path: "/transfers",
      // A-gateway2: the hops in order, each with its auth and the scopes its route demands.
      gateway: [
        {
          entry: { fact: "entry.post.forge-v1-accounts-id-transfers" },
          call: { fact: "call.post.transfers" },
          tie: { fact: "config.targetserver.accounts-backend" },
          auth: "oauth2",
          scopes: ["accounts.transfer"],
        },
      ],
      scopes: ["accounts.transfer"],
    });
    // Nothing says whether this gateway faces inside or out (`<VirtualHost>secure</VirtualHost>`).
    expect(post.gateway![0]!.facing).toBeUndefined();
  });

  it("picks the gateway repo by path when several share one host (each proxy its own repo)", () => {
    // Another team's proxy on the same gateway host, under its own base path.
    const payments: Fact = {
      ...read("forge-gateway").find((f) => f.id === "entry.get.forge-v1-accounts-id")!,
      id: "entry.get.forge-payments-v1-payments-id",
      repo: "forge-cards-proxy",
      path: "/forge-payments/v1/payments/{id}",
      handler: "forge-payments-v1/GetPayment",
    } as Fact;
    const shared = (order: "first" | "last"): JoinRepo[] => {
      const other: JoinRepo = {
        repo: "forge-cards-proxy",
        facts: [payments],
        component: "cards-proxy",
        hosts: ["api.forge.example"],
        gateway: true,
      };
      return order === "first" ? [other, ...estate()] : [...estate(), other];
    };
    for (const order of ["first", "last"] as const) {
      const out = joinFacts({ repos: shared(order) });
      const get = out.joins.find((j) => j.call.fact === PORTAL_GET)!;
      expect(get, order).toBeDefined();
      expect(get.entry).toMatchObject({ repo: "forge-accounts" });
      expect(get.gateway![0]!.entry.repo).toBe("forge-gateway");
      expect(out.asks.filter((a) => a.call.fact === PORTAL_GET)).toEqual([]);
    }
    expect(joinFacts({ repos: shared("first") })).toEqual(joinFacts({ repos: shared("last") }));
  });

  it("joins at the gateway when the forwarding call's host is one nobody lists, and asks the host", () => {
    const repos = estate().map((r) => (r.repo === "forge-accounts" ? { ...r, hosts: [] } : r));
    const out = joinFacts({ repos });
    const get = out.joins.find((j) => j.call.fact === PORTAL_GET)!;
    expect(get.gateway).toBeUndefined();
    expect(get.entry).toMatchObject({
      repo: "forge-gateway",
      fact: "entry.get.forge-v1-accounts-id",
    });
    expect(get.path).toBe("/forge/v1/accounts/{id}");
    expect(out.asks.map((a) => [a.call.fact, a.reason, a.host])).toEqual([
      ["call.get.accounts-id", "unknown-host", "accounts.forge.internal"],
      ["call.post.transfers", "unknown-host", "accounts.forge.internal"],
    ]);
  });

  it("asks, never guesses, when a TargetServer's hosts (one per environment) are different repos'", () => {
    const dev: Fact = {
      ...(read("forge-gateway").find(
        (f) => f.id === "config.targetserver.accounts-backend",
      )! as Fact),
      id: "config.targetserver.accounts-backend-dev",
      value: "ledger.forge.internal",
      env: "dev",
    } as Fact;
    const ledger: JoinRepo = {
      repo: "forge-ledger",
      component: "ledger-api",
      hosts: ["ledger.forge.internal"],
      facts: read("forge-accounts").map((f) => ({ ...f, repo: "forge-ledger" }) as Fact),
    };
    const out = joinFacts({
      repos: [...swap(estate(), "forge-gateway", (fs) => [...fs, dev]), ledger],
    });
    const asked = out.asks.find((a) => a.call.fact === "call.get.accounts-id")!;
    expect(asked).toMatchObject({
      reason: "ambiguous",
      question:
        "Which repo or system answers GET /accounts/{id}, which api-gateway calls through accounts-backend?",
    });
    expect(asked.candidates.map((c) => `${c.repo}/${c.fact}`)).toEqual([
      "forge-accounts/entry.get.accounts-id",
      "forge-ledger/entry.get.accounts-id",
    ]);
    expect(out.joins.some((j) => j.call.fact === "call.get.accounts-id")).toBe(false);
    // The portal's call stops at the gateway's route: where it goes on is the question.
    expect(out.joins.find((j) => j.call.fact === PORTAL_GET)!.entry.repo).toBe("forge-gateway");
    // A person's answer settles it.
    const answered = joinFacts({
      repos: [...swap(estate(), "forge-gateway", (fs) => [...fs, dev]), ledger],
      targets: { "forge-gateway": { "call.get.accounts-id": "forge-accounts" } },
    });
    expect(answered.joins.find((j) => j.call.fact === PORTAL_GET)!.entry).toMatchObject({
      repo: "forge-accounts",
      fact: "entry.get.accounts-id",
    });
  });

  it("joins at the gateway a route that forwards to two services", () => {
    const other: Fact = {
      ...(read("forge-gateway").find((f) => f.id === "call.get.accounts-id")! as Fact),
      id: "call.get.accounts-id-ledger",
      base: "ledger-backend",
      host: "ledger.forge.internal",
    } as Fact;
    const ledger: JoinRepo = {
      repo: "forge-ledger",
      component: "ledger-api",
      hosts: ["ledger.forge.internal"],
      facts: read("forge-accounts").map((f) => ({ ...f, repo: "forge-ledger" }) as Fact),
    };
    const out = joinFacts({
      repos: [...swap(estate(), "forge-gateway", (fs) => [...fs, other]), ledger],
    });
    const get = out.joins.find((j) => j.call.fact === PORTAL_GET)!;
    expect(get.gateway).toBeUndefined();
    expect(get.entry.fact).toBe("entry.get.forge-v1-accounts-id");
    // Each forwarding call is joined on its own.
    expect(
      out.joins
        .filter((j) => j.call.repo === "forge-gateway")
        .map((j) => `${j.call.fact} -> ${j.entry.repo}`),
    ).toEqual([
      "call.get.accounts-id -> forge-accounts",
      "call.get.accounts-id-ledger -> forge-ledger",
      "call.post.transfers -> forge-accounts",
    ]);
  });

  it("doesn't walk through a service's own entry that makes a call (only a gateway's routes)", () => {
    // The accounts service's handler calling another service is not a route.
    const repos = estate({ gateway: false }).map((r) =>
      r.repo === "forge-gateway"
        ? {
            ...r,
            facts: r.facts.map((f) =>
              f.cite.file.includes("apiproxy/")
                ? ({
                    ...f,
                    cite: { ...f.cite, file: f.cite.file.replace("apiproxy/", "src/") },
                  } as Fact)
                : f,
            ),
          }
        : r,
    );
    const get = joinFacts({ repos }).joins.find((j) => j.call.fact === PORTAL_GET)!;
    expect(get.gateway).toBeUndefined();
    expect(get.entry.repo).toBe("forge-gateway");
  });
});

describe("joinRecords through a gateway: the Interface, its route and the auth a caller meets", () => {
  const records = () => {
    const repos = estate();
    return joinRecords(joinFacts({ repos }), repos);
  };

  it("records the caller to the service via the gateway, at the rewritten path, with the route's auth", () => {
    const rs = records();
    const post = rs.find((r) => r.id === "if-0136b1d1afc3441f")!;
    expect(post).toMatchObject({
      kind: "Interface",
      confidence: "verified",
      from: "portal-api",
      to: "accounts-api",
      via: "gateway",
      route: "gw-api-gateway-post-forge-v1-accounts-id-transfers",
      method: "POST",
      normalizedPath: "/transfers",
      auth: "oauth2",
    });
    expect(
      (post.evidence as { source: string; side?: string; path?: string; line?: number }[]).map(
        (e) => `${e.source}/${e.side} ${e.path}:${e.line}`,
      ),
    ).toEqual([
      "code/caller src/main/java/forge/portal/AccountsGatewayClient.java:22",
      "config/caller src/main/resources/application.yml:3",
      "gateway/gateway proxies/forge-accounts-v1/apiproxy/proxies/default.xml:26",
      "gateway/gateway proxies/forge-accounts-v1/apiproxy/policies/AM-RewriteTransfers.xml:8",
      "config/gateway environments/prod/targetservers.json:4",
      "code/callee src/main/java/forge/accounts/AccountsController.java:23",
    ]);
    expect(rs.find((r) => r.id === "if-1d1553e8f834ec02")).toMatchObject({
      via: "gateway",
      normalizedPath: "/accounts/{}",
      auth: "api-key",
    });
  });

  it("records each route as a GatewayRoute from the facts, valid C1", () => {
    const rs = records();
    const routes = rs.filter((r) => r.kind === "GatewayRoute");
    expect(routes.map((r) => r.id)).toEqual([
      "gw-api-gateway-get-forge-v1-accounts-id",
      "gw-api-gateway-post-forge-v1-accounts-id-transfers",
    ]);
    expect(routes[1]).toMatchObject({
      proxy: "forge-accounts-v1",
      basepath: "/forge/v1",
      target: "accounts-api",
      policies: ["OAuth-VerifyToken"],
      // A-gateway2: filled from the route's scope facts, not left empty.
      scopes: ["accounts.transfer"],
    });
    expect(routes[0]).toMatchObject({ policies: ["VAK-VerifyKey"], scopes: [] });
    for (const r of rs) expect(parseRecord(JSON.parse(JSON.stringify(r))).ok, r.id).toBe(true);
  });

  it("takes the service's auth when the route has none, and says none when neither has", () => {
    const noRouteAuth = (fs: Fact[]) =>
      fs.map((f) => {
        if (f.kind !== "entry") return f;
        const { auth: _a, authCite: _c, scopes: _s, ...rest } = f;
        return rest as Fact;
      });
    const bare = swap(estate(), "forge-gateway", noRouteAuth);
    const iface = (repos: JoinRepo[]) =>
      joinRecords(joinFacts({ repos }), repos).find((r) => r.id === "if-1d1553e8f834ec02")!;
    expect(iface(bare)).not.toHaveProperty("auth");
    const served = swap(bare, "forge-accounts", (fs) =>
      fs.map((f) =>
        f.kind === "entry"
          ? ({
              ...f,
              auth: "mtls",
              authCite: { file: f.cite.file, line: f.cite.line, value: "x" },
            } as Fact)
          : f,
      ),
    );
    expect(iface(served)).toMatchObject({ auth: "mtls", via: "gateway" });
  });
});

describe("joinRecords through a gateway: a hop that guessed makes the whole link a guess (J0, J1)", () => {
  it("marks the Interface inferred and flagged when the forwarding call's host is one an open conflict disputes", () => {
    // The manifest lists another host for forge-accounts; a Route says accounts.forge.internal.
    const repos: JoinRepo[] = [
      ...estate().map((r) =>
        r.repo === "forge-accounts" ? { ...r, hosts: ["accounts.other.internal"] } : r,
      ),
      {
        repo: "forge-deploy",
        component: "deploy-config",
        facts: [
          {
            kind: "deploy",
            id: "d-accounts-route",
            repo: "forge-deploy",
            commit: "7777aaa",
            platform: "openshift",
            resourceType: "route",
            resourceName: "forge-accounts",
            host: "accounts.forge.internal",
            exposes: "forge-accounts",
            cite: { file: "routes/accounts.yaml", line: 5, value: "accounts.forge.internal" },
            verified: "line",
            by: "assistant",
            conf: "declared",
          } as Fact,
        ],
      },
    ];
    const out = joinFacts({ repos });
    expect(out.exposure?.map((x) => x.reason)).toEqual(["host-conflict"]);
    const post = out.joins.find((j) => j.call.fact === PORTAL_POST)!;
    expect(post.gateway?.length).toBe(1);
    expect(post.guesses).toEqual(["joined-despite-conflict"]);
    const iface = joinRecords(out, repos).find((r) => r.id === post.interface)!;
    expect(iface).toMatchObject({
      confidence: "inferred",
      via: "gateway",
      flags: ["joined-despite-conflict"],
    });
  });
});

describe("joinRecords through a gateway: a hop the AI decided makes the whole link the AI's (ADR 0181)", () => {
  // Ninth UX walk: a caller joined through a gateway route whose forwarding call an AI answer
  // named was recorded as `joined-by-answer` (a person's), with no AI chip.
  const unlisted = () =>
    estate().map((r) => (r.repo === "forge-accounts" ? { ...r, hosts: [] } : r));
  const ai = { runtime: "copilot-acp", run: "run-20261108-0001" };
  const targets = {
    "forge-gateway": {
      "call.get.accounts-id": "forge-accounts",
      "call.post.transfers": "forge-accounts",
    },
  };
  type Rec = {
    kind: string;
    from?: string;
    to?: string;
    confidence: string;
    flags?: string[];
    evidence: Record<string, unknown>[];
  };
  const portal = (rs: readonly unknown[]) =>
    (rs as Rec[]).filter(
      (r) => r.kind === "Interface" && r.from === "portal-api" && r.to === "accounts-api",
    );

  it("flags the walked link joined-by-ai, with evidence of source ai and the run", () => {
    const repos = unlisted();
    const out = joinFacts({
      repos,
      targets,
      aiTargets: { "forge-gateway": { "call.get.accounts-id": ai, "call.post.transfers": ai } },
    });
    const get = out.joins.find((j) => j.call.fact === PORTAL_GET)!;
    expect(get.entry.repo).toBe("forge-accounts");
    expect(get.gateway).toHaveLength(1);
    const links = portal(joinRecords(out, repos));
    expect(links).toHaveLength(2);
    for (const r of links) {
      expect(r.flags).toContain("joined-by-ai");
      expect(r.flags ?? []).not.toContain("joined-by-answer");
      expect(r.confidence).toBe("inferred");
      expect(r.evidence).toContainEqual(
        expect.objectContaining({ source: "ai", by: "copilot-acp", run: ai.run }),
      );
    }
  });

  it("keeps a person's answer on the hop a person's: never joined-by-ai", () => {
    const repos = unlisted();
    const links = portal(joinRecords(joinFacts({ repos, targets }), repos));
    expect(links).toHaveLength(2);
    for (const r of links) expect(r.flags ?? []).not.toContain("joined-by-ai");
  });
});

describe("joinRecords through a gateway: a hop that guessed makes the whole link a guess (final review)", () => {
  // A hop's forwarding call joined by path, by a host's first label or by a person's pairing
  // was dropped: the walked link came out verified, flagged joined-by-host.
  type Link = { confidence: string; flags?: string[]; evidence: Record<string, unknown>[] };
  const walkedLinks = (rs: readonly unknown[]) =>
    (rs as (Link & { kind: string; from?: string; to?: string })[]).filter(
      (r) => r.kind === "Interface" && r.from === "portal-api" && r.to === "accounts-api",
    );

  it("a hop naming no host is never joined by path (beta.24): the walk stops at the gateway", () => {
    // Beta.23 joined such a hop to whichever service served the path, a guess that made the
    // walked link inferred; a gateway forwards to the host its target names, so with none the
    // hop is left, and the caller's call is the gateway's.
    const repos = swap(estate(), "forge-gateway", (fs) =>
      fs.map((f) => {
        if (f.kind !== "call") return f;
        const { base: _b, host: _h, ...rest } = f as Fact & { base?: string; host?: string };
        return rest as Fact;
      }),
    );
    const out = joinFacts({ repos, explain: true });
    expect(out.joins.find((j) => j.call.fact === "call.post.transfers")).toBeUndefined();
    expect((out.left ?? []).map((l) => [l.call.fact, l.reason])).toContainEqual([
      "call.post.transfers",
      "no-host",
    ]);
    const post = out.joins.find((j) => j.call.fact === PORTAL_POST)!;
    expect(post.gateway).toBeUndefined();
    expect(post.entry.repo).toBe("forge-gateway");
    expect(walkedLinks(joinRecords(out, repos))).toEqual([]);
  });

  it("a hop a person paired: the walked link is that person's pairing, citing the hop's call", () => {
    const repos = estate();
    const out = joinFacts({
      repos,
      pairs: {
        "forge-gateway": {
          "call.post.transfers": {
            repo: "forge-accounts",
            entry: "entry.post.transfers",
            path: "/transfers",
            by: "dana.okafor",
          },
        },
      },
    });
    const post = out.joins.find((j) => j.call.fact === PORTAL_POST)!;
    expect(post.gateway).toHaveLength(1);
    expect(post.paired).toMatchObject({ by: "dana.okafor" });
    const iface = joinRecords(out, repos).find((r) => r.id === post.interface) as unknown as Link;
    expect(iface.confidence).toBe("inferred");
    expect(iface.flags).toEqual(["joined-by-person"]);
    expect(iface.evidence).toContainEqual(
      expect.objectContaining({
        source: "manual",
        repo: "forge-gateway",
        path: "proxies/forge-accounts-v1/apiproxy/policies/AM-RewriteTransfers.xml",
        line: 8,
        by: "dana.okafor",
      }),
    );
    // The GET's hop nobody paired stays as the code says.
    const get = out.joins.find((j) => j.call.fact === PORTAL_GET)!;
    expect(get.paired).toBeUndefined();
  });
});
