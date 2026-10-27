import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  callerRecords,
  citedFiles,
  joinCallers,
  joinFacts,
  joinRecords,
  parseFacts,
  projectFacts,
  type CatalogRecord,
  type Fact,
  type JoinRepo,
} from "@maycombhq/core";
import { codeLinkerFor, dirSource, renderMap, verifyFacts } from "../src/index.js";

/**
 * The consumers a gateway route names, checked like any other citation (ADR 0124 addendum
 * A-callers), on the invented `fixtures/gateway-chain/`: the edge gateway's forge-refunds-v1 routes
 * name the API product forge-refunds and the two developer apps subscribed to it, each cited on the
 * line that names it, with the line that ties it to the route in `with`.
 */
const FIX = join(__dirname, "..", "..", "..", "fixtures", "gateway-chain");
const EDGE = "forge-edge-gateway";
const POST = "entry.post.forge-refunds-v1-refunds";
const APPS = "resources/edge/org/developerApps.json";
const PRODUCTS = "resources/edge/org/apiProducts.json";
const facts = (): Fact[] => {
  const r = parseFacts(readFileSync(join(FIX, "facts", `${EDGE}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const run = (fs: Fact[] = facts()) =>
  verifyFacts({ facts: fs, source: dirSource(join(FIX, "repos", EDGE)), commit: "bbb2222" });
/** The edge gateway's facts with the POST route's callers replaced. */
const withCallers = (callers: unknown[]) =>
  facts().map((x) => (x.id === POST ? ({ ...x, callers } as Fact) : x));
const ids = (r: Awaited<ReturnType<typeof run>>) => r.rejected.map((x) => [x.fact.id, x.code]);

describe("a route's consumers rest on the lines that name them", () => {
  it("keeps the product and both apps, each cited", async () => {
    const r = await run();
    expect(r.rejected).toEqual([]);
    const kept = r.accepted.find((f) => f.id === POST)!;
    expect(kept.kind === "entry" && kept.callers?.map((c) => `${c.as} ${c.value}`)).toEqual([
      "product forge-refunds",
      "app harbor-desk-portal",
      "app forge-ops-console",
    ]);
    // The product and app files count as read: a fact rests on them.
    expect(r.coverage.read).toEqual(expect.arrayContaining([APPS, PRODUCTS]));
  });

  it("rejects a consumer no line names (an invented app)", async () => {
    const r = await run(
      withCallers([
        {
          as: "app",
          file: APPS,
          line: 4,
          value: "harbor-desk-batch",
          quote: '"name": "harbor-desk-portal",',
        },
      ]),
    );
    expect(ids(r)).toEqual([
      ["call.post.refunds", "ref-rejected"],
      [POST, "claim-not-on-line"],
    ]);
    expect(r.rejected[1]!.message).toContain('caller 1 (app "harbor-desk-batch")');
  });

  it("rejects a consumer cited on the wrong line", async () => {
    const r = await run(
      withCallers([{ as: "app", file: APPS, line: 11, value: "harbor-desk-portal" }]),
    );
    expect(ids(r)).toContainEqual([POST, "claim-not-on-line"]);
  });

  it("rejects a tie to the route that isn't on its line", async () => {
    const r = await run(
      withCallers([
        {
          as: "product",
          file: PRODUCTS,
          line: 3,
          value: "forge-refunds",
          with: [{ file: PRODUCTS, line: 6, value: "forge-orders-v2" }],
        },
      ]),
    );
    expect(ids(r)).toContainEqual([POST, "claim-not-on-line"]);
  });

  it("rejects a consumer in a file that isn't there", async () => {
    const r = await run(
      withCallers([
        { as: "app", file: "resources/edge/org/apps.json", line: 4, value: "x-portal" },
      ]),
    );
    expect(ids(r)).toContainEqual([POST, "no-file"]);
  });

  it("a changed consumer line invalidates the route that rests on it", () => {
    const post = facts().find((f) => f.id === POST)!;
    expect(citedFiles(post)).toEqual(expect.arrayContaining([APPS, PRODUCTS]));
  });
});

describe("the map says who calls each gateway route", () => {
  const read = (repo: string): Fact[] => {
    const r = parseFacts(readFileSync(join(FIX, "facts", `${repo}.jsonl`), "utf8"));
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    return r.facts;
  };
  const estate = (edge: (fs: Fact[]) => Fact[] = (fs) => fs): JoinRepo[] => [
    { repo: "forge-shop-bff", facts: read("forge-shop-bff"), component: "shop-bff" },
    {
      repo: EDGE,
      facts: edge(read(EDGE)),
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
      repo: "forge-refunds",
      facts: read("forge-refunds"),
      component: "refunds-api",
      hosts: ["refunds.forge.internal"],
    },
  ];
  const HARBOR = {
    system: "harbor-desk",
    name: "Harbor Desk",
    boundary: "internal" as const,
    owner: "team-harbor",
    as: "app" as const,
    identity: "harbor-desk-portal",
    source: "profiles/forge/profile.yaml",
  };
  const mapOf = (repos: JoinRepo[], declared = [HARBOR]) => {
    const join = joinFacts({ repos });
    const joined = joinRecords(join, repos);
    const records: CatalogRecord[] = [
      ...repos.flatMap(
        (r) =>
          projectFacts(
            r.facts.map((f) => ({ ...f, component: r.component }) as Fact),
            { system: r.component! },
          ).records,
      ),
      ...joined,
      ...callerRecords(joinCallers({ repos, join, declared }), repos, join, { existing: joined }),
      {
        kind: "System",
        schemaVersion: 3,
        id: "harbor-desk",
        status: "current",
        confidence: "asserted",
        name: "Harbor Desk",
        boundary: "internal",
        repos: [],
        tags: [],
        accessGroup: "everyone",
        evidence: [{ source: "manual", by: "person" }],
      } as CatalogRecord,
    ];
    return renderMap({
      repo: EDGE,
      records,
      flows: [],
      paths: { map: `map/${EDGE}`, questions: "questions", specs: `specs/${EDGE}` },
      codeLink: codeLinkerFor({ url: `https://git.forge.example/forge/${EDGE}.git` }),
    })["map.md"]!;
  };
  const line = (map: string, what: string) =>
    map.split("\n").find((l) => l.startsWith(`- \`${what}\``)) ?? "";

  it("names the declared caller as a person's word, then the consumers the route's files name", () => {
    expect(line(mapOf(estate()), "POST /forge/refunds/v1/refunds")).toContain(
      "callers Harbor Desk (declared; app harbor-desk-portal), app forge-ops-console, product forge-refunds",
    );
  });

  it("names a scanned caller as the component that calls", () => {
    expect(line(mapOf(estate()), "GET /forge/v2/orders/{id}")).toContain("callers shop-bff");
  });

  it("says callers unknown where nothing names, declares or calls the route", () => {
    const strip = (fs: Fact[]) =>
      fs.map((f) => {
        if (f.kind !== "entry") return f;
        const { callers: _, ...rest } = f;
        return rest as Fact;
      });
    const map = mapOf(estate(strip), []);
    expect(line(map, "POST /forge/refunds/v1/refunds")).toContain("callers unknown");
    expect(line(map, "GET /forge/refunds/v1/refunds/{id}")).toContain("callers unknown");
    expect(line(map, "GET /forge/v2/orders/{id}")).not.toContain("callers unknown");
  });
});
