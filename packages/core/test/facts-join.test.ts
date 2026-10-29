import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  joinFacts,
  joinRecords,
  parseFacts,
  parseRecord,
  type Fact,
  type JoinRepo,
} from "../src/index.js";

/**
 * The estate join from facts (ADR 0124 addendum C-join): each repo's calls joined to the entries
 * of the repo that serves them, with both citations, and the fields that cross.
 */

const ESTATE = join(__dirname, "..", "..", "..", "fixtures", "estate-facts");
const read = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(ESTATE, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
/** The three repos as the manifest lists them: a default component each, and one host. */
const estate = (): JoinRepo[] => [
  { repo: "forge-web", facts: read("forge-web"), component: "web-app" },
  {
    repo: "forge-customers",
    facts: read("forge-customers"),
    component: "customers-api",
    hosts: ["customers.forge.example"],
  },
  { repo: "forge-ledger", facts: read("forge-ledger"), component: "ledger-api" },
];
const expected = () => parse(readFileSync(join(ESTATE, "expected", "join.yaml"), "utf8"));

const call = (repo: string, id: string, extra: Record<string, unknown>): Fact =>
  ({
    kind: "call",
    id,
    repo,
    commit: "4444ddd",
    callType: "rest",
    cite: { file: "src/client.ts", line: 3, value: "x" },
    verified: "line",
    by: "assistant",
    conf: "declared",
    ...extra,
  }) as Fact;
const entry = (repo: string, id: string, extra: Record<string, unknown>): Fact =>
  ({
    kind: "entry",
    id,
    repo,
    commit: "5555eee",
    entryType: "rest",
    cite: { file: "src/Api.java", line: 9, value: "x" },
    verified: "line",
    by: "assistant",
    conf: "declared",
    ...extra,
  }) as Fact;

describe("joinFacts on a host several repos share: each repo's base path (ADR 0134)", () => {
  // Two Spring Boot services on one platform host, each under its own base path, both with /ping.
  const services = (o: { basePaths: boolean }): JoinRepo[] => [
    {
      repo: "forge-web",
      component: "forge-web",
      facts: [
        call("forge-web", "call.get.cdp-limits-ping", {
          method: "GET",
          path: "/cdp/limits/ping",
          host: "apps.ocp.forge.internal",
        }),
        call("forge-web", "call.get.cdp-limits-limits-id", {
          method: "GET",
          path: "/cdp/limits/limits/{id}",
          host: "apps.ocp.forge.internal",
        }),
      ],
    },
    ...(["limits", "wallets"] as const).map((m): JoinRepo => ({
      repo: `forge-${m}`,
      component: `${m}-api`,
      hosts: ["apps.ocp.forge.internal"],
      ...(o.basePaths ? { basePath: `/cdp/${m}` } : {}),
      facts: [
        entry(`forge-${m}`, "entry.get.ping", { method: "GET", path: "/ping" }),
        ...(m === "limits"
          ? [entry("forge-limits", "entry.get.limits-id", { method: "GET", path: "/limits/{id}" })]
          : []),
      ],
    })),
  ];

  it("joins the repo whose base path starts the call's path, even where every repo serves the rest", () => {
    const out = joinFacts({ repos: services({ basePaths: true }) });
    const ping = out.joins.find((j) => j.call.fact === "call.get.cdp-limits-ping")!;
    expect(ping.entry).toMatchObject({ repo: "forge-limits", fact: "entry.get.ping" });
    expect(ping.how).toBe("host");
    expect(out.asks).toEqual([]);
    expect(joinFacts({ repos: [...services({ basePaths: true })].reverse() })).toEqual(out);
  });

  it("without base paths, joins what only one repo serves and asks about the rest", () => {
    const out = joinFacts({ repos: services({ basePaths: false }) });
    expect(
      out.joins.find((j) => j.call.fact === "call.get.cdp-limits-limits-id")?.entry,
    ).toMatchObject({ repo: "forge-limits" });
    expect(out.asks.map((a) => [a.call.fact, a.reason])).toEqual([
      ["call.get.cdp-limits-ping", "ambiguous"],
    ]);
  });
});

describe("joinFacts: calls joined to the entries that serve them, across repos", () => {
  it("gives the golden joins, questions and field lineage for the Forge estate", () => {
    expect(JSON.parse(JSON.stringify(joinFacts({ repos: estate() })))).toEqual(expected());
  });

  it("is the same whatever order the repos come in", () => {
    expect(joinFacts({ repos: [...estate()].reverse() })).toEqual(joinFacts({ repos: estate() }));
  });

  it("joins an ambiguous call once a person names the repo, and asks no more", () => {
    const out = joinFacts({
      repos: estate(),
      targets: { "forge-web": { "c-get-account": "ledger-api" } },
    });
    expect(out.asks.map((a) => a.call.fact)).toEqual(["c-risk-score"]);
    const j = out.joins.find((x) => x.call.fact === "c-get-account")!;
    expect(j).toMatchObject({
      how: "answer",
      entry: { repo: "forge-ledger", fact: "e-get-account" },
    });
  });

  it("reads a target that names a repo as the component of that repo serving the call", () => {
    const out = joinFacts({
      repos: [
        {
          repo: "pets-ui",
          facts: [
            call("pets-ui", "c-owners", {
              component: "OwnerService",
              method: "GET",
              path: "/clinic/api/owners",
              host: "localhost:9966",
              to: "pets-api",
            }),
          ],
        },
        {
          repo: "pets-api",
          facts: [
            entry("pets-api", "e-owners", {
              component: "OwnerController",
              method: "GET",
              path: "/clinic/api/owners",
            }),
            entry("pets-api", "e-vets", {
              component: "VetController",
              method: "GET",
              path: "/clinic/api/vets",
            }),
          ],
        },
      ],
    });
    expect(out.asks).toEqual([]);
    expect(out.joins).toHaveLength(1);
    expect(out.joins[0]).toMatchObject({
      how: "repo",
      entry: { component: "ownercontroller", fact: "e-owners" },
    });
  });

  it("asks about a host no repo lists even when one entry elsewhere has the path: never a guess", () => {
    const out = joinFacts({
      repos: [
        {
          repo: "a",
          facts: [call("a", "c1", { method: "POST", path: "/v1/charge", host: "pay.example" })],
        },
        { repo: "b", facts: [entry("b", "e1", { method: "POST", path: "/v1/charge" })] },
      ],
    });
    expect(out.joins).toEqual([]);
    expect(out.asks).toMatchObject([{ reason: "unknown-host", host: "pay.example" }]);
  });

  it("says when the repo a call names has no entry for it", () => {
    const out = joinFacts({
      repos: [
        { repo: "a", facts: [call("a", "c1", { method: "GET", path: "/v1/things", to: "b" })] },
        { repo: "b", facts: [entry("b", "e1", { method: "GET", path: "/v1/other" })] },
      ],
    });
    expect(out.joins).toEqual([]);
    expect(out.misses).toMatchObject([{ call: { fact: "c1" }, target: "b" }]);
  });

  it("matches a catch-all route and a context path in front, preferring the exact entry", () => {
    const out = joinFacts({
      repos: [
        {
          repo: "a",
          facts: [
            call("a", "c1", { method: "GET", path: "/api/catalog/items/{id}", to: "bff" }),
            call("a", "c2", { method: "GET", path: "/shop/api/orders/{id}", to: "b" }),
          ],
        },
        {
          repo: "bff",
          facts: [entry("bff", "e-any", { path: "/api/catalog/{*any}" })],
        },
        {
          repo: "b",
          facts: [
            entry("b", "e-order", { method: "GET", path: "/api/orders/{orderId}" }),
            entry("b", "e-orders", { method: "GET", path: "/api/orders" }),
          ],
        },
      ],
    });
    expect(out.joins.map((j) => [j.call.fact, j.entry.fact])).toEqual([
      ["c1", "e-any"],
      ["c2", "e-order"],
    ]);
  });
});

/**
 * The join fallback (ADR 0124 addendum C-join): one repo holds a single-page app and its API;
 * the app's calls are relative, and the reader guessed a target (`notes-service`) that is no
 * component of the estate. Invented Forge names.
 */
describe("joinFacts: a relative call whose target names nothing in the estate", () => {
  const notes = (extra: Fact[] = []): JoinRepo => ({
    repo: "forge-notes",
    facts: [
      call("forge-notes", "c-note", {
        component: "forge-notes-web",
        method: "GET",
        path: "/api/notes/{id}",
        to: "notes-service",
      }),
      call("forge-notes", "c-tags", {
        component: "forge-notes-web",
        method: "GET",
        path: "/api/tags",
        to: "notes-service",
      }),
      call("forge-notes", "c-save", {
        component: "forge-notes-web",
        method: "POST",
        path: "/api/notes",
      }),
      entry("forge-notes", "e-note", { method: "GET", path: "/api/notes/{noteId}" }),
      entry("forge-notes", "e-save", { method: "POST", path: "/api/notes" }),
      ...extra,
    ],
  });
  const archive: JoinRepo = {
    repo: "forge-archive",
    facts: [
      entry("forge-archive", "e-note", { method: "GET", path: "/api/notes/{id}" }),
      entry("forge-archive", "e-tags", { method: "GET", path: "/api/tags" }),
    ],
  };

  it("joins the one entry of its own repo that serves it first, then of the estate, marked inferred", () => {
    const out = joinFacts({ repos: [notes(), archive] });
    expect(out.asks).toEqual([]);
    expect(
      out.joins.map((j) => [j.call.fact, `${j.entry.repo}/${j.entry.fact}`, j.how, j.inferred]),
    ).toEqual([
      ["c-note", "forge-notes/e-note", "path", { within: "repo", named: "notes-service" }],
      ["c-save", "forge-notes/e-save", "path", { within: "repo" }],
      ["c-tags", "forge-archive/e-tags", "path", { within: "estate", named: "notes-service" }],
    ]);
    // The API's component is the repo's: the app's calls join it, not themselves.
    expect(out.joins[0]!.entry.component).toBe("forge-notes");
  });

  it("asks when two entries of its own repo could answer, never a guess", () => {
    const out = joinFacts({
      repos: [
        notes([
          entry("forge-notes", "e-note-admin", {
            component: "forge-notes-admin",
            method: "GET",
            path: "/api/notes/{id}",
          }),
        ]),
        archive,
      ],
    });
    expect(out.joins.map((j) => j.call.fact)).toEqual(["c-save", "c-tags"]);
    expect(out.asks).toMatchObject([
      {
        call: { fact: "c-note" },
        reason: "ambiguous",
        question: "Which repo or system answers GET /api/notes/{id}, which forge-notes-web calls?",
        candidates: [
          { repo: "forge-notes", fact: "e-note" },
          { repo: "forge-notes", fact: "e-note-admin" },
        ],
      },
    ]);
  });

  it("keeps a target the org pack lists as an outside system, and one with a host", () => {
    const out = joinFacts({
      repos: [
        {
          repo: "forge-notes",
          facts: [
            call("forge-notes", "c-pay", {
              component: "forge-notes-web",
              method: "GET",
              path: "/api/tags",
              to: "Northwind Pay",
            }),
            call("forge-notes", "c-host", {
              component: "forge-notes-web",
              method: "GET",
              path: "/api/tags",
              host: "tags.northwind.example",
              to: "northwind-tags",
            }),
          ],
        },
        archive,
      ],
      outside: ["northwind-pay"],
    });
    expect(out.joins).toEqual([]);
    expect(out.asks).toEqual([]);
  });

  it("makes an Interface for each join by path, citing both ends", () => {
    const repos = [notes(), archive];
    const records = joinRecords(joinFacts({ repos }), repos);
    const ifaces = records.filter((r) => r.kind === "Interface");
    expect(ifaces.map((r) => (r.kind === "Interface" ? `${r.from} -> ${r.to}` : ""))).toEqual(
      expect.arrayContaining([
        "forge-notes-web -> forge-notes",
        "forge-notes-web -> forge-archive",
      ]),
    );
    for (const r of ifaces) expect(r.evidence.map((e) => e.side)).toEqual(["caller", "callee"]);
  });
});

describe("joinRecords: the joins as C1 records", () => {
  it("makes an Interface citing both ends and the config between, and a FieldMapping per crossing", () => {
    const repos = estate();
    const records = joinRecords(joinFacts({ repos }), repos);
    for (const r of records) expect(parseRecord(r).ok, r.id).toBe(true);
    const create = records.find((r) => r.kind === "Interface" && r.id === "if-0f06d434a34c81c9");
    expect(create).toMatchObject({
      from: "web-app",
      to: "customers-api",
      method: "POST",
      normalizedPath: "/api/customers",
      confidence: "verified",
      evidence: [
        {
          source: "code",
          repo: "forge-web",
          path: "src/app/customers/customer.service.ts",
          line: 21,
          side: "caller",
        },
        {
          source: "config",
          repo: "forge-web",
          path: "src/environments/environment.ts",
          line: 4,
          side: "caller",
        },
        {
          source: "code",
          repo: "forge-customers",
          path: "src/main/java/forge/customers/CustomerController.java",
          line: 24,
          side: "callee",
        },
      ],
    });
    const grpc = records.find((r) => r.kind === "Interface" && r.id === "if-fc58b23d49c7c652");
    expect(grpc).toMatchObject({ endpoint: "ledger-api.forge-ledger-v1-ledger-openaccount" });
    // A publish's Interface to its listener, as the merge pairs them.
    expect(records.find((r) => r.id === "if-b0f886eee91a68ad")).toMatchObject({
      from: "customers-api",
      to: "ledger-api",
      endpoint: "ledger-api.on-forge-customers-created",
      via: "event-bus",
      sync: "async",
    });
    const maps = records
      .filter((r) => r.kind === "FieldMapping")
      .map((r) =>
        r.kind === "FieldMapping" ? `${r.interface} ${r.sourceField} -> ${r.targetField}` : "",
      );
    expect(maps).toContain("if-0f06d434a34c81c9 email -> email");
    expect(maps).toContain("if-0f06d434a34c81c9 email -> customers.email_address");
    expect(maps).toContain("if-fc58b23d49c7c652 account_id -> accountId");
    expect(maps).toContain("if-b0f886eee91a68ad customerId -> customerId");
  });
});
