import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  declarableGateways,
  declarableRoutes,
  declaredRouteMatches,
  declareLink,
  DeclareError,
  joinCallers,
  joinFacts,
  type Fact,
  type JoinRepo,
} from "../src/index.js";

/**
 * ADR 0200: the gateway routes a person can declare a caller of, listed to pick from, and
 * several declared in one write. On the invented Forge estate: forge-edge (a gateway repo),
 * forge-ledger (an ordinary service), forge-studio (a service with one proxy bundle folder) and
 * Harbor Audit, another team's system no repo of the estate is in.
 */

const entry = (
  repo: string,
  id: string,
  method: string | undefined,
  path: string,
  file: string,
  line: number,
  handler?: string,
): Fact =>
  ({
    kind: "entry",
    id,
    repo,
    commit: "c0ffee1",
    entryType: "rest",
    ...(method ? { method } : {}),
    path,
    ...(handler ? { handler } : {}),
    cite: { file, line, value: path, quote: path },
    verified: "line",
    by: "assistant",
    conf: "declared",
  }) as Fact;

const EDGE = "apiproxy/proxies/default.xml";
const repos: JoinRepo[] = [
  {
    repo: "forge-edge",
    gateway: true,
    facts: [
      entry(
        "forge-edge",
        "entry.post.audit",
        "POST",
        "/edge/audit/v1/events",
        EDGE,
        9,
        "edge/Post",
      ),
      entry(
        "forge-edge",
        "entry.get.audit",
        "GET",
        "/edge/audit/v1/events/{id}",
        EDGE,
        4,
        "edge/Get",
      ),
      entry("forge-edge", "entry.any.health", undefined, "/edge/health", EDGE, 14),
    ],
  },
  {
    repo: "forge-edge-partner",
    gateway: true,
    facts: [
      // The same words as a route of forge-edge: a declaration by METHOD /path lands on both.
      entry(
        "forge-edge-partner",
        "entry.post.audit",
        "POST",
        "/edge/audit/v1/events",
        "routes.yaml",
        3,
        "partner/Post",
      ),
    ],
  },
  {
    repo: "forge-ledger",
    facts: [entry("forge-ledger", "entry.get.accounts", "GET", "/accounts", "src/Api.java", 12)],
  },
  {
    repo: "forge-studio",
    facts: [
      entry("forge-studio", "entry.get.themes", "GET", "/themes", "src/Api.java", 5),
      entry("forge-studio", "entry.get.proxy", "GET", "/studio/v1/themes", EDGE, 3, "studio/Get"),
    ],
  },
];

describe("the gateway routes a caller can be declared on (ADR 0200)", () => {
  it("lists a gateway repo's routes by path then method, with the handler, where it is read, and the words to declare", () => {
    const v = declarableRoutes({ repos, repo: "forge-edge", declared: [] });
    expect(v.gateway).toBe(true);
    expect(v.routes).toEqual([
      // The same METHOD /path is a route of forge-edge-partner too: the handler names only this one.
      {
        id: "entry.post.audit",
        method: "POST",
        path: "/edge/audit/v1/events",
        handler: "edge/Post",
        at: `${EDGE}:9`,
        say: "edge/Post",
      },
      {
        id: "entry.get.audit",
        method: "GET",
        path: "/edge/audit/v1/events/{id}",
        handler: "edge/Get",
        at: `${EDGE}:4`,
        say: "GET /edge/audit/v1/events/{id}",
      },
      // No method read: the join takes ANY for it.
      { id: "entry.any.health", path: "/edge/health", at: `${EDGE}:14`, say: "ANY /edge/health" },
    ]);
  });

  it("marks the routes the system declared already, by the route's words or its handler", () => {
    const v = declarableRoutes({
      repos,
      repo: "forge-edge",
      declared: ["get /edge/audit/v1/events/{id}/", "EDGE/post"],
    });
    expect(v.routes.map((r) => [r.id, r.declared ?? false])).toEqual([
      ["entry.post.audit", true],
      ["entry.get.audit", true],
      ["entry.any.health", false],
    ]);
  });

  it("says an ordinary service has no gateway route, with how many entries it has", () => {
    expect(declarableRoutes({ repos, repo: "forge-ledger", declared: [] })).toEqual({
      gateway: false,
      routes: [],
      entries: 1,
    });
  });

  it("takes the entries under a proxy bundle folder of any repo as routes, and only those", () => {
    const v = declarableRoutes({ repos, repo: "forge-studio", declared: [] });
    expect(v.gateway).toBe(true);
    expect(v.routes.map((r) => r.say)).toEqual(["GET /studio/v1/themes"]);
    expect(v.entries).toBe(2);
    // Another estate's own folders (the conventions): none of forge-studio's files is under one.
    expect(
      declarableRoutes({ repos, repo: "forge-studio", declared: [], bundleFolders: ["gw"] })
        .gateway,
    ).toBe(false);
  });

  it("where two routes share METHOD /path and no handler tells them apart, says which other repo it lands on too", () => {
    const twins: JoinRepo[] = [
      {
        repo: "forge-edge",
        gateway: true,
        facts: [entry("forge-edge", "e1", "GET", "/x", EDGE, 1)],
      },
      {
        repo: "forge-edge-b",
        gateway: true,
        facts: [entry("forge-edge-b", "e1", "GET", "/x", EDGE, 1)],
      },
    ];
    expect(declarableRoutes({ repos: twins, repo: "forge-edge", declared: [] }).routes).toEqual([
      {
        id: "e1",
        method: "GET",
        path: "/x",
        at: `${EDGE}:1`,
        say: "GET /x",
        also: ["forge-edge-b"],
      },
    ]);
  });

  it("lists the repos that have gateway routes, by id, with how many", () => {
    expect(declarableGateways({ repos })).toEqual([
      { repo: "forge-edge", routes: 3 },
      { repo: "forge-edge-partner", routes: 1 },
      { repo: "forge-studio", routes: 1 },
    ]);
  });

  it("offers only words the join places on that very route", () => {
    const join = joinFacts({ repos });
    for (const r of repos) {
      for (const route of declarableRoutes({ repos, repo: r.repo, declared: [] }).routes) {
        const got = joinCallers({
          repos,
          join,
          declared: [
            {
              system: "harbor-audit",
              name: "Harbor Audit",
              boundary: "internal",
              route: route.say,
              source: "profiles/forge/profile.yaml",
            },
          ],
        });
        expect(got.problems).toEqual([]);
        const on = got.routes.filter((x) => x.declared.length).map((x) => x.route);
        expect(on.some((x) => x.repo === r.repo && x.fact === route.id)).toBe(true);
        expect(
          on
            .filter((x) => !(x.repo === r.repo && x.fact === route.id))
            .map((x) => x.repo)
            .sort(),
        ).toEqual(route.also ?? []);
      }
    }
  });

  it("matches a declared route as the join does", () => {
    const e = { method: "POST", path: "/a/b/", handler: "p/Flow" };
    expect(declaredRouteMatches(e, "post /a/b")).toBe(true);
    expect(declaredRouteMatches(e, "P/flow")).toBe(true);
    expect(declaredRouteMatches(e, "GET /a/b")).toBe(false);
    expect(declaredRouteMatches({ path: "/h" }, "ANY /h")).toBe(true);
    expect(declaredRouteMatches({ path: "/h" }, "/h")).toBe(false);
  });
});

const PROFILE = `# The Forge profile (invented).
schemaVersion: 1
platform: forge
name: Forge
systems:
  - id: ledger
    name: Ledger
    boundary: product
  - id: harbor-audit
    name: Harbor Audit
    boundary: internal
    owner: team-harbor
    calls:
      - route: GET /edge/health # declared by sam on 2026-11-01
`;
const at = "2026-11-17T09:00:00.000Z";
const metarepo = async () => {
  const root = await mkdtemp(join(tmpdir(), "atticus-declare-many-"));
  await mkdir(join(root, "org-pack/profiles/forge"), { recursive: true });
  await writeFile(join(root, "org-pack/profiles/forge/profile.yaml"), PROFILE);
  return root;
};

describe("several routes declared in one write (ADR 0200)", () => {
  it("writes each route once, in a fixed order whatever order they were picked in, and the preview is what is written", async () => {
    const root = await metarepo();
    const file = join(root, "org-pack/profiles/forge/profile.yaml");
    const d = {
      kind: "call" as const,
      system: "harbor-audit",
      routes: ["POST /edge/audit/v1/events", "edge/Get", " POST /edge/audit/v1/events "],
    };
    const p = await declareLink(root, d, { by: "pat", at, preview: true });
    expect(p.written).toBe(false);
    expect(await readFile(file, "utf8")).toBe(PROFILE);
    const w = await declareLink(root, d, { by: "pat", at });
    expect(w.changes).toEqual(p.changes);
    const other = await metarepo();
    const o = await declareLink(
      other,
      { ...d, routes: ["edge/Get", "POST /edge/audit/v1/events"] },
      { by: "pat", at },
    );
    expect(o.changes).toEqual(w.changes);
    const text = await readFile(file, "utf8");
    expect(text).toContain("# The Forge profile (invented).");
    expect(text).toContain("- route: GET /edge/health # declared by sam on 2026-11-01");
    expect(text.match(/declared by pat on 2026-11-17/g)).toHaveLength(2);
    expect(
      (parse(text) as { systems: { calls?: { route: string }[] }[] }).systems[1]!.calls!.map(
        (c) => c.route,
      ),
    ).toEqual(["GET /edge/health", "POST /edge/audit/v1/events", "edge/Get"]);
  });

  it("refuses the lot, naming each route the profile has already, and writes nothing", async () => {
    const root = await metarepo();
    const e = await declareLink(
      root,
      { kind: "call", system: "harbor-audit", routes: ["GET /edge/health", "edge/Get"] },
      { by: "pat", at },
    ).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DeclareError);
    expect((e as DeclareError).code).toBe("exists");
    expect((e as DeclareError).message).toContain("GET /edge/health");
    expect((e as DeclareError).message).not.toContain("edge/Get");
    expect(await readFile(join(root, "org-pack/profiles/forge/profile.yaml"), "utf8")).toBe(
      PROFILE,
    );
    await expect(
      declareLink(root, { kind: "call", system: "harbor-audit", routes: [" "] }, { by: "pat", at }),
    ).rejects.toMatchObject({ code: "invalid" });
  });
});
