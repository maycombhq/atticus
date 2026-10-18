import { describe, expect, it } from "vitest";
import { detectFeatures, featureFlows } from "../src/index.js";
import { build, forgeRecords, record } from "./helpers.js";

describe("featureFlows", () => {
  it("finds where the Forge features' flows end in something nobody can follow", () => {
    const records = forgeRecords();
    const flows = featureFlows([...records, ...detectFeatures(records)]);
    expect(flows.map((f) => [f.feature.id, f.system, f.looseEnds])).toEqual([
      ["feature.account-balance", "portal", []],
      ["feature.daily-entries-report", "reports", []],
      [
        "feature.payments",
        "ledger",
        [
          {
            kind: "unknown-trigger",
            record: "if-32d38aecd11b86b1",
            text: "nothing Atticus found makes portal-bff publish payments.initiated",
          },
        ],
      ],
      [
        "feature.transfers",
        "ledger",
        [
          {
            kind: "unknown-caller",
            record: "if-d99f508a2ac9b6e0",
            text: "nothing Atticus found makes portal-bff call POST /transfers",
          },
        ],
      ],
    ]);
  });

  it("reports calls seen at one end and loose ends the flow passes", () => {
    const records = [
      build.system("web"),
      build.system("loans"),
      build.component("web-ui", "web", "spa"),
      build.component("loan-api", "loans"),
      build.component("scoring", "loans"),
      build.endpoint("loan-api", "POST", "/loans"),
      build.call("web-ui", "loan-api", "POST", "/loans", { endpoint: "loan-api.post-loan" }),
      build.call("loan-api", "scoring", "POST", "/loans/score", { confidence: "inferred" }),
      record({
        kind: "Unresolved",
        id: "scoring.http-call.abc",
        confidence: "inferred",
        unresolvedKind: "http-call",
        raw: "POST ${bureau.url}/loans/check",
        owner: "scoring",
        evidence: [{ source: "code", repo: "estate", path: "scoring/Bureau.java", line: 9 }],
      }),
    ];
    const [f] = featureFlows([...records, ...detectFeatures(records)]);
    expect(f!.looseEnds.map((e) => [e.kind, e.record])).toEqual([
      ["one-end", records[7]!.id],
      ["loose-end", "scoring.http-call.abc"],
    ]);
    expect(f!.looseEnds[1]!.text).toBe(
      "scoring has a loose end Atticus couldn't follow (POST ${bureau.url}/loans/check)",
    );
  });
});
