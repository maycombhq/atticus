import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  JOINED_BY_BASE_PATH,
  JOINED_BY_PATH,
  joinFacts,
  joinRecords,
  parseFacts,
  parseRecord,
  type Fact,
  type JoinRepo,
} from "../src/index.js";

/**
 * An Apigee proxy that fronts a system outside the estate, and the estate's services that wrap
 * that system (serving the same paths themselves) and call it through the gateway. The invented
 * `fixtures/gateway-facts/vendor-proxy/`: the proxy's target `<URL>` is a build token the Maven
 * config plugin's `config.json` replaces per environment with a host no repo lists; the callers
 * give the gateway's host and the proxy's paths in settings laid out two different ways. Its
 * `expected/join.yaml` and `expected/records.yaml` are the join and its records, checked by hand:
 * the callers join the proxy's flows (verified, by the gateway's host the manifest lists), and
 * the proxy's forwarding calls go outside the estate, never back to the services by their path.
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
const swap = (repos: JoinRepo[], repo: string, facts: (fs: Fact[]) => Fact[]): JoinRepo[] =>
  repos.map((r) => (r.repo === repo ? { ...r, facts: facts([...r.facts]) } : r));
const golden = (name: string, got?: unknown) => {
  // UPDATE_GOLDEN=1 writes what the join gives now, to be checked by hand before it's committed.
  if (process.env.UPDATE_GOLDEN && got !== undefined)
    writeFileSync(join(DIR, "expected", name), stringify(got));
  return parse(readFileSync(join(DIR, "expected", name), "utf8"));
};
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
type Iface = {
  kind: string;
  from: string;
  to: string;
  method?: string;
  normalizedPath?: string;
  confidence: string;
  flags?: string[];
};
const ifaces = (repos: JoinRepo[]) =>
  (joinRecords(joinFacts({ repos }), repos) as unknown as Iface[]).filter(
    (r) => r.kind === "Interface",
  );
const pairs = (out: ReturnType<typeof joinFacts>) =>
  out.joins.map((j) => [j.call.repo, j.call.fact, j.entry.repo, j.entry.fact]).sort();
const forwarding = (out: ReturnType<typeof joinFacts>) =>
  out.joins.filter((j) => j.call.repo === PROXY);

describe("a proxy to an outside vendor (golden)", () => {
  it("gives the golden join", () => {
    const got = plain(joinFacts({ repos: estate() }));
    expect(got).toEqual(golden("join.yaml", got));
  });

  it("gives the golden records, each valid C1", () => {
    const repos = estate();
    const rs = plain(joinRecords(joinFacts({ repos }), repos));
    expect(rs).toEqual(golden("records.yaml", rs));
    for (const r of rs) expect(parseRecord(r).ok, r.id).toBe(true);
  });

  it("is the same whatever order the repos come in", () => {
    expect(joinFacts({ repos: [...estate()].reverse() })).toEqual(joinFacts({ repos: estate() }));
  });
});

describe("the proxy's forwarding calls: the target URL a build token sets", () => {
  it("never joins the services that serve the same paths: they go outside", () => {
    const out = joinFacts({ repos: estate(), explain: true });
    expect(forwarding(out)).toEqual([]);
    expect(out.asks.filter((a) => a.call.repo === PROXY)).toEqual([]);
    const gone = (out.outside ?? []).filter((o) => o.call.repo === PROXY);
    expect(gone.map((o) => [o.call.fact, o.target])).toEqual([
      ["call.get.accounts-id", "api.northwind.example"],
      ["call.get.wallets", "api.northwind.example"],
      ["call.get.wallets-id", "api.northwind.example"],
      ["call.post.accounts-id-status", "api.northwind.example"],
      ["call.post.wallets", "api.northwind.example"],
      ["call.put.accounts-id", "api.northwind.example"],
    ]);
    // No Interface from the proxy back into the estate.
    expect(ifaces(estate()).filter((i) => i.from === "northwind-wallets-proxy")).toEqual([]);
  });

  it("names the outside system that lists one of the environments' hosts", () => {
    const out = joinFacts({ repos: estate(), outside: ["sandbox.northwind.example"] });
    const gone = (out.outside ?? []).filter((o) => o.call.repo === PROXY);
    expect(new Set(gone.map((o) => o.target))).toEqual(new Set(["sandbox.northwind.example"]));
  });

  it("asks which repo answers when nothing sets the token: never a guess by path", () => {
    const repos = swap(estate(), PROXY, (fs) => fs.filter((f) => f.kind !== "config"));
    const out = joinFacts({ repos });
    expect(forwarding(out)).toEqual([]);
    const asked = out.asks.filter((a) => a.call.repo === PROXY);
    expect(asked).toHaveLength(6);
    for (const a of asked) expect(a).toMatchObject({ reason: "unknown-host" });
    expect(ifaces(repos).filter((i) => i.from === "northwind-wallets-proxy")).toEqual([]);
  });

  it("joins the estate when the token sets an estate host: the resolver isn't only for outside", () => {
    const repos = swap(estate(), PROXY, (fs) =>
      fs
        .filter((f) => f.id !== "config.northwind-url-test")
        .map((f) =>
          f.id === "config.northwind-url-prod"
            ? ({ ...f, value: "https://wallets.forge.internal" } as Fact)
            : f,
        ),
    );
    const got = forwarding(joinFacts({ repos }));
    expect(got.map((j) => [j.call.fact, j.entry.fact, j.how]).sort()).toEqual([
      ["call.get.wallets", "entry.get.wallets", "host"],
      ["call.get.wallets-id", "entry.get.wallets-wallet-guid", "host"],
      ["call.post.wallets", "entry.post.wallets", "host"],
    ]);
  });

  it("resolves a TargetServer the forwarding calls name, whatever its name (another layout)", () => {
    const repos = swap(estate(), PROXY, (fs) => {
      const prod = fs.find((f) => f.id === "config.northwind-url-prod")!;
      return [
        ...fs
          .filter((f) => f.kind !== "config")
          .map((f) => {
            if (f.kind !== "call") return f;
            const { host: _h, ...rest } = f;
            return { ...rest, base: "partner-ledger" } as Fact;
          }),
        {
          ...prod,
          id: "config.target-server-partner-ledger",
          key: "partner-ledger",
          value: "ledger.partner.example",
          cite: {
            file: "resources/edge/env/prod/targetServers.json",
            line: 4,
            value: "partner-ledger",
          },
        } as Fact,
      ];
    });
    const out = joinFacts({ repos });
    expect(forwarding(out)).toEqual([]);
    // The services wrapping the vendor serve the same whole paths (/wallets, /accounts/{id}), so
    // the host, though in no domain of the estate's, may be theirs: asked, never joined by path
    // and never silently outside (review of beta.24).
    expect(out.asks.filter((a) => a.call.repo === PROXY).map((a) => a.host)).toEqual(
      Array(6).fill("ledger.partner.example"),
    );
    // The profile listing it as an outside system's says where they go.
    const listed = joinFacts({ repos, outside: ["ledger.partner.example"] });
    expect(forwarding(listed)).toEqual([]);
    expect(
      new Set((listed.outside ?? []).filter((o) => o.call.repo === PROXY).map((o) => o.target)),
    ).toEqual(new Set(["ledger.partner.example"]));
  });
});

describe("the callers to the proxy, by the gateway's host and the whole path", () => {
  /** The host setting a placeholder nothing sets: the call names a host the join can't read. */
  const unresolved = (fs: Fact[]) =>
    fs.map((f) =>
      f.id === "config.gateway-host" ? ({ ...f, value: "${GATEWAY_HOST}" } as Fact) : f,
    );

  it("joins each caller's call to the proxy's flow, verified, in that direction", () => {
    const out = joinFacts({ repos: estate() });
    expect(pairs(out)).toEqual([
      ["forge-accounts", "call.get.account", PROXY, "entry.get.northwind-accounts-id"],
      [
        "forge-accounts",
        "call.post.account-status",
        PROXY,
        "entry.post.northwind-accounts-id-status",
      ],
      ["forge-accounts", "call.put.account", PROXY, "entry.put.northwind-accounts-id"],
      ["forge-wallets", "call.get.get-wallet", PROXY, "entry.get.northwind-wallets-id"],
      ["forge-wallets", "call.get.search-wallet", PROXY, "entry.get.northwind-wallets"],
      ["forge-wallets", "call.post.create-wallet", PROXY, "entry.post.northwind-wallets"],
    ]);
    const to = ifaces(estate()).filter((i) => i.to === "northwind-wallets-proxy");
    expect(to.map((i) => [i.from, i.method, i.normalizedPath, i.confidence]).sort()).toEqual([
      ["accounts-api", "GET", "/northwind-wallets/1.0/accounts/{}", "verified"],
      ["accounts-api", "POST", "/northwind-wallets/1.0/accounts/{}/status", "verified"],
      ["accounts-api", "PUT", "/northwind-wallets/1.0/accounts/{}", "verified"],
      ["wallets-api", "GET", "/northwind-wallets/1.0/wallets", "verified"],
      ["wallets-api", "GET", "/northwind-wallets/1.0/wallets/{}", "verified"],
      ["wallets-api", "POST", "/northwind-wallets/1.0/wallets", "verified"],
    ]);
  });

  it("joins by the proxy's BasePath when the caller's host setting resolves to nothing", () => {
    const repos = swap(estate(), "forge-wallets", unresolved);
    const out = joinFacts({ repos });
    const got = out.joins.filter((j) => j.call.repo === "forge-wallets");
    expect(got.map((j) => [j.call.fact, j.entry.fact, j.how]).sort()).toEqual([
      ["call.get.get-wallet", "entry.get.northwind-wallets-id", "base-path"],
      ["call.get.search-wallet", "entry.get.northwind-wallets", "base-path"],
      ["call.post.create-wallet", "entry.post.northwind-wallets", "base-path"],
    ]);
    // Beta.25 review: the caller's host is unknown, so the link is kept as a guess, never verified.
    const to = ifaces(repos).filter((i) => i.from === "wallets-api");
    for (const i of to) {
      expect(i.confidence).toBe("inferred");
      expect(i.flags).toEqual([JOINED_BY_PATH, JOINED_BY_BASE_PATH]);
    }
  });

  it("asks when two flows under the BasePath serve the call as well as each other", () => {
    const repos = swap(estate(), "forge-wallets", (fs) =>
      unresolved(fs).map((f) => {
        if (f.id !== "call.post.create-wallet" || f.kind !== "call") return f;
        const { method: _m, ...rest } = f;
        return rest as Fact;
      }),
    );
    const out = joinFacts({ repos });
    expect(out.joins.some((j) => j.call.fact === "call.post.create-wallet")).toBe(false);
    const [ask] = out.asks.filter((a) => a.call.fact === "call.post.create-wallet");
    expect(ask).toMatchObject({ reason: "ambiguous" });
    expect(ask!.candidates.map((c) => c.fact)).toEqual([
      "entry.get.northwind-wallets",
      "entry.post.northwind-wallets",
    ]);
  });

  it("never joins by the BasePath a call with no host or base at all: it stays a relative call", () => {
    const repos = swap(estate(), "forge-wallets", (fs) =>
      fs.map((f) => {
        if (f.kind !== "call") return f;
        const { base: _b, ...rest } = f;
        return rest as Fact;
      }),
    );
    const out = joinFacts({ repos });
    expect(
      out.joins.filter((j) => j.call.repo === "forge-wallets" && j.how === "base-path"),
    ).toEqual([]);
  });
});
