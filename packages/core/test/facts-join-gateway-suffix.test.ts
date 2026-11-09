import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  JOINED_BY_PATH_OVERLAP,
  MAX_PASS_THROUGH_LINKS,
  joinFacts,
  joinRecords,
  parseFacts,
  parseRecord,
  type Fact,
  type JoinRepo,
} from "../src/index.js";

/**
 * An Apigee proxy to the backend endpoint it forwards to (ADR 0124 addendum A-gateway, the
 * path suffix): Apigee sends the target the target's own path with the request's path suffix
 * (the part after the proxy's `<BasePath>`) after it, unless the proxy sets
 * `target.copy.pathsuffix` false; and the service serves its routes under a base path of its own
 * (a Spring context path, a Route's path, the manifest's `basePath`), which its entries may leave
 * out. The invented `fixtures/gateway-facts/passthrough-suffix/` holds the four shapes; its
 * `expected/join.yaml` and `expected/records.yaml` are the join and its records, checked by hand.
 */
const DIR = join(__dirname, "..", "..", "..", "fixtures", "gateway-facts", "passthrough-suffix");
const read = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(DIR, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
type ManifestRepo = {
  id: string;
  type: string;
  component: string;
  hosts?: string[];
  basePath?: string;
};
/** The repos as the fixture's manifest lists them. */
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
    ...(r.basePath ? { basePath: r.basePath } : {}),
    ...(r.type === "gateway" ? { gateway: true } : {}),
  }));
const swap = (repos: JoinRepo[], repo: string, facts: (fs: Fact[]) => Fact[]): JoinRepo[] =>
  repos.map((r) => (r.repo === repo ? { ...r, facts: facts([...r.facts]) } : r));
const golden = (name: string) => parse(readFileSync(join(DIR, "expected", name), "utf8"));
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const joinsOf = (out: ReturnType<typeof joinFacts>, repo: string, call: string) =>
  out.joins.filter((j) => j.call.repo === repo && j.call.fact === call);
type Iface = {
  kind: string;
  id: string;
  from: string;
  to: string;
  method?: string;
  normalizedPath?: string;
  confidence: string;
  flags?: string[];
  via?: string;
  evidence: { source: string; side?: string; repo?: string; path?: string; line?: number }[];
};
const links = (repos: JoinRepo[], from: string, to: string) =>
  (joinRecords(joinFacts({ repos }), repos) as unknown as Iface[]).filter(
    (r) => r.kind === "Interface" && r.from === from && r.to === to,
  );
const lines = (r: Iface) => r.evidence.map((e) => `${e.source}/${e.side} ${e.path}:${e.line}`);

describe("an Apigee proxy joins the backend endpoint it forwards to (golden)", () => {
  it("gives the golden join", () => {
    expect(plain(joinFacts({ repos: estate() }))).toEqual(golden("join.yaml"));
  });

  it("gives the golden records, each valid C1", () => {
    const repos = estate();
    const rs = plain(joinRecords(joinFacts({ repos }), repos));
    expect(rs).toEqual(golden("records.yaml"));
    for (const r of rs) expect(parseRecord(r).ok, r.id).toBe(true);
  });

  it("is the same whatever order the repos come in", () => {
    expect(joinFacts({ repos: [...estate()].reverse() })).toEqual(joinFacts({ repos: estate() }));
  });
});

describe("the path the target receives: its own path and the route's suffix", () => {
  it("joins each conditional flow to the service's entry under the context path the service's config sets", () => {
    const out = joinFacts({ repos: estate() });
    const got = joinsOf(out, "forge-fees-proxy", "call.fees.target");
    expect(
      got.map((j) => [j.forRoute?.fact, j.method, j.entry.fact, j.base?.from, j.base?.path]),
    ).toEqual([
      [
        "entry.get.forge-fees-v1-retrieve",
        "GET",
        "entry.get.fees-retrieve",
        "config",
        "/forge-fees/1.0",
      ],
      [
        "entry.post.forge-fees-v1-quote",
        "POST",
        "entry.post.fees-quote",
        "config",
        "/forge-fees/1.0",
      ],
    ]);
    // The service's /ping is no route of the proxy's: nothing joins it.
    expect(out.joins.some((j) => j.entry.fact === "entry.get.ping")).toBe(false);
    // Joined, so no longer a miss.
    expect(out.misses.filter((m) => m.call.fact === "call.fees.target")).toEqual([]);
  });

  it("records each as a verified link, citing the route, the target URL, the setting and the entry", () => {
    const both = links(estate(), "fees-proxy", "fees-api");
    expect(both).toHaveLength(2);
    const retrieve = both.find((l) => l.method === "GET");
    const quote = both.find((l) => l.method === "POST");
    expect(retrieve).toMatchObject({
      confidence: "verified",
      method: "GET",
      normalizedPath: "/fees/retrieve",
      flags: ["joined-by-host"],
    });
    expect(lines(retrieve!)).toEqual([
      "code/caller apiproxy/targets/TE-Fees.xml:3",
      "gateway/caller apiproxy/proxies/default.xml:4",
      "config/caller config/prod.properties:2",
      "code/callee src/main/java/forge/fees/FeesController.java:9",
      "config/callee src/main/resources/application.properties:2",
    ]);
    expect(quote).toMatchObject({ method: "POST", normalizedPath: "/fees/quote" });
  });

  it("walks a caller of the proxy's route on to the service's entry", () => {
    const out = joinFacts({ repos: estate() });
    const bff = joinsOf(out, "forge-billing-bff", "call.get.forge-fees-v1-retrieve");
    expect(bff).toHaveLength(1);
    expect(bff[0]).toMatchObject({
      entry: { repo: "forge-fees", fact: "entry.get.fees-retrieve" },
      path: "/fees/retrieve",
      gateway: [
        {
          entry: { fact: "entry.get.forge-fees-v1-retrieve" },
          call: { fact: "call.fees.target" },
        },
      ],
    });
    const [link] = links(estate(), "billing-bff", "fees-api");
    expect(link).toMatchObject({ confidence: "verified", via: "gateway" });
    expect(lines(link!)).toContain("config/callee src/main/resources/application.properties:2");
  });

  it("doesn't append the suffix again to a forwarding call that already carries it", () => {
    const repos = swap(estate(), "forge-edge", (fs) =>
      fs.map((f) =>
        f.id === "call.get.limits" ? ({ ...f, path: "/forge-limits/v3/limits/check" } as Fact) : f,
      ),
    );
    const got = joinsOf(joinFacts({ repos }), "forge-edge", "call.get.limits");
    expect(got.map((j) => j.entry.fact)).toEqual(["entry.get.limits-check"]);
  });

  it("joins an entry the service records with its context path without stripping anything", () => {
    const repos = swap(estate(), "forge-fees", (fs) =>
      fs.map((f) =>
        f.kind === "entry" && f.path.startsWith("/fees")
          ? ({ ...f, path: `/forge-fees/1.0${f.path}` } as Fact)
          : f,
      ),
    );
    const got = joinsOf(joinFacts({ repos }), "forge-fees-proxy", "call.fees.target");
    expect(got.map((j) => [j.entry.fact, j.base])).toEqual([
      ["entry.get.fees-retrieve", undefined],
      ["entry.post.fees-quote", undefined],
    ]);
    expect(links(repos, "fees-proxy", "fees-api").map((l) => l.confidence)).toEqual([
      "verified",
      "verified",
    ]);
  });
});

describe("a <BasePath>/** pass-through: every entry under the target's path", () => {
  it("links to each entry under the base the manifest gives, by its own method", () => {
    const got = joinsOf(joinFacts({ repos: estate() }), "forge-edge", "call.any.rates");
    expect(got.map((j) => [j.method, j.entry.fact, j.base?.from, j.base?.path])).toEqual([
      ["GET", "entry.get.rates-history-date", "manifest", "/forge-rates/2.0"],
      ["GET", "entry.get.rates-today", "manifest", "/forge-rates/2.0"],
    ]);
    const recs = links(estate(), "edge-gateway", "rates-api");
    expect(recs.map((r) => [r.method, r.normalizedPath, r.confidence])).toEqual([
      ["GET", "/rates/history/{}", "verified"],
      ["GET", "/rates/today", "verified"],
    ]);
  });

  it(`stops at ${MAX_PASS_THROUGH_LINKS} entries`, () => {
    const many = (fs: Fact[]) => {
      const today = fs.find((f) => f.id === "entry.get.rates-today")!;
      return [
        ...fs,
        ...Array.from(
          { length: MAX_PASS_THROUGH_LINKS + 5 },
          (_, i) =>
            ({
              ...today,
              id: `entry.get.rates-extra-${String(i).padStart(3, "0")}`,
              path: `/rates/extra-${String(i).padStart(3, "0")}`,
            }) as Fact,
        ),
      ];
    };
    const got = joinsOf(
      joinFacts({ repos: swap(estate(), "forge-rates", many) }),
      "forge-edge",
      "call.any.rates",
    );
    expect(got).toHaveLength(MAX_PASS_THROUGH_LINKS);
  });
});

describe("the service's base path: from code or the manifest verified, else a guess", () => {
  it("takes it from an OpenShift Route's path, and keeps the target's path as is when copy.pathsuffix is false", () => {
    const out = joinFacts({ repos: estate() });
    const got = joinsOf(out, "forge-edge", "call.post.refunds");
    expect(got.map((j) => [j.entry.fact, j.base?.from, j.base?.path])).toEqual([
      ["entry.post.refunds", "deploy", "/forge-refunds/1.0"],
    ]);
    expect(got[0]!.exposedBy?.map((e) => e.fact)).toEqual(["deploy.route.forge-refunds"]);
    const [link] = links(estate(), "edge-gateway", "refunds-api");
    expect(link).toMatchObject({ confidence: "verified", normalizedPath: "/refunds" });
    expect(lines(link!)).toEqual([
      "code/caller proxies/forge-refunds-v1/apiproxy/targets/refunds.xml:3",
      "gateway/caller proxies/forge-refunds-v1/apiproxy/proxies/default.xml:9",
      "config/caller proxies/forge-refunds-v1/apiproxy/resources/jsc/no-suffix.js:2",
      "code/callee src/main/java/forge/refunds/RefundsController.java:6",
      "infrastructure/callee deploy/openshift/route.yaml:4",
    ]);
  });

  it("appends the suffix when nothing turns copy.pathsuffix off", () => {
    const repos = swap(estate(), "forge-edge", (fs) =>
      fs.filter((f) => f.id !== "config.refunds-copy-pathsuffix"),
    );
    const got = joinsOf(joinFacts({ repos }), "forge-edge", "call.post.refunds");
    expect(got.map((j) => j.entry.fact)).toEqual(["entry.post.refunds-submit"]);
  });

  it("guesses by the overlap when nothing gives the base: inferred, flagged", () => {
    const got = joinsOf(joinFacts({ repos: estate() }), "forge-edge", "call.get.limits");
    expect(got.map((j) => [j.entry.fact, j.base?.from, j.base?.path])).toEqual([
      ["entry.get.limits-check", "overlap", "/forge-limits/v3"],
    ]);
    const [link] = links(estate(), "edge-gateway", "limits-api");
    expect(link).toMatchObject({ confidence: "inferred" });
    expect(link!.flags).toContain(JOINED_BY_PATH_OVERLAP);
  });

  it("makes the fees link a guess too once the context path's setting is gone", () => {
    const repos = swap(estate(), "forge-fees", (fs) =>
      fs.filter((f) => f.id !== "config.context-path"),
    );
    const got = joinsOf(joinFacts({ repos }), "forge-fees-proxy", "call.fees.target");
    expect(got.map((j) => [j.entry.fact, j.base?.from])).toEqual([
      ["entry.get.fees-retrieve", "overlap"],
      ["entry.post.fees-quote", "overlap"],
    ]);
    // The walked link from the BFF is a guess as well.
    const [bff] = links(repos, "billing-bff", "fees-api");
    expect(bff).toMatchObject({ confidence: "inferred" });
    expect(bff!.flags).toContain(JOINED_BY_PATH_OVERLAP);
  });

  it("takes the context path and the servlet path together", () => {
    const repos = swap(estate(), "forge-fees", (fs) => [
      ...fs.map((f) =>
        f.id === "config.context-path" ? ({ ...f, value: "/forge-fees" } as Fact) : f,
      ),
      {
        ...fs.find((f) => f.id === "config.context-path")!,
        id: "config.servlet-path",
        key: "spring.mvc.servlet.path",
        value: "/1.0",
      } as Fact,
    ]);
    const got = joinsOf(joinFacts({ repos }), "forge-fees-proxy", "call.fees.target");
    expect(got.map((j) => [j.entry.fact, j.base?.from, j.base?.path])).toEqual([
      ["entry.get.fees-retrieve", "config", "/forge-fees/1.0"],
      ["entry.post.fees-quote", "config", "/forge-fees/1.0"],
    ]);
  });
});
