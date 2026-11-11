import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  JOINED_BY_BASE_PATH,
  JOINED_BY_PATH,
  joinFacts,
  joinRecords,
  parseFacts,
  registrableDomain,
  sharedLinkFlags,
  type Fact,
  type JoinRepo,
} from "../src/index.js";

/**
 * The review of beta.24's gateway join, second round (beta.25): a token's host behind an estate
 * service's base path, a Kubernetes namespace that looks like a top-level name, a base URL whose
 * host placeholder nothing sets, a link joined by a BasePath though the caller's host is unknown,
 * a deploy tool's token for another element of a file of the same name, and an outside system the
 * profile lists by its bare host. The invented `fixtures/gateway-facts/vendor-proxy/` estate.
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
const swap = (repos: JoinRepo[], repo: string, fn: (fs: Fact[]) => Fact[]): JoinRepo[] =>
  repos.map((r) => (r.repo === repo ? { ...r, facts: fn([...r.facts]) } : r));
/** The proxy's target URL, one environment's, set to `url`. */
const hostIs = (url: string, repos = estate()) =>
  swap(repos, PROXY, (fs) =>
    fs
      .filter((f) => f.id !== "config.northwind-url-test")
      .map((f) => (f.id === "config.northwind-url-prod" ? ({ ...f, value: url } as Fact) : f)),
  );
const fate = (out: ReturnType<typeof joinFacts>) => ({
  asked: out.asks.filter((a) => a.call.repo === PROXY).map((a) => a.reason),
  outside: (out.outside ?? []).filter((o) => o.call.repo === PROXY).map((o) => o.target),
});
type Iface = { kind: string; from: string; confidence: string; flags?: string[] };
const ifaces = (repos: JoinRepo[]) =>
  joinRecords(joinFacts({ repos }), repos).filter(
    (r) => r.kind === "Interface",
  ) as unknown as Iface[];

describe("an outside host behind an estate service's base path", () => {
  it("is asked about, never outside, when a service serves the whole path under its context path", () => {
    let repos = hostIs("https://accounts-svc.forge-apps.example/accounts-api");
    repos = swap(repos, "forge-accounts", (fs) => [
      ...fs,
      {
        kind: "config",
        id: "config.context-path",
        repo: "forge-accounts",
        commit: "aaaa111",
        settingKind: "config",
        key: "server.servlet.context-path",
        value: "/accounts-api",
        cite: {
          file: "src/main/resources/application.properties",
          line: 9,
          value: "server.servlet.context-path",
        },
        verified: "line",
        by: "assistant",
        conf: "declared",
      } as Fact,
    ]);
    const got = fate(joinFacts({ repos }));
    expect(got.outside).toEqual([]);
    expect(got.asked.length).toBeGreaterThan(0);
    expect(new Set(got.asked)).toEqual(new Set(["unknown-host"]));
  });

  it("still goes outside when no service could serve it under any base", () => {
    const got = fate(joinFacts({ repos: hostIs("https://accounts-svc.forge-apps.example/v9") }));
    expect(got.asked).toEqual([]);
    expect(new Set(got.outside)).toEqual(new Set(["accounts-svc.forge-apps.example"]));
  });

  /** An estate service with a common base (`/v1`, `/api`) that serves none of the proxy's paths. */
  const fx = (base: string): JoinRepo => ({
    repo: "forge-fx",
    component: "fx-api",
    hosts: ["fx.forge.internal"],
    facts: [
      {
        kind: "entry",
        id: "entry.get.rates",
        repo: "forge-fx",
        commit: "bbbb222",
        entryType: "rest",
        method: "GET",
        path: "/rates",
        handler: "RatesController.list",
        cite: { file: "src/main/java/forge/fx/RatesController.java", line: 9, value: "/rates" },
        verified: "line",
        by: "assistant",
        conf: "declared",
      } as Fact,
      {
        kind: "config",
        id: "config.context-path",
        repo: "forge-fx",
        commit: "bbbb222",
        settingKind: "config",
        key: "server.servlet.context-path",
        value: base,
        cite: {
          file: "src/main/resources/application.properties",
          line: 1,
          value: "server.servlet.context-path",
        },
        verified: "line",
        by: "assistant",
        conf: "declared",
      } as Fact,
    ],
  });

  it.each([
    ["/v1", "https://api.northwind.example/v1"],
    ["/api", "https://api.northwind.example/api"],
    ["/v1", "https://api.northwind.example/v1/payments"],
  ])(
    "goes outside though an unrelated service's base is %s: it serves none of the proxy's paths (%s)",
    (base, url) => {
      const got = fate(joinFacts({ repos: hostIs(url, [...estate(), fx(base)]) }));
      expect(got.asked).toEqual([]);
      expect(new Set(got.outside)).toEqual(new Set(["api.northwind.example"]));
    },
  );

  it("is asked about when a service under that common base serves the proxy's path", () => {
    let repos = hostIs("https://api.northwind.example/v1", [...estate(), fx("/v1")]);
    repos = swap(repos, "forge-accounts", (fs) => [
      ...fs,
      {
        kind: "config",
        id: "config.context-path",
        repo: "forge-accounts",
        commit: "aaaa111",
        settingKind: "config",
        key: "server.servlet.context-path",
        value: "/v1",
        cite: {
          file: "src/main/resources/application.properties",
          line: 9,
          value: "server.servlet.context-path",
        },
        verified: "line",
        by: "assistant",
        conf: "declared",
      } as Fact,
    ]);
    const got = fate(joinFacts({ repos }));
    expect(got.outside).toEqual([]);
    expect(new Set(got.asked)).toEqual(new Set(["unknown-host"]));
  });
});

describe("a host the outside rule can't place", () => {
  it.each([
    "http://forge-wallets.qa:8080/v1",
    "http://forge-wallets.dev:8080/v1",
    "https://wallets.forge.int/v1",
    "http://forge-wallets.app:8080/v1",
    "http://forge-wallets.api:8080/v1",
    "http://forge-wallets.bank/v1",
  ])("is asked about, not outside: %s", (url) => {
    const got = fate(joinFacts({ repos: hostIs(url) }));
    expect(got.outside).toEqual([]);
    expect(got.asked).toHaveLength(6);
  });

  it.each([
    ["https://api.northwind.dev/v1", "api.northwind.dev"],
    ["https://api.northwind.de/v1", "api.northwind.de"],
    ["https://northwind.com/v1", "northwind.com"],
  ])("goes outside in a public registrable domain: %s", (url, host) => {
    const got = fate(joinFacts({ repos: hostIs(url) }));
    expect(got.asked).toEqual([]);
    expect(new Set(got.outside)).toEqual(new Set([host]));
  });

  it("places a host by its registrable domain only where the last label is public", () => {
    expect(registrableDomain("wallets.dev")).toBeUndefined();
    expect(registrableDomain("wallets.qa")).toBeUndefined();
    expect(registrableDomain("wallets.app:8080")).toBeUndefined();
    expect(registrableDomain("wallets.forge.int")).toBeUndefined();
    expect(registrableDomain("forge.api")).toBeUndefined();
    expect(registrableDomain("api.northwind.dev")).toBe("northwind.dev");
    expect(registrableDomain("api.northwind.de")).toBe("northwind.de");
    expect(registrableDomain("northwind.com")).toBe("northwind.com");
    expect(registrableDomain("northwind.io")).toBe("northwind.io");
    expect(registrableDomain("api.northwind.example")).toBe("northwind.example");
    expect(registrableDomain("api.northwind.co.uk")).toBe("northwind.co.uk");
  });
});

describe("a base URL whose host placeholder nothing sets", () => {
  const unsetHost = (fs: Fact[]) =>
    fs.map((f) =>
      f.id === "config.vendor-base-url"
        ? ({ ...f, value: "https://${GATEWAY_HOST}/northwind-wallets/1.0" } as Fact)
        : f,
    );

  it("keeps the URL's path, so the proxy's BasePath joins it", () => {
    const out = joinFacts({ repos: swap(estate(), "forge-accounts", unsetHost), explain: true });
    const got = out.joins.filter((j) => j.call.repo === "forge-accounts");
    expect(got.map((j) => [j.call.fact, j.entry.repo, j.entry.fact, j.how]).sort()).toEqual([
      ["call.get.account", PROXY, "entry.get.northwind-accounts-id", "base-path"],
      ["call.post.account-status", PROXY, "entry.post.northwind-accounts-id-status", "base-path"],
      ["call.put.account", PROXY, "entry.put.northwind-accounts-id", "base-path"],
    ]);
    expect((out.left ?? []).filter((l) => l.call.repo === "forge-accounts")).toEqual([]);
  });

  it("keeps a bare placeholder base's path too (`${GATEWAY_URL}/northwind-wallets/1.0`)", () => {
    const repos = swap(estate(), "forge-accounts", (fs) =>
      fs.map((f) =>
        f.id === "config.vendor-base-url"
          ? ({ ...f, value: "${GATEWAY_URL}/northwind-wallets/1.0" } as Fact)
          : f,
      ),
    );
    const got = joinFacts({ repos }).joins.filter((j) => j.call.repo === "forge-accounts");
    expect(got.map((j) => j.how)).toEqual(["base-path", "base-path", "base-path"]);
  });
});

describe("a join by BasePath whose caller's host is unknown", () => {
  const unresolved = (fs: Fact[]) =>
    fs.map((f) =>
      f.id === "config.gateway-host" ? ({ ...f, value: "${GATEWAY_HOST}" } as Fact) : f,
    );

  it("is kept, but inferred: a guess a person can correct, never verified", () => {
    const repos = swap(estate(), "forge-wallets", unresolved);
    const got = joinFacts({ repos }).joins.filter((j) => j.call.repo === "forge-wallets");
    expect(got).toHaveLength(3);
    for (const j of got) {
      expect(j.how).toBe("base-path");
      expect(j.inferred).toEqual({ within: "estate" });
    }
    const to = ifaces(repos).filter((i) => i.from === "wallets-api");
    expect(to).toHaveLength(3);
    for (const i of to) {
      expect(i.confidence).toBe("inferred");
      // Found by the BasePath, a guess for the caller's unknown host: the BasePath said first.
      expect(i.flags).toEqual([JOINED_BY_BASE_PATH, JOINED_BY_PATH]);
    }
  });

  it("says the BasePath first on a link of such calls, a guess by path after", () => {
    expect(sharedLinkFlags([JOINED_BY_PATH, JOINED_BY_BASE_PATH], "inferred")).toEqual([
      JOINED_BY_BASE_PATH,
      JOINED_BY_PATH,
    ]);
    // Any other guess beside it still comes first: the link rests on that.
    expect(
      sharedLinkFlags([JOINED_BY_PATH, JOINED_BY_BASE_PATH, "joined-by-label"], "inferred")[0],
    ).toBe(JOINED_BY_PATH);
  });
});

describe("a deploy tool's token for another element of a file of the same name", () => {
  it("never replaces the call's target URL: the XPath's root is the file's kind", () => {
    const repos = swap(estate(), PROXY, (fs) => [
      ...fs.map((f) =>
        // The proxy's own endpoint file and the target's both `default.xml`.
        f.kind === "call"
          ? ({
              ...f,
              cite: {
                ...f.cite,
                with: [
                  { file: "apiproxy/targets/default.xml", line: 4, value: "@targetNorthwindUrl@" },
                ],
              },
            } as Fact)
          : f.kind === "config"
            ? ({ ...f, target: "default.xml" } as Fact)
            : f,
      ),
      {
        kind: "config",
        id: "config.route-url-prod",
        repo: PROXY,
        commit: "8888aaa",
        settingKind: "config",
        key: "/ProxyEndpoint/RouteRule/URL",
        value: "https://aaa.forge-apps.example/v9",
        target: "default.xml",
        env: "prod",
        cite: { file: "config.json", line: 40, value: "/ProxyEndpoint/RouteRule/URL" },
        verified: "line",
        by: "assistant",
        conf: "declared",
      } as Fact,
    ]);
    const got = fate(joinFacts({ repos }));
    expect(got.asked).toEqual([]);
    expect(new Set(got.outside)).toEqual(new Set(["api.northwind.example"]));
  });
});

describe("an outside system the profile lists by its bare host", () => {
  it("takes a forwarding call whose host has a port", () => {
    const out = joinFacts({
      repos: hostIs("https://wallets.corp:8443/v1"),
      outside: ["wallets.corp"],
    });
    const got = fate(out);
    expect(got.asked).toEqual([]);
    expect(new Set(got.outside)).toEqual(new Set(["wallets.corp"]));
  });

  it("takes a service's call whose host has a port", () => {
    const repos = swap(estate(), "forge-accounts", (fs) =>
      fs.map((f) =>
        f.id === "config.vendor-base-url"
          ? ({ ...f, value: "https://pay.northwind.corp:8443/v2" } as Fact)
          : f,
      ),
    );
    const out = joinFacts({ repos, outside: ["pay.northwind.corp"] });
    const gone = (out.outside ?? []).filter((o) => o.call.repo === "forge-accounts");
    expect(gone.map((o) => o.target)).toEqual([
      "pay.northwind.corp",
      "pay.northwind.corp",
      "pay.northwind.corp",
    ]);
  });
});

describe("a verified link that merged a pairing", () => {
  it("lists the code's how first, a pairing's after it", () => {
    expect(sharedLinkFlags(["joined-by-ai", "joined-by-host"], "verified")).toEqual([
      "joined-by-host",
      "joined-by-ai",
    ]);
    expect(sharedLinkFlags(["joined-by-person", "joined-by-answer"], "verified")).toEqual([
      "joined-by-answer",
      "joined-by-person",
    ]);
  });
});

/**
 * Beta.25 review, second round: an estate service whose route under its context path is a
 * catch-all (`GET /accounts/**` under `/ledger-api`) serves the proxy's paths sent to its URL; a
 * gateway's pass-through route still places nothing. And a target URL whose path is a service's
 * own declared base, one no other service would share (not `/`, `/v1`, `/api`, `/rest`,
 * `/services`), is that service's though none of its routes is one the proxy sends.
 */
describe("a target URL an estate service may serve under its base", () => {
  const LEDGER_URL = "https://ledger.forge-cloud.example/ledger-api";
  /** The estate without the two services that serve the vendor's paths themselves. */
  const bare = () =>
    estate().map((r) =>
      r.repo === PROXY ? r : { ...r, facts: r.facts.filter((f) => f.kind !== "entry") },
    );
  const ledger = (
    paths: readonly string[],
    base: string,
    o: { gateway?: boolean; file?: string } = {},
  ): JoinRepo => ({
    repo: "forge-ledger",
    component: "ledger-api",
    hosts: ["ledger.forge.internal"],
    ...(o.gateway ? { gateway: true } : {}),
    facts: [
      ...paths.map(
        (path, i) =>
          ({
            kind: "entry",
            id: `entry.get.ledger-${i}`,
            repo: "forge-ledger",
            commit: "cccc333",
            entryType: "rest",
            method: "GET",
            path,
            handler: "LedgerController.get",
            cite: {
              file: o.file ?? "src/main/java/forge/ledger/LedgerController.java",
              line: 9 + i,
              value: path,
            },
            verified: "line",
            by: "assistant",
            conf: "declared",
          }) as Fact,
      ),
      {
        kind: "config",
        id: "config.context-path",
        repo: "forge-ledger",
        commit: "cccc333",
        settingKind: "config",
        key: "server.servlet.context-path",
        value: base,
        cite: {
          file: "src/main/resources/application.properties",
          line: 1,
          value: "server.servlet.context-path",
        },
        verified: "line",
        by: "assistant",
        conf: "declared",
      } as Fact,
    ],
  });

  it("is asked about when the service's route under its context path is a catch-all", () => {
    const got = fate(
      joinFacts({
        repos: hostIs(LEDGER_URL, [...bare(), ledger(["/accounts/**"], "/ledger-api")]),
      }),
    );
    expect(got.outside).toEqual([]);
    expect(new Set(got.asked)).toEqual(new Set(["unknown-host"]));
  });

  it("is asked about when a catch-all under the base takes the URL's own path too", () => {
    const got = fate(
      joinFacts({
        repos: hostIs(`${LEDGER_URL}/v9`, [...bare(), ledger(["/v9/**"], "/ledger-api")]),
      }),
    );
    expect(got.outside).toEqual([]);
    expect(new Set(got.asked)).toEqual(new Set(["unknown-host"]));
  });

  it("goes outside when the catch-all is another gateway's pass-through route", () => {
    const got = fate(
      joinFacts({
        repos: hostIs(`${LEDGER_URL}/v9`, [
          ...bare(),
          ledger(["/v9/**"], "/ledger-api", {
            gateway: true,
            file: "apiproxy/proxies/default.xml",
          }),
        ]),
      }),
    );
    expect(got.asked).toEqual([]);
    expect(new Set(got.outside)).toEqual(new Set(["ledger.forge-cloud.example"]));
  });

  it("is asked about when the URL's path is the service's own base, though no route matches", () => {
    const got = fate(
      joinFacts({ repos: hostIs(LEDGER_URL, [...bare(), ledger(["/customers"], "/ledger-api")]) }),
    );
    expect(got.outside).toEqual([]);
    expect(new Set(got.asked)).toEqual(new Set(["unknown-host"]));
  });

  it.each([
    ["/v1", "https://api.northwind.example/v1"],
    ["/api", "https://api.northwind.example/api/"],
    ["/rest", "https://api.northwind.example/rest"],
    ["/services", "https://api.northwind.example/services"],
    ["/api/v2", "https://api.northwind.example/api/v2"],
  ])("goes outside when that base is a common one (%s, %s)", (base, url) => {
    const got = fate(joinFacts({ repos: hostIs(url, [...bare(), ledger(["/customers"], base)]) }));
    expect(got.asked).toEqual([]);
    expect(new Set(got.outside)).toEqual(new Set(["api.northwind.example"]));
  });

  it("goes outside when the URL only starts with the service's base", () => {
    const got = fate(
      joinFacts({
        repos: hostIs(`${LEDGER_URL}/v9`, [...bare(), ledger(["/customers"], "/ledger-api")]),
      }),
    );
    expect(got.asked).toEqual([]);
    expect(new Set(got.outside)).toEqual(new Set(["ledger.forge-cloud.example"]));
  });
});
