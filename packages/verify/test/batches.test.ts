import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  dirSource,
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
