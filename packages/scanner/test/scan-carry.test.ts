import { describe, expect, it } from "vitest";
import { interfaceId, mergeCatalog, type CatalogRecord } from "@maycombhq/core";
import { carryFrom, withCarried, withoutCovered } from "../src/scan-carry.js";

/**
 * Beta.26 review, second round (ADR 0124 addendum B-keep): what a scan carries of the catalog
 * before it goes into its merge, so a link between a repo read and one not read is joined again
 * as it was (never thinner, never an arrow and a loose end); outdated fact records go; the
 * readers' records a carried fact record has are left out; a fact record is carried only when
 * every repo it rests on can't be read now. Invented Northwind estate only.
 */

const rec = (kind: string, id: string, extra: Record<string, unknown>, evidence: object[]) =>
  ({
    schemaVersion: 5,
    kind,
    id,
    status: "current",
    confidence: "verified",
    ...extra,
    evidence,
  }) as unknown as CatalogRecord;

const code = (repo: string, path: string, line: number, extra: Record<string, unknown> = {}) => ({
  source: "code",
  repo,
  path,
  line,
  ...extra,
});
const fact = (repo: string, path: string, line: number, side?: string) =>
  code(repo, path, line, { by: "assistant", commit: "abc1234", ...(side ? { side } : {}) });

const component = (id: string, repo: string) =>
  rec("Component", id, { system: "northwind", type: "service", repo }, [code(repo, "pom.xml", 1)]);

const repos = [
  { id: "northwind-web", type: "spring-boot", component: "northwind-web" },
  {
    id: "northwind-api",
    type: "spring-boot",
    component: "northwind-api",
    hosts: ["api.northwind.example"],
  },
];
const repoOf = (c: string) =>
  ({ "northwind-web": "northwind-web", "northwind-api": "northwind-api" })[c];

const merge = (records: CatalogRecord[]) => {
  const m = mergeCatalog({ records, repos, systems: [], patterns: [] });
  expect(m.invalid).toEqual([]);
  return m.records;
};

const quotes = rec(
  "Endpoint",
  "northwind-api.get-quotes",
  {
    component: "northwind-api",
    endpointType: "rest",
    method: "GET",
    pathOrTopic: "/quotes",
    normalizedPath: "/quotes",
    auth: "oauth2",
  },
  [code("northwind-api", "src/Quotes.java", 3, { side: "definition" })],
);

describe("a link to a repo not read is joined again from what is carried (item 1)", () => {
  it("joins the readers' call to the carried endpoint: verified, with its endpoint and auth", () => {
    const before = merge([
      component("northwind-api", "northwind-api"),
      component("northwind-web", "northwind-web"),
      quotes,
      rec(
        "Unresolved",
        "unresolved.web.1",
        {
          unresolvedKind: "http-call",
          owner: "northwind-web",
          raw: "GET https://api.northwind.example/quotes",
        },
        [code("northwind-web", "src/Client.java", 12, { side: "caller" })],
      ),
    ]);
    const link = before.find((r) => r.kind === "Interface")!;
    const endpoint = before.find((r) => r.kind === "Endpoint")!.id;
    expect(link).toMatchObject({ confidence: "verified", endpoint, auth: "oauth2" });

    // northwind-api isn't cloned now; the readers read northwind-web's call again.
    const carry = carryFrom({
      before,
      estate: ["northwind-api", "northwind-web"],
      read: ["northwind-web"],
      standIn: {},
      repoOf,
    });
    const readers = [
      component("northwind-web", "northwind-web"),
      rec(
        "Unresolved",
        "unresolved.web.1",
        {
          unresolvedKind: "http-call",
          owner: "northwind-web",
          raw: "GET https://api.northwind.example/quotes",
        },
        [code("northwind-web", "src/Client.java", 12, { side: "caller" })],
      ),
    ];
    const after = withCarried(merge([...carry.context, ...readers]), carry, 0).records;
    expect(after.find((r) => r.id === link.id)).toEqual(link);
    expect(after.filter((r) => r.kind === "Unresolved")).toEqual([]);
    // Without what is carried, the same call is a thin link: what the first round kept.
    const thin = merge(readers).find((r) => r.id === link.id);
    expect(thin).toMatchObject({ confidence: "inferred" });
    expect(thin).not.toHaveProperty("endpoint");
  });

  it("lets a call the read repo no longer makes go", () => {
    const before = merge([
      component("northwind-api", "northwind-api"),
      quotes,
      rec(
        "Unresolved",
        "unresolved.web.1",
        {
          unresolvedKind: "http-call",
          owner: "northwind-web",
          raw: "GET https://api.northwind.example/quotes",
        },
        [code("northwind-web", "src/Client.java", 12, { side: "caller" })],
      ),
    ]);
    const carry = carryFrom({
      before,
      estate: ["northwind-api", "northwind-web"],
      read: ["northwind-web"],
      standIn: {},
      repoOf,
    });
    const after = withCarried(merge([...carry.context]), carry, 0).records;
    expect(after.filter((r) => r.kind === "Interface")).toEqual([]);
    expect(after.find((r) => r.id === quotes.id)).toEqual(before.find((r) => r.id === quotes.id));
  });

  it("never makes an event to a repo not read an arrow and a loose end", () => {
    const pub = rec(
      "Unresolved",
      "unresolved.web.pub",
      { unresolvedKind: "event-publish", owner: "northwind-web", raw: "quote.requested" },
      [code("northwind-web", "src/Events.java", 20)],
    );
    const sub = rec(
      "Unresolved",
      "unresolved.api.sub",
      { unresolvedKind: "event-subscribe", owner: "northwind-api", raw: "quote.requested" },
      [code("northwind-api", "src/Listen.java", 7)],
    );
    const before = merge([component("northwind-api", "northwind-api"), pub, sub]);
    const link = before.find((r) => r.kind === "Interface")!;
    expect(link).toMatchObject({ via: "event-bus", confidence: "verified" });
    const carry = carryFrom({
      before,
      estate: ["northwind-api", "northwind-web"],
      read: ["northwind-web"],
      standIn: {},
      repoOf,
    });
    const after = withCarried(merge([...carry.context, pub]), carry, 0).records;
    expect(after.find((r) => r.id === link.id)).toEqual(link);
    expect(after.filter((r) => r.kind === "Unresolved")).toEqual([]);
  });

  it("joins a carried caller's link to the endpoint read now", () => {
    const pages = rec(
      "Endpoint",
      "northwind-web.get-pages",
      {
        component: "northwind-web",
        endpointType: "rest",
        method: "GET",
        pathOrTopic: "/pages",
        normalizedPath: "/pages",
      },
      [code("northwind-web", "src/Pages.java", 5, { side: "definition" })],
    );
    const call = rec(
      "Interface",
      interfaceId("northwind-api", "northwind-web", "GET", "/pages"),
      {
        from: "northwind-api",
        to: "northwind-web",
        method: "GET",
        normalizedPath: "/pages",
        via: "direct",
        sync: "sync",
        direction: "outbound",
        conflicts: [],
      },
      [code("northwind-api", "src/Web.java", 9, { side: "caller" })],
    );
    const before = merge([component("northwind-api", "northwind-api"), pages, call]);
    const link = before.find((r) => r.id === call.id)!;
    const endpoint = before.find((r) => r.kind === "Endpoint")!.id;
    expect(link).toMatchObject({ confidence: "verified", endpoint });
    const carry = carryFrom({
      before,
      estate: ["northwind-api", "northwind-web"],
      read: ["northwind-web"],
      standIn: {},
      repoOf,
    });
    // The endpoint is still read: the link is as it was.
    expect(withCarried(merge([...carry.context, pages]), carry, 0).records).toContainEqual(link);
    // Taken out of the code: the carried link keeps its caller, and is no longer verified.
    const gone = withCarried(merge([...carry.context]), carry, 0).records.find(
      (r) => r.id === call.id,
    );
    expect(gone).toMatchObject({ confidence: "inferred" });
    expect(gone).not.toHaveProperty("endpoint");
  });
});

describe("what is carried from the assistant's facts", () => {
  const estate = ["northwind-api", "northwind-web"];
  const read = ["northwind-api", "northwind-web"];

  it("lets go of fact records citing a file changed since, keeps those that don't (item 2)", () => {
    const changed = rec("Endpoint", "northwind-web.get-page", {}, [
      fact("northwind-web", "src/pages.ts", 4),
    ]);
    const unchanged = rec("Endpoint", "northwind-web.get-health", {}, [
      fact("northwind-web", "src/health.ts", 2),
    ]);
    const carry = carryFrom({
      before: [changed, unchanged],
      estate,
      read,
      standIn: { "northwind-web": { why: "cited-changed", changed: ["src/pages.ts"] } },
    });
    expect(carry.held.map((h) => h.r)).toEqual([unchanged]);
    expect(carry.outdated).toBe(1);
    // Facts not verified yet, of a commit that can't be compared, or that don't read: kept.
    for (const why of ["unverified", "not-comparable", "unparsed"] as const)
      expect(
        carryFrom({
          before: [changed, unchanged],
          estate,
          read,
          standIn: { "northwind-web": { why } },
        }).held.length,
      ).toBe(2);
    // Read from its facts: the facts decide.
    expect(carryFrom({ before: [changed], estate, read, standIn: {} }).held).toEqual([]);
  });

  it("carries a fact record only when every repo it rests on can't be read now (item 5)", () => {
    const across = rec(
      "Interface",
      "if-web-api-get-quotes",
      { from: "northwind-web", to: "northwind-api", method: "GET", normalizedPath: "/quotes" },
      [
        fact("northwind-web", "src/q.ts", 1, "caller"),
        fact("northwind-api", "src/quotes.ts", 3, "callee"),
      ],
    );
    expect(
      carryFrom({
        before: [across],
        estate,
        read,
        standIn: { "northwind-web": { why: "unverified" } },
      }).held,
    ).toEqual([]);
    expect(
      carryFrom({
        before: [across],
        estate,
        read,
        standIn: { "northwind-web": { why: "unverified" }, "northwind-api": { why: "unverified" } },
      }).held.length,
    ).toBe(1);
  });

  const standIn = { "northwind-web": { why: "unverified" as const } };

  it("leaves out the readers' loose end for a call a fact's loose end has (item 4)", () => {
    const factLoose = rec(
      "Unresolved",
      "unresolved.c-get-rates",
      {
        unresolvedKind: "call",
        owner: "northwind-web",
        raw: "GET https://rates.northwind.example /rates/{currency}",
      },
      [fact("northwind-web", "src/rates.ts", 9, "caller")],
    );
    const readerLoose = rec(
      "Unresolved",
      "unresolved.northwind-web.5d4c3b",
      {
        unresolvedKind: "http-call",
        owner: "northwind-web",
        raw: "GET https://rates.northwind.example/rates/${code}",
      },
      [code("northwind-web", "src/rates.ts", 10, { side: "caller" })],
    );
    const carry = carryFrom({ before: [factLoose], estate, read, standIn });
    const left = withoutCovered("northwind-web", [readerLoose], carry);
    expect(left).toEqual({ records: [], covered: 1 });
    const after = withCarried(merge([...carry.context, ...left.records]), carry, 1);
    expect(after.records.filter((r) => r.kind === "Unresolved")).toEqual([factLoose]);
    expect(after.summary).toMatchObject({ fromFacts: 1, covered: 1 });
  });

  it("leaves out the readers' loose end and endpoint beside a fact's, keeps what's new (item 4)", () => {
    const factLink = rec(
      "Interface",
      "if-web-ledger-post-payments",
      {
        from: "northwind-web",
        to: "northwind-ledger",
        method: "POST",
        normalizedPath: "/payments",
      },
      [fact("northwind-web", "src/pay.ts", 15, "caller")],
    );
    const factEndpoint = rec(
      "Endpoint",
      "northwind-web.get-page",
      { component: "northwind-web", method: "GET", pathOrTopic: "/page", endpointType: "rest" },
      [fact("northwind-web", "src/Page.java", 3, "definition")],
    );
    const readerLoose = rec(
      "Unresolved",
      "unresolved.northwind-web.1a2b3c",
      {
        unresolvedKind: "http-call",
        owner: "northwind-web",
        raw: "POST http://ledger.northwind.internal/payments",
      },
      [code("northwind-web", "src/pay.ts", 16, { side: "caller" })],
    );
    const readerSame = rec(
      "Endpoint",
      "northwind-web.get-page-x",
      { component: "northwind-web", method: "GET", pathOrTopic: "/page", endpointType: "rest" },
      [code("northwind-web", "src/Page.java", 4, { side: "definition" })],
    );
    const readerNew = rec(
      "Endpoint",
      "northwind-web.get-new",
      { component: "northwind-web", method: "GET", pathOrTopic: "/new", endpointType: "rest" },
      [code("northwind-web", "src/New.java", 2, { side: "definition" })],
    );
    const carry = carryFrom({ before: [factLink, factEndpoint], estate, read, standIn });
    const left = withoutCovered("northwind-web", [readerLoose, readerSame, readerNew], carry);
    expect(left).toEqual({ records: [readerNew], covered: 2 });
    // A repo the readers don't stand in for keeps all its readers' records.
    expect(withoutCovered("northwind-api", [readerLoose], carry).covered).toBe(0);
  });
});
