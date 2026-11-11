import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  joinDependencies,
  parseFacts,
  parseRecord,
  projectFacts,
  type CatalogRecord,
  type Fact,
  type FactOf,
} from "@maycombhq/core";
import { buildEstate, nodeView } from "@maycombhq/diagrams";
import {
  buildCoordinatesProblem,
  buildModuleOf,
  buildUnrecorded,
  gradleDependencyOn,
  gradleProjects,
  isPomFile,
  isPomFileIn,
  memorySource,
  pomCoordinates,
  pomFilesNamed,
  pomParents,
  verifyFacts,
} from "../src/index.js";

/**
 * Review of beta.25 (ADR 0192 addendum): a multi-module build that ships as one component is
 * that component (never pseudo-components named for its folders), a parent pom in a sibling
 * folder is found through `<relativePath>` and `../` modules, Gradle's multi-line includes,
 * Kotlin string configurations and root `subprojects { }` dependencies, and a big pom verified
 * quickly. Invented Forge names only.
 */
const FIX = join(__dirname, "..", "..", "..", "fixtures", "library-deps");
const base = { commit: "5555eee", verified: "none", by: "assistant", conf: "declared" } as const;
const libraryFacts = (): Fact[] => {
  const r = parseFacts(readFileSync(join(FIX, "facts", "forge-payments-common.jsonl"), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const linesOf = (files: Record<string, string>) => (f: string) => files[f]?.split("\n");
type Coordinates = FactOf<"artifact"> | FactOf<"dependency">;
const at = (file: string, line: number, value: string, ...with_: [string, number, string][]) => ({
  file,
  line,
  value,
  ...(with_.length ? { with: with_.map(([f, l, v]) => ({ file: f, line: l, value: v })) } : {}),
});
const artifact = (repo: string, id: string, name: string, group: string, cite: Fact["cite"]) =>
  ({ ...base, kind: "artifact", repo, id, group, name, cite }) as Fact;
const dependency = (
  repo: string,
  id: string,
  o: { group: string; name: string; component?: string; scope?: string },
  cite: Fact["cite"],
) => ({ ...base, kind: "dependency", repo, id, ...o, cite }) as Fact;

// ------------------------------------------------------------------------------- forge-cards
const CARDS: Record<string, string> = {
  "pom.xml": [
    "<project>", // 1
    "  <modelVersion>4.0.0</modelVersion>", // 2
    "  <groupId>forge.cards</groupId>", // 3
    "  <artifactId>forge-cards-parent</artifactId>", // 4
    "  <version>2.0.0</version>", // 5
    "  <packaging>pom</packaging>", // 6
    "  <modules>", // 7
    "    <module>cards-api</module>", // 8
    "    <module>cards-core</module>", // 9
    "  </modules>", // 10
    "</project>", // 11
  ].join("\n"),
  "cards-api/pom.xml": [
    "<project>", // 1
    "  <parent>", // 2
    "    <groupId>forge.cards</groupId>", // 3
    "    <artifactId>forge-cards-parent</artifactId>", // 4
    "    <version>2.0.0</version>", // 5
    "  </parent>", // 6
    "  <artifactId>cards-api</artifactId>", // 7
    "  <dependencies>", // 8
    "    <dependency>", // 9
    "      <groupId>forge.cards</groupId>", // 10
    "      <artifactId>cards-core</artifactId>", // 11
    "    </dependency>", // 12
    "    <dependency>", // 13
    "      <groupId>forge.payments</groupId>", // 14
    "      <artifactId>forge-payments-common</artifactId>", // 15
    "    </dependency>", // 16
    "  </dependencies>", // 17
    "</project>", // 18
  ].join("\n"),
  "cards-core/pom.xml": [
    "<project>", // 1
    "  <parent>", // 2
    "    <groupId>forge.cards</groupId>", // 3
    "    <artifactId>forge-cards-parent</artifactId>", // 4
    "    <version>2.0.0</version>", // 5
    "  </parent>", // 6
    "  <artifactId>cards-core</artifactId>", // 7
    "  <dependencies>", // 8
    "    <dependency>", // 9
    "      <groupId>forge.payments</groupId>", // 10
    "      <artifactId>forge-payments-common</artifactId>", // 11
    "    </dependency>", // 12
    "  </dependencies>", // 13
    "</project>", // 14
  ].join("\n"),
  "cards-api/src/main/java/forge/cards/api/CardsController.java": [
    "package forge.cards.api;",
    "@RestController",
    "class CardsController {",
    '  @GetMapping("/cards/{id}") String card(String id) { return id; }',
    "}",
  ].join("\n"),
};
const R = "forge-cards";
const cardsFacts = (): Fact[] => [
  artifact(
    R,
    "artifact.cards-api",
    "cards-api",
    "forge.cards",
    at("cards-api/pom.xml", 7, "cards-api", ["cards-api/pom.xml", 3, "forge.cards"]),
  ),
  artifact(
    R,
    "artifact.cards-core",
    "cards-core",
    "forge.cards",
    at("cards-core/pom.xml", 7, "cards-core", ["cards-core/pom.xml", 3, "forge.cards"]),
  ),
  // a module on another module of the same component: draws nothing
  dependency(
    R,
    "dependency.cards-api.cards-core",
    { group: "forge.cards", name: "cards-core" },
    at("cards-api/pom.xml", 11, "cards-core", ["cards-api/pom.xml", 10, "forge.cards"]),
  ),
  // naming the repo's manifest component is accepted
  dependency(
    R,
    "dependency.cards-api.common",
    { group: "forge.payments", name: "forge-payments-common", component: "forge-cards" },
    at("cards-api/pom.xml", 15, "forge-payments-common", [
      "cards-api/pom.xml",
      14,
      "forge.payments",
    ]),
  ),
  // naming none, it is the repo's manifest component
  dependency(
    R,
    "dependency.cards-core.common",
    { group: "forge.payments", name: "forge-payments-common" },
    at("cards-core/pom.xml", 11, "forge-payments-common", [
      "cards-core/pom.xml",
      10,
      "forge.payments",
    ]),
  ),
];
// repos.manifest.yaml: `component: forge-cards`, no `modules`
const ESTATE = {
  components: ["forge-cards", "payments-common"],
  repoComponent: { "forge-cards": "forge-cards", "forge-payments-common": "payments-common" },
};

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

describe("a multi-module repo that ships as one component (review of beta.25)", () => {
  const run = (facts: Fact[]) =>
    verifyFacts({ facts, source: memorySource(CARDS), commit: "5555eee", estate: ESTATE });

  it("takes every build file for the manifest's component, and never a folder's name", async () => {
    const r = await run(cardsFacts());
    expect(r.rejected.map((x) => x.message)).toEqual([]);
    expect(r.accepted.map((f) => [f.id, f.component])).toEqual([
      ["artifact.cards-api", undefined],
      ["artifact.cards-core", undefined],
      ["dependency.cards-api.cards-core", undefined],
      ["dependency.cards-api.common", "forge-cards"],
      ["dependency.cards-core.common", undefined],
    ]);
    const f = cardsFacts()[2] as Coordinates;
    expect(buildModuleOf(f, linesOf(CARDS), [], "forge-cards")).toEqual({
      path: "",
      component: "forge-cards",
      names: ["forge-cards"],
      from: "repo",
    });
    // no manifest known: nothing is said of the component at all
    expect(buildModuleOf(f, linesOf(CARDS))).toBeUndefined();
  });

  it("refuses a module's folder name as a component the manifest doesn't list", async () => {
    const r = await run(
      cardsFacts().map((f) =>
        f.id === "dependency.cards-core.common" ? ({ ...f, component: "cards-core" } as Fact) : f,
      ),
    );
    expect(r.rejected.map((x) => [x.fact.id, x.code])).toEqual([
      ["dependency.cards-core.common", "build-coordinates"],
    ]);
    expect(r.rejected[0]!.message).toContain(
      "a module is a component only when the manifest lists it",
    );
    expect(r.rejected[0]!.message).toContain("name forge-cards");
  });

  it("draws one arrow from the service box to the library, end to end (verify, join, map)", async () => {
    const r = await run(cardsFacts());
    const { links } = joinDependencies({
      repos: [
        { repo: R, component: "forge-cards", facts: r.accepted },
        { repo: "forge-payments-common", component: "payments-common", facts: libraryFacts() },
      ],
    });
    expect(links.map((l) => [l.from.component, l.to.component])).toEqual([
      ["forge-cards", "payments-common"],
    ]);
    // both modules' lines are on that one arrow
    expect(links[0]!.facts!.map((f) => f.fact)).toEqual([
      "dependency.cards-api.common",
      "dependency.cards-core.common",
    ]);
    const est = buildEstate(
      [
        component("forge-cards", R, "cards"),
        component("payments-common", "forge-payments-common", "payments"),
      ],
      { dependsOn: links },
    );
    const v = nodeView(est, "system:cards", { lens: "architecture", depth: 2 });
    expect(
      v.edges.filter((e) => e.type === "depends-on").map((e) => [e.from, e.to, e.count]),
    ).toEqual([["component:forge-cards", "system:payments", 1]]);
  });

  it("gives a manifest module its own component only when the manifest lists it", () => {
    const f = cardsFacts()[4] as Coordinates;
    const mods = [{ path: "cards-core", component: "cards-batch" }];
    expect(buildModuleOf(f, linesOf(CARDS), mods, "forge-cards")).toMatchObject({
      component: "cards-batch",
      from: "manifest",
    });
    // the root pom of a repo with modules is the repo's own
    const root = { ...f, cite: at("pom.xml", 4, "x") } as Coordinates;
    expect(buildModuleOf(root, linesOf(CARDS), mods, "forge-cards")).toMatchObject({
      component: "forge-cards",
      from: "repo",
    });
  });
});

// ------------------------------------------------------- forge-ledger: an entry in a folder's box
const LEDGER: Record<string, string> = {
  "pom.xml": [
    "<project>", // 1
    "  <groupId>forge.ledger</groupId>", // 2
    "  <artifactId>forge-ledger</artifactId>", // 3
    "  <dependencies>", // 4
    "    <dependency>", // 5
    "      <groupId>forge.payments</groupId>", // 6
    "      <artifactId>forge-payments-common</artifactId>", // 7
    "    </dependency>", // 8
    "  </dependencies>", // 9
    "</project>", // 10
  ].join("\n"),
  "ledger-api/src/main/java/forge/ledger/api/LedgerController.java": [
    "package forge.ledger.api;", // 1
    "@RestController", // 2
    "class LedgerController {", // 3
    '  @GetMapping("/ledger/{id}") String one(String id) { return id; }', // 4
    '  @PostMapping("/ledger") String add(String b) { return b; }', // 5
    "}", // 6
  ].join("\n"),
};
const L = "forge-ledger";
const CONTROLLER = "ledger-api/src/main/java/forge/ledger/api/LedgerController.java";
const entry = (id: string, method: string, path: string, line: number, named?: string) =>
  ({
    ...base,
    kind: "entry",
    repo: L,
    id,
    entryType: "rest",
    method,
    path,
    ...(named ? { component: named } : {}),
    cite: at(CONTROLLER, line, path),
  }) as Fact;
const ledgerFacts = (named = "ledger-api"): Fact[] => [
  artifact(
    L,
    "artifact.forge-ledger",
    "forge-ledger",
    "forge.ledger",
    at("pom.xml", 3, "forge-ledger", ["pom.xml", 2, "forge.ledger"]),
  ),
  dependency(
    L,
    "dependency.common",
    { group: "forge.payments", name: "forge-payments-common" },
    at("pom.xml", 7, "forge-payments-common", ["pom.xml", 6, "forge.payments"]),
  ),
  // named for the folder the code is in, which the manifest doesn't list
  entry("entry.get.ledger-id", "get", "/ledger/{id}", 4, named),
  // naming none: the repo's
  entry("entry.post.ledger", "post", "/ledger", 5),
];
// repos.manifest.yaml: forge-ledger is `component: ledger`, no `modules`
const LEDGER_ESTATE = {
  components: ["forge-ledger", "ledger", "forge-payments-common", "payments-common"],
  repoComponent: { "forge-ledger": "ledger", "forge-payments-common": "payments-common" },
};

describe("a fact naming a folder's component in a repo that ships as one (review of beta.25)", () => {
  type Estate = Parameters<typeof verifyFacts>[0]["estate"];
  const run = (facts: Fact[], estate: Estate | null = LEDGER_ESTATE) =>
    verifyFacts({
      facts,
      source: memorySource(LEDGER),
      commit: "5555eee",
      ...(estate ? { estate } : {}),
    });

  it("places it in the repo's component with a note, never refusing it", async () => {
    const r = await run(ledgerFacts());
    expect(r.rejected.map((x) => x.message)).toEqual([]);
    expect(r.accepted.map((f) => [f.id, f.component])).toEqual([
      ["artifact.forge-ledger", undefined],
      ["dependency.common", undefined],
      ["entry.get.ledger-id", "ledger"],
      ["entry.post.ledger", undefined],
    ]);
    expect(r.componentsPlaced).toEqual([
      {
        id: "entry.get.ledger-id",
        named: "ledger-api",
        component: "ledger",
        cite: `${CONTROLLER}:4`,
      },
    ]);
  });

  it("leaves a component the manifest names as it is, and places nothing in a repo with modules", async () => {
    for (const named of ["ledger", "forge-ledger"]) {
      const r = await run(ledgerFacts(named));
      expect(r.accepted.find((f) => f.id === "entry.get.ledger-id")!.component).toBe(named);
      expect(r.componentsPlaced).toBeUndefined();
    }
    const mods = await run(ledgerFacts(), {
      ...LEDGER_ESTATE,
      modules: { [L]: [{ path: "ledger-api", component: "ledger-api" }] },
    });
    expect(mods.accepted.find((f) => f.id === "entry.get.ledger-id")!.component).toBe("ledger-api");
    expect(mods.componentsPlaced).toBeUndefined();
    // a prototype's UI, BFF and mocks are components of their own (ADR 0133)
    const proto = await run(ledgerFacts(), { ...LEDGER_ESTATE, prototypes: [L] });
    expect(proto.accepted.find((f) => f.id === "entry.get.ledger-id")!.component).toBe(
      "ledger-api",
    );
    expect(proto.componentsPlaced).toBeUndefined();
    // no manifest known: nothing is placed
    const bare = await run(ledgerFacts(), null);
    expect(bare.accepted.find((f) => f.id === "entry.get.ledger-id")!.component).toBe("ledger-api");
  });

  it("ends the endpoints and the depends-on arrow in the same ledger box", async () => {
    const r = await run(ledgerFacts());
    // the manifest's component for a fact naming none, as a scan's projection gives it
    const kept = r.accepted.map((f) => (f.component ? f : ({ ...f, component: "ledger" } as Fact)));
    const projected = projectFacts(kept, { system: "ledger" });
    expect(projected.records.filter((x) => x.kind === "Component").map((x) => x.id)).toEqual([
      "ledger",
    ]);
    const endpoints = projected.records.filter((x) => x.kind === "Endpoint");
    expect(endpoints.map((x) => (x as { component: string }).component)).toEqual([
      "ledger",
      "ledger",
    ]);
    const { links } = joinDependencies({
      repos: [
        { repo: L, component: "ledger", facts: r.accepted },
        { repo: "forge-payments-common", component: "payments-common", facts: libraryFacts() },
      ],
    });
    expect(links.map((l) => [l.from.component, l.to.component])).toEqual([
      ["ledger", "payments-common"],
    ]);
    const est = buildEstate(
      [...projected.records, component("payments-common", "forge-payments-common", "payments")],
      { dependsOn: links },
    );
    const parents = [...est.kids].filter(([, ks]) => ks.some((k) => k.startsWith("endpoint:")));
    expect(parents.map(([p]) => p)).toEqual(["component:ledger"]);
    const v = nodeView(est, "system:ledger", { lens: "architecture", depth: 2 });
    expect(v.edges.filter((e) => e.type === "depends-on").map((e) => [e.from, e.to])).toEqual([
      ["component:ledger", "system:payments"],
    ]);
  });
});

// -------------------------------------------------------------------- a sibling parent folder
const SIBLING: Record<string, string> = {
  "parent/parent.xml": [
    "<project>", // 1
    "  <groupId>forge.cards</groupId>", // 2
    "  <artifactId>cards-parent</artifactId>", // 3
    "  <version>2.0.0</version>", // 4
    "  <packaging>pom</packaging>", // 5
    "  <properties>", // 6
    "    <forge.payments.group>forge.payments</forge.payments.group>", // 7
    "  </properties>", // 8
    "  <modules>", // 9
    "    <module>../cards-api</module>", // 10
    "  </modules>", // 11
    "</project>", // 12
  ].join("\n"),
  "parent/pom.xml": [
    "<project>", // 1
    "  <groupId>forge.cards</groupId>", // 2
    "  <artifactId>cards-build</artifactId>", // 3
    "  <properties>", // 4
    "    <forge.payments.group>forge.other</forge.payments.group>", // 5
    "  </properties>", // 6
    "  <modules>", // 7
    "    <module>../cards-core</module>", // 8
    "  </modules>", // 9
    "</project>", // 10
  ].join("\n"),
  "cards-api/pom.xml": [
    "<project>", // 1
    "  <parent>", // 2
    "    <groupId>forge.cards</groupId>", // 3
    "    <artifactId>cards-parent</artifactId>", // 4
    "    <relativePath>../parent/parent.xml</relativePath>", // 5
    "  </parent>", // 6
    "  <artifactId>cards-api</artifactId>", // 7
    "  <dependencies>", // 8
    "    <dependency>", // 9
    "      <groupId>${forge.payments.group}</groupId>", // 10
    "      <artifactId>forge-payments-common</artifactId>", // 11
    "    </dependency>", // 12
    "  </dependencies>", // 13
    "</project>", // 14
  ].join("\n"),
  "cards-core/pom.xml": [
    "<project>", // 1
    "  <parent>", // 2
    "    <groupId>forge.cards</groupId>", // 3
    "    <artifactId>cards-build</artifactId>", // 4
    "  </parent>", // 5
    "  <artifactId>cards-core</artifactId>", // 6
    "  <dependencies>", // 7
    "    <dependency>", // 8
    "      <groupId>${forge.payments.group}</groupId>", // 9
    "      <artifactId>forge-payments-common</artifactId>", // 10
    "    </dependency>", // 11
    "  </dependencies>", // 12
    "</project>", // 13
  ].join("\n"),
  "cards-api/dependency-reduced-pom.xml": "<project><artifactId>cards-api</artifactId></project>",
  "cards-api/.flattened-pom.xml": "<project><artifactId>cards-api</artifactId></project>",
};
const FILES = Object.keys(SIBLING);

describe("a parent pom in a sibling folder (review of beta.25)", () => {
  const of = linesOf(SIBLING);

  it("finds the parent through <relativePath>, and through a ../ module", () => {
    expect(pomParents("cards-api/pom.xml", of, FILES).map((p) => p.file)).toEqual([
      "parent/parent.xml",
    ]);
    // no <relativePath>: the pom whose <modules> lists ../cards-core, not ../pom.xml
    expect(pomParents("cards-core/pom.xml", of, FILES).map((p) => p.file)).toEqual([
      "parent/pom.xml",
    ]);
    expect(pomCoordinates(of("cards-api/pom.xml")!).parentRelativePath).toEqual({
      value: "../parent/parent.xml",
      line: 5,
    });
  });

  it("reads a parent pom a <relativePath> names as a pom, and never a generated one", () => {
    expect(isPomFile("parent/parent.xml")).toBe(false);
    const named = pomFilesNamed(FILES, of);
    expect([...named]).toEqual(["parent/parent.xml"]);
    expect(isPomFileIn("parent/parent.xml", named)).toBe(true);
    expect(isPomFile("cards-api/dependency-reduced-pom.xml")).toBe(false);
    expect(isPomFile("cards-api/.flattened-pom.xml")).toBe(false);
    expect(isPomFile("parent-pom.xml")).toBe(true);
  });

  it("resolves a ${property} from the parent pom's <properties>, that line cited", async () => {
    const dep = (file: string, line: number, group: number, ...more: [string, number, string][]) =>
      dependency(
        "forge-cards",
        `dependency.${file.split("/")[0]}`,
        { group: "forge.payments", name: "forge-payments-common" },
        at(file, line, "forge-payments-common", [file, group, "${forge.payments.group}"], ...more),
      ) as Coordinates;
    expect(
      buildCoordinatesProblem(
        dep("cards-api/pom.xml", 11, 10, ["parent/parent.xml", 7, "forge.payments"]),
        of,
        FILES,
      ),
    ).toBeUndefined();
    expect(buildCoordinatesProblem(dep("cards-api/pom.xml", 11, 10), of, FILES)).toContain(
      "through parent/parent.xml:7; cite that line in cite.with",
    );
    // the ../ module's parent says forge.other
    expect(
      buildCoordinatesProblem(
        dep("cards-core/pom.xml", 10, 9, ["parent/pom.xml", 5, "forge.other"]),
        of,
        FILES,
      ),
    ).toContain('writes "${forge.payments.group}" (forge.other)');
    // without the files, the parent isn't found and the property is said unresolved
    expect(buildCoordinatesProblem(dep("cards-core/pom.xml", 10, 9), of)).toContain(
      "${forge.payments.group}",
    );
    // the cross-check reads the named parent as a pom, and resolves through it
    const r = await verifyFacts({
      facts: [],
      source: memorySource(SIBLING),
      commit: "5555eee",
      routed: ["parent/parent.xml", "cards-api/pom.xml"],
    });
    expect(r.buildUnrecorded).toEqual([
      { cite: "cards-api/pom.xml:7", kind: "artifact", coordinates: "forge.cards:cards-api" },
      {
        cite: "cards-api/pom.xml:11",
        kind: "dependency",
        coordinates: "forge.payments:forge-payments-common",
      },
      { cite: "parent/parent.xml:3", kind: "artifact", coordinates: "forge.cards:cards-parent" },
    ]);
    // read by name alone, the parent isn't a pom
    expect(buildUnrecorded(["parent/parent.xml"], of, [])).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------ Gradle
describe("Gradle includes over lines, Kotlin string configurations, subprojects (review of beta.25)", () => {
  it("reads a Kotlin include written over several lines, each name on its line", () => {
    const settings = [
      'rootProject.name = "forge-kit"', // 1
      "include(", // 2
      '    ":kit-api",', // 3
      '    ":kit-core"', // 4
      ")", // 5
      "include 'kit-batch',", // 6
      "    'kit-tools'", // 7
      "includeBuild('build-logic')", // 8
    ];
    expect(gradleProjects(settings).map((p) => [p.path, p.line])).toEqual([
      ["kit-api", 3],
      ["kit-core", 4],
      ["kit-batch", 6],
      ["kit-tools", 7],
    ]);
  });

  it("reads a Kotlin string configuration", () => {
    expect(
      gradleDependencyOn('    "implementation"("forge.payments:forge-payments-common:1.4.0")'),
    ).toEqual({
      configuration: "implementation",
      group: "forge.payments",
      name: "forge-payments-common",
      version: "1.4.0",
      scope: "compile",
    });
    expect(gradleDependencyOn('    "testImplementation"("forge.payments:testkit")')?.scope).toBe(
      "test",
    );
  });

  const KIT: Record<string, string> = {
    "settings.gradle.kts": [
      'rootProject.name = "forge-kit"',
      "include(",
      '    ":kit-api",',
      '    ":kit-core"',
      ")",
    ].join("\n"),
    "build.gradle.kts": [
      "allprojects {", // 1
      '    group = "forge.kit"', // 2
      "}", // 3
      "subprojects {", // 4
      "    dependencies {", // 5
      '        "implementation"("forge.payments:forge-payments-common:1.4.0")', // 6
      "    }", // 7
      "}", // 8
    ].join("\n"),
    "kit-api/build.gradle.kts": "",
    "kit-core/build.gradle.kts": "",
  };
  const dep = (component?: string) =>
    dependency(
      "forge-kit",
      `dependency.common${component ? `.${component}` : ""}`,
      {
        group: "forge.payments",
        name: "forge-payments-common",
        ...(component ? { component } : {}),
      },
      at("build.gradle.kts", 6, "forge.payments:forge-payments-common:1.4.0"),
    );
  const run = (facts: Fact[], modules?: { path: string; component: string }[]) =>
    verifyFacts({
      facts,
      source: memorySource(KIT),
      commit: "5555eee",
      estate: {
        components: ["forge-kit", "kit-api", "kit-core"],
        repoComponent: { "forge-kit": "forge-kit" },
        ...(modules ? { modules: { "forge-kit": modules } } : {}),
      },
    });

  it("takes a root subprojects { } dependency for the repo's component when the manifest lists no modules", async () => {
    const r = await run([dep()]);
    expect(r.rejected).toEqual([]);
    expect(r.accepted.map((f) => f.component)).toEqual([undefined]);
    // and a subproject's include on its own line is its artifact
    const a = await run([
      artifact(
        "forge-kit",
        "artifact.kit-core",
        "kit-core",
        "forge.kit",
        at("settings.gradle.kts", 4, "kit-core", ["build.gradle.kts", 2, "forge.kit"]),
      ),
    ]);
    expect(a.rejected.map((x) => x.message)).toEqual([]);
  });

  it("takes it as each subproject's when they are modules of their own: one fact each", async () => {
    const mods = [
      { path: "kit-api", component: "kit-api" },
      { path: "kit-core", component: "kit-core" },
    ];
    const r = await run([dep("kit-api"), dep("kit-core"), dep(), dep("forge-kit")], mods);
    expect(r.accepted.map((f) => [f.id, f.component])).toEqual([
      ["dependency.common.kit-api", "kit-api"],
      ["dependency.common.kit-core", "kit-core"],
    ]);
    expect(r.rejected.map((x) => x.fact.id)).toEqual([
      "dependency.common",
      "dependency.common.forge-kit",
    ]);
    expect(r.rejected[0]!.message).toContain("write one dependency fact for each");
    expect(r.rejected[1]!.message).toContain("components kit-api, kit-core");
    const { links } = joinDependencies({
      repos: [
        {
          repo: "forge-kit",
          component: "forge-kit",
          moduleDirs: mods,
          facts: r.accepted,
        },
        { repo: "forge-payments-common", component: "payments-common", facts: libraryFacts() },
      ],
    });
    expect(links.map((l) => l.from.component)).toEqual(["kit-api", "kit-core"]);
  });
});

// ------------------------------------------------------------------------------------- speed
describe("a big pom (review of beta.25)", () => {
  it("verifies 3,000 dependencies in a few seconds", async () => {
    const n = 3000;
    const lines = [
      "<project>",
      "  <groupId>forge.big</groupId>",
      "  <artifactId>forge-big</artifactId>",
      "  <dependencies>",
    ];
    const facts: Fact[] = [];
    for (let i = 0; i < n; i++) {
      const g = lines.length + 2;
      lines.push(
        "    <dependency>",
        `      <groupId>forge.lib${i}</groupId>`,
        `      <artifactId>lib-${i}</artifactId>`,
        "    </dependency>",
      );
      facts.push(
        dependency(
          "forge-big",
          `dependency.lib-${i}`,
          { group: `forge.lib${i}`, name: `lib-${i}` },
          at("pom.xml", g + 1, `lib-${i}`, ["pom.xml", g, `forge.lib${i}`]),
        ),
      );
    }
    lines.push("  </dependencies>", "</project>");
    const started = performance.now();
    const r = await verifyFacts({
      facts,
      source: memorySource({ "pom.xml": lines.join("\n") }),
      commit: "5555eee",
      estate: { components: ["forge-big"], repoComponent: { "forge-big": "forge-big" } },
    });
    const took = performance.now() - started;
    expect(r.rejected.slice(0, 3).map((x) => x.message)).toEqual([]);
    expect(r.accepted).toHaveLength(n);
    expect(took).toBeLessThan(8000);
  }, 30000);
});
