import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { CatalogRecord } from "@maycombhq/core";
import { fsRepo, memoryRepo, scanRepo } from "@maycombhq/sdk";
import { readSpecKitFeatures, SPECKIT_EXTRACTORS, speckitExtractor } from "../src/speckit/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures/speckit");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const AT = "2026-10-20T08:00:00Z";
const INFO = { component: "ledger-api", system: "ledger", repoType: "forge-service" };

type Rec = Record<string, unknown> & { kind: string; id: string; evidence: Rec[] };

function bare(r: CatalogRecord): Rec {
  const x = r as unknown as Rec;
  return {
    ...x,
    evidence: x.evidence.map((e) => {
      const { repo: _r, commit: _c, scannedAt: _s, extractor: _x, ...rest } = e;
      return rest;
    }),
  };
}

const sortKey = (r: { kind: string; id: string }) => `${r.kind}|${r.id}`;

describe("speckit extractor (golden)", () => {
  it("reads contracts, data-model.md, the structured parts of plan.md and tasks.md", async () => {
    const s = await scanRepo({
      repo: fsRepo("forge-ledger", join(FIX, "ledger-plan"), SHA),
      extractors: [speckitExtractor],
      scannedAt: AT,
      repoInfo: INFO,
    });
    expect(s.rejected).toEqual([]);
    expect(s.runs.map((r) => r.status)).toEqual(["ran"]);
    const want = (parse(readFileSync(join(FIX, "ledger-plan.expected.yaml"), "utf8")) as Rec[]).map(
      (r) => ({ schemaVersion: 2, ...r }),
    );
    const got = s.records.map(bare);
    expect(got.map(sortKey).sort()).toEqual(want.map(sortKey).sort());
    for (const w of want) expect(got.find((g) => sortKey(g) === sortKey(w))).toEqual(w);
  });

  it("stamps every record as the speckit extractor's, planned and inferred", async () => {
    const s = await scanRepo({
      repo: fsRepo("forge-ledger", join(FIX, "ledger-plan"), SHA),
      extractors: SPECKIT_EXTRACTORS,
      scannedAt: AT,
      repoInfo: INFO,
    });
    for (const r of s.records) {
      expect(r.status).toMatch(/^planned-/);
      expect(r.confidence).toBe("inferred");
      expect(r.evidence[0]!.extractor).toBe(`speckit@${speckitExtractor.version}`);
    }
  });

  it("ignores a specs/ folder in a repo without .specify/ (not a Spec Kit repo)", async () => {
    const s = await scanRepo({
      repo: fsRepo("notes", join(FIX, "no-specify"), SHA),
      extractors: [speckitExtractor],
      scannedAt: AT,
    });
    expect(s.records).toEqual([]);
  });

  it("is deterministic and tolerates broken files with warnings", async () => {
    const repo = memoryRepo("forge-ledger", SHA, {
      ".specify/memory/constitution.md": "# C\n",
      "specs/2.1/contracts/broken.yaml": "openapi: 3.0.0\npaths: [\n",
      "specs/2.1/contracts/notes.md": "# not a contract\n",
      "specs/2.1/data-model.md":
        "# Data Model\n\n### orphan (new table)\n\n| Column | Type |\n| --- | --- |\n| id | bigint |\n",
      "specs/2.1/plan.md":
        "# Plan\n\n### Services this feature calls\n\n| Service | Operation | Via | Pattern | Status |\n| --- | --- | --- | --- | --- |\n| Not An Id | GET /x | carrier-pigeon |  | someday |\n| ok-svc | GET /ok | pigeon |  |  |\n",
    });
    const a = await scanRepo({
      repo,
      extractors: [speckitExtractor],
      scannedAt: AT,
      repoInfo: INFO,
    });
    const b = await scanRepo({
      repo,
      extractors: [speckitExtractor],
      scannedAt: AT,
      repoInfo: INFO,
    });
    expect(a.records).toEqual(b.records);
    expect(a.rejected).toEqual([]);
    // No data store named and no datasource config: the store falls back like the migrations extractor's.
    expect(a.records.find((r) => r.kind === "Table")?.id).toBe("ledger-db.orphan");
    const ifs = a.records.filter((r) => r.kind === "Interface") as unknown as Rec[];
    expect(ifs.map((i) => [i.to, i.via, i.status])).toEqual([["ok-svc", "other", "planned-new"]]);
    expect(a.warnings.map((w) => w.message)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/specs\/2.1\/contracts\/broken.yaml/),
        expect.stringMatching(/"Not An Id" is not a service id/),
      ]),
    );
  });
});

describe("readSpecKitFeatures (the report hand-up and drift read)", () => {
  it("gives stack, files touched, task progress and the planned records per feature", async () => {
    const repo = fsRepo("forge-ledger", join(FIX, "ledger-plan"), SHA);
    const [f, ...rest] = await readSpecKitFeatures(repo, {
      component: "ledger-api",
      system: "ledger",
      scannedAt: AT,
      dialects: [],
      warn: () => undefined,
    });
    expect(rest).toEqual([]);
    expect(f!.feature).toBe("1.2-transfer-limit");
    expect(f!.dir).toBe("specs/1.2-transfer-limit");
    expect(f!.files).toEqual([
      "specs/1.2-transfer-limit/contracts/ledger-api.yaml",
      "specs/1.2-transfer-limit/contracts/limit-events.yaml",
      "specs/1.2-transfer-limit/data-model.md",
      "specs/1.2-transfer-limit/plan.md",
      "specs/1.2-transfer-limit/spec.md",
      "specs/1.2-transfer-limit/tasks.md",
    ]);
    expect(f!.stack).toEqual({
      "language/version": "Java 21",
      "primary dependencies": "Forge framework 3, Spring JDBC",
      storage: "ledger-db (PostgreSQL)",
      testing: "JUnit 5, Testcontainers",
      "target platform": "OpenShift",
      "project type": "single",
      "performance goals": "NEEDS CLARIFICATION",
      constraints: "the limit check adds no more than 20 ms to POST /transfers",
    });
    expect(f!.structure).toEqual([
      "src/main/java/forge/ledger/LedgerEndpoints.java",
      "src/main/java/forge/ledger/TransferLimits.java",
      "src/main/resources/db/migration/V3__add_daily_limit.sql",
    ]);
    expect(f!.tasks).toEqual([
      {
        id: "T001",
        done: true,
        line: 5,
        text: "Add the migration in src/main/resources/db/migration/V3__add_daily_limit.sql",
        files: ["src/main/resources/db/migration/V3__add_daily_limit.sql"],
        story: undefined,
        parallel: false,
      },
      {
        id: "T002",
        done: true,
        line: 6,
        text: "Add LIMIT_EXCEEDED to contracts/ledger-api.yaml",
        files: ["contracts/ledger-api.yaml"],
        story: undefined,
        parallel: true,
      },
      {
        id: "T003",
        done: false,
        line: 10,
        text: "Sum today's entries in src/main/java/forge/ledger/TransferLimits.java",
        files: ["src/main/java/forge/ledger/TransferLimits.java"],
        story: "US1",
        parallel: false,
      },
      {
        id: "T004",
        done: false,
        line: 11,
        text: "Refuse over-limit transfers in src/main/java/forge/ledger/LedgerEndpoints.java",
        files: ["src/main/java/forge/ledger/LedgerEndpoints.java"],
        story: "US1",
        parallel: false,
      },
      {
        id: "T005",
        done: false,
        line: 12,
        text: "Test the limit in src/test/java/forge/ledger/TransferLimitsTest.java",
        files: ["src/test/java/forge/ledger/TransferLimitsTest.java"],
        story: "US1",
        parallel: false,
      },
    ]);
    expect(f!.records.length).toBe(18);
  });
});
