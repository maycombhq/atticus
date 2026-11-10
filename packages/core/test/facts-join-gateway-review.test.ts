import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { joinFacts, parseFacts, type Fact, type JoinRepo } from "../src/index.js";

/**
 * The review of beta.24's gateway join: a deploy tool's tokens are the call's bundle's only, a
 * BasePath join is verified only when nothing else of the estate serves the whole path, the
 * outside rule asks about every host it can't place, hostless forwarding calls chain proxies
 * (Apigee's LocalTargetConnection) and are never dropped, and nested BasePaths take the longest.
 * The invented `fixtures/gateway-facts/vendor-proxy/` estate, with invented proxies added.
 */
const DIR = join(__dirname, "..", "..", "..", "fixtures", "gateway-facts", "vendor-proxy");
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
const PROXY = "northwind_wallets_1-0";
const GW = "forge-gateway";
const swap = (repos: JoinRepo[], repo: string, fn: (fs: Fact[]) => Fact[]): JoinRepo[] =>
  repos.map((r) => (r.repo === repo ? { ...r, facts: fn([...r.facts]) } : r));
const common = { commit: "1111aaa", verified: "line", by: "assistant", conf: "declared" };
/** A gateway route: a flow under its proxy's BasePath, cited on its Condition and BasePath lines. */
const route = (
  id: string,
  method: string,
  path: string,
  file: string,
  base: string,
  repo = GW,
): Fact =>
  ({
    ...common,
    kind: "entry",
    id,
    repo,
    entryType: "rest",
    method,
    path,
    handler: `${file.split("/")[0]}/${id}`,
    cite: {
      file,
      line: 4,
      value: path.slice(base.length) || "/",
      quote: "<Condition/>",
      with: [{ file, line: 23, value: base }],
    },
  }) as Fact;
/** A proxy's forwarding call to its target's `@targetUrl@` URL. */
const forward = (
  id: string,
  method: string,
  path: string,
  file: string,
  target: string,
  from: string,
): Fact =>
  ({
    ...common,
    kind: "call",
    id,
    repo: GW,
    callType: "rest",
    method,
    path,
    host: "@targetUrl@",
    from,
    cite: {
      file,
      line: 4,
      value: path,
      quote: "<Condition/>",
      with: [{ file: target, line: 4, value: "@targetUrl@" }],
    },
  }) as Fact;
/** The config plugin's token for a bundle's `targets/default.xml` URL. */
const token = (id: string, file: string, value: string): Fact =>
  ({
    ...common,
    kind: "config",
    id,
    repo: GW,
    settingKind: "config",
    key: "/TargetEndpoint/HTTPTargetConnection/URL",
    value,
    target: "default.xml",
    env: "prod",
    cite: {
      file,
      line: 11,
      value: "/TargetEndpoint/HTTPTargetConnection/URL",
      quote: '"xpath": "/TargetEndpoint/HTTPTargetConnection/URL",',
      with: [{ file, line: 12, value }],
    },
  }) as Fact;
const gateway = (facts: Fact[], hosts = ["gw2.forge.example"]): JoinRepo => ({
  repo: GW,
  facts,
  component: "forge-gateway",
  hosts,
  gateway: true,
});

describe("a deploy tool's tokens are the call's own bundle's", () => {
  it("two bundles with a targets/default.xml each: each call takes its bundle's token only", () => {
    const facts = [
      route(
        "entry.get.w",
        "GET",
        "/wallets/1.0/wallets",
        "wallets/apiproxy/proxies/default.xml",
        "/wallets/1.0",
      ),
      forward(
        "call.get.w",
        "GET",
        "/wallets",
        "wallets/apiproxy/proxies/default.xml",
        "wallets/apiproxy/targets/default.xml",
        "entry.get.w",
      ),
      route(
        "entry.get.l",
        "GET",
        "/ledger/1.0/wallets",
        "ledger/apiproxy/proxies/default.xml",
        "/ledger/1.0",
      ),
      forward(
        "call.get.l",
        "GET",
        "/wallets",
        "ledger/apiproxy/proxies/default.xml",
        "ledger/apiproxy/targets/default.xml",
        "entry.get.l",
      ),
      token("config.wallets-url", "wallets/config.json", "https://wallets.forge.internal"),
      token("config.ledger-url", "ledger/config.json", "https://api.northwind.example/v1"),
    ];
    const repos = [...estate().filter((r) => r.repo !== PROXY), gateway(facts)];
    const out = joinFacts({ repos, explain: true });
    const mine = out.joins.filter((j) => j.call.repo === GW);
    expect(mine.map((j) => [j.call.fact, j.entry.repo, j.entry.fact, j.how])).toEqual([
      ["call.get.w", "forge-wallets", "entry.get.wallets", "host"],
    ]);
    expect(mine[0]!.through?.map((t) => t.fact)).toEqual(["config.wallets-url"]);
    expect((out.outside ?? []).map((o) => [o.call.fact, o.target])).toEqual([
      ["call.get.l", "api.northwind.example"],
    ]);
  });

  it("a token that names its placeholder applies only to a URL written with that name", () => {
    const named = (id: string, value: string, name: string): Fact => {
      const t = token(id, "wallets/config.json", value) as Fact & { cite: { with: unknown[] } };
      return {
        ...t,
        cite: {
          ...t.cite,
          with: [...t.cite.with, { file: "wallets/config.json", line: 9, value: name }],
        },
      } as Fact;
    };
    const facts = [
      route(
        "entry.get.w",
        "GET",
        "/wallets/1.0/wallets",
        "wallets/apiproxy/proxies/default.xml",
        "/wallets/1.0",
      ),
      forward(
        "call.get.w",
        "GET",
        "/wallets",
        "wallets/apiproxy/proxies/default.xml",
        "wallets/apiproxy/targets/default.xml",
        "entry.get.w",
      ),
      named("config.a-other", "https://wallets.forge.internal", "@otherUrl@"),
      named("config.b-mine", "https://api.northwind.example/v1", "@targetUrl@"),
    ];
    const repos = [...estate().filter((r) => r.repo !== PROXY), gateway(facts)];
    const out = joinFacts({ repos });
    expect(out.joins.filter((j) => j.call.repo === GW)).toEqual([]);
    expect((out.outside ?? []).map((o) => [o.call.fact, o.target])).toEqual([
      ["call.get.w", "api.northwind.example"],
    ]);
  });
});

describe("a join by a proxy's BasePath", () => {
  const unresolved = (fs: Fact[]) =>
    fs.map((f) =>
      f.id === "config.gateway-host" ? ({ ...f, value: "${GATEWAY_HOST}" } as Fact) : f,
    );

  it("is a question when another entry of the estate serves the whole path as it is", () => {
    const facts = [
      route(
        "entry.get.wallets-id",
        "GET",
        "/wallets/{id}",
        "walletsproxy/apiproxy/proxies/default.xml",
        "/wallets",
      ),
    ];
    const direct = {
      ...common,
      kind: "call",
      id: "call.get.direct-wallet",
      repo: "forge-accounts",
      callType: "rest",
      method: "GET",
      path: "/wallets/{walletGuid}",
      base: "${WALLETS_URL}",
      cite: {
        file: "src/main/java/forge/accounts/AccountsController.java",
        line: 12,
        value: "/wallets/{walletGuid}",
        quote: "x",
      },
    } as Fact;
    const repos = [
      ...swap(estate(), "forge-accounts", (fs) => [...fs, direct]),
      gateway(facts, ["gw.forge.example"]),
    ];
    const out = joinFacts({ repos });
    expect(out.joins.find((j) => j.call.fact === "call.get.direct-wallet")).toBeUndefined();
    const ask = out.asks.find((a) => a.call.fact === "call.get.direct-wallet");
    expect(ask).toMatchObject({ reason: "ambiguous" });
    expect(ask!.candidates.map((c) => [c.repo, c.fact])).toEqual([
      [GW, "entry.get.wallets-id"],
      ["forge-wallets", "entry.get.wallets-wallet-guid"],
    ]);
  });

  it("takes the longest BasePath that starts the path, as Apigee does (nested BasePaths)", () => {
    const facts = [
      route(
        "entry.get.other",
        "GET",
        "/northwind-wallets/{version}/wallets",
        "other/apiproxy/proxies/default.xml",
        "/northwind-wallets",
      ),
    ];
    const repos = [
      ...swap(estate(), "forge-wallets", unresolved),
      gateway(facts, ["gw.forge.example"]),
    ];
    const out = joinFacts({ repos });
    const got = out.joins.filter((j) => j.call.repo === "forge-wallets");
    expect(got.map((j) => [j.call.fact, j.entry.repo, j.entry.fact, j.how]).sort()).toEqual([
      ["call.get.get-wallet", PROXY, "entry.get.northwind-wallets-id", "base-path"],
      ["call.get.search-wallet", PROXY, "entry.get.northwind-wallets", "base-path"],
      ["call.post.create-wallet", PROXY, "entry.post.northwind-wallets", "base-path"],
    ]);
  });
});

describe("a gateway's forwarding call to a host the estate doesn't list", () => {
  const hostIs = (url: string) =>
    swap(estate(), PROXY, (fs) =>
      fs
        .filter((f) => f.id !== "config.northwind-url-test")
        .map((f) => (f.id === "config.northwind-url-prod" ? ({ ...f, value: url } as Fact) : f)),
    );
  const fate = (repos: JoinRepo[]) => {
    const out = joinFacts({ repos });
    return {
      asked: out.asks.filter((a) => a.call.repo === PROXY).map((a) => a.reason),
      outside: (out.outside ?? []).filter((o) => o.call.repo === PROXY).map((o) => o.target),
      joined: out.joins.filter((j) => j.call.repo === PROXY).length,
    };
  };

  it.each([
    ["a Service and its namespace", "http://forge-wallets.payments:8080/v1"],
    ["a private top-level name", "https://wallets.corp/v1"],
    ["an in-cluster name", "http://wallets.forge.svc.cluster.local/v1"],
    ["an address", "https://10.1.2.3:8443/v1"],
    ["one label", "http://wallets/v1"],
    ["localhost", "http://localhost:8080/v1"],
  ])("is asked about, never silently outside: %s", (_what, url) => {
    const got = fate(hostIs(url));
    expect(got.outside).toEqual([]);
    expect(got.joined).toBe(0);
    expect(got.asked).toHaveLength(6);
    expect(new Set(got.asked)).toEqual(new Set(["unknown-host"]));
  });

  it("is asked about when an estate repo serves the call's whole path, in another domain", () => {
    // An environment's subdomain of the estate's own: forge-wallets and forge-accounts serve
    // /wallets and /accounts/{id} as they are, so the host may be theirs.
    const got = fate(hostIs("https://wallets.forge-uat.example"));
    expect(got.outside).toEqual([]);
    expect(got.asked).toHaveLength(6);
  });

  it("goes outside in another registrable domain under a two-part suffix (co.uk)", () => {
    const repos = hostIs("https://api.northwind.co.uk/v1").map((r) =>
      r.repo === PROXY ? { ...r, hosts: ["gw.forge.co.uk"] } : r,
    );
    const got = fate(repos);
    expect(got.asked).toEqual([]);
    expect(new Set(got.outside)).toEqual(new Set(["api.northwind.co.uk"]));
  });

  it("is asked about in the estate's own registrable domain under a two-part suffix", () => {
    const repos = hostIs("https://wallets-vendor.forge.co.uk/v1").map((r) =>
      r.repo === PROXY ? { ...r, hosts: ["gw.forge.co.uk"] } : r,
    );
    const got = fate(repos);
    expect(got.outside).toEqual([]);
    expect(got.asked).toHaveLength(6);
  });

  it("goes outside when the profile lists the host as an outside system's, whatever its form", () => {
    const got = joinFacts({ repos: hostIs("https://wallets.corp/v1"), outside: ["wallets.corp"] });
    const gone = (got.outside ?? []).filter((o) => o.call.repo === PROXY);
    expect(gone).toHaveLength(6);
    expect(got.asks.filter((a) => a.call.repo === PROXY)).toEqual([]);
  });
});

describe("a gateway's forwarding call whose target URL is a token nothing sets", () => {
  it("says to read the gateway repo again, its next step (a read before beta.24 lacks the tokens)", () => {
    const repos = swap(estate(), PROXY, (fs) => fs.filter((f) => f.kind !== "config"));
    const asked = joinFacts({ repos }).asks.filter((a) => a.call.repo === PROXY);
    expect(asked).toHaveLength(6);
    for (const a of asked) {
      expect(a).toMatchObject({ reason: "unknown-host", host: "@targetNorthwindUrl@" });
      expect(a.question).toContain(
        `read ${PROXY} again with your assistant (Read with my assistant)`,
      );
    }
  });

  it("asks a plain host in the words it always had", () => {
    const repos = swap(estate(), PROXY, (fs) =>
      fs
        .filter((f) => f.id !== "config.northwind-url-test")
        .map((f) =>
          f.id === "config.northwind-url-prod"
            ? ({ ...f, value: "https://wallets.corp/v1" } as Fact)
            : f,
        ),
    );
    const [a] = joinFacts({ repos }).asks.filter((x) => x.call.repo === PROXY);
    expect(a!.question).toBe("Which repo answers on wallets.corp?");
  });
});

describe("a gateway's forwarding call that names no host", () => {
  it("chains to the proxy whose BasePath starts its path (LocalTargetConnection)", () => {
    const local = {
      ...common,
      kind: "call",
      id: "call.post.local-token",
      repo: GW,
      callType: "rest",
      method: "POST",
      path: "/auth/1.0/token",
      from: "entry.get.w",
      cite: {
        file: "wallets/apiproxy/policies/SC-Token.xml",
        line: 6,
        value: "/auth/1.0/token",
        quote: "<Path>/auth/1.0/token</Path>",
      },
    } as Fact;
    const repos = [
      ...estate(),
      gateway([
        route(
          "entry.get.w",
          "GET",
          "/wallets/1.0/wallets",
          "wallets/apiproxy/proxies/default.xml",
          "/wallets/1.0",
        ),
        local,
      ]),
      {
        repo: "auth-proxy",
        facts: [
          route(
            "entry.post.token",
            "POST",
            "/auth/1.0/token",
            "auth/apiproxy/proxies/default.xml",
            "/auth/1.0",
            "auth-proxy",
          ),
        ],
        component: "auth-proxy",
        hosts: ["gw2.forge.example"],
        gateway: true,
      },
    ];
    const out = joinFacts({ repos, explain: true });
    const j = out.joins.find((x) => x.call.fact === "call.post.local-token");
    expect(j).toMatchObject({
      how: "base-path",
      entry: { repo: "auth-proxy", fact: "entry.post.token" },
    });
  });
});
