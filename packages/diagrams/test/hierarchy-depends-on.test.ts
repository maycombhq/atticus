import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  interfaceId,
  joinDependencies,
  parseFacts,
  parseRecord,
  type CatalogRecord,
  type Fact,
  type JoinRepo,
} from "@maycombhq/core";
import { buildEstate, focusView, nodeView } from "../src/index.js";

/**
 * A library of the estate's own on the map (ADR 0192): `fixtures/library-deps/` (invented), its
 * dependency join drawn as `depends-on` edges, never merged into the calls or their counts, and
 * the library's own call left the library's.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "../../../fixtures/library-deps");
const facts = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(FIX, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const repos: JoinRepo[] = [
  {
    repo: "forge-payments-common",
    component: "payments-common",
    facts: facts("forge-payments-common"),
  },
  { repo: "forge-ledger", component: "ledger-api", facts: facts("forge-ledger") },
  { repo: "forge-wallets", component: "wallets-api", facts: facts("forge-wallets") },
  { repo: "forge-statements", component: "statements-api", facts: facts("forge-statements") },
];
const dependsOn = joinDependencies({ repos }).links;

const rec = (r: Record<string, unknown>): CatalogRecord => {
  const p = parseRecord({ schemaVersion: 1, status: "current", confidence: "verified", ...r });
  if (!p.ok) throw new Error(`${String(r.id)}: ${JSON.stringify(p.issues)}`);
  return p.record;
};
const component = (id: string, repo: string, system: string) =>
  rec({
    kind: "Component",
    id,
    repo,
    system,
    type: "service",
    evidence: [{ source: "code", repo, path: "pom.xml", line: 1 }],
  });
const records = (): CatalogRecord[] => [
  component("payments-common", "forge-payments-common", "payments"),
  component("ledger-api", "forge-ledger", "ledger"),
  component("statements-api", "forge-statements", "ledger"),
  component("wallets-api", "forge-wallets", "wallets"),
  component("wallets-batch", "forge-wallets", "wallets"),
  // The library's own call, to a vendor's host outside the estate.
  rec({
    kind: "Interface",
    id: interfaceId("payments-common", "northwind-fx", "GET", "/rates/{}"),
    from: "payments-common",
    to: "northwind-fx",
    via: "direct",
    sync: "sync",
    method: "GET",
    normalizedPath: "/rates/{}",
    flags: ["joined-by-name"],
    evidence: [
      {
        source: "code",
        repo: "forge-payments-common",
        path: "src/main/java/forge/payments/common/NorthwindFxClient.java",
        line: 9,
        side: "caller",
      },
    ],
  }),
  // A call the ledger makes to the library's system too, to show the two are kept apart.
  rec({
    kind: "Interface",
    id: interfaceId("ledger-api", "payments-common", "GET", "/fx"),
    from: "ledger-api",
    to: "payments-common",
    via: "direct",
    sync: "sync",
    method: "GET",
    normalizedPath: "/fx",
    flags: ["joined-by-name"],
    evidence: [
      { source: "code", repo: "forge-ledger", path: "src/Fx.java", line: 4, side: "caller" },
    ],
  }),
];
const edges = (v: { edges: { from: string; to: string; type: string; count: number }[] }) =>
  v.edges.map((e) => `${e.from} ${e.type} ${e.to} x${e.count}`).sort();

describe("depends-on edges (ADR 0192)", () => {
  const est = buildEstate(records(), { dependsOn });

  it("draws each service's build dependency on the library as its own edge kind, at system level", () => {
    const v = nodeView(est, "estate", { lens: "architecture" });
    expect(edges(v)).toEqual([
      "system:ledger calls system:payments x1",
      // ledger-api and statements-api: two dependencies, one edge between the systems
      "system:ledger depends-on system:payments x2",
      "system:payments calls system:northwind-fx x1",
      "system:wallets depends-on system:payments x1",
    ]);
  });

  it("never counts a dependency as a call, nor a call as a dependency", () => {
    const v = nodeView(est, "system:ledger", { lens: "architecture", depth: 2 });
    const calls = v.edges.filter((e) => e.type === "calls");
    const deps = v.edges.filter((e) => e.type === "depends-on");
    expect(calls.map((e) => [e.from, e.to, e.count])).toEqual([
      ["component:ledger-api", "system:payments", 1],
    ]);
    expect(deps.map((e) => [e.from, e.to, e.count])).toEqual([
      ["component:ledger-api", "system:payments", 1],
      ["component:statements-api", "system:payments", 1],
    ]);
    expect(calls[0]!.joins!.every((j) => j.how !== "coordinates")).toBe(true);
  });

  it("explains a dependency by its coordinates and the cited lines at both ends", () => {
    const v = nodeView(est, "system:wallets", { lens: "architecture", depth: 2 });
    const e = v.edges.find((x) => x.type === "depends-on")!;
    expect(e).toMatchObject({ from: "component:wallets-api", to: "system:payments", count: 1 });
    expect(e.joins).toEqual([
      {
        interface: "depends-on:forge-wallets/wallets-api>forge-payments-common/payments-common",
        from: "wallets-api",
        to: "payments-common",
        how: "coordinates",
        gateway: false,
        verified: true,
        caller: [
          { source: "code", repo: "forge-wallets", at: "wallets-api/pom.xml:13" },
          { source: "code", repo: "forge-wallets", at: "wallets-api/pom.xml:12" },
        ],
        callee: [
          { source: "code", repo: "forge-payments-common", at: "pom.xml:10" },
          { source: "code", repo: "forge-payments-common", at: "pom.xml:9" },
          { source: "code", repo: "forge-payments-common", at: "pom.xml:11" },
        ],
        hops: [],
        other: [],
        dependency: { group: "forge.payments", name: "forge-payments-common" },
      },
    ]);
    // wallets-batch builds only its tests on the library: no edge from it.
    expect(v.edges.some((x) => x.from === "component:wallets-batch")).toBe(false);
  });

  it("leaves the library's own call the library's, not its dependants'", () => {
    const f = focusView(est, "system:northwind-fx", { lens: "architecture" });
    // the library's own client of the vendor, inside its component
    expect(edges(f)).toEqual(["client:payments-common.northwind-fx calls system:northwind-fx x1"]);
  });

  it("is in the architecture and repo lenses, never the integration or data lens", () => {
    const has = (lens: "architecture" | "repo" | "integration" | "data") =>
      nodeView(est, "estate", { lens }).edges.some((e) => e.type === "depends-on");
    expect([has("architecture"), has("repo"), has("integration"), has("data")]).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  it("draws nothing to a component the catalog doesn't have yet, and nothing without the join", () => {
    const noLib = records().filter(
      (r) =>
        r.id !== "payments-common" && !(r.kind === "Interface" && r.from === "payments-common"),
    );
    const v = nodeView(buildEstate(noLib, { dependsOn }), "estate", { lens: "architecture" });
    expect(v.edges.some((e) => e.type === "depends-on")).toBe(false);
    expect(v.children.some((n) => n.kind === "unknown")).toBe(false);
    const plain = nodeView(buildEstate(records()), "estate", { lens: "architecture" });
    expect(plain.edges.some((e) => e.type === "depends-on")).toBe(false);
  });
});
