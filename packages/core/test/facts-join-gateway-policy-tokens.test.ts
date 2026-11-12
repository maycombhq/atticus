import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  forwardHostQuestion,
  joinFacts,
  joinRecords,
  parseFacts,
  parseRecord,
  type Fact,
  type JoinRepo,
} from "../src/index.js";

/**
 * Beta.27 (a user's estate, re-made with invented names): an Apigee proxy that is its own repo
 * fronts a vendor, Northwind Pay. Its TargetEndpoint's `<URL>` is the deploy token
 * `@targetVendorUrl@`, which the deploy's `config.json` sets per environment by the token's name
 * (`configurations[].policies[]` of `{ "name": "@targetVendorUrl@", "value": "<URL>" }`, not the
 * config plugin's XPath `tokens`). Two of the estate's services serve the same paths as the vendor
 * does. `fixtures/gateway-facts/policy-tokens/`, its `expected/join.yaml` and
 * `expected/records.yaml` checked by hand: the proxy's forwarding calls go to the vendor by its
 * hosts (the profile's aliases), and never to the services by their path.
 *
 * What went wrong in beta.26: the read wrote the forwarding calls with no `host` (the token only
 * on the `<URL>` line its citation names), so the join took each for a proxy chained to another
 * and joined it to "the only entry in the estate that serves its path", a guess, and asked nothing.
 */
const DIR = join(__dirname, "..", "..", "..", "fixtures", "gateway-facts", "policy-tokens");
const PROXY = "northwind_pay_1-0";
const TOKEN = "@targetVendorUrl@";
/** The profile's systems outside the estate, as `outsideSystems` lists them: id, name, aliases. */
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
const swap = (repos: JoinRepo[], repo: string, facts: (fs: Fact[]) => Fact[]): JoinRepo[] =>
  repos.map((r) => (r.repo === repo ? { ...r, facts: facts([...r.facts]) } : r));
const golden = (name: string, got?: unknown) => {
  // UPDATE_GOLDEN=1 writes what the join gives now, to be checked by hand before it's committed.
  if (process.env.UPDATE_GOLDEN && got !== undefined)
    writeFileSync(join(DIR, "expected", name), stringify(got));
  return parse(readFileSync(join(DIR, "expected", name), "utf8"));
};
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const fromProxy = (out: ReturnType<typeof joinFacts>) =>
  out.joins.filter((j) => j.call.repo === PROXY);
const outsideOf = (out: ReturnType<typeof joinFacts>) =>
  (out.outside ?? [])
    .filter((o) => o.call.repo === PROXY)
    .map((o) => [o.call.fact, o.target])
    .sort();
/** The forwarding calls as a read before beta.27 wrote them: no host, the token on the `<URL>` part. */
const hostless = (fs: Fact[]) =>
  fs.map((f) => {
    if (f.kind !== "call") return f;
    const { host: _h, ...rest } = f;
    return rest as Fact;
  });
const noSettings = (fs: Fact[]) => fs.filter((f) => f.kind !== "config");
const TO_VENDOR = [
  ["call.get.payments-id", "devapi.northwind-pay.example"],
  ["call.get.refunds-id", "devapi.northwind-pay.example"],
  ["call.post.payments", "devapi.northwind-pay.example"],
  ["call.post.refunds", "devapi.northwind-pay.example"],
];

describe("a proxy whose target URL a config.json token sets by its name (golden)", () => {
  it("gives the golden join", () => {
    const got = plain(joinFacts({ repos: estate(), outside: OUTSIDE }));
    expect(got).toEqual(golden("join.yaml", got));
  });

  it("gives the golden records, each valid C1", () => {
    const repos = estate();
    const rs = plain(joinRecords(joinFacts({ repos, outside: OUTSIDE }), repos));
    expect(rs).toEqual(golden("records.yaml", rs));
    for (const r of rs) expect(parseRecord(r).ok, r.id).toBe(true);
  });

  it("is the same whatever order the repos come in", () => {
    expect(joinFacts({ repos: [...estate()].reverse(), outside: OUTSIDE })).toEqual(
      joinFacts({ repos: estate(), outside: OUTSIDE }),
    );
  });
});

describe("the proxy's forwarding calls: the token resolved per environment, by its name", () => {
  it("go to the vendor by the hosts the token's values give, never to a service by its path", () => {
    const out = joinFacts({ repos: estate(), outside: OUTSIDE });
    expect(fromProxy(out)).toEqual([]);
    expect(out.asks.filter((a) => a.call.repo === PROXY)).toEqual([]);
    expect(outsideOf(out)).toEqual(TO_VENDOR);
  });

  it("read the token's setting keyed without its marks the same way", () => {
    const repos = swap(estate(), PROXY, (fs) =>
      fs.map((f) => (f.kind === "config" ? ({ ...f, key: "targetVendorUrl" } as Fact) : f)),
    );
    const out = joinFacts({ repos, outside: OUTSIDE });
    expect(fromProxy(out)).toEqual([]);
    expect(outsideOf(out)).toEqual(TO_VENDOR);
  });

  it("resolve the token a hostless call's `<URL>` part writes (a read before beta.27)", () => {
    const out = joinFacts({ repos: swap(estate(), PROXY, hostless), outside: OUTSIDE });
    expect(fromProxy(out)).toEqual([]);
    expect(out.asks.filter((a) => a.call.repo === PROXY)).toEqual([]);
    expect(outsideOf(out)).toEqual(TO_VENDOR);
  });
});

describe("a route with no forwarding call joins nothing (golden; the user's second case)", () => {
  /**
   * The proxy as the user's Map had it: a person said one route's forwarding call isn't a call
   * (a `wrong` correction: the verifier leaves the fact out), and the read gave another route
   * none at all (a `<Flow>` with empty Request and Response, routed by the same RouteRule).
   */
  const noForward = () =>
    swap(estate(), PROXY, (fs) =>
      fs.filter((f) => f.id !== "call.get.refunds-id" && f.id !== "call.post.payments"),
    );
  const ROUTES = ["entry.get.northwind-pay-refunds-id", "entry.post.northwind-pay-payments"];

  it("gives the golden join", () => {
    const got = plain(joinFacts({ repos: noForward(), outside: OUTSIDE }));
    expect(got).toEqual(golden("join-no-forward.yaml", got));
  });

  it("draws no arrow from the proxy into the estate, and asks nothing about those routes", () => {
    const repos = noForward();
    const out = joinFacts({ repos, outside: OUTSIDE });
    expect(fromProxy(out)).toEqual([]);
    expect(out.asks.filter((a) => a.call.repo === PROXY)).toEqual([]);
    // The routes that still forward go to the vendor.
    expect(outsideOf(out)).toEqual(
      TO_VENDOR.filter(([f]) => f === "call.get.payments-id" || f === "call.post.refunds"),
    );
    const rs = plain(joinRecords(out, repos)) as unknown as { kind: string; from?: string }[];
    expect(rs.filter((r) => r.kind === "Interface" && r.from === "northwind-pay-proxy")).toEqual(
      [],
    );
  });

  it("a caller's call to such a route ends at the route: never walked on to a service by its path", () => {
    const out = joinFacts({ repos: noForward(), outside: OUTSIDE });
    const checkout = out.joins.filter((j) => j.call.repo === "forge-checkout");
    expect(checkout.map((j) => [j.call.fact, j.entry.repo, j.entry.fact, !!j.gateway])).toEqual([
      ["call.get.northwind-pay-payments-id", PROXY, "entry.get.northwind-pay-payments-id", false],
      ["call.get.northwind-pay-refunds-id", PROXY, ROUTES[0], false],
    ]);
    // A route that forwards to the vendor: the caller's call stops at the gateway too.
    expect(out.joins.some((j) => j.entry.repo === "forge-refunds")).toBe(false);
    expect(out.joins.some((j) => j.entry.repo === "forge-payments")).toBe(false);
  });
});

describe("the proxy's forwarding calls: a token nothing sets is asked, never guessed", () => {
  const unresolved = (repos: JoinRepo[]) => {
    const out = joinFacts({ repos, outside: OUTSIDE, explain: true });
    expect(fromProxy(out)).toEqual([]);
    expect(outsideOf(out)).toEqual([]);
    const asked = out.asks.filter((a) => a.call.repo === PROXY);
    expect(asked.map((a) => [a.call.fact, a.reason, a.host]).sort()).toEqual([
      ["call.get.payments-id", "unknown-host", TOKEN],
      ["call.get.refunds-id", "unknown-host", TOKEN],
      ["call.post.payments", "unknown-host", TOKEN],
      ["call.post.refunds", "unknown-host", TOKEN],
    ]);
    for (const a of asked) {
      expect(a.question).toBe(forwardHostQuestion(TOKEN, PROXY));
      expect(a.candidates).toEqual([]);
    }
    return out;
  };

  it("asks about a call that carries the token as its host", () => {
    unresolved(swap(estate(), PROXY, noSettings));
  });

  it("asks about a hostless call whose `<URL>` part is the token: no path guess (the beta.26 bug)", () => {
    unresolved(swap(estate(), PROXY, (fs) => noSettings(hostless(fs))));
  });

  it("asks when the token's only setting is another repo's, for no one (no platform-setting guess)", () => {
    // A setting of the same name in a service's own file, for no component in particular: a
    // deploy token in a gateway bundle is set by the bundle's deploy file, never by a namesake.
    let repos = swap(estate(), PROXY, noSettings);
    repos = swap(repos, "forge-payments", (fs) => [
      ...fs,
      {
        kind: "config",
        id: "config.target-vendor-url",
        repo: "forge-payments",
        commit: "5555ddd",
        settingKind: "config",
        key: "targetVendorUrl",
        value: "https://payments.forge.internal",
        cite: { file: "charts/platform/values.yaml", line: 3, value: "targetVendorUrl" },
        verified: "line",
        by: "assistant",
        conf: "declared",
      } as Fact,
    ]);
    unresolved(repos);
  });

  it("asks when only a file in a folder named for the proxy sets it (no folder-name guess)", () => {
    let repos = swap(estate(), PROXY, noSettings);
    repos = swap(repos, "forge-payments", (fs) => [
      ...fs,
      {
        kind: "config",
        id: "config.target-vendor-url",
        repo: "forge-payments",
        commit: "5555ddd",
        settingKind: "config",
        key: "targetVendorUrl",
        value: "https://payments.forge.internal",
        cite: { file: "deploy/northwind-pay-proxy/values.yaml", line: 3, value: "targetVendorUrl" },
        verified: "line",
        by: "assistant",
        conf: "declared",
      } as Fact,
    ]);
    unresolved(repos);
  });

  it("never joins by a host label or a service name read out of the token", () => {
    // A token named like a component of the estate is still no host.
    const named = "@payments-api@";
    const repos = swap(estate(), PROXY, (fs) =>
      noSettings(fs).map((f) =>
        f.kind === "call"
          ? ({
              ...f,
              host: named,
              cite: { ...f.cite, with: [{ ...f.cite.with![0]!, value: named }] },
            } as Fact)
          : f,
      ),
    );
    const out = joinFacts({ repos, outside: OUTSIDE });
    expect(fromProxy(out)).toEqual([]);
    expect(out.asks.filter((a) => a.call.repo === PROXY).map((a) => a.host)).toEqual(
      Array(4).fill(named),
    );
  });

  it("still joins a forwarding call that names no target URL at all by its path (a chained proxy)", () => {
    // Nothing on its citation writes a token: Apigee's LocalTargetConnection, a proxy chained to
    // another. That is the one case a forwarding call is still joined by its path (as before).
    const repos = swap(estate(), PROXY, (fs) =>
      noSettings(hostless(fs)).map((f) =>
        f.kind === "call" ? ({ ...f, cite: { ...f.cite, with: [] } } as Fact) : f,
      ),
    );
    const out = joinFacts({ repos, outside: OUTSIDE });
    expect(
      fromProxy(out)
        .map((j) => [j.call.fact, j.entry.repo, j.how])
        .sort(),
    ).toEqual([
      ["call.get.payments-id", "forge-payments", "path"],
      ["call.get.refunds-id", "forge-refunds", "path"],
      ["call.post.payments", "forge-payments", "path"],
      ["call.post.refunds", "forge-refunds", "path"],
    ]);
  });
});
