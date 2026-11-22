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
    // v30 slice 8 (docs/guide/words.md): an HTTP call's loose end is a call with no arrow.
    expect(f!.looseEnds[1]!.text).toBe(
      "scoring has a call with no arrow (POST ${bureau.url}/loans/check): Atticus couldn't tell where it goes",
    );
    // A link a person paired cites both ends: no "one end seen".
    const paired = records.map((r, i) =>
      i === 7 ? ({ ...r, flags: ["joined-by-person"] } as typeof r) : r,
    );
    const [g] = featureFlows([...paired, ...detectFeatures(paired)]);
    expect(g!.looseEnds.map((e) => e.kind)).toEqual(["loose-end"]);
    // A webhook the component sends (an outbound HTTP call, a vendor spec's) is a call too.
    const hook = records.map((r) =>
      r.kind === "Unresolved"
        ? ({ ...r, unresolvedKind: "webhook-send", raw: "POST loans.checked" } as typeof r)
        : r,
    );
    const [w] = featureFlows([...hook, ...detectFeatures(hook)]);
    expect(w!.looseEnds.find((e) => e.kind === "loose-end")?.text).toBe(
      "scoring has a call with no arrow (POST loans.checked): Atticus couldn't tell where it goes",
    );
    // Any other kind (a topic listened to, a table) stays a loose end in words.
    const topic = records.map((r) =>
      r.kind === "Unresolved"
        ? ({ ...r, unresolvedKind: "event-subscribe", raw: "loans.checked" } as typeof r)
        : r,
    );
    const [t] = featureFlows([...topic, ...detectFeatures(topic)]);
    expect(t!.looseEnds.find((e) => e.kind === "loose-end")?.text).toBe(
      "scoring has a loose end Atticus couldn't follow (loans.checked)",
    );
  });
});
