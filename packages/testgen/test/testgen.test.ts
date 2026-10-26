import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { MockRuntime, ReplayRuntime } from "@maycombhq/ai";
import {
  generateTests,
  mappedFields,
  mutations,
  readHeader,
  sha256,
  splitCriterion,
  TestgenError,
  writeGenerated,
  type ApiCase,
  type ContractCase,
} from "../src/index.js";
import {
  CHANGE,
  changeDir,
  expected,
  FIXTURES,
  FORGE_CHANGE,
  forgeChangeRoot,
  NOW,
  read,
  worktree,
} from "./helpers.js";

const S1 = "s1-daily-transfer-limit";
const S2 = "s2-remaining-limit";
const S3 = "s3-northwind-pay-velocity-checks";
const S4 = "s4-limit-change-events";
const JAVA = "src/test/java/atticus/add_transfer_limit";

/** A generated file's body (without the header), after checking the header's hash. */
async function body(path: string): Promise<string> {
  const h = readHeader(await read(path));
  expect(h, path).toBeDefined();
  expect(sha256(h!.body)).toBe(h!.hash);
  return h!.body;
}

describe("test generation (golden on the forge change)", () => {
  it("writes the acceptance feature, API, contract and data tests into each repo's change worktree", async () => {
    const root = await forgeChangeRoot();
    const r = await generateTests(root, CHANGE, S1, { now: NOW });
    expect(r.names.by).toBe("fallback");
    expect(r.gaps).toEqual([]);
    const want = parse(expected("s1-cases.yaml")) as Record<string, string[][]>;
    expect(
      Object.fromEntries(
        r.model.repos.map((x) => [
          x.repo,
          x.cases.map((c) => [c.id, c.name, ...(c.type === "api" ? [c.expect.status] : [])]),
        ]),
      ),
    ).toEqual(want);
    expect(
      r.files.map((f) => [
        f.repo,
        f.generator,
        f.path.replace(/^workspace\/\.worktrees\/add-transfer-limit\//, ""),
        f.action,
      ]),
    ).toEqual([
      [
        "forge-ledger",
        "gherkin",
        "forge-ledger/src/test/resources/features/s1-daily-transfer-limit.feature",
        "created",
      ],
      [
        "forge-ledger",
        "json",
        "forge-ledger/src/test/resources/atticus/s1-daily-transfer-limit.tests.json",
        "created",
      ],
      [
        "forge-ledger",
        "junit5-restassured",
        `forge-ledger/${JAVA}/S1DailyTransferLimitApiTest.java`,
        "created",
      ],
      [
        "forge-ledger",
        "junit5-restassured",
        `forge-ledger/${JAVA}/S1DailyTransferLimitContractTest.java`,
        "created",
      ],
      [
        "forge-ledger",
        "junit5-restassured",
        `forge-ledger/${JAVA}/S1DailyTransferLimitDataTest.java`,
        "created",
      ],
      [
        "forge-portal-bff",
        "json",
        "forge-portal-bff/src/test/resources/atticus/s1-daily-transfer-limit.tests.json",
        "created",
      ],
      [
        "forge-portal-bff",
        "junit5-restassured",
        `forge-portal-bff/${JAVA}/S1DailyTransferLimitContractTest.java`,
        "created",
      ],
    ]);
    expect(
      await body(
        join(
          worktree(root, "forge-ledger"),
          "src/test/resources/features/s1-daily-transfer-limit.feature",
        ),
      ),
    ).toBe(expected("s1-daily-transfer-limit.feature"));
  });

  it("links the documented error to the criterion that names its code, and the consumer to the gateway path", async () => {
    const root = await forgeChangeRoot();
    const r = await generateTests(root, CHANGE, S1, { now: NOW });
    const ledger = r.model.repos.find((x) => x.repo === "forge-ledger")!;
    const err = ledger.cases.find((c) => c.id === "api.post-transfers.status-422") as ApiCase;
    expect(err).toMatchObject({
      scenario: "acceptance.c1",
      endpoint: "ledger-api.post-transfer",
      interfaceId: "if-d99f508a2ac9b6e0",
      expect: { status: "422", body: { error: "LIMIT_EXCEEDED", remaining: 100 } },
    });
    const consumer = r.model.repos.find((x) => x.repo === "forge-portal-bff")!
      .cases[0] as ContractCase;
    expect(consumer).toMatchObject({
      role: "consumer",
      consumerPath: "/ledger/v1/transfers",
      errors: [{ status: "422", code: "LIMIT_EXCEEDED" }],
      spec: "forge-ledger:api/ledger-openapi.yaml",
      gaps: [],
    });
    expect(consumer.checks).toEqual([
      "portal-bff sends POST /ledger/v1/transfers",
      "it handles 422 LIMIT_EXCEEDED",
    ]);
    const data = ledger.cases.find((c) => c.id === "data.account.daily-limit");
    expect(data).toMatchObject({
      column: "daily_limit",
      columnType: "numeric(18,2)",
      notNull: true,
      default: "1000",
    });
    const json = JSON.parse(
      await read(
        join(
          worktree(root, "forge-ledger"),
          "src/test/resources/atticus/s1-daily-transfer-limit.tests.json",
        ),
      ),
    ) as { $generated: string; format: string; cases: { id: string; type: string }[] };
    expect(json.format).toBe("atticus-tests/1");
    expect(json.$generated).toMatch(
      /^Generated by Atticus from openspec\/changes\/add-transfer-limit\/stories\/s1-daily-transfer-limit\.md\./,
    );
    expect(json.cases).toHaveLength(20);
  });

  it("renders JUnit 5 + RestAssured for a Java repo (golden)", async () => {
    const root = await forgeChangeRoot();
    await generateTests(root, CHANGE, S2, { now: NOW });
    expect(
      await body(join(worktree(root, "forge-ledger"), JAVA, "S2RemainingLimitApiTest.java")),
    ).toBe(expected("S2RemainingLimitApiTest.java"));
  });

  it("renders Vitest + fetch when asked (golden), and Jest when the repo uses it", async () => {
    const root = await forgeChangeRoot();
    const r = await generateTests(root, CHANGE, S2, { now: NOW, framework: "vitest-fetch" });
    expect(
      r.files
        .filter((f) => f.generator === "vitest-fetch")
        .map((f) => f.path.split("/").slice(-1)[0]),
    ).toEqual([
      "s2-remaining-limit.api.test.ts",
      "s2-remaining-limit.contract.test.ts",
      "s2-remaining-limit.contract.test.ts",
    ]);
    expect(
      await body(
        join(worktree(root, "forge-ledger"), "test/atticus/s2-remaining-limit.api.test.ts"),
      ),
    ).toBe(expected("s2-remaining-limit.api.test.ts.txt"));
    const jest = await forgeChangeRoot();
    await writeFile(
      join(worktree(jest, "forge-portal-bff"), "package.json"),
      JSON.stringify({ devDependencies: { jest: "29.7.0" } }),
    );
    await rm(join(worktree(jest, "forge-portal-bff"), "pom.xml"));
    await rm(join(worktree(jest, "forge-portal-bff"), "src/main/java"), { recursive: true });
    const j = await generateTests(jest, CHANGE, S2, { now: NOW });
    const f = j.files.find((x) => x.repo === "forge-portal-bff" && x.generator === "jest-fetch")!;
    expect(f.path).toMatch(
      /forge-portal-bff\/test\/atticus\/s2-remaining-limit\.contract\.test\.ts$/,
    );
    expect(await read(join(jest, f.path))).toContain(
      `import { describe, expect, it } from "@jest/globals";`,
    );
  });

  it("records what it can't check: a vendor spec without the operation, a table without a migration", async () => {
    const root = await forgeChangeRoot();
    const s3 = await generateTests(root, CHANGE, S3, { now: NOW });
    expect(s3.gaps).toEqual([
      "inputs/partner-specs/northwind-pay-openapi.yaml has no POST /v2/velocity-checks: the provider's side can't be checked until the spec has it.",
    ]);
    expect(s3.notes).toContain(
      "northwind-pay has no repo here, so its POST /v2/velocity-checks gets no API tests; ledger-api's contract tests cover the call.",
    );
    expect(s3.model.elsewhere.map((c) => c.id)).toEqual([
      "contract.post-v2-velocity-checks.provider",
    ]);
    const consumer = s3.model.repos[0]!.cases.find((c) => c.type === "contract") as ContractCase;
    expect(consumer.request.fields).toEqual(["accountRef", "amount.value"]);

    const s4 = await generateTests(root, CHANGE, S4, { now: NOW });
    expect(s4.gaps).toEqual([
      "data.md names no migration for limit_change: the migration test can't be generated.",
    ]);
    expect(
      Object.fromEntries(s4.model.repos.map((x) => [x.repo, x.cases.map((c) => c.id)])),
    ).toEqual({
      "forge-ledger": [
        "acceptance.c1",
        "contract.publish-limits-changed.publisher",
        "event.limits-changed.publish",
        "data.limit-change.table",
      ],
      "forge-reports-job": [
        "contract.publish-limits-changed.subscriber",
        "event.limits-changed.consume",
      ],
    });
    // forge-reports-job has no worktree: its tests go to the change folder.
    expect(s4.files.filter((f) => f.repo === "forge-reports-job").map((f) => f.where)).toEqual([
      "change-folder",
      "change-folder",
      "change-folder",
    ]);
    expect(s4.files.find((f) => f.repo === "forge-reports-job")!.path).toBe(
      "openspec/changes/add-transfer-limit/tests/s4-limit-change-events/forge-reports-job/src/test/resources/atticus/s4-limit-change-events.tests.json",
    );
  });

  it("generates what the strategy's row and the change's risk ask for, each in its own words", async () => {
    const root = await forgeChangeRoot();
    await writeFile(
      join(root, "org-pack/test-strategy.yaml"),
      "schemaVersion: 1\nmatrix:\n  - { changeType: feature, risk: high, required: [unit, contract] }\n",
    );
    const r = await generateTests(root, CHANGE, S1, { now: NOW });
    // The row asks for unit and contract; the change's own risk adds integration (ADR 0124
    // addendum B-change: it spans three repos), so api and data are generated too, and each
    // says which of the two asked for it.
    expect(r.model.kinds.map((k) => [k.type, k.generated])).toEqual([
      ["acceptance", true],
      ["api", true],
      ["contract", true],
      ["data", true],
      ["event", true],
    ]);
    expect(r.model.kinds.find((k) => k.type === "contract")!.why).toBe(
      "test-strategy.yaml (feature/high) asks for contract.",
    );
    expect(r.model.kinds.find((k) => k.type === "api")!.why).toBe(
      "The change's spread risk asks for integration tests across the repos in their deploy order (3 repos (forge-ledger, forge-portal-bff, forge-reports-job)).",
    );
  });
});

describe("generated files and edits", () => {
  it("is idempotent, keeps hand edits and files it didn't write unless --force, and writes nothing in check mode", async () => {
    const root = await forgeChangeRoot();
    await generateTests(root, CHANGE, S2, { now: NOW });
    const again = await generateTests(root, CHANGE, S2, { now: NOW });
    expect(new Set(again.files.map((f) => f.action))).toEqual(new Set(["unchanged"]));
    const api = join(worktree(root, "forge-ledger"), JAVA, "S2RemainingLimitApiTest.java");
    await writeFile(api, `${await read(api)}// my note\n`);
    const kept = await generateTests(root, CHANGE, S2, { now: NOW });
    expect(kept.files.find((f) => f.path.endsWith("S2RemainingLimitApiTest.java"))!.action).toBe(
      "kept-edited",
    );
    expect(kept.notes.some((n) => n.includes("was edited by a person"))).toBe(true);
    expect(await read(api)).toContain("// my note");
    const forced = await generateTests(root, CHANGE, S2, { now: NOW, force: true });
    expect(forced.files.find((f) => f.path.endsWith("S2RemainingLimitApiTest.java"))!.action).toBe(
      "updated",
    );
    expect(await read(api)).not.toContain("// my note");

    const feature = join(
      worktree(root, "forge-ledger"),
      "src/test/resources/features/s2-remaining-limit.feature",
    );
    await writeFile(feature, "Feature: mine\n");
    const mine = await generateTests(root, CHANGE, S2, { now: NOW, check: true });
    expect(mine.files.find((f) => f.path.endsWith(".feature"))!).toMatchObject({
      action: "kept-not-generated",
      written: false,
    });
    expect(await read(feature)).toBe("Feature: mine\n");

    const fresh = await forgeChangeRoot();
    const check = await generateTests(fresh, CHANGE, S2, { now: NOW, check: true });
    expect(check.files.every((f) => f.action === "created" && !f.written)).toBe(true);
    await expect(read(join(fresh, check.manifest))).rejects.toThrow();
  });

  it("refuses to write outside the target folder", async () => {
    await expect(
      writeGenerated(FIXTURES, [
        { path: "../x.feature", content: "x\n", style: "hash", source: "s" },
      ]),
    ).rejects.toThrow(/outside the target folder/);
  });

  it("writes a manifest that says which file holds which case", async () => {
    const root = await forgeChangeRoot();
    const r = await generateTests(root, CHANGE, S1, { now: NOW });
    const m = parse(await read(join(root, r.manifest))) as {
      story: string;
      names: string;
      files: { path: string; cases: string[] }[];
      cases: { id: string; scenario?: string; endpoint?: string; repo: string }[];
    };
    expect(m.story).toBe(S1);
    expect(m.names).toBe("fallback");
    expect(m.files.find((f) => f.path.endsWith(".feature"))!.cases).toEqual([
      "acceptance.c1",
      "acceptance.c2",
    ]);
    expect(m.cases.find((c) => c.id === "acceptance.c1")).toMatchObject({
      scenario: "specs/transfer-limits/spec.md:6",
      repo: "forge-ledger",
    });
    expect(m.cases.find((c) => c.id === "api.post-transfers.happy")).toMatchObject({
      endpoint: "ledger-api.post-transfer",
    });
  });

  it("falls back to the change folder when no repo is checked out", async () => {
    const root = await forgeChangeRoot({ worktrees: false });
    const r = await generateTests(root, CHANGE, S2, { now: NOW });
    expect(new Set(r.files.map((f) => f.where))).toEqual(new Set(["change-folder"]));
    expect(r.files[0]!.path).toBe(
      "openspec/changes/add-transfer-limit/tests/s2-remaining-limit/forge-ledger/features/s2-remaining-limit.feature",
    );
    // Without a checkout or a type that says Java, only Gherkin and JSON are written for forge-ledger.
    expect(r.notes).toContain(
      "No test framework suits forge-ledger (its language isn't known): only Gherkin and JSON were written.",
    );
    // Without the change worktree, the spec is the base one, which lacks the new operation.
    expect(r.notes).toContain(
      "No spec has GET /accounts/{id}/limit for ledger-api: only the happy path was generated.",
    );
  });
});

describe("names from the test writer (replay)", () => {
  it("takes scenario, test and data names from the recording, and discards unknown ids", async () => {
    const root = await forgeChangeRoot();
    const runtime = await ReplayRuntime.fromDir(join(FIXTURES, "recordings"));
    const r = await generateTests(root, CHANGE, S1, { now: NOW, runtime });
    expect(r.names.by).toBe("ai");
    expect(r.names.discarded).toEqual([
      { id: "api.delete-transfers.happy", reason: "no such id in the generated tests" },
    ]);
    const ledger = r.model.repos[0]!;
    expect(ledger.cases.find((c) => c.id === "acceptance.c1")!.name).toBe(
      "A transfer that would pass the daily limit is refused",
    );
    const happy = ledger.cases.find((c) => c.id === "api.post-transfers.happy") as ApiCase;
    expect(happy.name).toBe("Creates a transfer within the limit");
    expect(happy.data).toEqual({ id: "data.post-transfers", name: "transferOfOneHundredEuros" });
    const java = await read(
      join(worktree(root, "forge-ledger"), JAVA, "S1DailyTransferLimitApiTest.java"),
    );
    expect(java).toContain("  void createsATransferWithinTheLimit() {");
    expect(java).toContain('    String transferOfOneHundredEuros = """');
    const feature = await read(
      join(
        worktree(root, "forge-ledger"),
        "src/test/resources/features/s1-daily-transfer-limit.feature",
      ),
    );
    expect(feature).toContain("  Scenario: A transfer that would pass the daily limit is refused");
  });

  it("keeps the deterministic names when the answer is not usable", async () => {
    const root = await forgeChangeRoot();
    const r = await generateTests(root, CHANGE, S2, {
      now: NOW,
      runtime: new MockRuntime(() => "not: [yaml"),
    });
    expect(r.names.by).toBe("ai");
    expect(r.names.discarded[0]!.reason).toMatch(/isn't YAML/);
    expect(r.model.repos[0]!.cases[0]!.name).toBe("Remaining limit after transfers");
  });
});

describe("stories without links, and refusals", () => {
  it("infers what a hand-written story touches from what it mentions", async () => {
    const root = await forgeChangeRoot();
    await cp(
      join(FORGE_CHANGE, "openspec/changes", CHANGE, "stories/s1-refuse-over-limit.md"),
      join(changeDir(root), "stories/s1-refuse-over-limit.md"),
    );
    const r = await generateTests(root, CHANGE, "s1-refuse-over-limit", { now: NOW });
    expect(r.model.linkedBy).toBe("inferred");
    expect(r.notes[0]).toBe(
      "s1-refuse-over-limit has no links section: its interfaces and data changes were found by what it mentions.",
    );
    expect(r.model.repos[0]!.cases.map((c) => [c.id, c.name])).toEqual([
      ["acceptance.c1", "Transfer over the limit"],
      ["acceptance.c2", "Transfer within the limit"],
    ]);
  });

  it("refuses an unknown story, change or framework", async () => {
    const root = await forgeChangeRoot();
    await expect(generateTests(root, CHANGE, "s9-nope")).rejects.toThrow(/has no story s9-nope/);
    await expect(generateTests(root, "nope", S1)).rejects.toThrow(TestgenError);
    await expect(generateTests(root, CHANGE, S1, { framework: "mocha" })).rejects.toThrow(
      "There is no test framework mocha. Frameworks: gherkin, json, junit5-restassured, vitest-fetch, jest-fetch.",
    );
  });
});

describe("pieces", () => {
  it("splits a Given/When/Then criterion and its trace", () => {
    expect(
      splitCriterion(
        "Given an account with a limit of 1000 that has sent 900 today, when it asks to send 200, then the transfer is refused with LIMIT_EXCEEDED (HTTP 422) and nothing is posted. (specs/transfer-limits/spec.md:6)",
      ),
    ).toEqual({
      given: "an account with a limit of 1000 that has sent 900 today",
      when: "it asks to send 200",
      then: "the transfer is refused with LIMIT_EXCEEDED (HTTP 422) and nothing is posted",
      ref: { file: "specs/transfer-limits/spec.md", line: 6 },
    });
    expect(splitCriterion("The transfer is held.")).toEqual({
      given: "",
      when: "",
      then: "The transfer is held",
    });
    // B-once: the story file's note of the other tasks a criterion accepts is no part of it.
    expect(
      splitCriterion(
        "Given a client, when it posts deliverBy 2026-11-02, then 201 returns it. (also accepts tasks 1.2, 1.3 and 1.4)",
      ),
    ).toEqual({ given: "a client", when: "it posts deliverBy 2026-11-02", then: "201 returns it" });
  });

  it("makes one invalid value per constraint", () => {
    expect(
      mutations("code", { type: "string", minLength: 2, maxLength: 3, format: "uuid" }),
    ).toEqual([
      { key: "type", value: 12345, title: "refuses code that is not text" },
      { key: "min-length", value: "x", title: "refuses code shorter than 2 characters" },
      { key: "max-length", value: "xxxx", title: "refuses code longer than 3 characters" },
      { key: "format", value: "not-a-uuid", title: "refuses code that is not a uuid" },
    ]);
    expect(
      mutations("n", { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 10 }).map((m) => [
        m.key,
        m.value,
      ]),
    ).toEqual([
      ["type", "abc"],
      ["exclusive-minimum", 0],
      ["exclusive-maximum", 10],
    ]);
  });

  it("reads the target fields of a mappings table", async () => {
    const text = await readFile(
      join(FORGE_CHANGE, "openspec/changes", CHANGE, "mappings.md"),
      "utf8",
    );
    const section = text.split("## POST /v2/velocity-checks")[1]!.split("##")[0]!;
    expect(mappedFields(section)).toEqual(["accountRef", "amount.value"]);
  });
});
