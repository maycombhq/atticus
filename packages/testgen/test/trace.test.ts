import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { recordPath, serializeRecord, parseRecord } from "@maycombhq/core";
import { gateStatus } from "@maycombhq/naysayer";
import type { GitRunner } from "@maycombhq/workspace";
import {
  generateTests,
  matrixCsv,
  matrixMarkdown,
  traceMatrix,
  writeTraceFindings,
} from "../src/index.js";
import { CHANGE, changeDir, forgeChangeRoot, NOW, worktree } from "./helpers.js";

const put = async (path: string, text: string) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
};

async function prepared() {
  const root = await forgeChangeRoot();
  for (const s of [
    "s1-daily-transfer-limit",
    "s2-remaining-limit",
    "s3-northwind-pay-velocity-checks",
  ])
    await generateTests(root, CHANGE, s, { now: NOW });
  // A feature the catalog found in code, spanning the transfer endpoint.
  const feature = parseRecord({
    schemaVersion: 2,
    kind: "Capability",
    id: "feature.transfer",
    status: "current",
    confidence: "inferred",
    name: "Transfers",
    entryPoints: ["ledger-api.post-transfer"],
    records: ["ledger-api.post-transfer", "if-d99f508a2ac9b6e0"],
    namedBy: "detected",
    evidence: [
      {
        source: "code",
        repo: "forge-ledger",
        path: "src/main/java/forge/ledger/LedgerEndpoints.java",
        line: 11,
      },
    ],
  });
  if (!feature.ok) throw new Error(JSON.stringify(feature.issues));
  await put(
    join(root, "catalog/generated", recordPath(feature.record)),
    serializeRecord(feature.record),
  );
  // What Run with AI recorded for task 1.1, and a git checkout for the task branch's diff.
  await put(
    join(changeDir(root), "tasks/1.1/task-run.yaml"),
    "schemaVersion: 1\nchange: add-transfer-limit\ntask: '1.1'\nrepo: forge-ledger\nchanged:\n  - src/main/java/forge/ledger/LedgerEndpoints.java\n  - src/main/resources/db/migration/V3__add_daily_limit.sql\n",
  );
  await put(join(worktree(root, "forge-ledger"), ".git"), "gitdir: /elsewhere\n");
  return root;
}

const calls: string[][] = [];
const git: GitRunner = async (args) => {
  calls.push(args);
  if (args.join(" ") === "diff --name-only change/add-transfer-limit...task/add-transfer-limit/1.1")
    return {
      stdout:
        "src/main/java/forge/ledger/LimitCheck.java\nsrc/main/java/forge/ledger/LedgerEndpoints.java\n",
      stderr: "",
    };
  throw new Error("unknown revision");
};

describe("traceability", () => {
  it("links requirement → story → criterion → test → code → records → feature", async () => {
    const root = await prepared();
    const m = await traceMatrix(root, CHANGE, { git });
    expect(m.stories).toEqual([
      "s1-daily-transfer-limit",
      "s2-remaining-limit",
      "s3-northwind-pay-velocity-checks",
      "s4-limit-change-events",
    ]);
    expect(m.requirements.map((r) => r.key)).toEqual([
      "specs/transfer-limits/spec.md:6",
      "specs/transfer-limits/spec.md:10",
      "specs/transfer-limits/spec.md:17",
    ]);
    const c1 = m.rows.find((r) => r.story === "s1-daily-transfer-limit" && r.criterion?.n === 1)!;
    expect(c1.requirement).toMatchObject({
      requirement: "Daily transfer limit",
      scenario: "Transfer over the limit",
    });
    expect(c1.tests.map((t) => t.path.split("/").pop())).toEqual([
      "s1-daily-transfer-limit.feature",
      "s1-daily-transfer-limit.tests.json",
      "S1DailyTransferLimitApiTest.java",
    ]);
    expect(c1.code).toEqual([
      "forge-ledger:src/main/java/forge/ledger/LedgerEndpoints.java",
      "forge-ledger:src/main/java/forge/ledger/LimitCheck.java",
      "forge-ledger:src/main/resources/db/migration/V3__add_daily_limit.sql",
    ]);
    expect(c1.records).toEqual([
      "if-d99f508a2ac9b6e0",
      "ledger-api.post-transfer",
      "ledger-db.account",
    ]);
    expect(c1.features).toEqual(["feature.transfer"]);
    const s2 = m.rows.find((r) => r.story === "s2-remaining-limit" && r.criterion)!;
    expect(s2.records).toEqual(["new: portal-bff → ledger-api GET /accounts/{id}/limit"]);
    expect(calls.some((a) => a.join(" ").includes("task/add-transfer-limit/1.1"))).toBe(true);
  });

  it("says one quiet line about tasks that have no branch yet, not Git's error for each", async () => {
    const root = await prepared();
    const m = await traceMatrix(root, CHANGE, { git });
    expect(m.problems.filter((p) => /no diff for task|unknown revision/.test(p))).toEqual([]);
    expect(m.problems).toHaveLength(1);
    expect(m.problems[0]).toMatch(/^Not started yet \(no task branch\): forge-ledger 1\.2/);
    expect(m.problems[0]).not.toMatch(/\bgit\b/i);
    // A task with a run record is not "not started", whatever happened to its branch.
    expect(m.problems[0]).not.toMatch(/\b1\.1\b/);
  });

  it("still reports a real failure to read a task branch that exists", async () => {
    const root = await prepared();
    const broken: GitRunner = async (args) => {
      if (args[0] === "rev-parse") return { stdout: "abc\n", stderr: "" };
      throw new Error("fatal: bad object\nmore");
    };
    const m = await traceMatrix(root, CHANGE, { git: broken });
    expect(
      m.problems.some((p) => p.startsWith("forge-ledger: no diff for task 1.1 (fatal: bad object")),
    ).toBe(true);
    expect(m.problems.some((p) => /Not started/.test(p))).toBe(false);
  });

  it("reports the gaps: untested story and endpoints, tests with no requirement", async () => {
    const root = await prepared();
    const m = await traceMatrix(root, CHANGE, { git });
    expect(m.gaps.map((g) => [g.kind, g.summary])).toEqual([
      [
        "endpoint-without-test",
        "POST /risk/assess (ledger-api to risk-engine, planned-new) has no API or contract test.",
      ],
      [
        "endpoint-without-test",
        "POST /audit/events (portal-bff to audit-svc, planned-modify) has no API or contract test.",
      ],
      [
        "story-without-test",
        "Story s4-limit-change-events has no test: none generated and none in its repos names it.",
      ],
      [
        "test-without-requirement",
        "The tests of s3-northwind-pay-velocity-checks trace to no requirement: its criteria match no spec scenario.",
      ],
    ]);
  });

  it("counts tests found in the repos, and a requirement no story covers", async () => {
    const root = await prepared();
    await put(
      join(
        worktree(root, "forge-portal-bff"),
        "src/test/java/forge/portal/AuditPublisherTest.java",
      ),
      'class AuditPublisherTest {\n  // posts to "/audit/events"\n  String path = "/audit/events";\n}\n',
    );
    await put(
      join(worktree(root, "forge-ledger"), "src/test/java/forge/ledger/LimitChangeTest.java"),
      "// Story s4-limit-change-events: limit changes are recorded.\nclass LimitChangeTest {}\n",
    );
    // s2's story is gone; its generated tests (and their manifest) are still there.
    await rm(join(changeDir(root), "stories/s2-remaining-limit.md"));
    const m = await traceMatrix(root, CHANGE, { git });
    expect(m.found.map((f) => [f.repo, f.path.split("/").pop(), f.refs])).toEqual([
      [
        "forge-ledger",
        "LimitChangeTest.java",
        { stories: ["s4-limit-change-events"], scenarios: [], endpoints: [] },
      ],
      [
        "forge-portal-bff",
        "AuditPublisherTest.java",
        { stories: [], scenarios: [], endpoints: ["POST /audit/events"] },
      ],
    ]);
    expect(m.gaps.map((g) => [g.kind, g.subject])).toEqual([
      ["endpoint-without-test", "ledger-api-risk-engine-POST-/risk/assess"],
      ["requirement-without-story", "specs/transfer-limits/spec.md:17"],
      ["test-without-requirement", "s3-northwind-pay-velocity-checks"],
      [
        "test-without-requirement",
        "workspace/.worktrees/add-transfer-limit/forge-portal-bff/src/test/java/forge/portal/AuditPublisherTest.java",
      ],
    ]);
    expect(m.gaps.find((g) => g.kind === "requirement-without-story")!.summary).toBe(
      'Scenario "Remaining limit after transfers" of requirement "Remaining limit" has no story.',
    );
  });

  it("writes the gaps as findings on the built-in trace gate, once per change in the picture", async () => {
    const root = await prepared();
    const m = await traceMatrix(root, CHANGE, { git });
    const w = await writeTraceFindings(root, m, "2026-10-21T10:00:00Z");
    expect(w).toMatchObject({ gate: "trace", round: 1, unchanged: false });
    expect(w.findings.map((f) => [f.finding.id, f.finding.severity, f.finding.rule])).toEqual([
      [
        "endpoint-without-test-ledger-api-risk-engine-post-risk-assess",
        "blocking",
        "trace.endpoint-without-test",
      ],
      [
        "endpoint-without-test-portal-bff-audit-svc-post-audit-events",
        "blocking",
        "trace.endpoint-without-test",
      ],
      ["story-without-test-s4-limit-change-events", "blocking", "trace.story-without-test"],
      [
        "test-without-requirement-s3-northwind-pay-velocity-checks",
        "risk",
        "trace.test-without-requirement",
      ],
    ]);
    expect(
      (await readdir(join(changeDir(root), "review/trace/1"))).filter((f) => f.endsWith(".yaml")),
    ).toHaveLength(4);
    const again = await writeTraceFindings(
      root,
      await traceMatrix(root, CHANGE, { git }),
      "2026-10-21T11:00:00Z",
    );
    expect(again).toMatchObject({ round: 1, unchanged: true });
    const status = await gateStatus(root, CHANGE, "trace");
    expect(status.open).toEqual({ blocking: 3, gaps: 0, risks: 1, ideas: 0 });
    expect(status.mayProceed).toBe(false);
  });

  it("exports the matrix as Markdown and CSV", async () => {
    const root = await prepared();
    const m = await traceMatrix(root, CHANGE, { git });
    const md = matrixMarkdown(m);
    expect(md.split("\n").slice(0, 4)).toEqual([
      "# Traceability: add-transfer-limit",
      "",
      "| Requirement | Scenario | Story | Criterion | Tests | Code | Records | Features |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]);
    expect(md).toContain("## Gaps");
    const csv = matrixCsv(m).split("\n");
    expect(csv[0]).toBe("requirement,scenario,story,criterion,tests,code,records,features");
    expect(
      csv[1]!.startsWith(
        "Daily transfer limit (specs/transfer-limits/spec.md:6),Transfer over the limit,s1-daily-transfer-limit,",
      ),
    ).toBe(true);
    expect(csv).toHaveLength(m.rows.length + 2);
  });
});

describe("tests found in task worktrees (M3 live finding 4)", () => {
  it("cites each test in the worktree of the task that wrote it, not another task's copy", async () => {
    const root = await prepared();
    const tasks = join(root, "workspace/.worktrees", CHANGE, ".tasks");
    const rel = "src/test/java/forge/ledger/LimitEndpointTest.java";
    // Every task worktree is a full checkout: the file exists in both, but only task 1.2's copy
    // (story s2) has the new test in it.
    await put(join(tasks, "1.1/forge-ledger", rel), "class LimitEndpointTest {}\n");
    await put(
      join(tasks, "1.2/forge-ledger", rel),
      '// story s2-remaining-limit\nclass LimitEndpointTest { void getLimit() { get("/accounts/1/limit"); } }\n',
    );
    const m = await traceMatrix(root, CHANGE, { git });
    const hits = m.found.filter((f) => f.path.endsWith(rel));
    expect(hits.map((h) => h.path)).toEqual([
      `workspace/.worktrees/${CHANGE}/.tasks/1.2/forge-ledger/${rel}`,
    ]);
    expect(hits[0]!.refs!.stories).toEqual(["s2-remaining-limit"]);
  });

  it("cites a test that is the same in several worktrees once, in its own story's worktree", async () => {
    const root = await prepared();
    const tasks = join(root, "workspace/.worktrees", CHANGE, ".tasks");
    const rel = "src/test/java/forge/ledger/VelocityCheckTest.java";
    const text = "// story s3-northwind-pay-velocity-checks\nclass VelocityCheckTest {}\n";
    for (const t of ["1.1", "1.2", "1.3"]) await put(join(tasks, t, "forge-ledger", rel), text);
    const m = await traceMatrix(root, CHANGE, { git });
    expect(m.found.filter((f) => f.path.endsWith(rel)).map((f) => f.path)).toEqual([
      `workspace/.worktrees/${CHANGE}/.tasks/1.3/forge-ledger/${rel}`,
    ]);
  });

  it("counts copies that differ only in line endings once (Git for Windows checks out CRLF)", async () => {
    const root = await prepared();
    const tasks = join(root, "workspace/.worktrees", CHANGE, ".tasks");
    const rel = "specs/1.2/plan.md";
    const text = "# Plan\n\nTests POST /transfers and GET /accounts/{id}/limit.\n";
    // Atticus wrote one copy with LF; core.autocrlf=true checked the other out with CRLF.
    await put(join(tasks, "1.2/forge-ledger", rel), text);
    await put(join(worktree(root, "forge-ledger"), rel), text.replace(/\n/g, "\r\n"));
    const m = await traceMatrix(root, CHANGE, { git });
    expect(m.found.filter((f) => f.path.endsWith(rel))).toHaveLength(1);
    expect(
      m.gaps.filter((g) => g.kind === "test-without-requirement" && g.subject.endsWith(rel)),
    ).toHaveLength(1);
  });
});
