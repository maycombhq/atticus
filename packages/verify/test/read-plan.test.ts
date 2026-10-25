import { describe, expect, it } from "vitest";
import {
  DATA_FILE_CHARS,
  DATA_FILE_LINES,
  exclusionYaml,
  isSourceFile,
  memorySource,
  planBatches,
  planParts,
  proposeExclusions,
  SESSION_TOKENS,
  type FileTokens,
} from "../src/index.js";

/**
 * A big repo's first read (ADR 0124 addendum A-big): what coverage and the estimate don't count
 * by default (locale bundles, big data files), the folders the estimate proposes to leave out,
 * and the parts it proposes for a repo bigger than one session reads. The repo is the invented
 * Forge atlas: a Java service, a web app, research tables, a docs site and a vendored codec.
 */

const lines = (n: number, line = (i: number) => `  "k${i}": ${i},`) =>
  Array.from({ length: n }, (_, i) => line(i)).join("\n") + "\n";
const javaClass = (name: string, n: number) =>
  `package forge.atlas;\n\npublic class ${name} {\n${lines(n, (i) => `  int field${i} = ${i}; // a line of code`)}}\n`;

describe("not product by default: locale bundles (ADR 0124 addendum A-big)", () => {
  it("doesn't count translation bundles under a locale folder", () => {
    for (const p of [
      "web/src/i18n/ui.ml.json",
      "web/src/i18n/readings.hi.json",
      "web/src/assets/locales/en/common.json",
      "web/public/locale/de.json",
      "config/lang/de.yml",
      "translations/labels.fr.properties",
      "app/src/main/res/values-hi/strings.xml",
      "app/src/main/res/values/strings.xml",
    ])
      expect(isSourceFile(p), p).toBe(false);
  });

  it("still counts code in a locale folder, and code in a package named lang", () => {
    for (const p of [
      "web/src/i18n/index.ts",
      "web/src/i18n/config.ts",
      "src/main/java/forge/atlas/lang/Parser.java",
      "src/main/resources/application.yml",
    ])
      expect(isSourceFile(p), p).toBe(true);
  });
});

describe("not product by default: big data files (ADR 0124 addendum A-big)", () => {
  const big = lines(DATA_FILE_LINES + 1).split("\n");
  const small = lines(100).split("\n");
  const oneLine = [`[${'"x",'.repeat(DATA_FILE_CHARS / 4)}"x"]`];

  it("doesn't count a JSON or XML file over the line or size threshold", () => {
    expect(isSourceFile("research/tables/rates-1990.json", big[0], big)).toBe(false);
    expect(isSourceFile("src/main/resources/data/regions.xml", big[0], big)).toBe(false);
    // minified: one line, over the size threshold
    expect(isSourceFile("web/public/atlas.min.json", oneLine[0], oneLine)).toBe(false);
  });

  it("counts a small one, and any whose size it isn't told", () => {
    expect(isSourceFile("research/tables/rates-1990.json", small[0], small)).toBe(true);
    expect(isSourceFile("research/tables/rates-1990.json")).toBe(true);
  });

  it("counts big build, config, API and migration files whatever their size", () => {
    for (const p of [
      "pom.xml",
      "atlas-api/pom.xml",
      "web/package.json",
      "web/angular.json",
      "web/tsconfig.app.json",
      "src/Forge.Atlas/appsettings.Production.json",
      "api/openapi.json",
      "docs/api/swagger.json",
      "atlas-api/src/main/resources/db/changelog/master.xml",
      "atlas-api/src/main/resources/mapper/AccountMapper.xml",
    ])
      expect(isSourceFile(p, big[0], big), p).toBe(true);
  });

  it("leaves YAML to the proposals: a big manifest or spec is usually code", () => {
    expect(isSourceFile("k8s/atlas.yaml", big[0], big)).toBe(true);
  });

  it("is applied by the batch plan, so the estimate doesn't count them either", () => {
    const plan = planBatches(
      memorySource({
        "src/main/java/forge/atlas/Atlas.java": javaClass("Atlas", 20),
        "research/tables/rates-1990.json": lines(DATA_FILE_LINES + 1),
        "web/src/i18n/ui.ml.json": lines(50),
      }),
      { room: Number.MAX_SAFE_INTEGER },
    );
    expect(plan.files).toBe(1);
  });
});

/** The Forge atlas, as the estimate sees it: each source file and its tokens. */
function atlas(): { files: FileTokens[]; all: string[] } {
  const files: FileTokens[] = [
    { path: "pom.xml", tokens: 900 },
    { path: "Dockerfile", tokens: 100 },
    { path: "atlas-api/pom.xml", tokens: 700 },
    { path: "atlas-api/src/main/resources/application.yml", tokens: 400 },
    { path: "atlas-api/src/main/resources/templates/report.html", tokens: 3_000 },
    { path: "atlas-api/src/main/resources/data/regions.json", tokens: 1_000 },
    ...Array.from({ length: 20 }, (_, i) => ({
      path: `atlas-api/src/main/java/forge/atlas/Service${i}.java`,
      tokens: 2_000,
    })),
    { path: "web/package.json", tokens: 600 },
    ...Array.from({ length: 10 }, (_, i) => ({ path: `web/src/Screen${i}.tsx`, tokens: 1_500 })),
    // research data: JSON tables under the size threshold, so they count by default
    ...Array.from({ length: 12 }, (_, i) => ({
      path: `research/tables/rates-${1990 + i}.json`,
      tokens: 5_000,
    })),
    { path: "research/tables/index.json", tokens: 9_000 },
    // a docs site: pages and its own script
    ...Array.from({ length: 8 }, (_, i) => ({ path: `docs/site/page${i}.html`, tokens: 3_000 })),
    { path: "docs/site/search.js", tokens: 800 },
    // a library's source dropped in beside its LICENSE, no build file of its own
    ...Array.from({ length: 6 }, (_, i) => ({
      path: `jar/org/northwind/codec/Codec${i}.java`,
      tokens: 2_500,
    })),
    // a small data folder: not worth proposing
    { path: "seed/accounts.json", tokens: 300 },
  ];
  const all = [
    ...files.map((f) => f.path),
    "jar/LICENSE",
    "jar/README.md",
    "web/LICENSE",
    "README.md",
    "LICENSE",
  ].sort();
  return { files, all };
}

describe("proposed exclusions: folders that hold data, docs or vendored code (A-big)", () => {
  it("proposes the research tables, the docs site and the vendored codec, biggest first", () => {
    const { files, all } = atlas();
    const r = proposeExclusions(files, all);
    expect(r.proposals.map((p) => [p.path, p.tokens, p.files, p.at])).toEqual([
      ["research/**", 69_000, 13, "research/tables/index.json:1"],
      ["docs/**", 24_800, 9, "docs/site/page0.html:1"],
      ["jar/**", 15_000, 6, "jar/LICENSE:1"],
    ]);
    const total = files.reduce((n, f) => n + f.tokens, 0);
    expect(r.before).toBe(total);
    expect(r.after).toBe(total - 69_000 - 24_800 - 15_000);
  });

  it("says why, in words a person can check before accepting", () => {
    const { files, all } = atlas();
    const [research, docs, jar] = proposeExclusions(files, all).proposals;
    expect(research!.why).toBe("data, not code: 13 .json files");
    expect(docs!.why).toBe("documentation, not the product: 8 .html files, 1 .js file");
    expect(jar!.why).toBe(
      "its own LICENSE and no build file: a vendored copy of third-party code? Check before accepting",
    );
  });

  it("never proposes the product: config and templates, a workspace package with its own LICENSE, a small data folder", () => {
    const { files, all } = atlas();
    const paths = proposeExclusions(files, all).proposals.map((p) => p.path);
    expect(paths).not.toContain("atlas-api/**");
    expect(paths.some((p) => p.startsWith("atlas-api/src/main/resources"))).toBe(false);
    expect(paths).not.toContain("web/**");
    expect(paths).not.toContain("seed/**");
  });

  it("proposes the folder holding the data, not a parent that holds config too", () => {
    const files: FileTokens[] = [
      { path: "atlas-api/src/main/resources/application.yml", tokens: 400 },
      { path: "atlas-api/src/main/resources/data/big.json", tokens: 90_000 },
      { path: "atlas-api/src/main/java/forge/atlas/Atlas.java", tokens: 10_000 },
    ];
    const r = proposeExclusions(
      files,
      files.map((f) => f.path),
    );
    expect(r.proposals.map((p) => p.path)).toEqual(["atlas-api/src/main/resources/data/**"]);
  });

  it("proposes nothing for a repo of code", () => {
    const files: FileTokens[] = [
      { path: "pom.xml", tokens: 900 },
      { path: "src/main/java/forge/atlas/Atlas.java", tokens: 50_000 },
    ];
    expect(
      proposeExclusions(
        files,
        files.map((f) => f.path),
      ),
    ).toEqual({ proposals: [], before: 50_900, after: 50_900 });
  });

  it("gives a ready exclude: block for org-pack/scan/<repo>.yaml, every entry citing a file", () => {
    const { files, all } = atlas();
    expect(exclusionYaml(proposeExclusions(files, all).proposals)).toBe(
      [
        "exclude:",
        '  - { path: "research/**", why: "data, not code: 13 .json files", at: "research/tables/index.json:1" }',
        '  - { path: "docs/**", why: "documentation, not the product: 8 .html files, 1 .js file", at: "docs/site/page0.html:1" }',
        '  - { path: "jar/**", why: "its own LICENSE and no build file: a vendored copy of third-party code? Check before accepting", at: "jar/LICENSE:1" }',
        "",
      ].join("\n"),
    );
  });
});

describe("reading a big repo in parts (A-big)", () => {
  const big = (): FileTokens[] => [
    { path: "pom.xml", tokens: 1_000 },
    { path: "Dockerfile", tokens: 200 },
    ...["accounts", "ledger", "payments", "reports"].flatMap((m) =>
      Array.from({ length: 10 }, (_, i) => ({
        path: `services/${m}/src/main/java/forge/${m}/C${i}.java`,
        tokens: 6_000,
      })),
    ),
    ...Array.from({ length: 30 }, (_, i) => ({ path: `web/src/S${i}.tsx`, tokens: 3_000 })),
  ];

  it("needs no parts when the repo fits one session", () => {
    expect(planParts([{ path: "a.java", tokens: SESSION_TOKENS }])).toEqual([]);
  });

  it("splits by module, balanced by tokens, each part within the room, every file once", () => {
    const files = big();
    const parts = planParts(files, 100_000);
    expect(parts.map((p) => [p.paths, p.tokens])).toEqual([
      [["*", "services/accounts/**"], 61_200],
      [["services/ledger/**"], 60_000],
      [["services/payments/**"], 60_000],
      [["services/reports/**"], 60_000],
      [["web/**"], 90_000],
    ]);
    expect(parts.reduce((n, p) => n + p.files, 0)).toBe(files.length);
    for (const p of parts) expect(p.tokens).toBeLessThanOrEqual(100_000);
  });

  it("joins small modules into one part, neighbours together", () => {
    const parts = planParts(big(), 200_000);
    expect(parts.map((p) => [p.paths, p.tokens])).toEqual([
      [["*", "services/accounts/**", "services/ledger/**", "services/payments/**"], 181_200],
      [["services/reports/**", "web/**"], 150_000],
    ]);
  });

  it("is the same plan for the same files, in any order", () => {
    const files = big();
    expect(planParts([...files].reverse(), 100_000)).toEqual(planParts(files, 100_000));
  });
});
