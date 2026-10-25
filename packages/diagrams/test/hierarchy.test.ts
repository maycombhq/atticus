import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, type CatalogRecord } from "@maycombhq/core";
import { buildEstate, focusView, nodeView, viewKey } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");

function forge(extra: Record<string, unknown>[] = []): CatalogRecord[] {
  const raw = parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[];
  return [...raw, ...extra].map((r) => {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
    if (!p.ok) throw new Error(`${String(r.id)}: ${JSON.stringify(p.issues)}`);
    return p.record;
  });
}

const ev = [{ source: "config", repo: "forge-portal-bff", path: "pom.xml", line: 3 }];
/** Three modules of one repo: a uses b, b uses c, a uses c (a's use of c is implied). */
const modules = [
  {
    kind: "Component",
    id: "portal-core",
    confidence: "verified",
    system: "portal",
    repo: "forge-portal-bff",
    type: "library",
    evidence: ev,
  },
  {
    kind: "Component",
    id: "portal-web",
    confidence: "verified",
    system: "portal",
    repo: "forge-portal-bff",
    type: "library",
    uses: ["portal-core"],
    evidence: ev,
  },
  {
    kind: "Component",
    id: "portal-app",
    confidence: "verified",
    system: "portal",
    repo: "forge-portal-bff",
    type: "library",
    uses: ["portal-web", "portal-core"],
    evidence: ev,
  },
];

const ids = (ns: { id: string }[]) => ns.map((n) => n.id);
const edge = (v: { edges: { from: string; to: string; type: string; count: number }[] }) =>
  v.edges.map((e) => `${e.from} ${e.type} ${e.to}${e.count > 1 ? ` x${e.count}` : ""}`).sort();

describe("the estate as a hierarchy: estate, system, repo, component, element", () => {
  it("opens the estate on its systems, each with its children counted and its evidence", () => {
    const v = nodeView(buildEstate(forge()), "estate", { lens: "architecture" });
    expect(v.node).toMatchObject({ id: "estate", kind: "estate", label: "Estate" });
    expect(v.path).toEqual([]);
    expect(ids(v.children)).toEqual([
      "system:audit",
      "system:ledger",
      "system:northwind-pay",
      "system:portal",
      "system:reports",
    ]);
    const portal = v.children.find((n) => n.id === "system:portal")!;
    expect(portal).toMatchObject({
      kind: "system",
      label: "Portal",
      parent: "estate",
      childCount: 2,
      state: "current",
      gaps: [],
      record: { kind: "System", id: "portal" },
      next: { command: "atticus guide portal" },
    });
    expect(portal.evidence).toEqual([
      { source: "config", repo: "forge-portal-bff", at: "pom.xml" },
    ]);
    // The inferred system is flagged as a gap: nothing in its own code was read.
    expect(v.children.find((n) => n.id === "system:audit")!.gaps).toContain("inferred");
  });

  it("merges the calls between systems into one edge each, with a count", () => {
    const v = nodeView(buildEstate(forge()), "estate", { lens: "architecture" });
    expect(edge(v)).toEqual([
      "system:ledger calls system:northwind-pay",
      "system:ledger subscribes system:portal",
      "system:portal calls system:audit",
      "system:portal calls system:ledger x2",
      "system:reports reads system:ledger",
      "system:reports subscribes system:ledger",
    ]);
    const calls = v.edges.find((e) => e.from === "system:portal" && e.to === "system:ledger")!;
    expect(calls).toMatchObject({ type: "calls", sync: "sync", via: "gateway", state: "current" });
    expect(calls.evidence).toContainEqual({
      source: "code",
      repo: "forge-portal-bff",
      at: "src/main/java/forge/portal/LedgerClient.java:8",
    });
  });

  it("opens a system on its repos, a repo on its components and a component on its elements", () => {
    const est = buildEstate(forge());
    const sys = nodeView(est, "system:portal", { lens: "architecture" });
    expect(ids(sys.path)).toEqual(["estate"]);
    expect(ids(sys.children)).toEqual(["repo:forge-portal-bff", "repo:forge-portal-ui"]);
    // Inside the system, the UI's repo calls the BFF's repo; outside, the BFF calls three systems.
    expect(edge(sys)).toEqual([
      "repo:forge-portal-bff calls system:audit",
      "repo:forge-portal-bff calls system:ledger x2",
      "repo:forge-portal-ui calls repo:forge-portal-bff",
      "system:ledger subscribes repo:forge-portal-bff",
    ]);
    expect(ids(sys.outside)).toEqual(["system:audit", "system:ledger"]);

    const repo = nodeView(est, "repo:forge-portal-bff", { lens: "architecture" });
    expect(ids(repo.path)).toEqual(["estate", "system:portal"]);
    expect(ids(repo.children)).toEqual(["component:portal-bff"]);

    const comp = nodeView(est, "component:portal-bff", { lens: "architecture" });
    expect(ids(comp.children)).toEqual([
      "endpoint:portal-bff.get-balance",
      "topic:topic.payments-initiated",
      "client:portal-bff.audit-svc",
      "client:portal-bff.ledger-api",
    ]);
    const ep = comp.children[0]!;
    expect(ep).toMatchObject({
      kind: "endpoint",
      label: "GET /api/balance/{accountId}",
      childCount: 0,
      properties: { endpointType: "rest", method: "GET" },
      next: { command: "atticus impact portal-bff.get-balance" },
    });
    expect(ep.evidence[0]!.at).toBe("src/main/java/forge/portal/BalanceController.java:12");
    expect(edge(comp)).toContain("client:portal-bff.ledger-api calls system:ledger x2");
    expect(edge(comp)).toContain("repo:forge-portal-ui calls endpoint:portal-bff.get-balance");
  });

  it("loads more than one level when asked, each child naming its parent", () => {
    const v = nodeView(buildEstate(forge()), "system:ledger", { lens: "architecture", depth: 2 });
    expect(ids(v.children)).toEqual(["repo:forge-ledger", "component:ledger-api"]);
    expect(v.children[1]!.parent).toBe("repo:forge-ledger");
  });

  it("marks a gap where the catalog is missing a part: a component with no repo", () => {
    const v = nodeView(buildEstate(forge()), "system:audit", { lens: "architecture" });
    expect(ids(v.children)).toEqual(["component:audit-svc"]);
    expect(v.children[0]!.gaps).toEqual(expect.arrayContaining(["inferred", "no-repo"]));
  });

  it("refuses a node it doesn't have", () => {
    expect(() =>
      nodeView(buildEstate(forge()), "system:nowhere", { lens: "architecture" }),
    ).toThrow(/There is no node system:nowhere/);
  });
});

describe("an estate read from facts, with no System record (a real metarepo, 2026-10-25)", () => {
  // As atticus verify --write projects one repo's facts: its components carry the system the
  // manifest names, and a call names an outside system (a model provider) no component is.
  const studio = () => {
    const at = (path: string, line: number) => [
      { source: "code", repo: "forge-studio", path, line, by: "assistant" },
    ];
    return [
      {
        kind: "Component",
        id: "api",
        confidence: "verified",
        system: "studio",
        repo: "forge-studio",
        type: "service",
        evidence: at("api/src/main/java/forge/studio/NotesController.java", 15),
      },
      {
        kind: "Component",
        id: "web",
        confidence: "verified",
        system: "studio",
        repo: "forge-studio",
        type: "spa",
        evidence: at("web/src/app/app.routes.ts", 5),
      },
      {
        kind: "Interface",
        id: "if-227370d7866959d3",
        confidence: "verified",
        from: "api",
        to: "llm",
        via: "direct",
        method: "POST",
        normalizedPath: "/v1/messages",
        sync: "sync",
        direction: "outbound",
        conflicts: [],
        evidence: at("api/src/main/java/forge/studio/SummaryClient.java", 9),
      },
    ].map((r) => {
      const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
      if (!p.ok) throw new Error(`${r.id}: ${JSON.stringify(p.issues)}`);
      return p.record;
    });
  };

  it("draws the system the components name, and the outside system a call names", () => {
    const est = buildEstate(studio());
    const v = nodeView(est, "estate", { lens: "architecture" });
    expect(ids(v.children)).toEqual(["system:llm", "system:studio"]);
    expect(v.node.next?.command).toMatch(/^atticus map /);
    const sys = v.children.find((n) => n.id === "system:studio")!;
    expect(sys).toMatchObject({ kind: "system", label: "studio", childCount: 1, gaps: [] });
    expect(sys.record).toBeUndefined();
    const llm = v.children.find((n) => n.id === "system:llm")!;
    expect(llm).toMatchObject({
      kind: "system",
      label: "llm",
      childCount: 0,
      properties: { boundary: "outside" },
      next: { command: 'atticus query "kind:interface to:llm"' },
    });
    expect(edge(v)).toEqual(["system:studio calls system:llm"]);
    const repo = nodeView(est, "repo:forge-studio", { lens: "architecture" });
    expect(ids(repo.path)).toEqual(["estate", "system:studio"]);
    expect(repo.node.gaps).toEqual([]);
    expect(repo.node.next?.command).toBe("atticus map forge-studio");
    expect(JSON.stringify([...est.nodes.values()])).not.toMatch(/atticus scan/);
  });
});

describe("lenses on the same model", () => {
  it("the data lens shows only what holds or touches data, and suggests focus on tables", () => {
    const est = buildEstate(forge());
    const v = nodeView(est, "estate", { lens: "data" });
    expect(ids(v.children)).toEqual(["system:ledger", "system:reports"]);
    const store = nodeView(est, "store:ledger-db", { lens: "data" });
    expect(ids(store.path)).toEqual([
      "estate",
      "system:ledger",
      "repo:forge-ledger",
      "component:ledger-api",
    ]);
    expect(ids(store.children)).toEqual(["table:ledger-db.account", "table:ledger-db.entry"]);
    expect(edge(store)).toEqual([
      "component:ledger-api reads table:ledger-db.account",
      "component:ledger-api reads table:ledger-db.entry",
      "component:ledger-api writes table:ledger-db.account",
      "component:ledger-api writes table:ledger-db.entry",
      "system:reports reads table:ledger-db.entry",
      "table:ledger-db.entry references table:ledger-db.account",
    ]);
    expect(store.suggest).toEqual({ mode: "focus", id: "table:ledger-db.account" });
  });

  it("the integration lens keeps calls and topics; the infrastructure lens deployments", () => {
    const est = buildEstate(forge());
    const i = nodeView(est, "estate", { lens: "integration" });
    expect(edge(i).every((e) => / (calls|publishes|subscribes) /.test(e))).toBe(true);
    const inf = nodeView(est, "estate", { lens: "infrastructure" });
    expect(ids(inf.children)).toEqual(["system:ledger", "system:portal", "environment:prod"]);
    expect(edge(inf)).toEqual([
      "system:ledger deployed-to environment:prod",
      "system:portal deployed-to environment:prod",
    ]);
    const c = nodeView(est, "component:ledger-api", { lens: "infrastructure" });
    expect(ids(c.children)).toEqual(["deployment:ledger-api.prod"]);
    expect(c.children[0]!.properties).toMatchObject({
      env: "prod",
      platform: "kubernetes",
      replicas: 3,
    });
  });
});

describe("the spike's rules", () => {
  it("draws the transitive reduction of 'uses' by default, every edge with all", () => {
    const est = buildEstate(forge(modules));
    const v = nodeView(est, "repo:forge-portal-bff", { lens: "architecture" });
    const uses = edge(v).filter((e) => e.includes(" uses "));
    expect(uses).toEqual([
      "component:portal-app uses component:portal-web",
      "component:portal-web uses component:portal-core",
    ]);
    expect(v.reduced).toBe(true);
    expect(v.hiddenEdges).toBe(1);
    const all = nodeView(est, "repo:forge-portal-bff", { lens: "architecture", all: true });
    expect(edge(all).filter((e) => e.includes(" uses "))).toHaveLength(3);
    expect(all.reduced).toBe(false);
    expect(all.hiddenEdges).toBe(0);
  });

  it("focus: a table and its direct neighbours, with the edges between them", () => {
    const v = focusView(buildEstate(forge()), "table:ledger-db.entry", { lens: "data" });
    expect(v.node.id).toBe("table:ledger-db.entry");
    expect(ids(v.neighbours)).toEqual([
      "component:ledger-api",
      "component:reports-job",
      "table:ledger-db.account",
    ]);
    expect(edge(v)).toEqual([
      "component:ledger-api reads table:ledger-db.account",
      "component:ledger-api reads table:ledger-db.entry",
      "component:ledger-api writes table:ledger-db.account",
      "component:ledger-api writes table:ledger-db.entry",
      "component:reports-job reads table:ledger-db.entry",
      "table:ledger-db.entry references table:ledger-db.account",
    ]);
  });

  it("gives the same answer whatever order the records come in", () => {
    const rs = forge(modules);
    const back = [...rs].reverse();
    for (const id of ["estate", "system:portal", "component:portal-bff", "store:ledger-db"])
      expect(nodeView(buildEstate(back), id, { lens: "repo" })).toEqual(
        nodeView(buildEstate(rs), id, { lens: "repo" }),
      );
  });
});

describe("view keys name a layout file", () => {
  it("is a slug made of the lens and the node", () => {
    expect(viewKey("architecture", "estate")).toBe("architecture.estate");
    expect(viewKey("data", "table:ledger-db.entry", "focus")).toBe(
      "data.focus.table-ledger-db.entry",
    );
  });
});
