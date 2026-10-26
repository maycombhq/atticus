import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  dirSource,
  FILE_KINDS,
  fileKinds,
  kindsOf,
  isSourceFile,
  memorySource,
  numberedSlice,
  planBatches,
  readingOrder,
  readingRank,
  sliceText,
} from "../src/index.js";

const repo = join(__dirname, "fixtures", "repo");
const L = "src/main/java/forge/ledger";

const ORDER = [
  "k8s/ledger-api.yaml",
  "src/main/resources/application.yml",
  `${L}/AccountController.java`,
  `${L}/EntryController.java`,
  `${L}/SettlementListener.java`,
  "generated/client.ts",
  `${L}/AccountRepository.java`,
  `${L}/EntryRepository.java`,
  `${L}/EntryRequest.java`,
  `${L}/FxClient.java`,
  "src/main/resources/db/migration/V2__create_entry.sql",
  `${L}/Notifier.java`,
];

describe("readingOrder: build and deploy files, config, then entry points (ADR 0124 §4)", () => {
  it("orders the Forge ledger's source files the way a reader outlines a repo", () => {
    const paths = dirSource(repo)
      .list()
      .filter((p) => isSourceFile(p));
    expect(readingOrder(paths)).toEqual(ORDER);
  });

  it("puts build files first and tests last, whatever the language", () => {
    expect(readingRank("pom.xml")).toBe(0);
    expect(readingRank("api/build.gradle.kts")).toBe(0);
    expect(readingRank("web/package.json")).toBe(0);
    expect(readingRank("Dockerfile")).toBe(0);
    expect(readingRank(".github/workflows/ci.yml")).toBe(0);
    expect(readingRank("infra/main.tf")).toBe(0);
    expect(readingRank("src/Forge.Api/Forge.Api.csproj")).toBe(0);
    expect(readingRank("src/main/resources/application-prod.properties")).toBe(1);
    expect(readingRank("appsettings.Development.json")).toBe(1);
    expect(readingRank("src/routes/orders.ts")).toBe(2);
    expect(readingRank("app/main.py")).toBe(2);
    expect(readingRank("cmd/server/main.go")).toBe(2);
    expect(readingRank("src/clients/ledgerClient.ts")).toBe(3);
    expect(readingRank("proto/ledger.proto")).toBe(3);
    expect(readingRank("src/util/strings.ts")).toBe(4);
    expect(readingRank("src/test/java/forge/AccountControllerTest.java")).toBe(5);
    expect(readingRank("web/src/orders.test.ts")).toBe(5);
    expect(readingRank("tests/test_orders.py")).toBe(5);
  });
});

describe("planBatches: every source line once, each batch within the room (ADR 0112)", () => {
  it("puts a small repo in one batch when the room allows, files whole and in reading order", () => {
    const p = planBatches(dirSource(repo), { room: 100_000 });
    expect(p.batches).toHaveLength(1);
    expect(p.files).toBe(12);
    expect(p.batches[0]!.map((s) => s.path)).toEqual(ORDER);
    for (const s of p.batches[0]!) expect(s.from).toBe(1);
    // The secret file and the README are no source: never sent.
    expect(p.batches.flat().some((s) => s.path === ".env" || s.path === "README.md")).toBe(false);
  });

  it("slices into batches that each fit the room, covering every line exactly once", () => {
    const source = dirSource(repo);
    const room = 400;
    const p = planBatches(source, { room });
    expect(p.batches.length).toBeGreaterThan(2);
    for (const b of p.batches) {
      const tokens = b.reduce((n, s) => n + s.tokens, 0);
      // A slice that can't be cut smaller (one line) may stand alone; none here.
      expect(tokens).toBeLessThanOrEqual(room);
    }
    const seen = new Map<string, number[]>();
    for (const s of p.batches.flat()) {
      const lines = seen.get(s.path) ?? [];
      for (let n = s.from; n <= s.to; n++) lines.push(n);
      seen.set(s.path, lines);
    }
    for (const [path, lines] of seen) {
      const total = source
        .read(path)!
        .replace(/\r\n?/g, "\n")
        .replace(/\n$/, "")
        .split("\n").length;
      expect(lines, path).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    }
    expect(p.lines).toBe([...seen.values()].reduce((n, l) => n + l.length, 0));
  });

  it("cuts a file too big for one prompt into line ranges, numbered as in the file", () => {
    const big = Array.from({ length: 300 }, (_, i) => `line ${i + 1} of the ledger job`).join("\n");
    const source = memorySource({ "src/LedgerJob.java": big, "pom.xml": "<project/>\n" });
    const p = planBatches(source, { room: 600 });
    const slices = p.batches.flat().filter((s) => s.path === "src/LedgerJob.java");
    expect(slices.length).toBeGreaterThan(1);
    expect(slices[0]!.from).toBe(1);
    expect(slices.at(-1)!.to).toBe(300);
    for (let i = 1; i < slices.length; i++) expect(slices[i]!.from).toBe(slices[i - 1]!.to + 1);
    const second = slices[1]!;
    const text = numberedSlice(source.read("src/LedgerJob.java")!, second);
    expect(text.split("\n")[0]).toBe(`${second.from}| line ${second.from} of the ledger job`);
    expect(sliceText(source, second)).toContain(
      `src/LedgerJob.java lines ${second.from}-${second.to} of 300 (numbered as in the file)`,
    );
  });

  it("leaves out what an accepted exclusion names, and says so", () => {
    const p = planBatches(dirSource(repo), { room: 100_000, exclude: ["generated/**"] });
    expect(p.excluded).toEqual(["generated/client.ts"]);
    expect(p.batches.flat().some((s) => s.path.startsWith("generated/"))).toBe(false);
  });

  it("is deterministic: the same repo and room give the same batches", () => {
    const a = planBatches(dirSource(repo), { room: 500 });
    const b = planBatches(dirSource(repo), { room: 500 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("fileKinds: which topic rules of the protocol a file's batch needs (ADR 0124 addendum A-lean)", () => {
  const BACK = ["backend", "routes", "data", "protocols", "flows"];
  const CODE = ["frontend", "backend", "routes", "data", "protocols", "flows"];

  it("gives server-side code every code topic but the front end's", () => {
    expect(fileKinds(`${L}/EntryController.java`)).toEqual(BACK);
    expect(fileKinds("src/Forge.Api/Controllers/OrdersController.cs")).toEqual(BACK);
    expect(fileKinds("app/main.py")).toEqual(BACK);
    expect(fileKinds("cmd/server/main.go")).toEqual(BACK);
    expect(fileKinds("src/orders/orders.controller.ts")).toEqual(BACK);
  });

  it("gives front-end files the front end's topics, and both sides when the path can't say", () => {
    expect(fileKinds("web/src/components/OrderForm.tsx")).toEqual(["frontend", "flows"]);
    expect(fileKinds("web/src/app/orders/order-list.component.ts")).toEqual(["frontend", "flows"]);
    expect(fileKinds("web/src/app/orders/order-list.component.html")).toEqual([
      "frontend",
      "flows",
    ]);
    expect(fileKinds("web/src/views/Orders.vue")).toEqual(["frontend", "flows"]);
    // A page a server renders also serves its route.
    expect(fileKinds("Pages/Accounts/Index.cshtml")).toEqual(["frontend", "routes", "flows"]);
    expect(fileKinds("src/main/resources/templates/account.html")).toEqual([
      "frontend",
      "routes",
      "flows",
    ]);
    // Code behind a page, a Next.js page and a plain .ts file could be either side: both.
    expect(fileKinds("Pages/Accounts/Index.cshtml.cs")).toEqual(CODE);
    expect(fileKinds("app/orders/page.tsx")).toEqual(CODE);
    expect(fileKinds("generated/client.ts")).toEqual(CODE);
    expect(fileKinds("src/util/strings.ts")).toEqual(CODE);
  });

  it("gives build, deploy and config files their own topics, infrastructure as code a few more", () => {
    expect(fileKinds("k8s/ledger-api.yaml")).toEqual(["deploy", "config"]);
    expect(fileKinds("Dockerfile")).toEqual(["deploy", "config"]);
    expect(fileKinds("charts/ledger/values-prod.yaml")).toEqual(["deploy", "config"]);
    expect(fileKinds(".github/workflows/ci.yml")).toEqual(["deploy", "config"]);
    expect(fileKinds("pom.xml")).toEqual(["deploy", "config"]);
    expect(fileKinds("infra/main.tf")).toEqual(["routes", "data", "deploy", "config", "protocols"]);
    expect(fileKinds("serverless.yml")).toEqual([
      "routes",
      "data",
      "deploy",
      "config",
      "protocols",
    ]);
    expect(fileKinds("src/main/resources/application.yml")).toEqual(["config"]);
    expect(fileKinds("appsettings.Production.json")).toEqual(["config"]);
    // Code that holds settings (an environment file, a settings module) is config too.
    expect(fileKinds("web/src/environments/environment.prod.ts")).toContain("config");
    expect(fileKinds("config/environments/production.rb")).toEqual([
      "backend",
      "routes",
      "data",
      "config",
      "protocols",
      "flows",
    ]);
  });

  it("gives schemas, migrations and contracts theirs, and an unknown file every topic", () => {
    expect(fileKinds("src/main/resources/db/migration/V2__create_entry.sql")).toEqual(["data"]);
    expect(fileKinds("proto/ledger.proto")).toEqual(["protocols"]);
    expect(fileKinds("schema/ledger.graphql")).toEqual(["routes", "protocols"]);
    expect(fileKinds("api/openapi.yaml")).toEqual(["routes", "protocols"]);
    expect(fileKinds("ops/kong.yaml")).toEqual(["routes", "data", "deploy", "config", "protocols"]);
    // Every kind but the gateway's: a gateway's files are told by their paths (A-gateway).
    expect(fileKinds("scripts/release.sh")).toEqual(FILE_KINDS.filter((k) => k !== "gateway"));
  });

  it("a batch's kinds are its files' kinds together, in one order", () => {
    expect(kindsOf(["k8s/ledger-api.yaml", "src/main/resources/application.yml"])).toEqual([
      "deploy",
      "config",
    ]);
    expect(kindsOf([])).toEqual([]);
  });
});

describe("planBatches with instructions that grow with a batch's kinds (A-lean)", () => {
  // Stand-in topic rules: 50 tokens for each kind a batch's files have.
  const overhead = (kinds: readonly string[]) => kinds.length * 50;

  it("keeps each batch's files and its topic rules within the room", () => {
    const room = 700;
    const p = planBatches(dirSource(repo), { room, overhead });
    for (const b of p.batches) {
      const tokens = b.reduce((n, s) => n + s.tokens, 0);
      expect(tokens + overhead(kindsOf(b.map((s) => s.path)))).toBeLessThanOrEqual(room);
    }
    // The least room a file had after its own topic rules: the generated client's six kinds (a
    // .ts file could be either side).
    expect(p.leastRoom).toBe(room - 6 * 50);
  });

  it("plans exactly as before without them", () => {
    const a = planBatches(dirSource(repo), { room: 500 });
    const b = planBatches(dirSource(repo), { room: 500, overhead: () => 0 });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(a.leastRoom).toBe(500);
  });
});
