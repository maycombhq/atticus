import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFacts, type Fact } from "@maycombhq/core";
import {
  dirSource,
  gradleDependencyOn,
  gradleNameOn,
  pomCoordinates,
  verifyFacts,
} from "../src/index.js";

/**
 * A library of the organisation's own and the services that build on it
 * (`fixtures/library-deps/`, invented, ADR 0192): each repo's `artifact` facts (the coordinates
 * its build publishes) and `dependency` facts (what it builds on) are checked against the build
 * file they cite: the name on the very line, as the project's own coordinates or a dependency's,
 * the group's line cited and saying the same, the scope as declared. `expected/verified.json` is
 * the verifier's result per repo, by hand.
 */
const FIX = join(__dirname, "..", "..", "..", "fixtures", "library-deps");
const COMMITS: Record<string, string> = {
  "forge-payments-common": "1111aaa",
  "forge-wallets": "2222bbb",
  "forge-ledger": "3333ccc",
  "forge-statements": "4444ddd",
};
const facts = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(FIX, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const run = (repo: string, fs: Fact[] = facts(repo)) =>
  verifyFacts({ facts: fs, source: dirSource(join(FIX, "repos", repo)), commit: COMMITS[repo]! });
const lines = (repo: string, file: string) =>
  readFileSync(join(FIX, "repos", repo, file), "utf8").split("\n");
const edit = (repo: string, id: string, change: (f: Fact) => Fact): Fact[] =>
  facts(repo).map((f) => (f.id === id ? change(f) : f));

describe("build coordinates read from a pom and a Gradle build", () => {
  it("reads the project's own coordinates, its parent's, and its dependencies with their lines", () => {
    const pom = pomCoordinates(lines("forge-ledger", "pom.xml"));
    expect(pom.group).toEqual({ value: "forge.ledger", line: 4 });
    expect(pom.artifact).toEqual({ value: "forge-ledger", line: 5 });
    expect(
      pom.dependencies.map((d) => [d.group?.value, d.artifact?.value, d.artifact?.line, d.managed]),
    ).toEqual([
      ["forge.payments", "forge-payments-common", 10, false],
      ["com.northwind.sdk", "northwind-pay-client", 15, false],
      ["forge.payments", "forge-payments-common", 23, true],
    ]);
    // A module inherits its group from its parent; the parent's own coordinates aren't the project's.
    const mod = pomCoordinates(lines("forge-wallets", "wallets-api/pom.xml"));
    expect(mod.group).toBeUndefined();
    expect(mod.parentGroup).toEqual({ value: "forge.wallets", line: 5 });
    expect(mod.artifact).toEqual({ value: "wallets-api", line: 9 });
    // A third-party parent's group is never the project's when the project writes its own.
    const lib = pomCoordinates(lines("forge-payments-common", "pom.xml"));
    expect(lib.group).toEqual({ value: "forge.payments", line: 9 });
    expect(lib.parentGroup?.value).toBe("org.springframework.boot");
  });

  it("reads a Gradle line's dependency and configuration, and the project name", () => {
    expect(
      gradleDependencyOn("    implementation 'forge.payments:forge-payments-common:1.4.0'"),
    ).toEqual({
      configuration: "implementation",
      group: "forge.payments",
      name: "forge-payments-common",
      version: "1.4.0",
      scope: "compile",
    });
    expect(
      gradleDependencyOn('    testImplementation("forge.payments:forge-payments-testkit")')?.scope,
    ).toBe("test");
    expect(
      gradleDependencyOn("    implementation group: 'g.x', name: 'a-y', version: '1'")?.name,
    ).toBe("a-y");
    expect(gradleDependencyOn("    id 'java'")).toBeUndefined();
    expect(gradleNameOn("rootProject.name = 'forge-statements'")).toBe("forge-statements");
  });
});

describe("build coordinates left in a comment", () => {
  it("are no dependency, on one line or across several", () => {
    const pom = pomCoordinates([
      "<project>",
      "  <artifactId>forge-x</artifactId>",
      "  <dependencies>",
      "    <!-- <dependency><groupId>g</groupId><artifactId>gone</artifactId></dependency> -->",
      "    <!--",
      "    <dependency>",
      "      <groupId>g</groupId>",
      "      <artifactId>also-gone</artifactId>",
      "    </dependency>",
      "    -->",
      "    <dependency>",
      "      <groupId>g</groupId>",
      "      <artifactId>kept</artifactId> <!-- a note -->",
      "    </dependency>",
      "  </dependencies>",
      "</project>",
    ]);
    expect(pom.artifact).toEqual({ value: "forge-x", line: 2 });
    expect(pom.dependencies.map((d) => [d.artifact?.value, d.artifact?.line])).toEqual([
      ["kept", 13],
    ]);
  });
});

describe("a library and the services that build on it, as read (ADR 0192)", () => {
  it("covers every repo of the fixture", () => {
    expect(
      readdirSync(join(FIX, "facts"))
        .map((f) => f.replace(/\.jsonl$/, ""))
        .sort(),
    ).toEqual(Object.keys(COMMITS).sort());
  });

  it("keeps every fact of every repo (golden)", async () => {
    const got: Record<string, unknown> = {};
    for (const repo of Object.keys(COMMITS).sort()) {
      const r = await run(repo);
      got[repo] = {
        accepted: r.accepted.map((f) => f.id).sort(),
        rejected: r.rejected.map((x) => ({ id: x.fact.id, code: x.code, message: x.message })),
        buildUnrecorded: r.buildUnrecorded ?? [],
      };
    }
    // UPDATE_GOLDEN=1 writes what the verifier gives now, to be checked by hand before it's committed.
    if (process.env.UPDATE_GOLDEN)
      writeFileSync(join(FIX, "expected", "verified.json"), `${JSON.stringify(got, null, 2)}\n`);
    expect(got).toEqual(JSON.parse(readFileSync(join(FIX, "expected", "verified.json"), "utf8")));
  });

  it("rejects a dependency cited on a line that doesn't name it", async () => {
    const r = await run(
      "forge-ledger",
      edit("forge-ledger", "dependency.forge-payments-common", (f) => ({
        ...f,
        cite: { ...f.cite, line: 15, quote: "<artifactId>northwind-pay-client</artifactId>" },
      })),
    );
    // Its group's line (a part) is beside its real line, so the words are near; the build file
    // says the line it cites declares another artifact.
    expect(r.rejected.map((x) => [x.fact.id, x.code])).toEqual([
      ["dependency.forge-payments-common", "build-coordinates"],
    ]);
    expect(r.rejected[0]!.message).toContain('declares "northwind-pay-client"');
    // With no part to lean on, the line check refuses it first.
    const bare = await run(
      "forge-ledger",
      edit("forge-ledger", "dependency.forge-payments-common", (f) => ({
        ...f,
        cite: { file: "pom.xml", line: 15, value: "forge-payments-common" },
      })),
    );
    expect(bare.rejected.map((x) => [x.fact.id, x.code])).toEqual([
      ["dependency.forge-payments-common", "claim-not-on-line"],
    ]);
  });

  it("rejects a dependency-management entry cited as a dependency", async () => {
    const r = await run(
      "forge-ledger",
      edit("forge-ledger", "dependency.forge-payments-common", (f) => ({
        ...f,
        cite: {
          file: "pom.xml",
          line: 23,
          value: "forge-payments-common",
          with: [
            { file: "pom.xml", line: 22, value: "forge.payments" },
            { file: "pom.xml", line: 24, value: "1.4.0" },
          ],
        },
      })),
    );
    expect(r.rejected.map((x) => [x.fact.id, x.code])).toEqual([
      ["dependency.forge-payments-common", "build-coordinates"],
    ]);
    expect(r.rejected[0]!.message).toContain("<dependencyManagement>");
  });

  it("rejects a dependency cited as the coordinates the build publishes, and the other way", async () => {
    const asArtifact = await run(
      "forge-ledger",
      facts("forge-ledger").map((f) =>
        f.id === "dependency.forge-payments-common"
          ? ({ ...f, kind: "artifact", id: "artifact.wrong", scope: undefined } as unknown as Fact)
          : f,
      ),
    );
    expect(asArtifact.rejected.map((x) => [x.fact.id, x.code])).toEqual([
      ["artifact.wrong", "build-coordinates"],
    ]);
    expect(asArtifact.rejected[0]!.message).toContain("a dependency's <artifactId>");
    const asDependency = await run(
      "forge-ledger",
      facts("forge-ledger").map((f) =>
        f.id === "artifact.forge-ledger"
          ? ({ ...f, kind: "dependency", id: "dependency.wrong" } as Fact)
          : f,
      ),
    );
    expect(asDependency.rejected.map((x) => [x.fact.id, x.code])).toEqual([
      ["dependency.wrong", "build-coordinates"],
    ]);
  });

  it("rejects a group the build doesn't write, a group line left uncited, and a scope not declared", async () => {
    const group = await run(
      "forge-wallets",
      edit(
        "forge-wallets",
        "artifact.wallets-api",
        (f) => ({ ...f, group: "forge.payments" }) as Fact,
      ),
    );
    expect(group.rejected.map((x) => x.code)).toEqual(["build-coordinates"]);
    const uncited = await run(
      "forge-wallets",
      edit("forge-wallets", "dependency.wallets-api.forge-payments-common", (f) => ({
        ...f,
        cite: { ...f.cite, with: [] },
      })),
    );
    expect(uncited.rejected.map((x) => x.code)).toEqual(["build-coordinates"]);
    expect(uncited.rejected[0]!.message).toContain("cite that line in cite.with");
    const scope = await run(
      "forge-wallets",
      edit("forge-wallets", "dependency.wallets-batch.forge-payments-common", (f) => {
        const { scope: _scope, ...rest } = f as Fact & { scope?: string };
        return rest as Fact;
      }),
    );
    expect(scope.rejected.map((x) => x.code)).toEqual(["build-coordinates"]);
    expect(scope.rejected[0]!.message).toContain("declares test");
  });

  it("rejects a Gradle dependency whose coordinates aren't the line's", async () => {
    const r = await run(
      "forge-statements",
      edit(
        "forge-statements",
        "dependency.forge-payments-common",
        (f) =>
          ({
            ...f,
            name: "forge-payments-core",
          }) as Fact,
      ),
    );
    expect(r.rejected.map((x) => [x.fact.id, x.code])).toEqual([
      ["dependency.forge-payments-common", "build-coordinates"],
    ]);
  });

  it("notes a dependency a read build file declares that no fact records (the cross-check)", async () => {
    const r = await run(
      "forge-ledger",
      facts("forge-ledger").filter((f) => f.id !== "dependency.northwind-pay-client"),
    );
    expect(r.buildUnrecorded).toEqual([
      {
        cite: "pom.xml:15",
        kind: "dependency",
        coordinates: "com.northwind.sdk:northwind-pay-client",
      },
    ]);
  });
});
