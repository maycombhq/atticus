import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyCurated, parseRecord, type CatalogRecord } from "@maycombhq/core";
import {
  detectFeatures,
  FeatureError,
  featureLinkDecision,
  featureMergeDecision,
  featureNameDecision,
  featureSplitDecisions,
  featureTagDecision,
  featureToSpec,
  parseExternalRef,
  type Capability,
} from "../src/index.js";
import { FIX, forgeRecords } from "./helpers.js";

const AT = "2026-10-18T13:00:00Z";
const by = { by: "a.owner", at: AT };

/** The catalog a scan would build: detection shaped by the decisions, then the decisions applied. */
function catalog(decisions: CatalogRecord[]) {
  const records = forgeRecords();
  const features = detectFeatures(records, { decisions });
  const applied = applyCurated([...records, ...features], decisions);
  return {
    features: applied.records.filter((r): r is Capability => r.kind === "Capability"),
    problems: applied.problems,
  };
}
const feature = (decisions: CatalogRecord[], id: string) =>
  catalog(decisions).features.find((f) => f.id === id)!;
const transfers = () => detectFeatures(forgeRecords()).find((f) => f.id === "feature.transfers")!;

describe("people name, tag, merge, split and link features", () => {
  it("naming writes an assert: the feature is confirmed, asserted, with manual evidence", () => {
    const d = featureNameDecision(transfers(), {
      name: "Money transfers",
      description: "Moves money between accounts.",
      owner: "team-ledger",
      ...by,
    });
    expect(d).toEqual({
      schemaVersion: 2,
      kind: "CuratedDecision",
      id: "feature-name.transfers",
      status: "current",
      confidence: "asserted",
      evidence: [{ source: "manual", by: "a.owner" }],
      target: "feature.transfers",
      action: "assert",
      value: {
        name: "Money transfers",
        namedBy: "person",
        description: "Moves money between accounts.",
        owner: "team-ledger",
      },
      reason: 'a.owner named feature.transfers "Money transfers"',
      by: "a.owner",
      at: AT,
    });
    const f = feature([d], "feature.transfers");
    expect(f).toMatchObject({
      name: "Money transfers",
      namedBy: "person",
      owner: "team-ledger",
      confidence: "asserted",
    });
    expect(f.evidence.at(-1)).toEqual({ source: "manual", by: "a.owner" });
  });

  it("refuses an empty name", () => {
    expect(() => featureNameDecision(transfers(), { name: "  ", ...by })).toThrow(FeatureError);
  });

  it("tags with the full list, lower-case and without repeats", () => {
    const d = featureTagDecision(transfers(), ["Payments", "ledger", "payments"], by);
    expect(d).toMatchObject({
      id: "feature-tags.transfers",
      action: "assert",
      value: { tags: ["ledger", "payments"] },
    });
    expect(feature([d], "feature.transfers").tags).toEqual(["ledger", "payments"]);
    expect(() => featureTagDecision(transfers(), ["not a tag!"], by)).toThrow(FeatureError);
  });

  it("merges with an alias: the merged feature folds into the target on every scan", () => {
    const all = detectFeatures(forgeRecords());
    const into = all.find((f) => f.id === "feature.transfers")!;
    const from = all.find((f) => f.id === "feature.payments")!;
    const d = featureMergeDecision(into, [from], by);
    expect(d).toMatchObject({
      id: "feature-merge.transfers.payments",
      target: "feature.transfers",
      action: "alias",
      value: ["feature.payments"],
    });
    const c = catalog([d]);
    expect(c.problems).toEqual([]);
    expect(c.features.map((f) => f.id)).toEqual([
      "feature.account-balance",
      "feature.daily-entries-report",
      "feature.transfers",
    ]);
    expect(() => featureMergeDecision(into, [into], by)).toThrow(FeatureError);
  });

  it("splits with two membership asserts, so both features keep their ids", () => {
    const balance = detectFeatures(forgeRecords()).find((f) => f.id === "feature.account-balance")!;
    const ds = featureSplitDecisions(balance, ["ledger-api.get-balance"], {
      into: "feature.ledger-balance",
      name: "Ledger balance",
      ...by,
    });
    expect(ds.map((d) => [d.id, d.target, d.value])).toEqual([
      [
        "feature-split.ledger-balance",
        "feature.ledger-balance",
        { entryPoints: ["ledger-api.get-balance"], name: "Ledger balance", namedBy: "person" },
      ],
      [
        "feature-members.account-balance",
        "feature.account-balance",
        { entryPoints: ["portal-bff.get-balance"] },
      ],
    ]);
    const c = catalog(ds);
    expect(c.problems).toEqual([]);
    expect(c.features.find((f) => f.id === "feature.ledger-balance")).toMatchObject({
      name: "Ledger balance",
      namedBy: "person",
      confidence: "asserted",
      entryPoints: ["ledger-api.get-balance"],
    });
    expect(c.features.find((f) => f.id === "feature.account-balance")!.entryPoints).toEqual([
      "portal-bff.get-balance",
    ]);
    expect(() => featureSplitDecisions(balance, ["portal-ui"], by)).toThrow(FeatureError);
    expect(() =>
      featureSplitDecisions(balance, ["portal-bff.get-balance", "ledger-api.get-balance"], by),
    ).toThrow(FeatureError);
  });

  it("names the split-off feature from what moved when no id is given", () => {
    const balance = detectFeatures(forgeRecords()).find((f) => f.id === "feature.account-balance")!;
    const [d] = featureSplitDecisions(balance, ["portal-bff.get-balance"], {
      ...by,
      records: forgeRecords(),
    });
    expect(d!.target).toBe("feature.balance");
  });

  it("links a work item, keeping the links already there", () => {
    const first = featureLinkDecision(transfers(), parseExternalRef("ado:102", "Transfers"), by);
    expect(first).toMatchObject({
      id: "feature-link.transfers.ado-102",
      value: { externalRefs: [{ system: "ado", id: "102", title: "Transfers" }] },
    });
    const linked = feature([first], "feature.transfers");
    const second = featureLinkDecision(
      linked,
      parseExternalRef("https://wiki.example.com/pages/transfers"),
      { by: "a.owner", at: "2026-10-18T14:00:00Z" },
    );
    expect(second.value).toEqual({
      externalRefs: [
        { system: "ado", id: "102", title: "Transfers" },
        {
          system: "wiki",
          id: "wiki.example.com/pages/transfers",
          url: "https://wiki.example.com/pages/transfers",
        },
      ],
    });
    expect(feature([first, second], "feature.transfers").externalRefs).toHaveLength(2);
    // linking the same item again changes nothing
    expect(featureLinkDecision(linked, parseExternalRef("ado:102"), by).value).toEqual(first.value);
  });

  it("reads work-item references in the forms people type", () => {
    expect(parseExternalRef("ado:4711")).toEqual({ system: "ado", id: "4711" });
    expect(parseExternalRef("JIRA:PAY-12")).toEqual({ system: "jira", id: "PAY-12" });
    expect(parseExternalRef("openspec:transfers")).toEqual({ system: "openspec", id: "transfers" });
    expect(parseExternalRef("https://dev.azure.com/contoso/payments/_workitems/edit/4711")).toEqual(
      {
        system: "ado",
        id: "4711",
        url: "https://dev.azure.com/contoso/payments/_workitems/edit/4711",
      },
    );
    expect(() => parseExternalRef("just words")).toThrow(FeatureError);
  });

  it("every decision is a valid C1 CuratedDecision", () => {
    const t = transfers();
    for (const d of [
      featureNameDecision(t, { name: "X", ...by }),
      featureTagDecision(t, ["x"], by),
      featureLinkDecision(t, parseExternalRef("ado:1"), by),
    ])
      expect(parseRecord(d).ok).toBe(true);
  });
});

describe("featureToSpec", () => {
  it("drafts an OpenSpec capability spec from a confirmed feature (golden)", () => {
    const name = featureNameDecision(transfers(), {
      name: "Money transfers",
      description:
        "Moves money between accounts through the ledger and tells reporting when a transfer completes.",
      ...by,
    });
    const f = feature([name], "feature.transfers");
    const draft = featureToSpec(f, forgeRecords());
    expect(draft.path).toBe("openspec/specs/transfers/spec.md");
    expect(draft.text).toBe(readFileSync(join(FIX, "specs/transfers.md"), "utf8"));
  });

  it("refuses a feature no person has confirmed", () => {
    expect(() => featureToSpec(transfers(), forgeRecords())).toThrow(
      "feature.transfers isn't confirmed yet: name it with atticus feature name first",
    );
  });
});
