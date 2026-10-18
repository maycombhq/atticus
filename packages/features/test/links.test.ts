import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockWorkTracker } from "@maycombhq/adapters";
import { readWorkItemExports } from "@maycombhq/intake";
import {
  detectFeatures,
  featureLinkDecision,
  parseExternalRef,
  suggestFeatureLinks,
  workItemsFromTracker,
} from "../src/index.js";
import { FORGE, HERE, forgeRecords, record } from "./helpers.js";

const WORK_ITEMS = join(HERE, "../../intake/test/fixtures/work-items");

describe("suggestFeatureLinks", () => {
  it("suggests the Forge stories for the features whose names they share", async () => {
    const { items } = await readWorkItemExports({
      root: join(FORGE, "metarepo"),
      inputsDir: join(FORGE, "inputs"),
    });
    const records = forgeRecords();
    const got = suggestFeatureLinks({ features: detectFeatures(records), items, records });
    expect(got.map((i) => [i.id, i.kind, i.records, i.summary, i.source])).toEqual([
      [
        "feature-link.account-balance.ado-101",
        "feature-link",
        ["feature.account-balance"],
        'ADO story 101 "As a customer I can see my available balance" may be what built Account balance (feature.account-balance): it shares "balance".',
        { path: "inputs/tickets/ado-stories.json", line: 2 },
      ],
      [
        "feature-link.transfers.ado-102",
        "feature-link",
        ["feature.transfers"],
        'ADO story 102 "Transfers" may be what built Transfers (feature.transfers): it shares "transfer".',
        { path: "inputs/tickets/ado-stories.json", line: 3 },
      ],
    ]);
    // each option is the curated-decision draft a person confirms: link, or dismiss
    expect(got[1]!.options).toEqual([
      {
        action: "assert",
        label: "Link ADO story 102 to Transfers",
        decision: {
          id: "feature-link.transfers.ado-102",
          target: "feature.transfers",
          action: "assert",
          value: { externalRefs: [{ system: "ado", id: "102", title: "Transfers" }] },
          reason: "Link ADO story 102 to Transfers",
        },
      },
      {
        action: "suppress",
        label: "Not this feature",
        decision: {
          id: "triage.feature-link.transfers.ado-102",
          target: "feature.transfers",
          action: "suppress",
          value: { triage: "feature-link.transfers.ado-102" },
          reason: "Not this feature",
        },
      },
    ]);
  });

  it("uses the repos and paths the items' pull requests touched, and skips tasks and bugs", async () => {
    const { items } = await readWorkItemExports({ root: WORK_ITEMS });
    const records = forgeRecords();
    const got = suggestFeatureLinks({ features: detectFeatures(records), items, records });
    expect(got.map((i) => i.id)).toEqual([
      "feature-link.account-balance.ado-7001",
      "feature-link.account-balance.ado-7002",
      "feature-link.daily-entries-report.ado-8001",
      "feature-link.payments.ado-7001",
      "feature-link.transfers.ado-7001",
    ]);
    const byId = new Map(got.map((i) => [i.id, i.summary]));
    expect(byId.get("feature-link.transfers.ado-7001")).toBe(
      'ADO epic 7001 "Move money between accounts" may be what built Transfers (feature.transfers): its pull requests touched forge-ledger (src/main/java/forge/ledger/LedgerEndpoints.java).',
    );
    expect(byId.get("feature-link.account-balance.ado-7001")).toBe(
      'ADO epic 7001 "Move money between accounts" may be what built Account balance (feature.account-balance): it shares "account"; its pull requests touched forge-ledger (src/main/java/forge/ledger/LedgerEndpoints.java).',
    );
    expect(byId.get("feature-link.account-balance.ado-7002")).toBe(
      'ADO feature 7002 "Account balance in the portal" may be what built Account balance (feature.account-balance): it shares "account", "balance".',
    );
  });

  it("leaves out links already made and suggestions already answered", async () => {
    const { items } = await readWorkItemExports({
      root: join(FORGE, "metarepo"),
      inputsDir: join(FORGE, "inputs"),
    });
    const records = forgeRecords();
    const features = detectFeatures(records);
    const transfers = features.find((f) => f.id === "feature.transfers")!;
    const linked = { ...transfers, externalRefs: [{ system: "ado" as const, id: "102" }] };
    expect(
      suggestFeatureLinks({
        features: features.map((f) => (f.id === transfers.id ? linked : f)),
        items,
        records,
      }).map((i) => i.id),
    ).toEqual(["feature-link.account-balance.ado-101"]);
    const dismissed = record({
      kind: "CuratedDecision",
      id: "triage.feature-link.account-balance.ado-101",
      confidence: "asserted",
      target: "feature.account-balance",
      action: "suppress",
      value: { triage: "feature-link.account-balance.ado-101" },
      reason: "Not this feature",
      by: "a.owner",
      at: "2026-10-18T10:00:00Z",
    });
    const link = featureLinkDecision(transfers, parseExternalRef("ado:102"), { by: "a.owner" });
    expect(suggestFeatureLinks({ features, items, records, decisions: [dismissed, link] })).toEqual(
      [],
    );
  });

  it("reads work items through the work tracker adapter, read-only", async () => {
    const tracker = new MockWorkTracker([
      {
        id: "9001",
        type: "feature",
        title: "Transfers between accounts",
        description: "",
        acceptanceCriteria: "",
        state: "Active",
        tags: [],
        url: "https://work.example.com/items/9001",
      },
      {
        id: "9002",
        type: "task",
        title: "Transfers runbook",
        description: "",
        acceptanceCriteria: "",
        state: "New",
        tags: [],
        url: "https://work.example.com/items/9002",
      },
    ]);
    const items = await workItemsFromTracker(tracker);
    expect(items.map((i) => [i.id, i.type])).toEqual([["9001", "feature"]]);
    expect(tracker.journal.every((c) => !c.approval)).toBe(true);
    const records = forgeRecords();
    const got = suggestFeatureLinks({ features: detectFeatures(records), items, records });
    expect(got.map((i) => [i.id, i.source])).toEqual([
      ["feature-link.account-balance.ado-9001", { path: "https://work.example.com/items/9001" }],
      ["feature-link.transfers.ado-9001", { path: "https://work.example.com/items/9001" }],
    ]);
  });
});
