import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  joinDependencies,
  joinFacts,
  parseFacts,
  type Fact,
  type FactsJoinResult,
  type JoinRepo,
} from "../src/index.js";

/**
 * The estate join on the real-shapes corpus (`fixtures/real-shapes/`, its README): five invented
 * repos shaped like public projects (a Maven multi-module Spring Boot service, a Gradle
 * multi-project with a Helm chart and a plain Service, a Kotlin DSL client with a version
 * catalog, an Apigee repo holding two proxies, a shared flow, the deploy plugin's `config.json`
 * and the config plugin's TargetServers, and a Camel bridge). `facts/` is what the assistant
 * writes for them, each fact citing its file, line, value and quote. `expected/join.yaml` and
 * `expected/deps.yaml` are the join and the dependency join, checked by hand.
 *
 * The forge-edge proxy chain (`call.rates.local`, a LocalTargetConnection from forge-ledger-v1 to
 * forge-rates-v1 in the same repo) is in the golden since beta.25, which joins it; the two ways
 * the join got it wrong before are tested below.
 */
const DIR = join(__dirname, "..", "..", "..", "fixtures", "real-shapes");
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
/** The org pack's vendors: Northwind is outside the estate. */
const OUTSIDE = ["northwind-pay"];
const run = (repos = estate()) => joinFacts({ repos, outside: OUTSIDE, explain: true });
const swap = (repos: JoinRepo[], repo: string, change: (fs: Fact[]) => Fact[]): JoinRepo[] =>
  repos.map((r) => (r.repo === repo ? { ...r, facts: change([...r.facts]) } : r));
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const golden = (name: string, got?: unknown) => {
  // UPDATE_GOLDEN=1 writes what the join gives now, to be checked by hand before it's committed.
  if (process.env.UPDATE_GOLDEN && got !== undefined) {
    mkdirSync(join(DIR, "expected"), { recursive: true });
    writeFileSync(join(DIR, "expected", name), stringify(got));
  }
  return parse(readFileSync(join(DIR, "expected", name), "utf8"));
};
const CHAIN = "call.rates.local";
const joinsOf = (out: FactsJoinResult, repo: string, call: string) =>
  out.joins.filter((j) => j.call.repo === repo && j.call.fact === call);
const named = (out: FactsJoinResult, repo: string, call: string) => [
  ...out.joins.filter((j) => j.call.repo === repo && j.call.fact === call).map((j) => j.entry.repo),
  ...out.misses.filter((m) => m.call.repo === repo && m.call.fact === call).map((m) => m.target),
  ...out.asks
    .filter((a) => a.call.repo === repo && a.call.fact === call)
    .flatMap((a) => a.candidates.map((c) => c.repo)),
];

describe("the real-shapes estate's join (golden)", () => {
  it("gives the golden join", () => {
    // Beta.25: the proxy chain joins (forge-ledger-v1 to forge-rates-v1 to rates-service).
    const got = plain(run());
    expect(got).toEqual(golden("join.yaml", got));
  });

  it("gives the golden dependency join", () => {
    const got = plain(joinDependencies({ repos: estate() }));
    expect(got).toEqual(golden("deps.yaml", got));
  });

  it("gives the same join whatever order the repos come in", () => {
    const repos = estate();
    expect(plain(run([...repos].reverse()))).toEqual(plain(run(repos)));
    expect(plain(joinDependencies({ repos: [...repos].reverse() }))).toEqual(
      plain(joinDependencies({ repos })),
    );
  });
});

describe("what the join reads from real shapes", () => {
  it("resolves a Spring ${X:default} base to the in-cluster Service, and the prod profile's to the Ingress", () => {
    const [j, ...more] = joinsOf(run(), "forge-ledger", "call.get.rates-currency");
    expect(more).toEqual([]);
    expect(j!.entry).toMatchObject({ repo: "forge-rates", fact: "entry.get.rates-currency" });
    expect(j!.how).toBe("host");
    // the default document's value (its fallback a svc.cluster.local URL) and the prod profile's
    expect([j!.tie?.fact, ...(j!.through ?? []).map((t) => t.fact)].sort()).toEqual([
      "config.rates-base-url",
      "config.rates-base-url-prod",
    ]);
    expect((j!.exposedBy ?? []).map((e) => e.fact).sort()).toEqual([
      "deploy.ingress.forge-rates",
      "deploy.service.forge-rates",
    ]);
  });

  it("walks a Kotlin WebClient call through the Apigee proxy whose base path and target a config.json gives", () => {
    const [j, ...more] = joinsOf(run(), "forge-wallets", "call.get.ledger-account");
    expect(more).toEqual([]);
    expect(j!.entry).toMatchObject({ repo: "forge-ledger", fact: "entry.get.accounts-id" });
    expect(j!.gateway?.map((h) => h.entry.fact)).toEqual(["entry.get.forge-ledger-v1-accounts"]);
    // the forwarding call's target URL is a token per environment: both hosts are the ledger's
    const [fwd] = joinsOf(run(), "forge-edge", "call.ledger.target");
    expect([fwd!.tie?.fact, ...(fwd!.through ?? []).map((t) => t.fact)].sort()).toEqual([
      "config.ledger-url-prod",
      "config.ledger-url-test",
    ]);
  });

  it("resolves a Camel {{property}} URI to the setting that names the ledger's host", () => {
    const [j, ...more] = joinsOf(run(), "forge-bridge", "call.get.ledger-accounts-id");
    expect(more).toEqual([]);
    expect(j!.entry).toMatchObject({ repo: "forge-ledger", fact: "entry.get.accounts-id" });
    expect(j!.tie?.fact ?? j!.through?.[0]?.fact).toBe("config.ledger-base-uri");
  });

  it("joins a TargetServer's route to the Service at that host, its context path taken off", () => {
    const [j, ...more] = joinsOf(run(), "forge-edge", "call.rates.target");
    expect(more).toEqual([]);
    expect(j!.entry).toMatchObject({ repo: "forge-rates", fact: "entry.get.rates-currency" });
    expect(j!.tie?.fact).toBe("config.ts-rates");
  });

  it("leaves a blueprint route's call the ledger serves no entry for, and a vendor's call to the vendor", () => {
    const out = run();
    expect(out.left?.find((l) => l.call.fact === "call.post.ledger-statements")?.reason).toBe(
      "host-no-route",
    );
    expect(out.outside).toEqual([
      expect.objectContaining({
        call: expect.objectContaining({ fact: "call.get.payouts-id" }),
        target: "northwind-pay",
      }),
    ]);
  });

  it("draws each depends-on link the Maven, Gradle and catalog facts cite", () => {
    const d = joinDependencies({ repos: estate() });
    expect(
      d.links.map((l) => `${l.from.component} -> ${l.to.component} ${l.group}:${l.name}`),
    ).toEqual([
      "forge-bridge -> ledger-api forge.ledger:ledger-api",
      "ledger-service -> ledger-api forge.ledger:ledger-api",
      "ledger-service -> rates-core forge.rates:rates-core",
      "rates-service -> ledger-api forge.ledger:ledger-api",
      "wallets-api -> ledger-api forge.ledger:ledger-api",
      "wallets-api -> rates-core forge.rates:rates-core",
    ]);
    // Northwind's SDK twice, PostgreSQL's driver twice, Testcontainers' once: nobody's in the estate
    expect(d.outside).toBe(5);
    expect(d.ambiguous).toEqual([]);
  });

  // Beta.25: a token is the file's whose element its XPath's root is, not any file of its name
  it("never gives a call the URL token of another TargetEndpoint that shares its file name", () => {
    const out = run();
    expect(named(out, "forge-edge", CHAIN)).not.toContain("forge-ledger");
    expect(
      joinsOf(out, "forge-edge", CHAIN).flatMap((j) => [
        j.tie?.fact,
        ...(j.through ?? []).map((t) => t.fact),
      ]),
    ).not.toContain("config.ledger-url-test");
  });

  // Beta.25: each proxy of a gateway repo owns its routes, so one chains to a sibling
  it("joins a LocalTargetConnection to the other proxy of the same repo whose base path it names", () => {
    // the call cited on its <Path> line alone, so the token bug above is out of the way
    const repos = swap(estate(), "forge-edge", (fs) =>
      fs.map((f) => (f.id === CHAIN ? { ...f, cite: { ...f.cite, with: undefined } } : f)),
    );
    const out = run(repos);
    const js = joinsOf(out, "forge-edge", CHAIN);
    expect(js).toHaveLength(1);
    const reached = [js[0]!.entry.fact, ...(js[0]!.gateway ?? []).map((h) => h.entry.fact)];
    expect(reached).toContain("entry.get.forge-rates-v1-rates");
  });
});
