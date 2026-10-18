import { describe, expect, it } from "vitest";
import {
  driftJson,
  driftJUnit,
  driftMarkdown,
  pipelineSnippet,
  SNIPPET_KINDS,
  type DriftReport,
} from "../src/index.js";

const report = (o: Partial<DriftReport> = {}): DriftReport => ({
  schemaVersion: 1,
  repo: "forge-ledger",
  components: ["ledger-api"],
  mode: "block",
  drift: true,
  counts: { added: 1, changed: 0, removed: 0, unknown: 0, planned: 1 },
  items: [
    {
      kind: "added",
      subject: "endpoint",
      id: "ledger-api.delete-transfer",
      summary: "DELETE /transfers/{id} on ledger-api is in the code but not in the catalog.",
      evidence: [{ path: "src/main/java/forge/ledger/LedgerEndpoints.java", line: 17 }],
    },
    {
      kind: "planned",
      subject: "endpoint",
      id: "ledger-api.get-limit",
      summary:
        "GET /accounts/{id}/limit on ledger-api is in the code but not in the catalog (planned by add-transfer-limit).",
      change: "add-transfer-limit",
      evidence: [{ path: "src/main/java/forge/ledger/LedgerEndpoints.java", line: 14 }],
    },
  ],
  changes: ["add-transfer-limit"],
  scanned: { commit: "a".repeat(40), records: 30, extractors: ["component"] },
  problems: [],
  ...o,
});

describe("drift output", () => {
  it("JUnit XML fails drift in block mode, passes planned items and escapes text", () => {
    expect(driftJUnit(report())).toBe(
      [
        `<?xml version="1.0" encoding="UTF-8"?>`,
        `<testsuites name="atticus drift" tests="2" failures="1" skipped="0">`,
        `  <testsuite name="atticus drift forge-ledger" tests="2" failures="1" errors="0" skipped="0">`,
        `    <testcase classname="atticus.drift.endpoint" name="added endpoint ledger-api.delete-transfer">`,
        `      <failure message="DELETE /transfers/{id} on ledger-api is in the code but not in the catalog." type="added">DELETE /transfers/{id} on ledger-api is in the code but not in the catalog.`,
        `at src/main/java/forge/ledger/LedgerEndpoints.java:17</failure>`,
        `    </testcase>`,
        `    <testcase classname="atticus.drift.endpoint" name="planned endpoint ledger-api.get-limit">`,
        `      <system-out>GET /accounts/{id}/limit on ledger-api is in the code but not in the catalog (planned by add-transfer-limit).`,
        `at src/main/java/forge/ledger/LedgerEndpoints.java:14</system-out>`,
        `    </testcase>`,
        `  </testsuite>`,
        `</testsuites>`,
        ``,
      ].join("\n"),
    );
    const warn = driftJUnit(report({ mode: "warn" }));
    expect(warn).toContain(`failures="0" skipped="1"`);
    expect(warn).toContain(
      `<skipped message="warn-only: DELETE /transfers/{id} on ledger-api is in the code but not in the catalog."/>`,
    );
    const xmlish = driftJUnit(
      report({ items: [{ ...report().items[0]!, summary: `a <b> & "c"` }] }),
    );
    expect(xmlish).toContain(`message="a &lt;b&gt; &amp; &quot;c&quot;"`);
    const clean = driftJUnit(
      report({
        drift: false,
        items: [],
        counts: { added: 0, changed: 0, removed: 0, unknown: 0, planned: 0 },
      }),
    );
    expect(clean).toContain(
      `<testcase classname="atticus.drift" name="forge-ledger matches the catalog"/>`,
    );
    expect(clean).toContain(`tests="1" failures="0"`);
  });

  it("Markdown summary says what drifted and what to do", () => {
    expect(driftMarkdown(report())).toBe(
      [
        "## Atticus drift check: forge-ledger",
        "",
        "1 drift finding in forge-ledger.",
        "",
        "| What | Kind | Id | Details |",
        "| --- | --- | --- | --- |",
        "| Not in the catalog | endpoint | ledger-api.delete-transfer | DELETE /transfers/{id} on ledger-api is in the code but not in the catalog. (src/main/java/forge/ledger/LedgerEndpoints.java:17) |",
        "| Planned | endpoint | ledger-api.get-limit | GET /accounts/{id}/limit on ledger-api is in the code but not in the catalog (planned by add-transfer-limit). (src/main/java/forge/ledger/LedgerEndpoints.java:14) |",
        "",
        "Fix the code, or record the change in the catalog: plan it in an approved change's design, or rescan the estate once it is merged.",
        "",
      ].join("\n"),
    );
    expect(
      driftMarkdown(
        report({
          drift: false,
          items: [report().items[1]!],
          counts: { added: 0, changed: 0, removed: 0, unknown: 0, planned: 1 },
        }),
      ).split("\n")[2],
    ).toBe("No drift: forge-ledger matches the catalog (1 planned by approved changes).");
    expect(driftMarkdown(report({ mode: "warn" })).split("\n")[2]).toBe(
      "1 drift finding in forge-ledger (warn-only: the pipeline passes).",
    );
  });

  it("JSON is the report itself", () => {
    expect(JSON.parse(driftJson(report()))).toEqual(report());
  });
});

describe("pipeline snippets", () => {
  it("exist for GitHub Actions, Azure Pipelines, GitLab CI and Jenkins", () => {
    expect(SNIPPET_KINDS).toEqual(["github", "azure", "gitlab", "jenkins"]);
    for (const k of SNIPPET_KINDS) {
      const s = pipelineSnippet(k)!;
      expect(s.content).toContain(`Generated by Atticus (atticus ci snippet ${k})`);
      expect(s.content).toContain("ci drift");
      expect(s.content).toContain("--junit atticus-drift.xml");
      expect(s.content).toContain("--json atticus-drift.json");
    }
    expect(pipelineSnippet("github")!.path).toBe(".github/workflows/atticus-drift.yml");
    expect(pipelineSnippet("azure")!.content).toContain("PublishTestResults@2");
    expect(pipelineSnippet("gitlab")!.content).toContain("junit: atticus-drift.xml");
    expect(pipelineSnippet("jenkins")!.content).toContain("junit allowEmptyResults: false");
  });

  it("accepts the usual names and nothing else", () => {
    expect(pipelineSnippet("github-actions")?.kind).toBe("github");
    expect(pipelineSnippet("Azure Pipelines")?.kind).toBe("azure");
    expect(pipelineSnippet("gitlab-ci")?.kind).toBe("gitlab");
    expect(pipelineSnippet("circle")).toBeUndefined();
  });
});
