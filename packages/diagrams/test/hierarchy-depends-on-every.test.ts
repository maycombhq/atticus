import { describe, expect, it } from "vitest";
import { parseRecord, type CatalogRecord, type DependencyLink } from "@maycombhq/core";
import { buildEstate, dependencyJoin, nodeView } from "../src/index.js";

/**
 * Beta.25 review of ADR 0192: a `depends-on` join lists every dependency fact its link rests on
 * (caller lines from each), and a system-level `depends-on` edge merged from more links than a
 * view lists (20) gives every one when asked (`everyJoin`, GET /api/graph/edge-calls).
 * Invented Forge names only.
 */
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
const end = (repo: string, component: string, fact: string, at: string, lines = [at]) => ({
  repo,
  component,
  fact,
  at,
  lines,
});
const link = (
  from: string,
  facts = [end(`forge-${from}`, from, "dependency.lib", "pom.xml:10")],
): DependencyLink => ({
  from: facts[0]!,
  facts,
  to: end("forge-payments-common", "payments-common", "artifact.lib", "pom.xml:10", [
    "pom.xml:10",
    "pom.xml:9",
  ]),
  group: "forge.payments",
  name: "forge-payments-common",
});

describe("a depends-on join's every dependency fact (beta.25)", () => {
  it("lists each, and the caller lines of all of them", () => {
    const j = dependencyJoin(
      link("wallets-api", [
        end("forge-wallets", "wallets-api", "dependency.a", "wallets-api/pom.xml:13", [
          "wallets-api/pom.xml:13",
          "wallets-api/pom.xml:12",
        ]),
        end("forge-wallets", "wallets-api", "dependency.b", "wallets-api/pom.xml:31", [
          "wallets-api/pom.xml:31",
          "wallets-api/pom.xml:12",
        ]),
      ]),
    );
    expect(j.caller.map((e) => e.at)).toEqual([
      "wallets-api/pom.xml:13",
      "wallets-api/pom.xml:12",
      "wallets-api/pom.xml:31",
    ]);
    expect(j.dependency?.facts?.map((f) => [f.fact, f.at])).toEqual([
      ["dependency.a", "wallets-api/pom.xml:13"],
      ["dependency.b", "wallets-api/pom.xml:31"],
    ]);
  });
});

describe("a merged depends-on edge, every join on request (beta.25)", () => {
  const services = Array.from({ length: 25 }, (_, i) => `svc-${String(i).padStart(2, "0")}`);
  const est = buildEstate(
    [
      component("payments-common", "forge-payments-common", "payments"),
      ...services.map((s) => component(s, `forge-${s}`, "ledger")),
    ],
    { dependsOn: services.map((s) => link(s)) },
  );
  const edge = (everyJoin: boolean) =>
    nodeView(est, "estate", { lens: "architecture", everyJoin }).edges.find(
      (e) => e.type === "depends-on",
    )!;

  it("lists 20 in a view, and all 25 when every join is asked for", () => {
    expect(edge(false).count).toBe(25);
    expect(edge(false).joins).toHaveLength(20);
    expect(edge(true).joins?.map((j) => j.from)).toEqual(services);
  });
});

describe("two coordinates of one library component on one arrow (review of beta.25)", () => {
  it("is one join listing each fact with its coordinates, and both publishing lines", () => {
    const kitApi = end("forge-kit", "kit", "artifact.kit-api", "kit-api/pom.xml:7");
    const kitCore = end("forge-kit", "kit", "artifact.kit-core", "kit-core/pom.xml:7");
    const facts = [
      {
        ...end("forge-wallets", "wallets-api", "dependency.kit-api", "wallets-api/pom.xml:13"),
        group: "forge.kit",
        name: "kit-api",
      },
      {
        ...end("forge-wallets", "wallets-api", "dependency.kit-core", "wallets-api/pom.xml:17"),
        group: "forge.kit",
        name: "kit-core",
        scope: "runtime" as const,
      },
    ];
    const l: DependencyLink = {
      from: facts[0]!,
      facts,
      to: kitApi,
      published: [kitApi, kitCore],
      group: "forge.kit",
      name: "kit-api",
    };
    const j = dependencyJoin(l);
    expect(j.callee.map((e) => e.at)).toEqual(["kit-api/pom.xml:7", "kit-core/pom.xml:7"]);
    expect(j.dependency?.facts?.map((f) => [f.fact, `${f.group}:${f.name}`, f.scope])).toEqual([
      ["dependency.kit-api", "forge.kit:kit-api", undefined],
      ["dependency.kit-core", "forge.kit:kit-core", "runtime"],
    ]);
    const est = buildEstate(
      [component("wallets-api", "forge-wallets", "wallets"), component("kit", "forge-kit", "kit")],
      { dependsOn: [l] },
    );
    const e = nodeView(est, "system:wallets", { lens: "architecture", depth: 2 }).edges.filter(
      (x) => x.type === "depends-on",
    );
    expect(e.map((x) => [x.from, x.to, x.count, x.joins?.length])).toEqual([
      ["component:wallets-api", "system:kit", 1, 1],
    ]);
  });
});
