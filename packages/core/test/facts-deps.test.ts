import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  Fact,
  FACT_KINDS,
  FACTS_SCHEMA_VERSION,
  FactCorrection,
  dependencyLinkId,
  joinDependencies,
  joinFacts,
  parseFacts,
  type JoinRepo,
} from "../src/index.js";

/**
 * The estate's build dependencies (ADR 0192) over `fixtures/library-deps/` (invented): a library
 * of the organisation's own (forge-payments-common) that three services build on, a vendor SDK
 * two of them build on too, and the library's own call to that vendor's host.
 */
const FIX = join(__dirname, "..", "..", "..", "fixtures", "library-deps");
const facts = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(FIX, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
/** The repos as the manifest gives them to the join (`joinReposOf`): each with its component. */
const repos = (): JoinRepo[] => [
  {
    repo: "forge-payments-common",
    component: "payments-common",
    facts: facts("forge-payments-common"),
  },
  { repo: "forge-ledger", component: "ledger-api", facts: facts("forge-ledger") },
  { repo: "forge-wallets", component: "wallets-api", facts: facts("forge-wallets") },
  { repo: "forge-statements", component: "statements-api", facts: facts("forge-statements") },
];

describe("the facts schema, version 5 (ADR 0192)", () => {
  it("adds the artifact and dependency kinds, and a version-4 file reads unchanged", () => {
    expect(FACTS_SCHEMA_VERSION).toBeGreaterThanOrEqual(5);
    expect(FACT_KINDS).toContain("artifact");
    expect(FACT_KINDS).toContain("dependency");
    // A facts file written before version 5: no line carries a number, every kind it has is as it was.
    const old = readFileSync(
      join(
        __dirname,
        "..",
        "..",
        "..",
        "fixtures",
        "gateway-facts",
        "vendor-proxy",
        "facts",
        "forge-accounts.jsonl",
      ),
      "utf8",
    );
    const r = parseFacts(old);
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.facts.map((f) => f.kind)).toEqual(
        old
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l).kind),
      );
    // A correction file written before reads too, and a correction can now name a dependency.
    expect(
      FactCorrection.safeParse({
        schemaVersion: 1,
        fact: "dependency.forge-payments-common",
        target: { kind: "dependency", file: "pom.xml", line: 10, value: "forge-payments-common" },
        action: "wrong",
        reason: "a test helper, not what the service runs on",
        by: "a.person",
        at: "2026-11-10T10:00:00Z",
      }).success,
    ).toBe(true);
  });

  it("refuses a coordinate written as a placeholder", () => {
    const r = Fact.safeParse({
      kind: "dependency",
      id: "dependency.x",
      repo: "forge-ledger",
      commit: "3333ccc",
      group: "${project.groupId}",
      name: "forge-payments-common",
      cite: { file: "pom.xml", line: 10, value: "forge-payments-common" },
    });
    expect(r.success).toBe(false);
  });
});

describe("the dependency join (ADR 0192)", () => {
  const out = joinDependencies({ repos: repos() });

  it("draws a depends-on link from each component that builds on the library, cited at both ends", () => {
    expect(
      out.links.map((l) => ({
        from: `${l.from.repo}/${l.from.component}`,
        to: `${l.to.repo}/${l.to.component}`,
        coordinates: `${l.group}:${l.name}`,
        at: [l.from.lines, l.to.lines],
      })),
    ).toEqual([
      {
        from: "forge-ledger/ledger-api",
        to: "forge-payments-common/payments-common",
        coordinates: "forge.payments:forge-payments-common",
        at: [
          ["pom.xml:10", "pom.xml:9", "pom.xml:11"],
          ["pom.xml:10", "pom.xml:9", "pom.xml:11"],
        ],
      },
      {
        from: "forge-statements/statements-api",
        to: "forge-payments-common/payments-common",
        coordinates: "forge.payments:forge-payments-common",
        at: [["build.gradle:9"], ["pom.xml:10", "pom.xml:9", "pom.xml:11"]],
      },
      {
        from: "forge-wallets/wallets-api",
        to: "forge-payments-common/payments-common",
        coordinates: "forge.payments:forge-payments-common",
        at: [
          ["wallets-api/pom.xml:13", "wallets-api/pom.xml:12"],
          ["pom.xml:10", "pom.xml:9", "pom.xml:11"],
        ],
      },
    ]);
    expect(dependencyLinkId(out.links[0]!)).toBe(
      "depends-on:forge-ledger/ledger-api>forge-payments-common/payments-common",
    );
  });

  it("draws nothing for a vendor's or an open-source library, nor for a test-scoped dependency", () => {
    // northwind-pay-client twice, spring-boot-starter-web once: nobody in the estate publishes them.
    expect(out.outside).toBe(3);
    // wallets-batch builds its tests on the library: no link.
    expect(out.test).toBe(1);
    expect(out.links.some((l) => l.from.component === "wallets-batch")).toBe(false);
    expect(out.ambiguous).toEqual([]);
  });

  it("matches by the coordinates the estate publishes, whatever the group's prefix", () => {
    // The same library published under a group nothing else here starts with still joins.
    const renamed = repos().map((r) => ({
      ...r,
      facts: r.facts.map((f) =>
        (f.kind === "artifact" || f.kind === "dependency") && f.group === "forge.payments"
          ? ({ ...f, group: "io.tidewater.shared" } as Fact)
          : f,
      ),
    }));
    expect(joinDependencies({ repos: renamed }).links).toHaveLength(3);
    // Nothing published: nothing drawn, however the group looks.
    const unpublished = repos().map((r) => ({
      ...r,
      facts: r.facts.filter((f) => f.kind !== "artifact" || r.repo !== "forge-payments-common"),
    }));
    expect(joinDependencies({ repos: unpublished }).links).toEqual([]);
  });

  it("draws nothing to coordinates two components publish, and says so", () => {
    const twice = [
      ...repos(),
      {
        repo: "forge-payments-fork",
        component: "payments-fork",
        facts: facts("forge-payments-common")
          .filter((f) => f.kind === "artifact")
          .map((f) => ({ ...f, repo: "forge-payments-fork" }) as Fact),
      },
    ];
    const r = joinDependencies({ repos: twice });
    expect(r.links).toEqual([]);
    expect(r.ambiguous.map((a) => [a.name, a.by.map((b) => b.repo)])).toEqual([
      ["forge-payments-common", ["forge-payments-common", "forge-payments-fork"]],
    ]);
  });

  it("gives the same links whatever order the repos come in", () => {
    expect(joinDependencies({ repos: [...repos()].reverse() })).toEqual(out);
  });

  it("leaves the library's own call the library's: the call join doesn't move it to its dependants", () => {
    const calls = joinFacts({ repos: repos(), outside: ["northwind-fx"] });
    const rates = [...calls.joins, ...(calls.outside ?? [])].filter(
      (j) => j.call.fact === "call.get.rates",
    );
    expect(rates.map((j) => [j.call.repo, j.call.component])).toEqual([
      ["forge-payments-common", "payments-common"],
    ]);
    // and no call of a depending service is made from the library's facts
    expect(calls.joins.filter((j) => j.call.repo !== "forge-payments-common")).toEqual([]);
  });
});
