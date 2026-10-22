import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  compareReports,
  findRepoRoot,
  listReports,
  loadDatasets,
  passesLiveBar,
  qualityOf,
  readQuality,
  runEvals,
  saveReport,
  writeQuality,
  type CaseResult,
  type EvalCase,
  type EvalReport,
} from "../src/index.js";

const REPO = findRepoRoot()!;
const NOW = new Date("2026-10-20T09:00:00Z");
const clock = () => NOW;

const result = (c: string, pass: boolean, run = 1, agent = "a", aiGraded = true): CaseResult => ({
  case: c,
  agent,
  run,
  mode: "live",
  pass,
  state: "ran",
  grades: [],
  discarded: 0,
  aiGraded,
});

describe("datasets", () => {
  let cases: EvalCase[];
  beforeAll(async () => {
    const d = await loadDatasets({ repoRoot: REPO });
    expect(d.problems).toEqual([]);
    expect(d.unavailable).toEqual([]);
    cases = d.cases;
  });

  it("cover every agent the plan names, seeded from the existing fixtures", () => {
    expect([...new Set(cases.map((c) => c.agent))].sort()).toEqual([
      "architecture-critic",
      "business-critic",
      "delivery-critic",
      "dialect-writer",
      "feature-namer",
      "glossary-definer",
      "story-critic",
      "story-writer",
      "template-writer",
      "test-writer",
      "ux-critic",
    ]);
    for (const c of cases) expect(c.reference, `${c.id} has a mock answer`).toBeDefined();
  });

  // Each runs every dataset case end to end: seconds, not the 5 s a unit test gets.
  it("pass in mock mode: the parsers keep the hand-written answers and the graders agree", async () => {
    const r = await runEvals({ cases, mode: "mock", repoRoot: REPO, now: clock });
    const failed = r.results
      .filter((x) => !x.pass)
      .map(
        (x) =>
          `${x.case}: ${
            x.error ??
            x.grades
              .filter((g) => !g.pass)
              .map((g) => `${g.grader} (${g.notes.join("; ")})`)
              .join(", ")
          }`,
      );
    expect(failed).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.results).toHaveLength(cases.length);
    expect(r.agents.every((a) => a.passRate === 1)).toBe(true);
  }, 60_000);

  it("pass in replay mode: every recording still matches the exact prompt its agent sends", async () => {
    const r = await runEvals({ cases, mode: "replay", repoRoot: REPO, now: clock });
    const failed = r.results
      .filter((x) => !x.pass)
      .map(
        (x) =>
          `${x.case}: ${
            x.error ??
            x.grades
              .filter((g) => !g.pass)
              .map((g) => `${g.grader} (${g.notes.join("; ")})`)
              .join(", ")
          }`,
      );
    expect(failed).toEqual([]);
    // red-team cases and the dialect writer have no recordings: they run in mock (and live) only
    expect(r.skipped.map((s) => s.case).sort()).toEqual([
      "architecture-hidden-instruction",
      "dialect-writer-forge-messaging",
      "feature-namer-obeys-injection",
      "glossary-definer-obeys-injection",
    ]);
    for (const x of r.results) expect(x.promptSha256, x.case).toMatch(/^[0-9a-f]{64}$/);
  }, 60_000);

  it("red team: an agent that obeys injected instructions is rejected by the evidence-bounded parsers", async () => {
    const red = cases.filter((c) => c.tags.includes("red-team"));
    expect(red.map((c) => c.id).sort()).toEqual([
      "architecture-hidden-instruction",
      "feature-namer-obeys-injection",
      "glossary-definer-obeys-injection",
    ]);
    const r = await runEvals({ cases: red, mode: "mock", repoRoot: REPO, now: clock });
    expect(r.results.map((x) => [x.case, x.pass])).toEqual(red.map((c) => [c.id, true]));
    const critic = r.results.find((x) => x.case === "architecture-hidden-instruction")!;
    expect(
      critic.grades.find((g) => g.grader.startsWith("injected sources are quarantined"))!.pass,
    ).toBe(true);
    expect(critic.discarded).toBe(2);
  });

  it("fails a case whose answer is wrong, and says why", async () => {
    const namer = cases.find((c) => c.id === "feature-namer-forge")!;
    const wrong: EvalCase = {
      ...namer,
      reference: {
        "feature-namer":
          "features:\n  - { id: feature.transfers, name: MONEY, tags: [Payments], evidence: [ledger-api.post-transfer] }\n",
      },
    };
    const r = await runEvals({ cases: [wrong], mode: "mock", repoRoot: REPO, now: clock });
    expect(r.results[0]!.pass).toBe(false);
    const failing = r.results[0]!.grades.filter((g) => !g.pass).map((g) => g.grader);
    expect(failing).toContain("names as expected");
    expect(failing).toContain("every detected feature is named");
    expect(failing).toContain("names read like a product owner's");
  });

  it("refuses live mode without a runtime from runtime.yaml", async () => {
    await expect(
      runEvals({ cases: cases.slice(0, 1), mode: "live", repoRoot: REPO, now: clock }),
    ).rejects.toThrow("Live mode needs a runtime built from runtime.yaml.");
  });
});

describe("the live bar, regressions and the AI-quality summary", () => {
  it("passes a case at 4 of 5 runs and fails it at 3 of 5 or with fewer runs", () => {
    const ok = [1, 2, 3, 4, 5].map((n) => result("c1", n !== 3, n));
    expect(passesLiveBar(ok, { runs: 5, min: 4 })).toMatchObject({
      pass: true,
      cases: [{ case: "c1", runs: 5, passed: 4, ok: true }],
    });
    const three = [1, 2, 3, 4, 5].map((n) => result("c1", n > 2, n));
    expect(passesLiveBar(three, { runs: 5, min: 4 }).pass).toBe(false);
    const short = [1, 2, 3, 4].map((n) => result("c1", true, n));
    expect(passesLiveBar(short, { runs: 5, min: 4 })).toMatchObject({
      pass: false,
      cases: [{ runs: 4, ok: false }],
    });
    // cases that don't depend on a model don't count toward the bar
    expect(passesLiveBar([...ok, result("det", false, 1, "a", false)]).pass).toBe(true);
    expect(passesLiveBar([]).pass).toBe(false);
  });

  it("compares two runs: regressed, fixed, added, removed and pass rates per agent", () => {
    const rep = (id: string, rs: CaseResult[]): EvalReport => ({
      schemaVersion: 1,
      runId: id,
      mode: "mock",
      startedAt: id,
      finishedAt: id,
      runs: 1,
      agents: [
        {
          agent: "a",
          cases: rs.length,
          passed: rs.filter((r) => r.pass).length,
          runs: rs.length,
          passRate: rs.filter((r) => r.pass).length / rs.length,
        },
      ],
      results: rs,
      skipped: [],
    });
    const before = rep("2026-10-19T00:00:00Z", [
      result("x", true),
      result("y", false),
      result("gone", true),
    ]);
    const after = rep("2026-10-20T00:00:00Z", [
      result("x", false),
      result("y", true),
      result("new", true),
    ]);
    expect(compareReports(before, after)).toEqual({
      regressed: ["a/x"],
      fixed: ["a/y"],
      added: ["a/new"],
      removed: ["a/gone"],
      agents: [{ agent: "a", before: 2 / 3, after: 2 / 3, delta: 0 }],
    });
    const q = qualityOf([before, after], "2026-10-20T00:00:00Z");
    expect(q.agents).toEqual([
      {
        agent: "a",
        lastRunAt: after.finishedAt,
        lastRun: after.runId,
        mode: "mock",
        cases: 3,
        passRate: 2 / 3,
        regressed: ["a/x"],
      },
    ]);
  });

  it("stores reports and the quality summary under the metarepo's state folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-evals-root-"));
    await mkdir(join(root, "org-pack"), { recursive: true });
    const d = await loadDatasets({ repoRoot: REPO });
    const cases = d.cases.filter((c) => c.agent === "feature-namer");
    const r = await runEvals({ cases, mode: "mock", repoRoot: REPO, now: clock });
    const path = await saveReport(root, r);
    expect(path).toBe(join(root, ".evals/runs", r.runId, "report.json"));
    expect(r.runId).toBe("eval-20261020090000-mock");
    expect(await listReports(root)).toEqual([r]);
    const { summary } = await writeQuality(root, NOW);
    expect(summary.agents).toEqual([
      {
        agent: "feature-namer",
        lastRunAt: "2026-10-20T09:00:00Z",
        lastRun: r.runId,
        mode: "mock",
        cases: 2,
        passRate: 1,
        regressed: [],
      },
    ]);
    expect(await readQuality(root)).toEqual(summary);
  });

  it("runs an organisation's own self-contained cases from org-pack/evals", async () => {
    const pack = await mkdtemp(join(tmpdir(), "atticus-evals-pack-"));
    await mkdir(join(pack, "evals"), { recursive: true });
    await writeFile(
      join(pack, "evals/release-notes.yaml"),
      [
        "schemaVersion: 1",
        "suite: generic",
        "description: Release notes from a change summary.",
        "cases:",
        "  - id: notes-limit",
        "    agent: release-notes-writer",
        "    description: Notes mention the limit and quote the summary.",
        "    modes: [mock, live]",
        "    params:",
        "      sources:",
        "        - { id: task, trusted: true, text: Write release notes. Quote the summary with a line starting '> '. }",
        "        - { id: summary, text: Each account now has a daily transfer limit. }",
        "    expect: { contains: [daily transfer limit], notContains: [guaranteed], maxWords: 40 }",
        "    reference:",
        "      output: |",
        "        Transfers now stop at a daily limit.",
        "        > Each account now has a daily transfer limit.",
      ].join("\n"),
    );
    const d = await loadDatasets({ orgPackDir: pack, dir: join(pack, "none") });
    expect(d.problems).toEqual([]);
    const r = await runEvals({ cases: d.cases, mode: "mock", repoRoot: REPO, now: clock });
    expect(r.results.map((x) => [x.case, x.pass])).toEqual([["notes-limit", true]]);
    const bad: EvalCase = {
      ...d.cases[0]!,
      reference: { "release-notes-writer": "Guaranteed!\n> Something not in the data." },
    };
    const r2 = await runEvals({ cases: [bad], mode: "mock", repoRoot: REPO, now: clock });
    expect(r2.results[0]!.grades.filter((g) => !g.pass).map((g) => g.grader)).toEqual([
      "says what it must",
      "says nothing it mustn't",
      "every quote is in the data",
    ]);
  });
});
