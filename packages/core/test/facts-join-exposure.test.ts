import { describe, expect, it } from "vitest";
import {
  Fact,
  FACTS_SCHEMA_VERSION,
  interfaceId,
  JOINED_BY_HOST,
  JOINED_DESPITE_CONFLICT,
  joinFacts,
  joinRecords,
  type JoinRepo,
} from "../src/index.js";

/**
 * J1 (ADR 0143): where each component is reached — host, base path and environment — read from
 * the deploy repo's OpenShift Routes, Ingresses, Helm values and the gateway's BasePath as
 * `deploy` facts, and joined with the manifest's hosts and base paths (ADR 0134). Both are
 * accepted; where they disagree the join says so (a finding), and neither silently wins.
 */

const C = "e5e0010";
const fact = (f: Record<string, unknown>): Fact =>
  Fact.parse({ commit: C, verified: "line", by: "assistant", conf: "declared", ...f });
const route = (
  id: string,
  o: { host?: string; basePath?: string; exposes?: string; env?: string; line?: number },
): Fact =>
  fact({
    kind: "deploy",
    id,
    repo: "forge-deploy",
    platform: "openshift",
    resourceType: "route",
    resourceName: o.exposes ?? id,
    ...(o.host ? { host: o.host } : {}),
    ...(o.basePath ? { basePath: o.basePath } : {}),
    ...(o.exposes ? { exposes: o.exposes } : {}),
    ...(o.env ? { env: o.env } : {}),
    cite: { file: `apps/${id}/route.yaml`, line: o.line ?? 4, value: o.exposes ?? id },
  });
const entry = (repo: string, id: string, path: string): Fact =>
  fact({
    kind: "entry",
    id,
    repo,
    entryType: "rest",
    method: "GET",
    path,
    cite: { file: "src/Controller.java", line: 10, value: path },
  });
const call = (id: string, host: string, path: string): Fact =>
  fact({
    kind: "call",
    id,
    repo: "forge-pay",
    callType: "rest",
    method: "GET",
    path,
    host,
    cite: { file: "src/Clients.java", line: 20, value: path },
  });

const estate = (extra: Fact[] = []): JoinRepo[] => [
  {
    repo: "forge-pay",
    component: "pay-api",
    facts: [
      call("c-account", "https://apps.forge.internal", "/forge-svc/accounts/accounts/{id}"),
      call("c-limit-route", "https://apps.forge.internal", "/forge-svc/limits/limits/{id}"),
      call("c-limit-manifest", "https://apps.forge.internal", "/forge/limits/limits/{id}"),
      call("c-balance-route", "https://ledger.forge.example", "/balances/{id}"),
      call("c-balance-manifest", "https://ledger.forge.internal", "/balances/{id}"),
      call("c-card", "https://api.forge.example", "/forge/cards/v1/cards/{id}"),
    ],
  },
  {
    // The deploy repo: no entry of its own; its Routes name the component each reaches.
    repo: "forge-deploy",
    component: "deploy-config",
    facts: [
      route("accounts", {
        host: "apps.forge.internal",
        basePath: "/forge-svc/accounts",
        exposes: "accounts-api",
      }),
      // The manifest says /forge/limits: a conflict, and both are accepted.
      route("limits", {
        host: "apps.forge.internal",
        basePath: "/forge-svc/limits",
        exposes: "limits-api",
      }),
      // The repo's own name resolves too; the manifest lists another host: a conflict.
      route("ledger", { host: "ledger.forge.example", exposes: "forge-ledger", env: "prod" }),
      // Names nothing in the estate: a finding, and nothing is joined by it.
      route("ghost", {
        host: "apps.forge.internal",
        basePath: "/forge-svc/ghost",
        exposes: "ghost-api",
      }),
      ...extra,
    ],
  },
  // No hosts in the manifest: the Route alone says where it is reached.
  {
    repo: "forge-accounts",
    component: "accounts-api",
    facts: [entry("forge-accounts", "e-account", "/accounts/{id}")],
  },
  {
    repo: "forge-limits",
    component: "limits-api",
    hosts: ["apps.forge.internal"],
    basePath: "/forge/limits",
    facts: [entry("forge-limits", "e-limit", "/limits/{id}")],
  },
  {
    repo: "forge-ledger",
    component: "ledger-api",
    hosts: ["ledger.forge.internal"],
    facts: [entry("forge-ledger", "e-balance", "/balances/{id}")],
  },
  {
    // An Apigee proxy: the gateway's host stays in the manifest, its BasePath is read.
    repo: "forge-proxy-cards-v1",
    component: "proxy-cards-v1",
    hosts: ["api.forge.example"],
    gateway: true,
    facts: [
      entry("forge-proxy-cards-v1", "e-card", "/forge/cards/v1/cards/{id}"),
      fact({
        kind: "deploy",
        id: "d-proxy",
        repo: "forge-proxy-cards-v1",
        platform: "apigee",
        resourceName: "forge-cards-v1",
        basePath: "/forge/cards/v1",
        cite: {
          file: "apiproxy/forge-cards-v1.xml",
          line: 1,
          value: "forge-cards-v1",
          with: [{ file: "apiproxy/proxies/default.xml", line: 8, value: "/forge/cards/v1" }],
        },
      }),
    ],
  },
  {
    // Another proxy on the same host with no base path anywhere: the cards call's base path
    // rules it out, so the BasePath read is what tells the two apart.
    repo: "forge-proxy-misc",
    component: "proxy-misc",
    hosts: ["api.forge.example"],
    gateway: true,
    facts: [entry("forge-proxy-misc", "e-misc", "/cards/{id}")],
  },
];
const joinOf = (out: ReturnType<typeof joinFacts>, id: string) =>
  out.joins.filter((j) => j.call.fact === id);

describe("J1: exposure facts, the facts schema", () => {
  it("is version 2, and a deploy fact written before (no host, base path or exposes) parses unchanged", () => {
    expect(FACTS_SCHEMA_VERSION).toBe(2);
    const old = {
      kind: "deploy",
      id: "d-old",
      repo: "forge-pay",
      commit: C,
      platform: "openshift",
      resourceName: "pay-api",
      cite: { file: "openshift/deployment.yaml", line: 4, value: "pay-api" },
    };
    expect(Fact.parse(old)).toMatchObject(old);
  });

  it("takes a host, a base path and the component it exposes, and refuses a base path with no leading /", () => {
    const f = route("accounts", {
      host: "apps.forge.internal",
      basePath: "/forge-svc/accounts",
      exposes: "accounts-api",
    });
    expect(f).toMatchObject({
      host: "apps.forge.internal",
      basePath: "/forge-svc/accounts",
      exposes: "accounts-api",
    });
    expect(Fact.safeParse({ ...(f as object), basePath: "forge-svc/accounts" }).success).toBe(
      false,
    );
  });
});

describe("J1: the join takes hosts and base paths from exposure facts as well as the manifest", () => {
  const out = joinFacts({ repos: estate() });

  it("joins by a Route's host and path where the manifest lists nothing, citing the Route", () => {
    const [j, ...more] = joinOf(out, "c-account");
    expect(more).toEqual([]);
    expect(j).toMatchObject({
      entry: { repo: "forge-accounts", fact: "e-account" },
      how: "host",
      exposedBy: [{ repo: "forge-deploy", fact: "accounts", at: "apps/accounts/route.yaml:4" }],
    });
    expect(j!.inferred).toBeUndefined();
  });

  it("accepts both the manifest's base path and the Route's where they differ", () => {
    expect(joinOf(out, "c-limit-route")[0]).toMatchObject({
      entry: { repo: "forge-limits", fact: "e-limit" },
      how: "host",
      exposedBy: [{ fact: "limits" }],
    });
    const m = joinOf(out, "c-limit-manifest")[0];
    expect(m).toMatchObject({ entry: { repo: "forge-limits", fact: "e-limit" }, how: "host" });
    expect(m!.exposedBy).toBeUndefined();
  });

  it("accepts both hosts where the manifest's and the Route's differ", () => {
    expect(joinOf(out, "c-balance-route")[0]).toMatchObject({
      entry: { repo: "forge-ledger" },
      exposedBy: [{ fact: "ledger" }],
    });
    expect(joinOf(out, "c-balance-manifest")[0]).toMatchObject({ entry: { repo: "forge-ledger" } });
  });

  it("pairs a proxy's BasePath with the gateway host the manifest lists, so it alone answers", () => {
    const [j, ...more] = joinOf(out, "c-card");
    expect(more).toEqual([]);
    expect(j).toMatchObject({
      entry: { repo: "forge-proxy-cards-v1", fact: "e-card" },
      exposedBy: [{ repo: "forge-proxy-cards-v1", fact: "d-proxy" }],
    });
  });

  it("reports each conflict and each exposure naming nothing, never a silent override", () => {
    expect(out.exposure).toEqual([
      {
        reason: "no-component",
        exposure: {
          repo: "forge-deploy",
          fact: "ghost",
          component: "deploy-config",
          at: "apps/ghost/route.yaml:4",
        },
        names: "ghost-api",
        message:
          "forge-deploy's ghost (apps/ghost/route.yaml:4) exposes ghost-api, which is no component or repo of the estate: name the component the route reaches, or drop the fact",
      },
      {
        reason: "host-conflict",
        exposure: {
          repo: "forge-deploy",
          fact: "ledger",
          component: "deploy-config",
          at: "apps/ledger/route.yaml:4",
        },
        repo: "forge-ledger",
        component: "ledger-api",
        fact: "ledger.forge.example",
        manifest: ["ledger.forge.internal"],
        message:
          "ledger-api is reached on ledger.forge.example (prod) by forge-deploy's ledger (apps/ledger/route.yaml:4), and repos.manifest.yaml lists ledger.forge.internal for forge-ledger: both are joined; list the host in the manifest, or correct the one that is wrong",
      },
      {
        reason: "base-path-conflict",
        exposure: {
          repo: "forge-deploy",
          fact: "limits",
          component: "deploy-config",
          at: "apps/limits/route.yaml:4",
        },
        repo: "forge-limits",
        component: "limits-api",
        fact: "/forge-svc/limits",
        manifest: ["/forge/limits"],
        message:
          "limits-api is reached under /forge-svc/limits by forge-deploy's limits (apps/limits/route.yaml:4), and repos.manifest.yaml gives /forge/limits for forge-limits: both are joined; set the manifest's basePath to it, or correct the one that is wrong",
      },
    ]);
  });

  it("says nothing when the manifest agrees with the facts, or lists nothing", () => {
    const agree = estate().map((r) =>
      r.repo === "forge-deploy"
        ? { ...r, facts: r.facts.filter((f) => f.id === "accounts") }
        : r.repo === "forge-accounts"
          ? { ...r, hosts: ["apps.forge.internal"], basePath: "/forge-svc/accounts" }
          : r,
    );
    expect(joinFacts({ repos: agree }).exposure).toBeUndefined();
  });

  it("is the same whatever order the repos come in", () => {
    expect(joinFacts({ repos: [...estate()].reverse() })).toEqual(out);
  });

  it("cites the exposure in the Interface's evidence, as infrastructure", () => {
    const records = joinRecords(out, estate());
    const id = joinOf(out, "c-account")[0]!.interface;
    expect(id).toBe(interfaceId("pay-api", "accounts-api", "GET", "/accounts/{id}"));
    const iface = records.find((r) => r.kind === "Interface" && r.id === id);
    expect(iface?.evidence).toContainEqual(
      expect.objectContaining({
        source: "infrastructure",
        repo: "forge-deploy",
        path: "apps/accounts/route.yaml",
        line: 4,
        side: "callee",
      }),
    );
  });
  it("marks a join that took a host or base path an open conflict disputes inferred and flagged (J1)", () => {
    const records = joinRecords(out, estate());
    const iface = (call: string) => {
      const id = joinOf(out, call)[0]!.interface;
      return records.find((r) => r.kind === "Interface" && r.id === id) as {
        confidence: string;
        flags?: string[];
      };
    };
    // the Route's host the manifest doesn't list, and the Route's base path it disagrees with:
    // a link no other call shares is a guess
    expect(joinOf(out, "c-balance-route")[0]!.guesses).toEqual([JOINED_DESPITE_CONFLICT]);
    const alone = estate().map((r) =>
      r.repo === "forge-pay" ? { ...r, facts: r.facts.filter((f) => !/-manifest$/.test(f.id)) } : r,
    );
    const aloneOut = joinFacts({ repos: alone });
    const aloneRecords = joinRecords(aloneOut, alone);
    for (const c of ["c-balance-route", "c-limit-route"]) {
      const id = joinOf(aloneOut, c)[0]!.interface;
      expect(
        aloneRecords.find((r) => r.kind === "Interface" && r.id === id),
        c,
      ).toMatchObject({ confidence: "inferred", flags: [JOINED_DESPITE_CONFLICT] });
    }
    // ADR 0135 section 5: the same link the manifest's host or base path also joins is cited, so
    // verified, and keeps the disputed call's flag
    for (const c of ["c-balance-route", "c-limit-route"])
      expect(iface(c), c).toMatchObject({
        confidence: "verified",
        flags: [JOINED_BY_HOST, JOINED_DESPITE_CONFLICT],
      });
    // the manifest's own host and base path are no guess, nor an exposure nobody disputes
    for (const c of ["c-balance-manifest", "c-limit-manifest", "c-account"])
      expect(joinOf(out, c)[0]!.guesses, c).toBeUndefined();
    expect(iface("c-account")).toMatchObject({ confidence: "verified", flags: [JOINED_BY_HOST] });
  });
});
