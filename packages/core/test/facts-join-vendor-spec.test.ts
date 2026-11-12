import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  joinFacts,
  joinVendorOperations,
  parseFacts,
  preferredEnvironment,
  type Fact,
  type JoinRepo,
  type JoinVendor,
} from "../src/index.js";

/**
 * Beta.27 (a user's Outside systems page, re-made with invented names): an Apigee proxy that is
 * its own repo fronts Northwind Pay (an invented vendor). Its routes forward the path suffix to
 * the TargetEndpoint URL `@targetVendorUrl@`, which config.json sets per environment to
 * `https://devapi.northwind-pay.example/api/v1` (dv) and `https://api.northwind-pay.example/api/v1`
 * (prod). The vendor's spec publishes `/api/{version}/...` on the host root. An onboarding service
 * calls the proxy's base path on the gateway's host through a setting named after the vendor
 * (`northwind-pay.base-url: ${gateway-url}/northwind-accounts/1.0`).
 *
 * In beta.26 every forwarding call was a "call that matches nothing" (the vendor's path is the
 * target URL's `/api/v1` and the route's suffix, never the suffix alone), every operation showed
 * 0 calls, and the onboarding service's call was taken for a direct call to the vendor (its
 * setting's name read as a host, `northwind-pay.base-url`, whose first label names the vendor).
 * `fixtures/gateway-facts/vendor-spec/expected/vendor-join.yaml`, checked by hand.
 */
const DIR = join(__dirname, "..", "..", "..", "fixtures", "gateway-facts", "vendor-spec");
const PROXY = "northwind_accounts_1-0";
const SPEC = "inputs/inbox/northwind-pay-openapi.yaml";
const OUTSIDE = [
  "Northwind Pay",
  "api.northwind-pay.example",
  "devapi.northwind-pay.example",
  "northwind-pay",
];
const read = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(DIR, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
type ManifestRepo = { id: string; type: string; component: string; hosts?: string[] };
const estate = (): JoinRepo[] =>
  (
    parse(
      readFileSync(join(DIR, "org-pack", "profiles", "forge", "repos.manifest.yaml"), "utf8"),
    ) as { repos: ManifestRepo[] }
  ).repos.map((r) => ({
    repo: r.id,
    facts: read(r.id),
    component: r.component,
    ...(r.hosts ? { hosts: r.hosts } : {}),
    ...(r.type === "gateway" ? { gateway: true } : {}),
  }));
/** Northwind Pay's operations as intake reads its spec: servers on the host root. */
const northwind = (over: Partial<JoinVendor> = {}): JoinVendor => ({
  system: "northwind-pay",
  // The Outside systems page matches every system's direct calls too (ADR 0142).
  boundary: "internal",
  names: ["Northwind Pay", "api.northwind-pay.example", "devapi.northwind-pay.example"],
  hosts: ["devapi.northwind-pay.example", "api.northwind-pay.example"],
  operations: [
    ["northwind-pay.post-account-instruments", "POST", "/api/{version}/account_instruments", 10],
    ["northwind-pay.get-account", "GET", "/api/{version}/accounts/{account_guid}", 17],
    ["northwind-pay.get-balances", "GET", "/api/{version}/accounts/balances", 25],
    ["northwind-pay.get-card-pin", "GET", "/api/{version}/cards/{card_guid}/pin", 32],
    ["northwind-pay.post-login", "POST", "/api/v1/auth/login", 40],
  ].map(([id, method, path, line]) => ({
    id: String(id),
    method: String(method),
    path: String(path),
    fullPath: String(path),
    cite: `${SPEC}:${line}`,
  })),
  ...over,
});
const golden = (name: string, got?: unknown) => {
  // UPDATE_GOLDEN=1 writes what the join gives now, to be checked by hand before it's committed.
  if (process.env.UPDATE_GOLDEN && got !== undefined)
    writeFileSync(join(DIR, "expected", name), stringify(got));
  return parse(readFileSync(join(DIR, "expected", name), "utf8"));
};
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const vendorJoin = (repos = estate(), vendor = northwind()) => {
  const joined = joinFacts({ repos, outside: OUTSIDE });
  return joinVendorOperations({ repos, vendors: [vendor], joined: joined.joins });
};
const opsOf = (r: ReturnType<typeof vendorJoin>, fact: string) =>
  r.matches.filter((m) => m.call.fact === fact && m.call.repo === PROXY).map((m) => m.operation);

describe("a gateway's forwarding calls landed on the vendor's spec operations (golden)", () => {
  it("gives the golden vendor join", () => {
    const got = plain(vendorJoin());
    expect(got).toEqual(golden("vendor-join.yaml", got));
  });

  it("is the same whatever order the repos and operations come in", () => {
    const v = northwind();
    expect(
      vendorJoin([...estate()].reverse(), { ...v, operations: [...v.operations].reverse() }),
    ).toEqual(vendorJoin());
  });
});

describe("the vendor path: the target URL's own path, then the route's", () => {
  it("lands a call on the operation whose path parameters take the target's /api/v1", () => {
    const r = vendorJoin();
    expect(opsOf(r, "call.post.account-instruments")).toEqual([
      "northwind-pay.post-account-instruments",
    ]);
    const m = r.matches.find((x) => x.call.fact === "call.post.account-instruments")!;
    expect(m).toMatchObject({
      how: "host",
      method: "POST",
      path: "/api/v1/account_instruments",
      route: { fact: "entry.post.northwind-accounts-account-instruments" },
    });
    // dv and prod both send /api/v1: the match names the prod-like one (and its setting).
    expect(m.tie?.fact).toBe("config.target-vendor-url-prod");
    expect(m.env).toBe("prod");
  });

  it("prefers a literal segment to a parameter where both fit, as OpenAPI does", () => {
    expect(opsOf(vendorJoin(), "call.get.accounts-balances")).toEqual([
      "northwind-pay.get-balances",
    ]);
  });

  it("counts a wildcard route as reaching every operation under it, never as a question", () => {
    const r = vendorJoin();
    expect(opsOf(r, "call.get.accounts")).toEqual([
      "northwind-pay.get-account",
      "northwind-pay.get-balances",
    ]);
    expect(opsOf(r, "call.get.cards-pin")).toEqual(["northwind-pay.get-card-pin"]);
    expect(
      r.matches.filter((m) => m.call.fact === "call.get.accounts").every((m) => m.wildcard),
    ).toBe(true);
    expect(r.asks).toEqual([]);
  });

  it("leaves only a call that truly fits no operation under the gaps, said with the vendor's path", () => {
    expect(vendorJoin().gaps.map((g) => [g.call.repo, g.call.fact, g.message])).toEqual([
      [
        PROXY,
        "call.get.bulkorders",
        "northwind-accounts-proxy forwards GET /api/v1/bulkorders to Northwind Pay, whose spec publishes no such operation",
      ],
    ]);
  });

  it("matches a spec whose server carries the version, its paths without it", () => {
    const v = northwind();
    const versioned = northwind({
      operations: v.operations.map((o) => ({
        ...o,
        path: o.path.replace(/^\/api\/(\{version\}|v1)/, ""),
        fullPath: o.path.replace(/^\/api\/\{version\}/, "/api/v1"),
      })),
    });
    const r = vendorJoin(estate(), versioned);
    expect(opsOf(r, "call.get.accounts-balances")).toEqual(["northwind-pay.get-balances"]);
    expect(r.gaps.map((g) => g.call.fact)).toEqual(["call.get.bulkorders"]);
  });

  it("reads the token from the target's line when the read left it out of host (before beta.27)", () => {
    const repos = estate().map((x) =>
      x.repo !== PROXY
        ? x
        : {
            ...x,
            facts: x.facts.map((f) => {
              if (f.kind !== "call") return f;
              const { host: _h, ...rest } = f;
              return rest as Fact;
            }),
          },
    );
    const r = joinVendorOperations({ repos, vendors: [northwind()] });
    expect(opsOf(r, "call.get.accounts-balances")).toEqual(["northwind-pay.get-balances"]);
  });
});

/**
 * The per-environment case (`expected/vendor-join-per-env.yaml`): the deploy sets the target URL
 * to one host for both environments, but a different path: `/api/v1` in dv, `/api/v2` in prod.
 */
const perEnv = (): JoinRepo[] =>
  estate().map((x) =>
    x.repo !== PROXY
      ? x
      : {
          ...x,
          facts: x.facts.map((f) =>
            f.kind !== "config"
              ? f
              : ({
                  ...f,
                  value:
                    f.env === "prod"
                      ? "https://api.northwind-pay.example/api/v2"
                      : "https://api.northwind-pay.example/api/v1",
                } as Fact),
          ),
        },
  );
const perEnvJoin = (vendor = northwind()) =>
  joinVendorOperations({ repos: perEnv(), vendors: [vendor] });

describe("each environment's target path, matched on its own (review of beta.27)", () => {
  it("gives the golden per-environment join", () => {
    const got = plain(perEnvJoin());
    expect(got).toEqual(golden("vendor-join-per-env.yaml", got));
  });

  it("never asks between the operation dv's path reaches and the one prod's path reaches", () => {
    // The spec publishes each version's balances as its own operation.
    const v = northwind();
    const both = northwind({
      operations: [
        ...v.operations.filter((o) => o.id !== "northwind-pay.get-balances"),
        ...["v1", "v2"].map((ver) => ({
          id: `northwind-pay.get-balances-${ver}`,
          method: "GET",
          path: `/api/${ver}/accounts/balances`,
          fullPath: `/api/${ver}/accounts/balances`,
        })),
      ],
    });
    const r = perEnvJoin(both);
    expect(r.asks).toEqual([]);
    expect(
      r.matches
        .filter((m) => m.call.fact === "call.get.accounts-balances")
        .map((m) => [m.operation, m.path, m.env, m.tie?.fact]),
    ).toEqual([
      [
        "northwind-pay.get-balances-v1",
        "/api/v1/accounts/balances",
        "dv",
        "config.target-vendor-url-dv",
      ],
      [
        "northwind-pay.get-balances-v2",
        "/api/v2/accounts/balances",
        "prod",
        "config.target-vendor-url-prod",
      ],
    ]);
  });

  it("gives an operation both paths reach prod's path, and says so", () => {
    const m = perEnvJoin().matches.filter((x) => x.call.fact === "call.post.account-instruments");
    expect(m.map((x) => [x.operation, x.path, x.env])).toEqual([
      ["northwind-pay.post-account-instruments", "/api/v2/account_instruments", "prod"],
    ]);
  });

  it("says each environment's path in a gap", () => {
    expect(perEnvJoin().gaps.map((g) => [g.call.fact, g.path, g.env, g.message])).toEqual([
      [
        "call.get.bulkorders",
        "/api/v2/bulkorders",
        "prod",
        "northwind-accounts-proxy forwards GET /api/v2/bulkorders in prod (/api/v1/bulkorders in dv) to Northwind Pay, whose spec publishes no such operation",
      ],
    ]);
  });

  it("prefers a prod-like environment's name (pd, prod, prd), else the first by name", () => {
    expect(preferredEnvironment(["dv", "prod"])).toBe("prod");
    expect(preferredEnvironment(["dev", "test", "us-prd"])).toBe("us-prd");
    expect(preferredEnvironment(["pd", "qa"])).toBe("pd");
    expect(preferredEnvironment(["test", "dev"])).toBe("dev");
    expect(preferredEnvironment([])).toBeUndefined();
  });
});

describe("a wildcard route's call with a target path (review of beta.27)", () => {
  it("matches only with the target path, never the route's bare path against the spec's", () => {
    // The spec's server path is /api/v2; the target URL sends /api/v1: /accounts/* reaches
    // /api/v1/accounts/..., which the spec doesn't publish, never /api/v2/accounts/x.
    const v = northwind();
    const v2 = northwind({
      operations: v.operations.map((o) => ({
        ...o,
        path: o.path.replace(/^\/api\/(\{version\}|v1)/, ""),
        fullPath: o.path.replace(/^\/api\/(\{version\}|v1)/, "/api/v2"),
      })),
    });
    const r = vendorJoin(estate(), v2);
    expect(r.matches.filter((m) => m.call.repo === PROXY)).toEqual([]);
    expect(r.gaps.map((g) => [g.call.fact, g.path]).sort()).toEqual([
      ["call.get.accounts", "/api/v1/accounts/*"],
      ["call.get.accounts-balances", "/api/v1/accounts/balances"],
      ["call.get.bulkorders", "/api/v1/bulkorders"],
      ["call.get.cards-pin", "/api/v1/cards/*/pin"],
      ["call.post.account-instruments", "/api/v1/account_instruments"],
    ]);
  });

  it("still matches the spec's own path when the call has no target path", () => {
    const v = northwind();
    const v2 = northwind({
      operations: v.operations.map((o) => ({
        ...o,
        path: o.path.replace(/^\/api\/(\{version\}|v1)/, ""),
        fullPath: o.path.replace(/^\/api\/(\{version\}|v1)/, "/api/v2"),
      })),
    });
    // The deploy's target URL with no path: the route's path is the vendor's.
    const repos = estate().map((x) =>
      x.repo !== PROXY
        ? x
        : {
            ...x,
            facts: x.facts.map((f) =>
              f.kind === "config"
                ? ({ ...f, value: f.value!.replace(/\/api\/v1$/, "") } as Fact)
                : f,
            ),
          },
    );
    const r = joinVendorOperations({ repos, vendors: [v2] });
    expect(opsOf(r, "call.get.accounts")).toEqual([
      "northwind-pay.get-account",
      "northwind-pay.get-balances",
    ]);
  });
});

describe("a service's call to the gateway's own base path", () => {
  it("lands on the proxy's route, never as a direct call to the vendor", () => {
    const repos = estate();
    const joined = joinFacts({ repos, outside: OUTSIDE });
    // The estate join lands it on the proxy's route, which forwards it on.
    expect(
      joined.joins
        .filter((j) => j.call.repo === "forge-onboarding")
        .map((j) => [j.call.fact, j.entry.repo, j.entry.fact]),
    ).toEqual([
      ["call.post.account-instruments", PROXY, "entry.post.northwind-accounts-account-instruments"],
    ]);
    const r = joinVendorOperations({ repos, vendors: [northwind()], joined: joined.joins });
    const theirs = [...r.matches, ...r.gaps].filter((x) => x.call.repo === "forge-onboarding");
    expect(theirs).toEqual([]);
  });

  it("never reads a setting's name as a host, even with no join to say where the call goes", () => {
    // Without the join's word: the setting `northwind-pay.base-url` is a key of the repo (its
    // value a placeholder), never the host `northwind-pay.base-url` whose first label is the
    // vendor's name (what beta.26 did).
    const r = joinVendorOperations({ repos: estate(), vendors: [northwind()] });
    expect(
      [...r.matches, ...r.gaps, ...r.asks].filter((x) => x.call.repo === "forge-onboarding"),
    ).toEqual([]);
  });

  it("never gives a vendor a host an estate repo answers on, whatever its aliases say", () => {
    // The gateway's host added to the vendor's aliases by hand (a user's configuration).
    const v = northwind({ hosts: [...northwind().hosts, "gw.forge.example"] });
    const repos = estate().map((x) =>
      x.repo !== "forge-onboarding"
        ? x
        : {
            ...x,
            facts: x.facts.map((f) =>
              f.kind === "call" ? ({ ...f, base: undefined, host: "gw.forge.example" } as Fact) : f,
            ),
          },
    );
    const r = joinVendorOperations({ repos, vendors: [v] });
    expect([...r.matches, ...r.gaps].filter((x) => x.call.repo === "forge-onboarding")).toEqual([]);
  });
});
