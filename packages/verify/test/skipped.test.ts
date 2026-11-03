import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFacts, type Fact } from "@maycombhq/core";
import {
  candidatesIn,
  dirSource,
  memorySource,
  notReadForSkipped,
  parseReviewed,
  verifyFacts,
  type ReviewedEntry,
} from "../src/index.js";

/**
 * R1: the lines the reader skipped. Plain text patterns, in any language, find the strings that
 * look like a path, a URL or a topic; verify lists those of the files read that no kept fact
 * cites, the reviewed globs whose files write one, and the operations a repo's OpenAPI spec
 * declares that no entry covers. A note for the reader to check, never a fact or a rejection.
 */
const values = (path: string, text: string) =>
  candidatesIn(path, text.split("\n")).map((c) => `${c.kind} ${c.value}`);

describe("candidatesIn: path, URL and topic strings, in any language", () => {
  const cases: [string, string, string, string[]][] = [
    ["Spring", "A.java", '@GetMapping("/accounts/{id}")', ["path /accounts/{id}"]],
    ["ASP.NET", "A.cs", '[HttpGet("/api/v1/accounts/{id}")]', ["path /api/v1/accounts/{id}"]],
    ["Express", "a.js", "router.delete('/notes/:id', remove);", ["path /notes/:id"]],
    ["Flask", "a.py", '@app.route("/limits/<id>", methods=["PUT"])', ["path /limits/<id>"]],
    ["Go", "a.go", 'r.HandleFunc("/healthz", h)', ["path /healthz"]],
    ["a template", "a.ts", "fetch(`${base}/v2/rates/${pair}`)", ["path /v2/rates/${pair}"]],
    ["a format string", "a.go", 'fmt.Sprintf("%s/cards/%s", base, id)', ["path /cards/%s"]],
    [
      "a URL",
      "A.kt",
      'val base = "https://ledger.forge.internal/v1"',
      ["url https://ledger.forge.internal/v1"],
    ],
    [
      "a YAML URL",
      "a.yml",
      "  url: https://rates.forge.internal",
      ["url https://rates.forge.internal"],
    ],
    ["a YAML path", "a.yaml", "    path: /actuator/health", ["path /actuator/health"]],
    ["a properties path", "a.properties", "server.servlet.context-path=/wallet", ["path /wallet"]],
    ["an XML path", "p.xml", "  <BasePath>/v1/accounts</BasePath>", ["path /v1/accounts"]],
    [
      "a dotted topic",
      "A.java",
      'publisher.send("forge.accounts.created", e);',
      ["topic forge.accounts.created"],
    ],
    [
      "a Kafka listener",
      "L.java",
      '@KafkaListener(topics = "ledger-entries")',
      ["topic ledger-entries"],
    ],
    ["a YAML topic", "a.yml", "  topic: forge.wallet.audit", ["topic forge.wallet.audit"]],
    ["a queue by key", "a.yml", "  queue-name: payments_settled", ["topic payments_settled"]],
    ["a Ruby route", "routes.rb", 'get "/notes/:id", to: "notes#show"', ["path /notes/:id"]],
    [
      "a COBOL-ish literal",
      "X.cbl",
      "    MOVE '/forge/batch/run' TO WS-PATH.",
      ["path /forge/batch/run"],
    ],
  ];
  for (const [what, path, line, want] of cases)
    it(`finds ${want.join(", ")} in ${what}`, () => {
      expect(values(path, line)).toEqual(want);
    });

  const none: [string, string, string][] = [
    ["a line comment", "A.java", '  // GET "/wallets/legacy" was removed'],
    ["a hash comment", "a.yml", "# path: /old/health"],
    ["a trailing comment", "a.ts", 'const n = 1; // see "/wallets/old"'],
    ["a JS import", "a.ts", 'import { x } from "/static/vendor/lib";'],
    ["a require", "a.js", 'const cfg = require("/opt/forge/config");'],
    ["a Python import", "a.py", "from forge.accounts.models import Account"],
    ["a Java import", "A.java", "import forge.accounts.events.Created;"],
    ["a Go import", "a.go", 'import "github.com/forge/accounts/pkg"'],
    ["an asset", "a.ts", 'const logo = "/assets/logo.svg";'],
    ["a file system path", "Dockerfile", 'ENTRYPOINT ["java", "-jar", "/usr/local/app.jar"]'],
    ["a tmp path", "a.sh", 'OUT="/tmp/forge/out"'],
    ["an XML namespace", "pom.xml", '<project xmlns="http://maven.apache.org/POM/4.0.0">'],
    [
      "a schema location",
      "a.xml",
      '  xsi:schemaLocation="http://www.springframework.org/schema/beans">',
    ],
    ["a licence URL", "A.java", 'String L = "https://www.apache.org/licenses/LICENSE-2.0";'],
    ["a placeholder", "A.java", '@Value("${forge.notify.base-url}")'],
    ["a sentence", "A.java", 'throw new IllegalStateException("account is closed / frozen");'],
    ["a package name", "A.java", 'Logger.getLogger("com.forge.accounts.Service");'],
    ["a file name", "A.java", 'load("application.prod.yml");'],
    ["a host alone in a dotted string", "A.java", 'String h = "api.northwind.example";'],
    ["a Spring key", "A.java", 'env.getProperty("spring.datasource.url");'],
    ["a slash alone", "a.ts", 'if (p === "/") return;'],
    ["a regex", "a.ts", 'const re = new RegExp("/^\\\\d+$/");'],
    ["a JS doc line", "a.ts", " * GET /wallets/{id} returns the wallet"],
  ];
  for (const [what, path, line] of none)
    it(`finds nothing in ${what}`, () => {
      expect(values(path, line)).toEqual([]);
    });

  it("skips a block comment across lines, in C-like code and in XML", () => {
    expect(values("A.java", '/*\n  "/admin/wallets"\n*/\nx("/kept/one");')).toEqual([
      "path /kept/one",
    ]);
    expect(values("a.xml", "<!--\n<Path>/old</Path>\n-->\n<Path>/new</Path>")).toEqual([
      "path /new",
    ]);
  });

  it("leaves out a build file's artifact repositories, distribution and SCM, keeping real calls", () => {
    const pom = [
      "<project>",
      "  <properties>",
      "    <ci.git.url>https://git.forge.example/forge/ledger.git</ci.git.url>",
      "    <ledger.base-url>https://ledger.forge.internal/v1</ledger.base-url>",
      "  </properties>",
      "  <repositories>",
      "    <repository>",
      "      <id>forge-releases</id>",
      "      <url>https://nexus.forge.example/repository/maven-releases/</url>",
      "    </repository>",
      "  </repositories>",
      "  <distributionManagement>",
      "    <snapshotRepository>",
      "      <url>https://nexus.forge.example/repository/maven-snapshots/</url>",
      "    </snapshotRepository>",
      "  </distributionManagement>",
      "  <scm>",
      "    <connection>scm:git:https://git.forge.example/forge/ledger.git</connection>",
      "    <url>https://git.forge.example/forge/ledger</url>",
      "  </scm>",
      "</project>",
    ].join("\n");
    expect(values("pom.xml", pom)).toEqual(["url https://ledger.forge.internal/v1"]);
    const gradle = [
      "repositories {",
      "    maven { url 'https://nexus.forge.example/repository/maven-public/' }",
      "}",
      "def rates = 'https://rates.forge.internal/v2'",
    ].join("\n");
    expect(values("build.gradle", gradle)).toEqual(["url https://rates.forge.internal/v2"]);
    // A second stack: an npm package and a .NET project say the same in their own words.
    const pkg = [
      "{",
      '  "repository": { "type": "git", "url": "https://git.forge.example/forge/portal.git" },',
      '  "publishConfig": { "registry": "https://npm.forge.example/" },',
      '  "config": { "apiBase": "https://portal-bff.forge.internal/api" }',
      "}",
    ].join("\n");
    expect(values("package.json", pkg)).toEqual(["url https://portal-bff.forge.internal/api"]);
    expect(values(".npmrc", "registry=https://npm.forge.example/")).toEqual([]);
    expect(
      values(
        "Forge.Cards.csproj",
        "    <RepositoryUrl>https://git.forge.example/forge/cards</RepositoryUrl>",
      ),
    ).toEqual([]);
    // CI settings that point at the git host, by their key.
    expect(
      values("gradle.properties", "ci.scm.url=https://git.forge.example/forge/ledger"),
    ).toEqual([]);
  });

  it("leaves out an HTTP header's name, which a dotted or separated name can look like a topic", () => {
    const java = [
      'headers.set("X-Forge.requestingChannel", channel);',
      'public Account get(@RequestHeader("Forge.sourceChannel") String channel) {',
      '@RequestHeader(value = "forge-channel-id") String id',
      'publisher.send("forge.accounts.created", e);',
    ].join("\n");
    expect(values("A.java", java)).toEqual(["topic forge.accounts.created"]);
    // A second stack: TypeScript and C#.
    expect(
      values(
        "a.ts",
        [
          "const h = { 'X-Forge.channel': 'web' };",
          "req.setHeader('forge.request.channel', c);",
          "await bus.publish('forge.notes.archived', n);",
        ].join("\n"),
      ),
    ).toEqual(["topic forge.notes.archived"]);
    expect(values("A.cs", 'request.Headers.Add("X-Forge.Channel-Id", channel);')).toEqual([]);
  });

  it("gives each candidate its line number and the line as written", () => {
    expect(candidatesIn("A.java", ["", '  x("/one");', "", 'y("/two");'])).toEqual([
      { line: 2, kind: "path", value: "/one", text: 'x("/one");' },
      { line: 4, kind: "path", value: "/two", text: 'y("/two");' },
    ]);
  });
});

describe("notReadForSkipped: folders whose strings aren't the product's", () => {
  it("leaves out generated, build-output and vendored folders", () => {
    for (const p of [
      "generated/LedgerApi.java",
      "src/generated/x.ts",
      "target/generated-sources/A.java",
      "web/dist/main.js",
      "third_party/acme/A.java",
      "src/__generated__/schema.ts",
    ])
      expect(notReadForSkipped(p), p).toBe(true);
    expect(notReadForSkipped("src/main/java/forge/wallet/A.java")).toBe(false);
  });
});

const FIX = join(__dirname, "..", "..", "..", "fixtures", "verify-skipped");
const repo = dirSource(join(FIX, "repo"));
const COMMIT = "5e1f00d";
const facts = (): Fact[] => {
  const r = parseFacts(readFileSync(join(FIX, "forge-wallet.facts.jsonl"), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const reviewedLines = (): ReviewedEntry[] => {
  const r = parseReviewed(readFileSync(join(FIX, "forge-wallet.reviewed.jsonl"), "utf8"));
  expect(r.bad).toEqual([]);
  return r.entries;
};

describe("verifyFacts: the lines the reader skipped (R1)", () => {
  it("lists them, the reviewed globs that hold some, and the spec's uncovered operations, as the golden file says", async () => {
    const r = await verifyFacts({
      facts: facts(),
      source: repo,
      commit: COMMIT,
      reviewed: reviewedLines(),
      exclude: ["third_party/**"],
    });
    expect(r.rejected).toEqual([]);
    const want = JSON.parse(readFileSync(join(FIX, "expected.json"), "utf8"));
    expect(r.skipped).toEqual(want.skipped);
    expect(r.reviewedHolds).toEqual(want.reviewedHolds);
    expect(r.specOpsUncovered).toEqual(want.specOpsUncovered);
  });

  it("is a note: it never rejects a fact or changes what is kept", async () => {
    const r = await verifyFacts({ facts: facts(), source: repo, commit: COMMIT });
    expect(r.rejected).toEqual([]);
    expect(r.accepted.map((f) => f.id).sort()).toEqual(
      facts()
        .map((f) => f.id)
        .sort(),
    );
  });

  it("lists nothing more once a fact cites the line, or names the same value elsewhere", async () => {
    const more = parseFacts(
      [
        readFileSync(join(FIX, "forge-wallet.facts.jsonl"), "utf8").trim(),
        JSON.stringify({
          kind: "call",
          id: "c-hold-released",
          repo: "forge-wallet",
          commit: COMMIT,
          component: "wallet-api",
          callType: "event-topic",
          path: "forge.wallet.hold-released",
          cite: {
            file: "src/main/java/forge/wallet/HoldEvents.java",
            line: 11,
            value: "forge.wallet.hold-released",
          },
        }),
        JSON.stringify({
          kind: "entry",
          id: "e-post-freeze",
          repo: "forge-wallet",
          commit: COMMIT,
          component: "wallet-api",
          entryType: "rest",
          method: "POST",
          path: "/wallets/{id}/freeze",
          cite: {
            file: "src/main/java/forge/wallet/WalletController.java",
            line: 23,
            value: "/{id}/freeze",
            with: [
              {
                file: "src/main/java/forge/wallet/WalletController.java",
                line: 9,
                value: "/wallets",
              },
            ],
          },
        }),
      ].join("\n"),
    );
    if (!more.ok) throw new Error(JSON.stringify(more.issues));
    const r = await verifyFacts({ facts: more.facts, source: repo, commit: COMMIT });
    const cites = r.skipped.map((s) => s.cite);
    expect(cites).not.toContain("src/main/java/forge/wallet/HoldEvents.java:11");
    expect(cites).not.toContain("src/main/java/forge/wallet/WalletController.java:23");
    // the spec's freeze is covered by the new entry; the history stays
    expect(r.specOpsUncovered.map((o) => `${o.method} ${o.path}`)).toEqual([
      "GET /wallets/{id}/history",
    ]);
  });

  it("looks only at the files the reader read: an unread file is already listed as unknown", async () => {
    const r = await verifyFacts({
      facts: [],
      source: memorySource({ "src/A.java": 'x("/not/read");' }),
    });
    expect(r.coverage.unknown).toEqual(["src/A.java"]);
    expect(r.skipped).toEqual([]);
  });

  it("redacts a secret written in a URL it lists", async () => {
    const r = await verifyFacts({
      facts: [],
      source: memorySource({
        "src/A.java": 'String u = "https://svc:hunter2pass@ledger.forge.internal/v1";',
      }),
      routed: ["src/A.java"],
    });
    expect(JSON.stringify(r.skipped)).not.toContain("hunter2pass");
    expect(r.skipped).toHaveLength(1);
  });
});
