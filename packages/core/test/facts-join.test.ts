import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  callHostOf,
  JOIN_GUESS_FLAGS,
  JOIN_HOW_FLAGS,
  joinFacts,
  joinRecords,
  NO_TARGET,
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
        call("forge-web", "call.get.forge-limits-ping", {
          method: "GET",
          path: "/forge/limits/ping",
          host: "apps.ocp.forge.internal",
        }),
        call("forge-web", "call.get.forge-limits-limits-id", {
          method: "GET",
          path: "/forge/limits/limits/{id}",
          host: "apps.ocp.forge.internal",
        }),
      ],
    },
    ...(["limits", "wallets"] as const).map((m): JoinRepo => ({
      repo: `forge-${m}`,
      component: `${m}-api`,
      hosts: ["apps.ocp.forge.internal"],
      ...(o.basePaths ? { basePath: `/forge/${m}` } : {}),
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
    const ping = out.joins.find((j) => j.call.fact === "call.get.forge-limits-ping")!;
    expect(ping.entry).toMatchObject({ repo: "forge-limits", fact: "entry.get.ping" });
    expect(ping.how).toBe("host");
    expect(out.asks).toEqual([]);
    expect(joinFacts({ repos: [...services({ basePaths: true })].reverse() })).toEqual(out);
  });

  it("joins no repo whose base path rules the call out, even where its route ends the path", () => {
    const repos = services({ basePaths: true });
    repos[0] = {
      ...repos[0]!,
      facts: [
        call("forge-web", "call.get.forge-accounts-ping", {
          method: "GET",
          path: "/forge/accounts/ping",
          host: "apps.ocp.forge.internal",
        }),
      ],
    };
    const out = joinFacts({ repos });
    expect(out.joins.filter((j) => j.call.fact === "call.get.forge-accounts-ping")).toEqual([]);
    expect(out.misses.map((m) => m.call.fact)).toEqual(["call.get.forge-accounts-ping"]);
  });

  it("reads a {placeholder} in a base path, or in the call's path, as any one segment", () => {
    const repos = services({ basePaths: true }).map((r) =>
      r.basePath ? { ...r, basePath: r.basePath.replace("/forge/", "/{tenant}/") } : r,
    );
    repos[0] = {
      ...repos[0]!,
      facts: [
        call("forge-web", "call.get.acme-limits-ping", {
          method: "GET",
          path: "/acme/limits/ping",
          host: "apps.ocp.forge.internal",
        }),
        call("forge-web", "call.get.tenant-wallets-ping", {
          method: "GET",
          path: "/{tenantId}/wallets/ping",
          host: "apps.ocp.forge.internal",
        }),
      ],
    };
    const out = joinFacts({ repos });
    const to = (id: string) => out.joins.find((j) => j.call.fact === id)?.entry.repo;
    expect(to("call.get.acme-limits-ping")).toBe("forge-limits");
    expect(to("call.get.tenant-wallets-ping")).toBe("forge-wallets");
    expect(out.asks).toEqual([]);
  });

  it("without base paths, joins what only one repo serves and asks about the rest", () => {
    const out = joinFacts({ repos: services({ basePaths: false }) });
    expect(
      out.joins.find((j) => j.call.fact === "call.get.forge-limits-limits-id")?.entry,
    ).toMatchObject({ repo: "forge-limits" });
    expect(out.asks.map((a) => [a.call.fact, a.reason])).toEqual([
      ["call.get.forge-limits-ping", "ambiguous"],
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
    // J2: each call left to a system outside the estate is listed, so a write can count them.
    expect(out.outside?.map((o) => `${o.call.fact} ${o.target}`)).toEqual([
      "c-host northwind-tags",
      "c-pay Northwind Pay",
    ]);
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

/**
 * F2 (honest link confidence): a join nobody named is a guess, whatever the two ends' facts say.
 * The path fallback and a host whose first label happens to be a component's name are marked
 * inferred on the Interface, with a flag saying how the callee was found.
 */
describe("joinFacts: an answer that names nothing binds (F3)", () => {
  const repos: JoinRepo[] = [
    {
      repo: "forge-notes",
      facts: [
        call("forge-notes", "c-tags", {
          component: "forge-notes-web",
          method: "GET",
          path: "/api/tags",
        }),
      ],
    },
    {
      repo: "forge-archive",
      facts: [entry("forge-archive", "e-tags", { method: "GET", path: "/api/tags" })],
    },
  ];
  it("never joins by path a call a person said nothing in the estate answers", () => {
    expect(joinFacts({ repos }).joins).toHaveLength(1);
    const out = joinFacts({ repos, targets: { "forge-notes": { "c-tags": NO_TARGET } } });
    expect(out.joins).toEqual([]);
    expect(out.asks).toEqual([]);
  });

  it("keeps a call to an outside system it names out of the path join", () => {
    const named: JoinRepo[] = [
      {
        ...repos[0]!,
        facts: [
          call("forge-notes", "c-tags", {
            component: "forge-notes-web",
            method: "GET",
            path: "/api/tags",
            to: "Forge Risk Team",
          }),
        ],
      },
      repos[1]!,
    ];
    expect(joinFacts({ repos: named, outside: ["forge-risk-team"] }).joins).toEqual([]);
  });

  it("lists a call a person answered with a system outside the estate as outside (J2)", () => {
    const out = joinFacts({ repos, targets: { "forge-notes": { "c-tags": "Northwind Pay" } } });
    expect(out.joins).toEqual([]);
    expect(out.outside?.map((o) => `${o.call.fact} ${o.target}`)).toEqual(["c-tags Northwind Pay"]);
  });
});

/**
 * O1: a hosts question answered "an outside system (new)" declares a system with the host as its
 * alias; a call on that host keeps it (no question, no guess by a first label), unless the
 * manifest lists the host under a repo.
 */
describe("joinFacts: a call on a host an outside system names (O1)", () => {
  const repos: JoinRepo[] = [
    {
      repo: "forge-notes",
      facts: [
        call("forge-notes", "c-tags", {
          component: "forge-notes-web",
          method: "GET",
          path: "/api/tags",
          host: "forge-archive.tidewater.example",
        }),
      ],
    },
    {
      repo: "forge-archive",
      component: "forge-archive",
      facts: [entry("forge-archive", "e-tags", { method: "GET", path: "/api/tags" })],
    },
  ];
  it("is left to the outside system, not asked and not joined by the host's first label", () => {
    const before = joinFacts({ repos });
    expect(before.joins.map((j) => j.byLabel)).toEqual([true]);
    const out = joinFacts({ repos, outside: ["forge-archive-tidewater-example"] });
    expect(out.joins).toEqual([]);
    expect(out.asks).toEqual([]);
  });

  it("joins the repo the manifest lists the host under, whatever the profile says", () => {
    const listed = [repos[0]!, { ...repos[1]!, hosts: ["forge-archive.tidewater.example"] }];
    const out = joinFacts({ repos: listed, outside: ["forge-archive-tidewater-example"] });
    expect(out.joins.map((j) => j.how)).toEqual(["host"]);
  });
});

describe("callHostOf: the host a call goes to, as the join reads it (P1)", () => {
  const c = (o: Record<string, unknown>) =>
    call("forge-notes", "c-x", { method: "GET", path: "/api/x", ...o }) as Fact & {
      kind: "call";
    };
  const cfg = (key: string, v: Record<string, unknown>): Fact =>
    ({
      kind: "config",
      id: `cfg-${key}`,
      repo: "forge-notes",
      commit: "abc1234",
      settingKind: "config",
      key,
      ...v,
      cite: { file: "application.yml", line: 1, value: key },
      verified: "line",
      by: "assistant",
      conf: "declared",
    }) as Fact;
  it("takes the call's host, else its base's config value, else the base itself", () => {
    expect(callHostOf(c({ host: "https://api.lanternmail.example/v1" }), [])).toBe(
      "api.lanternmail.example",
    );
    const facts = [cfg("forge.lantern.url", { value: "http://mail.forge.internal:8025" })];
    expect(callHostOf(c({ base: "forge.lantern.url" }), facts)).toBe("mail.forge.internal:8025");
    // A ${PLACEHOLDER} names no host in the repo, and a config key is never read as one (J0).
    const held = [cfg("forge.notify.url", { source: "${NOTIFY_URL}" })];
    expect(callHostOf(c({ base: "forge.notify.url" }), held)).toBeUndefined();
    expect(callHostOf(c({ base: "notify.forge.internal" }), [])).toBe("notify.forge.internal");
    expect(callHostOf(c({}), [])).toBeUndefined();
  });
});

describe("joinRecords: a guessed join is inferred, with how it was found (F2)", () => {
  it("marks a join by path inferred and flags it joined-by-path", () => {
    const repos: JoinRepo[] = [
      {
        repo: "forge-notes",
        facts: [
          call("forge-notes", "c-tags", {
            component: "forge-notes-web",
            method: "GET",
            path: "/api/tags",
          }),
        ],
      },
      {
        repo: "forge-archive",
        facts: [entry("forge-archive", "e-tags", { method: "GET", path: "/api/tags" })],
      },
    ];
    const ifaces = joinRecords(joinFacts({ repos }), repos).filter((r) => r.kind === "Interface");
    expect(ifaces).toHaveLength(1);
    expect(ifaces[0]).toMatchObject({ confidence: "inferred", flags: ["joined-by-path"] });
  });

  it("marks a join by a host's first label inferred and flags it joined-by-label", () => {
    const repos: JoinRepo[] = [
      {
        repo: "forge-web",
        facts: [
          call("forge-web", "c-limits", {
            component: "forge-web",
            method: "GET",
            path: "/limits/{id}",
            host: "forge-limits.apps.forge.internal",
          }),
        ],
      },
      {
        repo: "forge-limits",
        facts: [entry("forge-limits", "e-limit", { method: "GET", path: "/limits/{limitId}" })],
      },
    ];
    const out = joinFacts({ repos });
    expect(out.joins).toHaveLength(1);
    const ifaces = joinRecords(out, repos).filter((r) => r.kind === "Interface");
    expect(ifaces[0]).toMatchObject({
      to: "forge-limits",
      confidence: "inferred",
      flags: ["joined-by-label"],
    });
  });

  it("keeps a join by a named target verified, flagged how (C1: never a gap)", () => {
    const repos: JoinRepo[] = [
      {
        repo: "forge-web",
        facts: [
          call("forge-web", "c-limits", {
            component: "forge-web",
            method: "GET",
            path: "/limits/{id}",
            to: "forge-limits",
          }),
        ],
      },
      {
        repo: "forge-limits",
        facts: [entry("forge-limits", "e-limit", { method: "GET", path: "/limits/{limitId}" })],
      },
    ];
    const iface = joinRecords(joinFacts({ repos }), repos).find((r) => r.kind === "Interface");
    expect(iface).toMatchObject({ confidence: "verified", flags: ["joined-by-repo"] });
  });
});

describe("joinRecords: every Interface says how it was joined (C1, ADR 0135)", () => {
  const callee: JoinRepo = {
    repo: "forge-limits",
    component: "forge-limits",
    hosts: ["limits.forge.example"],
    facts: [entry("forge-limits", "e-limit", { method: "GET", path: "/limits/{limitId}" })],
  };
  const caller = (extra: Record<string, unknown>): JoinRepo => ({
    repo: "forge-web",
    facts: [
      call("forge-web", "c-limits", {
        component: "forge-web",
        method: "GET",
        path: "/limits/{id}",
        ...extra,
      }),
    ],
  });
  const flagsOf = (repos: JoinRepo[], targets?: Record<string, Record<string, string>>) => {
    const out = joinFacts({ repos, ...(targets ? { targets } : {}) });
    const i = joinRecords(out, repos).find((r) => r.kind === "Interface");
    return i && "flags" in i ? i.flags : undefined;
  };

  it("flags a join a person's answer made joined-by-answer", () => {
    expect(flagsOf([caller({}), callee], { "forge-web": { "c-limits": "forge-limits" } })).toEqual([
      "joined-by-answer",
    ]);
  });

  it("flags a join by the component the call names joined-by-name", () => {
    expect(flagsOf([caller({ to: "limits-api" }), { ...callee, component: "limits-api" }])).toEqual(
      ["joined-by-name"],
    );
  });

  it("flags a join by the repo the call names joined-by-repo", () => {
    expect(
      flagsOf([caller({ to: "forge-limits" }), { ...callee, component: "limits-api" }]),
    ).toEqual(["joined-by-repo"]);
  });

  it("flags a join by a host the manifest lists joined-by-host", () => {
    expect(flagsOf([caller({ host: "limits.forge.example" }), callee])).toEqual(["joined-by-host"]);
  });

  it("flags a join of a publish to its listener with nothing: via says it", () => {
    const repos: JoinRepo[] = [
      {
        repo: "forge-web",
        facts: [
          call("forge-web", "c-pub", {
            component: "forge-web",
            callType: "event-topic",
            method: "publish",
            path: "forge.limits.changed",
          }),
        ],
      },
      {
        repo: "forge-limits",
        facts: [
          entry("forge-limits", "e-sub", {
            entryType: "event-topic",
            path: "forge.limits.changed",
          }),
        ],
      },
    ];
    expect(flagsOf(repos)).toBeUndefined();
  });

  it("names every guess in JOIN_GUESS_FLAGS, and none of them says how", () => {
    expect([...JOIN_GUESS_FLAGS].sort()).toEqual([
      "joined-by-folder-name",
      "joined-by-label",
      "joined-by-path",
      "joined-by-platform-setting",
      "joined-despite-conflict",
    ]);
    for (const g of JOIN_GUESS_FLAGS) expect(JOIN_HOW_FLAGS.has(g)).toBe(false);
  });

  it("names every flag that says how in JOIN_HOW_FLAGS, apart from the guesses", () => {
    expect([...JOIN_HOW_FLAGS].sort()).toEqual([
      "declared-caller",
      "joined-by-answer",
      "joined-by-host",
      "joined-by-name",
      "joined-by-repo",
    ]);
  });
});

describe("joinFacts: a person's target outranks every join rule (C2, ADR 0135)", () => {
  it("leaves a call a person sent outside the estate unjoined, though a repo lists its host", () => {
    const repos: JoinRepo[] = [
      {
        repo: "forge-web",
        facts: [
          call("forge-web", "c-limits", {
            component: "forge-web",
            method: "GET",
            path: "/limits/{id}",
            host: "limits.forge.example",
            to: "Northwind Pay",
            by: "person",
            verified: "person",
          }),
        ],
      },
      {
        repo: "forge-limits",
        component: "forge-limits",
        hosts: ["limits.forge.example"],
        facts: [entry("forge-limits", "e-limit", { method: "GET", path: "/limits/{limitId}" })],
      },
    ];
    const out = joinFacts({ repos });
    expect(out.joins).toEqual([]);
    expect(out.asks).toEqual([]);
  });

  it("never joins a person's outside target by path", () => {
    const repos: JoinRepo[] = [
      {
        repo: "forge-web",
        facts: [
          call("forge-web", "c-tags", {
            component: "forge-web",
            method: "GET",
            path: "/api/tags",
            to: "Northwind Pay",
            by: "person",
            verified: "person",
          }),
        ],
      },
      {
        repo: "forge-archive",
        facts: [entry("forge-archive", "e-tags", { method: "GET", path: "/api/tags" })],
      },
    ];
    expect(joinFacts({ repos }).joins).toEqual([]);
  });

  it("joins a person's target in the estate by its name, whatever the host says", () => {
    const repos: JoinRepo[] = [
      {
        repo: "forge-web",
        facts: [
          call("forge-web", "c-limits", {
            component: "forge-web",
            method: "GET",
            path: "/limits/{id}",
            host: "limits.forge.example",
            to: "forge-quotas",
            by: "person",
            verified: "person",
          }),
        ],
      },
      {
        repo: "forge-limits",
        component: "forge-limits",
        hosts: ["limits.forge.example"],
        facts: [entry("forge-limits", "e-limit", { method: "GET", path: "/limits/{limitId}" })],
      },
      {
        repo: "forge-quotas",
        component: "forge-quotas",
        facts: [entry("forge-quotas", "e-q", { method: "GET", path: "/limits/{limitId}" })],
      },
    ];
    const out = joinFacts({ repos });
    expect(out.joins.map((j) => [j.entry.repo, j.how])).toEqual([["forge-quotas", "repo"]]);
  });

  /** A call whose base is set per environment to hosts two repos answer on (J0, A-gateway). */
  const perEnvironment = (extra: Record<string, unknown>): JoinRepo[] => {
    const setting = (id: string, env: string, value: string, line: number): Fact =>
      ({
        kind: "config",
        id,
        repo: "forge-web",
        commit: "4444ddd",
        key: "limits.url",
        value,
        env,
        cite: { file: `src/main/resources/application-${env}.yml`, line, value: "limits.url" },
        verified: "line",
        by: "assistant",
        conf: "declared",
      }) as Fact;
    return [
      {
        repo: "forge-web",
        component: "forge-web",
        facts: [
          call("forge-web", "c-limits", {
            method: "GET",
            path: "/limits/{id}",
            base: "limits.url",
            ...extra,
          }),
          setting("cfg-limits-dev", "dev", "https://limits-a.forge.example", 3),
          setting("cfg-limits-prod", "prod", "https://limits-b.forge.example", 4),
        ],
      },
      {
        repo: "forge-a",
        component: "forge-a",
        hosts: ["limits-a.forge.example"],
        facts: [entry("forge-a", "e-limit", { method: "GET", path: "/limits/{limitId}" })],
      },
      {
        repo: "forge-b",
        component: "forge-b",
        hosts: ["limits-b.forge.example"],
        facts: [entry("forge-b", "e-limit", { method: "GET", path: "/limits/{limitId}" })],
      },
    ];
  };

  it("asks which host is meant when nobody named the target (the case the next ones outrank)", () => {
    const out = joinFacts({ repos: perEnvironment({}) });
    expect(out.asks.map((a) => a.reason)).toEqual(["ambiguous"]);
  });

  it("doesn't ask which of two environments' hosts is meant when a person sent the call outside", () => {
    const out = joinFacts({
      repos: perEnvironment({ to: "Northwind Pay", by: "person", verified: "person" }),
    });
    expect(out.asks).toEqual([]);
    expect(out.joins).toEqual([]);
    expect(out.misses).toEqual([]);
    // and the call is listed outside with the person's target, as an answer naming a vendor is
    expect(out.outside).toEqual([
      {
        call: expect.objectContaining({ repo: "forge-web", fact: "c-limits" }),
        target: "Northwind Pay",
      },
    ]);
  });

  it("lists a person-corrected vendor call outside, as it lists a person's answer naming one", () => {
    const corrected = joinFacts({
      repos: perEnvironment({ to: "Northwind Pay", by: "person", verified: "person" }),
    }).outside;
    const answered = joinFacts({
      repos: perEnvironment({}),
      targets: { "forge-web": { "c-limits": "Northwind Pay" } },
    }).outside;
    expect(corrected).toEqual(answered);
  });

  it("lists outside a person's vendor target on a call whose host a repo lists", () => {
    const out = joinFacts({
      repos: [
        {
          repo: "forge-web",
          facts: [
            call("forge-web", "c-limits", {
              component: "forge-web",
              method: "GET",
              path: "/limits/{id}",
              host: "limits.forge.example",
              to: "Northwind Pay",
              by: "person",
              verified: "person",
            }),
          ],
        },
        {
          repo: "forge-limits",
          component: "forge-limits",
          hosts: ["limits.forge.example"],
          facts: [entry("forge-limits", "e-limit", { method: "GET", path: "/limits/{limitId}" })],
        },
      ],
    });
    expect(out.outside?.map((o) => [o.call.fact, o.target])).toEqual([
      ["c-limits", "Northwind Pay"],
    ]);
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
