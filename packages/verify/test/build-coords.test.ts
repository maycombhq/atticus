import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFacts, type Fact, type FactOf } from "@maycombhq/core";
import {
  buildCoordinatesProblem,
  buildModuleOf,
  buildUnrecorded,
  catalogLibraryAt,
  dirSource,
  gradleBlocks,
  gradleCatalogUseOn,
  gradleDependencyAt,
  gradleDependencyOn,
  gradleGroupOn,
  gradleProjectsOn,
  isPomFile,
  pomCoordinates,
  verifyFacts,
} from "../src/index.js";

/**
 * Beta.25 review of ADR 0192 (the "depends on" arrows): a pom read as one text (a tag, a
 * comment or a CDATA section broken over lines), a `${property}` resolved from the pom, a Gradle
 * build read with its blocks, a multi-project Gradle build's subprojects publishing, and a build
 * file's module being the component its facts belong to. Invented Forge names only.
 */
const FIX = join(__dirname, "..", "..", "..", "fixtures", "library-deps");
const read = (repo: string, file: string) =>
  readFileSync(join(FIX, "repos", repo, file), "utf8").split("\n");
const linesIn =
  (repo: string) =>
  (file: string): string[] | undefined => {
    try {
      return read(repo, file);
    } catch {
      return undefined;
    }
  };
const of = (files: Record<string, string>) => (file: string) => files[file]?.split("\n");
const base = { commit: "1111aaa", verified: "none", by: "assistant", conf: "declared" } as const;
type Coordinates = FactOf<"artifact"> | FactOf<"dependency">;
const artifact = (o: Partial<FactOf<"artifact">> & Pick<Fact, "cite">): Coordinates => ({
  ...base,
  kind: "artifact",
  id: "artifact.x",
  repo: "r",
  group: "forge.payments",
  name: "forge-x",
  ...o,
});
const dependency = (o: Partial<FactOf<"dependency">> & Pick<Fact, "cite">): Coordinates => ({
  ...base,
  kind: "dependency",
  id: "dependency.x",
  repo: "r",
  group: "forge.payments",
  name: "forge-payments-common",
  ...o,
});
const factsOf = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(FIX, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};

describe("a pom read as one text, its lines kept (beta.25)", () => {
  it("reads a namespaced <project> start tag written over two lines (the Initializr default)", () => {
    const pom = pomCoordinates(read("forge-payments-common", "pom.xml"));
    expect(pom.group).toEqual({ value: "forge.payments", line: 9 });
    expect(pom.artifact).toEqual({ value: "forge-payments-common", line: 10 });
    expect(pom.parentGroup).toEqual({ value: "org.springframework.boot", line: 5 });
    expect(pom.dependencies.map((d) => d.artifact)).toEqual([
      { value: "spring-boot-starter-web", line: 16 },
    ]);
  });

  it("reads any tag split over lines, a quoted > in an attribute, CRLF and a byte-order mark", () => {
    const pom = pomCoordinates([
      "﻿<?xml version='1.0'?>\r",
      '<project a="x > y"\r',
      "   b='2'>\r",
      "  <groupId\r",
      "  >forge.payments</groupId>\r",
      "  <artifactId>forge-x</artifactId\r",
      "  >\r",
      "</project>\r",
    ]);
    expect(pom.group).toEqual({ value: "forge.payments", line: 5 });
    expect(pom.artifact).toEqual({ value: "forge-x", line: 6 });
  });

  it("reads a CDATA section as its text, and leaves out a comment wherever it breaks", () => {
    const pom = pomCoordinates([
      "<project>",
      "  <groupId><![CDATA[forge.payments]]></groupId>",
      "  <!-- <artifactId>gone</artifactId>",
      "  --><artifactId>forge-x</artifactId>",
      "</project>",
    ]);
    expect(pom.group).toEqual({ value: "forge.payments", line: 2 });
    expect(pom.artifact).toEqual({ value: "forge-x", line: 4 });
  });

  it("checks the library's artifact against the two-line header pom", () => {
    const f = factsOf("forge-payments-common").find((x) => x.kind === "artifact") as Coordinates;
    expect(buildCoordinatesProblem(f, linesIn("forge-payments-common"))).toBeUndefined();
  });
});

describe("a pom's ${property} resolved, its line cited (beta.25)", () => {
  const POM = [
    "<project>", // 1
    "  <parent>", // 2
    "    <groupId>forge.parent</groupId>", // 3
    "    <artifactId>forge-parent</artifactId>", // 4
    "  </parent>", // 5
    "  <groupId>${forge.group}</groupId>", // 6
    "  <artifactId>forge-x</artifactId>", // 7
    "  <properties>", // 8
    "    <forge.group>forge.payments</forge.group>", // 9
    "    <common.name>forge-payments-common</common.name>", // 10
    "  </properties>", // 11
    "  <dependencies>", // 12
    "    <dependency>", // 13
    "      <groupId>${project.parent.groupId}</groupId>", // 14
    "      <artifactId>forge-parent-lib</artifactId>", // 15
    "    </dependency>", // 16
    "    <dependency>", // 17
    "      <groupId>${project.groupId}</groupId>", // 18
    "      <artifactId>${common.name}</artifactId>", // 19
    "      <scope>system</scope>", // 20
    "    </dependency>", // 21
    "    <dependency>", // 22
    "      <groupId>${nobody.sets}</groupId>", // 23
    "      <artifactId>forge-y</artifactId>", // 24
    "    </dependency>", // 25
    "  </dependencies>", // 26
    "</project>", // 27
  ].join("\n");
  const linesOf = of({ "pom.xml": POM });
  const cite = (line: number, value: string, ...parts: number[]) => ({
    file: "pom.xml",
    line,
    value,
    with: parts.map((l) => ({ file: "pom.xml", line: l, value: "x" })),
  });

  it("resolves the project's group from <properties>, and asks for that line", () => {
    expect(
      buildCoordinatesProblem(artifact({ cite: cite(7, "forge-x", 6, 9) }), linesOf),
    ).toBeUndefined();
    expect(buildCoordinatesProblem(artifact({ cite: cite(7, "forge-x", 6) }), linesOf)).toContain(
      "pom.xml:9; cite that line in cite.with",
    );
  });

  it("resolves a dependency's group from the <parent> and the project, and its name", () => {
    expect(
      buildCoordinatesProblem(
        dependency({
          group: "forge.parent",
          name: "forge-parent-lib",
          cite: cite(15, "forge-parent-lib", 14, 3),
        }),
        linesOf,
      ),
    ).toBeUndefined();
    expect(
      buildCoordinatesProblem(
        dependency({ scope: "provided", cite: cite(19, "${common.name}", 18, 6, 9, 10, 20) }),
        linesOf,
      ),
    ).toBeUndefined();
    // the property's own line left out
    expect(
      buildCoordinatesProblem(
        dependency({ scope: "provided", cite: cite(19, "${common.name}", 18, 6, 9, 20) }),
        linesOf,
      ),
    ).toContain("pom.xml:10; cite that line in cite.with");
  });

  it("records a system scope as provided (facts version 5), and refuses a property the pom doesn't set", () => {
    expect(
      buildCoordinatesProblem(
        dependency({ cite: cite(19, "${common.name}", 18, 6, 9, 10) }),
        linesOf,
      ),
    ).toContain("declares system, which is recorded as provided");
    expect(
      buildCoordinatesProblem(
        dependency({ name: "forge-y", cite: cite(24, "forge-y", 23) }),
        linesOf,
      ),
    ).toContain("${nobody.sets}");
  });
});

describe("a Gradle build read with its blocks (beta.25)", () => {
  const root = read("forge-payments-kit", "build.gradle");
  const core = read("forge-payments-kit", "kit-core/build.gradle");

  it("names the blocks each line is in, a brace in a string opening none", () => {
    const b = gradleBlocks(root);
    expect(b[24]).toEqual(["subprojects", "dependencyManagement", "dependencies"]);
    expect(b[28]).toEqual(["subprojects", "dependencies"]);
    expect(b[42]).toEqual(["project(:kit-batch)", "dependencies"]);
    expect(gradleBlocks(core)[8]).toEqual(["dependencies"]);
  });

  it("takes only a line directly in a project's dependencies { } as a dependency", () => {
    const at = (line: number) => gradleDependencyAt(root, line);
    expect(at(29)).toMatchObject({ dependency: { name: "forge-payments-common" }, all: true });
    expect(at(43)).toMatchObject({ dependency: { scope: "test" }, project: "kit-batch" });
    expect(at(25)).toBeUndefined(); // `dependency` is the management DSL, no configuration
    expect(at(31)).toEqual({ none: "dependencies { constraints { }" });
    expect(at(6)).toBeUndefined(); // the build's own class path
    expect(at(22)).toBeUndefined(); // a BOM
    expect(at(36)).toBeUndefined(); // a forced version
    expect(at(3)).toBeUndefined(); // a repository's url
    expect(at(17)).toBeUndefined();
  });

  it("refuses a URL or an interpolated string as coordinates, and keeps a dependency's closure", () => {
    expect(gradleDependencyOn("    url 'https://repo.forge.example/maven'")).toBeUndefined();
    expect(gradleDependencyOn("    implementation 'https://x.example:a'")).toBeUndefined();
    expect(gradleDependencyOn('    implementation "${forgeGroup}:forge-x:1"')).toBeUndefined();
    expect(
      gradleDependencyOn(
        "    implementation('forge.payments:forge-payments-common:1.4.0') { because 'x' }",
      ),
    ).toMatchObject({ group: "forge.payments", name: "forge-payments-common", scope: "compile" });
    expect(gradleDependencyAt(core, 6)).toMatchObject({ dependency: { scope: "compile" } });
  });

  it("reads a test suite's configuration as test, and providedCompile as provided", () => {
    const scope = (c: string) => gradleDependencyOn(`  ${c} 'forge.payments:forge-x:1'`)?.scope;
    expect(scope("integrationTestImplementation")).toBe("test");
    expect(scope("componentTestRuntimeOnly")).toBe("test");
    expect(scope("functionalTestImplementation")).toBe("test");
    expect(scope("testFixturesApi")).toBe("test");
    expect(scope("testImplementation")).toBe("test");
    expect(scope("providedCompile")).toBe("provided");
    expect(scope("providedRuntime")).toBe("provided");
    expect(scope("runtimeOnly")).toBe("runtime");
    expect(scope("implementation")).toBe("compile");
    expect(gradleDependencyAt(core, 9)).toMatchObject({ dependency: { scope: "test" } });
    expect(gradleDependencyAt(core, 10)).toMatchObject({ dependency: { scope: "provided" } });
  });

  it("reads a subproject's include and its name, and a group set for all projects", () => {
    expect(gradleProjectsOn("include 'kit-core', 'kit-batch'")).toEqual([
      { path: "kit-core", name: "kit-core" },
      { path: "kit-batch", name: "kit-batch" },
    ]);
    expect(gradleProjectsOn('include(":services:kit-api")')).toEqual([
      { path: "services:kit-api", name: "kit-api" },
    ]);
    expect(gradleProjectsOn("project(':kit-batch').name = 'payments-kit-batch'")).toEqual([
      { path: "kit-batch", name: "payments-kit-batch", renamed: true },
    ]);
    expect(gradleGroupOn("allprojects { group = 'forge.payments' }")).toBe("forge.payments");
    expect(gradleGroupOn("group = 'forge.payments'\r")).toBe("forge.payments");
  });
});

describe("a multi-project Gradle library's subprojects publish (beta.25)", () => {
  const source = dirSource(join(FIX, "repos", "forge-payments-kit"));
  const run = (facts: Fact[], modules?: { path: string; component: string }[]) =>
    verifyFacts({
      facts,
      source,
      commit: "1111aaa",
      estate: {
        components: ["forge-payments-kit", ...(modules ?? []).map((m) => m.component)],
        repoComponent: { "forge-payments-kit": "forge-payments-kit" },
        ...(modules ? { modules: { "forge-payments-kit": modules } } : {}),
      },
    });
  const MODULES = [
    { path: "kit-core", component: "kit-core" },
    { path: "kit-batch", component: "kit-batch" },
  ];
  const g = { file: "build.gradle", line: 11, value: "forge.payments" };
  const kit = (o: Partial<FactOf<"artifact">> & Pick<Fact, "cite" | "id">) =>
    ({
      ...base,
      kind: "artifact",
      repo: "forge-payments-kit",
      group: "forge.payments",
      ...o,
    }) as Fact;

  it("keeps a subproject's include as its coordinates, with the group set for all projects", async () => {
    const r = await run([
      kit({
        id: "artifact.kit-core",
        name: "kit-core",
        cite: { file: "settings.gradle", line: 2, value: "kit-core", with: [g] },
      }),
      kit({
        id: "artifact.kit-batch",
        name: "payments-kit-batch",
        cite: { file: "settings.gradle", line: 3, value: "payments-kit-batch", with: [g] },
      }),
    ]);
    expect(r.rejected.map((x) => x.message)).toEqual([]);
    // review of beta.25: the manifest lists no module of the repo, so both are the repo's own
    // component (never one named for a subproject's folder)
    expect(r.accepted.map((f) => [f.id, f.component])).toEqual([
      ["artifact.kit-batch", undefined],
      ["artifact.kit-core", undefined],
    ]);
  });

  it("refuses a renamed subproject's include, and a group line of another project", async () => {
    const r = await run([
      kit({
        id: "artifact.kit-batch",
        name: "kit-batch",
        cite: { file: "settings.gradle", line: 2, value: "kit-batch", with: [g] },
      }),
    ]);
    expect(r.rejected[0]!.message).toContain("settings.gradle:3");
    const root = await run([
      kit({
        id: "artifact.kit",
        name: "forge-payments-kit",
        cite: {
          file: "settings.gradle",
          line: 1,
          value: "forge-payments-kit",
          with: [{ file: "build.gradle", line: 11, value: "forge.payments" }],
        },
      }),
    ]);
    // allprojects { } sets the root's group too
    expect(root.rejected).toEqual([]);
  });

  it("refuses a dependency-management or constraints line, and gives a project block's its module", async () => {
    const dep = (o: Partial<FactOf<"dependency">> & Pick<Fact, "cite" | "id">) =>
      ({
        ...base,
        kind: "dependency",
        repo: "forge-payments-kit",
        group: "com.northwind.sdk",
        name: "northwind-pay-client",
        version: "2.1.0",
        ...o,
      }) as Fact;
    const root = read("forge-payments-kit", "build.gradle");
    const line = (n: number) => root[n - 1]!.trim();
    const at = (n: number) => ({
      file: "build.gradle",
      line: n,
      value: "com.northwind.sdk:northwind-pay-client:2.1.0",
      quote: line(n),
    });
    const r = await run(
      [
        dep({ id: "dependency.constraint", cite: at(31) }),
        dep({ id: "dependency.batch", scope: "test", cite: at(43) }),
        dep({ id: "dependency.wrong-module", component: "kit-core", scope: "test", cite: at(43) }),
      ],
      MODULES,
    );
    expect(r.rejected.map((x) => [x.fact.id, x.code])).toEqual([
      ["dependency.constraint", "build-coordinates"],
      ["dependency.wrong-module", "build-coordinates"],
    ]);
    expect(r.rejected[0]!.message).toContain("constraints { }");
    expect(r.rejected[1]!.message).toContain("module kit-batch");
    expect(r.accepted.map((f) => [f.id, f.component])).toEqual([["dependency.batch", "kit-batch"]]);
    // the cross-check counts only the dependencies { } lines
    expect(r.buildUnrecorded).toEqual([
      {
        cite: "build.gradle:29",
        kind: "dependency",
        coordinates: "forge.payments:forge-payments-common",
      },
    ]);
  });
});

describe("a module's build facts are its module's (beta.25)", () => {
  const source = dirSource(join(FIX, "repos", "forge-wallets"));
  const wallets = factsOf("forge-wallets");
  const id = "dependency.wallets-api.forge-payments-common";
  // repos.manifest.yaml's forge-wallets: its two modules
  const estate = {
    components: ["wallets-api", "wallets-batch"],
    repoComponent: { "forge-wallets": "wallets-api" },
    modules: {
      "forge-wallets": [
        { path: "wallets-api", component: "wallets-api" },
        { path: "wallets-batch", component: "wallets-batch" },
      ],
    },
  };

  it("refuses a dependency of wallets-api's pom claimed for wallets-batch", async () => {
    const r = await verifyFacts({
      facts: wallets.map((f) => (f.id === id ? ({ ...f, component: "wallets-batch" } as Fact) : f)),
      source,
      commit: "2222bbb",
      estate,
    });
    expect(r.rejected.map((x) => [x.fact.id, x.code])).toEqual([[id, "build-coordinates"]]);
    expect(r.rejected[0]!.message).toContain("module wallets-api");
  });

  it("gives a fact that names no component its build file's module, as the manifest lists it", async () => {
    const r = await verifyFacts({
      facts: wallets.map((f) => {
        if (f.id !== id) return f;
        const { component: _c, ...rest } = f;
        return rest as Fact;
      }),
      source,
      commit: "2222bbb",
      estate,
    });
    expect(r.rejected).toEqual([]);
    expect(r.accepted.find((f) => f.id === id)?.component).toBe("wallets-api");
  });

  it("takes the manifest's module before the folder's name", async () => {
    const modules = { "forge-wallets": [{ path: "wallets-api", component: "wallets-http" }] };
    const f = wallets.find((x) => x.id === id) as Coordinates;
    expect(buildModuleOf(f, linesIn("forge-wallets"), modules["forge-wallets"])).toEqual({
      path: "wallets-api",
      component: "wallets-http",
      names: ["wallets-http"],
      from: "manifest",
    });
    const r = await verifyFacts({
      facts: wallets,
      source,
      commit: "2222bbb",
      estate: { components: ["wallets-http", "wallets-batch"], modules },
    });
    expect(r.rejected.map((x) => x.fact.id)).toEqual(["artifact.wallets-api", id]);
  });
});

describe("parent poms, tool configurations and version catalogs (beta.25)", () => {
  it("takes a parent pom named for what it is for a pom, and nothing else", () => {
    expect(isPomFile("src/gateway/shared-pom.xml")).toBe(true);
    expect(isPomFile("parent-pom.xml")).toBe(true);
    expect(isPomFile("build/parent.pom.xml")).toBe(true);
    expect(isPomFile("pom.xml")).toBe(true);
    expect(isPomFile("src/main/resources/pomegranate.xml")).toBe(false);
    expect(isPomFile("src/main/resources/web.xml")).toBe(false);
  });

  it("takes a ${project.groupId} for the group the module inherits, its line cited", () => {
    const linesOf = of({
      "pom.xml": [
        "<project>", // 1
        "  <parent>", // 2
        "    <groupId>forge.payments</groupId>", // 3
        "    <artifactId>forge-parent</artifactId>", // 4
        "  </parent>", // 5
        "  <artifactId>forge-x</artifactId>", // 6
        "  <dependencies>", // 7
        "    <dependency>", // 8
        "      <groupId>${project.groupId}</groupId>", // 9
        "      <artifactId>forge-payments-common</artifactId>", // 10
        "    </dependency>", // 11
        "  </dependencies>", // 12
        "</project>", // 13
      ].join("\n"),
    });
    const f = dependency({
      cite: {
        file: "pom.xml",
        line: 10,
        value: "forge-payments-common",
        with: [{ file: "pom.xml", line: 9, value: "${project.groupId}" }],
      },
    });
    // the <parent>'s own element is read here; only a <properties> entry's line must be cited
    expect(buildCoordinatesProblem(f, linesOf)).toBeUndefined();
    expect(buildCoordinatesProblem({ ...f, group: "forge.other" }, linesOf)).toContain(
      "(forge.payments)",
    );
  });

  it("leaves a tool's configuration out, and says so of a fact citing one", () => {
    for (const c of ["checkstyle", "pmd", "spotbugs", "jacocoAgent", "detekt", "ktlint"])
      expect(gradleDependencyOn(`    ${c} "com.example.tools:${c}:1.0"`), c).toBeUndefined();
    expect(gradleDependencyOn("    detektPlugins('com.example.tools:rules:1.0')")).toBeUndefined();
    const linesOf = of({
      "build.gradle": "dependencies {\n  checkstyle 'com.example.tools:checkstyle:10'\n}",
    });
    expect(
      buildCoordinatesProblem(
        dependency({
          group: "com.example.tools",
          name: "checkstyle",
          cite: { file: "build.gradle", line: 2, value: "com.example.tools:checkstyle:10" },
        }),
        linesOf,
      ),
    ).toContain("the checkstyle tool's own configuration");
    expect(buildUnrecorded(["build.gradle"], linesOf, [])).toEqual([]);
  });

  it("reads developmentOnly as runtime, never compile", () => {
    expect(gradleDependencyOn("  developmentOnly 'org.example:devtools'")?.scope).toBe("runtime");
  });

  const CATALOG = [
    "[versions]", // 1
    'common = "1.4.0"', // 2
    "", // 3
    "[libraries]", // 4
    'forge-payments-common = { module = "forge.payments:forge-payments-common", version.ref = "common" }', // 5
    'northwind_pay = { group = "com.northwind.sdk", name = "northwind-pay-client", version = "2.1.0" }', // 6
    'forge-x = "forge.payments:forge-x:3.0.0"', // 7
    "", // 8
    "[plugins]", // 9
    'boot = { id = "org.example.boot", version = "1.0" }', // 10
  ].join("\n");
  const BUILD = [
    "dependencies {", // 1
    "  implementation(libs.forge.payments.common)", // 2
    "  testImplementation(libs.northwind.pay)", // 3
    "  implementation(platform(libs.forge.x))", // 4
    "}", // 5
    "dependencyManagement {", // 6
    "  dependencies {", // 7
    "    implementation(libs.forge.payments.common)", // 8
    "  }", // 9
    "}", // 10
  ].join("\n");
  const catalogOf = of({
    "gradle/libs.versions.toml": CATALOG,
    "kit-core/build.gradle.kts": BUILD,
  });
  const viaCatalog = (line: number, use: number, o: Partial<FactOf<"dependency">> = {}) =>
    dependency({
      cite: {
        file: "gradle/libs.versions.toml",
        line,
        value: "forge-payments-common",
        with: [{ file: "kit-core/build.gradle.kts", line: use, value: "libs" }],
      },
      ...o,
    });

  it("reads a version catalog's libraries in each notation, and a build line's alias", () => {
    const lines = CATALOG.split("\n");
    expect(catalogLibraryAt(lines, 5)).toEqual({
      alias: "forge-payments-common",
      accessor: "forge.payments.common",
      group: "forge.payments",
      name: "forge-payments-common",
      versionRef: "common",
    });
    expect(catalogLibraryAt(lines, 6)).toMatchObject({
      accessor: "northwind.pay",
      version: "2.1.0",
    });
    expect(catalogLibraryAt(lines, 7)).toMatchObject({ name: "forge-x", version: "3.0.0" });
    expect(catalogLibraryAt(lines, 2)).toBeUndefined(); // a version
    expect(catalogLibraryAt(lines, 10)).toBeUndefined(); // a plugin
    expect(gradleCatalogUseOn("  implementation(libs.forge.payments.common)")).toEqual({
      configuration: "implementation",
      catalog: "libs",
      accessor: "forge.payments.common",
      scope: "compile",
    });
    expect(gradleCatalogUseOn("  implementation(libs.bundles.forge)")).toBeUndefined();
    expect(gradleCatalogUseOn("  implementation project(':kit-core')")).toBeUndefined();
  });

  it("keeps a dependency cited on its catalog entry with the line that declares its alias", () => {
    expect(
      buildCoordinatesProblem(viaCatalog(5, 2, { version: "1.4.0" }), catalogOf),
    ).toBeUndefined();
    expect(
      buildCoordinatesProblem(
        viaCatalog(6, 3, {
          group: "com.northwind.sdk",
          name: "northwind-pay-client",
          scope: "test",
        }),
        catalogOf,
      ),
    ).toBeUndefined();
    expect(
      buildCoordinatesProblem(viaCatalog(7, 4, { name: "forge-x", scope: "import" }), catalogOf),
    ).toBeUndefined();
    // the module is the alias line's build file's
    expect(
      buildModuleOf(viaCatalog(5, 2), catalogOf, [{ path: "kit-core", component: "kit-core" }]),
    ).toMatchObject({ component: "kit-core", from: "manifest" });
  });

  it("refuses a catalog entry with no alias line, a wrong version or scope, or a management line", () => {
    expect(
      buildCoordinatesProblem(
        dependency({
          cite: { file: "gradle/libs.versions.toml", line: 5, value: "forge-payments-common" },
        }),
        catalogOf,
      ),
    ).toContain("libs.forge.payments.common");
    expect(buildCoordinatesProblem(viaCatalog(5, 2, { version: "9.9.9" }), catalogOf)).toContain(
      'gives "1.4.0" (version.ref = "common")',
    );
    expect(buildCoordinatesProblem(viaCatalog(5, 2, { scope: "test" }), catalogOf)).toContain(
      "declares it with implementation",
    );
    expect(buildCoordinatesProblem(viaCatalog(5, 8), catalogOf)).toContain(
      "dependencyManagement { dependencies { }",
    );
    expect(buildCoordinatesProblem(viaCatalog(2, 2), catalogOf)).toContain("no [libraries] entry");
  });
});
