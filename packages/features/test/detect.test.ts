import { describe, expect, it } from "vitest";
import { parseRecord, type CatalogRecord } from "@maycombhq/core";
import { detectFeatures, detectFeaturesWithReport } from "../src/index.js";
import { build, comparable, expectedFeatures, forgeRecords, record } from "./helpers.js";

const decision = (target: string, action: string, value: unknown, at = "2026-10-18T10:00:00Z") =>
  record({
    kind: "CuratedDecision",
    id: `d.${action}.${target}`,
    confidence: "asserted",
    target,
    action,
    value,
    reason: "test",
    by: "a.owner",
    at,
  });

describe("detectFeatures on the Forge catalog (golden)", () => {
  it("finds exactly the hand-written features, field for field", () => {
    const got = detectFeatures(forgeRecords());
    expect(got.map(comparable)).toEqual(expectedFeatures().map(comparable));
  });

  it("returns valid C1 records: detected, inferred, with the entry points' evidence", () => {
    for (const f of detectFeatures(forgeRecords())) {
      expect(parseRecord(f).ok).toBe(true);
      expect(f).toMatchObject({ namedBy: "detected", confidence: "inferred", status: "current" });
      expect(f.entryPoints.every((e) => f.records.includes(e))).toBe(true);
    }
  });

  it("is deterministic: input order doesn't matter, and features already in the input are rebuilt", () => {
    const records = forgeRecords();
    const first = detectFeatures(records);
    const shuffled = [...records].reverse();
    expect(detectFeatures(shuffled)).toEqual(first);
    const stale = { ...first[0]!, name: "Old name", records: ["portal-ui"] } as CatalogRecord;
    expect(detectFeatures([...records, stale])).toEqual(first);
  });
});

describe("entry points", () => {
  it("starts a feature at a scheduled job (a batch Setting schedule.*)", () => {
    const records = [
      build.system("statements"),
      build.component("statements-batch", "statements", "spring-boot"),
      build.schedule("statements-batch", "schedule.nightly-statement-run"),
      build.table("stmt-db", "statement", { writers: ["statements-batch"] }),
      build.table("stmt-db", "audit_log", { writers: ["statements-batch"] }),
    ];
    const [f, ...rest] = detectFeatures(records);
    expect(rest).toEqual([]);
    expect(f).toMatchObject({
      id: "feature.nightly-statement",
      name: "Nightly statement",
      entryPoints: ["statements-batch.schedule-nightly-statement-run"],
      // statement shares a word with the job; audit_log is left out because one table matched
      records: [
        "statements-batch",
        "statements-batch.schedule-nightly-statement-run",
        "stmt-db.statement",
      ],
    });
  });

  it("merges flows that share a primary resource, across systems", () => {
    const records = [
      build.system("partners"),
      build.system("orders"),
      build.system("fulfilment"),
      build.component("partner-portal", "partners", "spring-boot"),
      build.component("order-api", "orders"),
      build.component("fulfilment-api", "fulfilment"),
      build.endpoint("order-api", "GET", "/orders/{id}"),
      build.endpoint("fulfilment-api", "POST", "/orders"),
      build.call("partner-portal", "order-api", "GET", "/orders/{}", {
        endpoint: "order-api.get-order",
        via: "gateway",
      }),
      build.call("partner-portal", "fulfilment-api", "POST", "/orders", {
        endpoint: "fulfilment-api.post-order",
      }),
    ];
    const got = detectFeatures(records);
    expect(got.map((f) => [f.id, f.name, f.entryPoints])).toEqual([
      ["feature.orders", "Orders", ["fulfilment-api.post-order", "order-api.get-order"]],
    ]);
  });

  it("leaves out vendor endpoints, endpoints nobody calls and calls within one system", () => {
    const records = [
      build.system("shop"),
      build.system("fabrikam-tax", "vendor"),
      build.component("shop-api", "shop"),
      build.component("shop-worker", "shop"),
      build.endpoint("shop-api", "GET", "/baskets/{id}"),
      build.endpoint("shop-api", "DELETE", "/baskets/{id}"),
      build.endpoint("fabrikam-tax", "POST", "/v1/quotes"),
      build.call("shop-worker", "shop-api", "GET", "/baskets/{}", {
        endpoint: "shop-api.get-basket",
      }),
      build.call("shop-api", "fabrikam-tax", "POST", "/v1/quotes", {
        endpoint: "fabrikam-tax.post-quote",
      }),
    ];
    expect(detectFeatures(records)).toEqual([]);
  });

  it("follows calls only to a bounded depth", () => {
    const chain = [
      build.system("web"),
      build.system("inventory"),
      build.component("web-ui", "web", "spa"),
      ...["items-a", "items-b", "items-c", "items-d"].map((c) => build.component(c, "inventory")),
      build.endpoint("items-a", "GET", "/items/{id}"),
      build.call("web-ui", "items-a", "GET", "/items/{}", { endpoint: "items-a.get-item" }),
      build.call("items-a", "items-b", "GET", "/items/{}"),
      build.call("items-b", "items-c", "GET", "/items/{}"),
      build.call("items-c", "items-d", "GET", "/items/{}"),
    ];
    const comps = (depth?: number) =>
      detectFeatures(chain, depth ? { maxDepth: depth } : {})[0]!.records.filter(
        (r) => r.startsWith("items-") || r === "web-ui",
      );
    expect(comps()).toEqual([
      "items-a",
      "items-a.get-item",
      "items-b",
      "items-c",
      "items-d",
      "web-ui",
    ]);
    expect(comps(2)).toEqual(["items-a", "items-a.get-item", "items-b", "items-c", "web-ui"]);
  });
});

describe("people's merges and splits shape detection on every scan", () => {
  it("folds a merged feature into the one it was merged into (an alias decision)", () => {
    const merge = decision("feature.transfers", "alias", "feature.payments");
    const got = detectFeatures(forgeRecords(), { decisions: [merge] });
    expect(got.map((f) => f.id)).toEqual([
      "feature.account-balance",
      "feature.daily-entries-report",
      "feature.transfers",
    ]);
    const t = got.find((f) => f.id === "feature.transfers")!;
    expect(t.entryPoints).toEqual([
      "ledger-api.post-transfer",
      "if-f1cd1f189eaa4b7b",
      "if-32d38aecd11b86b1",
    ]);
    expect(t.records).toEqual([
      "if-32d38aecd11b86b1",
      "if-d99f508a2ac9b6e0",
      "if-e7344c9455608119",
      "if-f1cd1f189eaa4b7b",
      "ledger-api",
      "ledger-api.post-transfer",
      "ledger-db.entry",
      "northwind-pay",
      "northwind-pay.post-payment",
      "portal-bff",
      "reports-job",
      "topic.payments-initiated",
      "topic.transfers-completed",
    ]);
  });

  it("keeps entry points where membership asserts pin them (a split), and both ids stay", () => {
    const split = [
      decision("feature.ledger-balance", "assert", { entryPoints: ["ledger-api.get-balance"] }),
      decision("feature.account-balance", "assert", { entryPoints: ["portal-bff.get-balance"] }),
    ];
    const got = detectFeatures(forgeRecords(), { decisions: split });
    const byId = new Map(got.map((f) => [f.id, f]));
    expect([...byId.keys()].sort()).toEqual([
      "feature.account-balance",
      "feature.daily-entries-report",
      "feature.ledger-balance",
      "feature.payments",
      "feature.transfers",
    ]);
    expect(byId.get("feature.ledger-balance")).toMatchObject({
      name: "Account balance",
      entryPoints: ["ledger-api.get-balance"],
      records: [
        "if-75b5e8d8aa780837",
        "ledger-api",
        "ledger-api.get-balance",
        "ledger-db.account",
        "portal-bff",
      ],
    });
    // the portal's flow still passes through the ledger; only the entry points moved
    expect(byId.get("feature.account-balance")).toMatchObject({
      name: "Balance",
      entryPoints: ["portal-bff.get-balance"],
    });
    expect(byId.get("feature.account-balance")!.records).toContain("ledger-db.account");
  });

  it("reports a merge it can't apply instead of guessing", () => {
    const merge = decision("feature.transfers", "alias", "feature.refunds");
    const r = detectFeaturesWithReport(forgeRecords(), { decisions: [merge] });
    expect(r.features).toHaveLength(4);
    expect(r.problems).toEqual([
      {
        decision: "d.alias.feature.transfers",
        message:
          "feature.refunds isn't a detected feature, so it can't be merged into feature.transfers",
      },
    ]);
  });
});

describe("AI name proposals", () => {
  it("names a detected feature from a proposal, still inferred, and ignores unknown features", () => {
    const got = detectFeatures(forgeRecords(), {
      proposals: [
        {
          feature: "feature.transfers",
          name: "Money transfers",
          description: "Moves money between accounts and tells reporting when it is done.",
          tags: ["payments"],
          evidence: ["ledger-api.post-transfer"],
          agent: "feature-namer",
          at: "2026-10-18T11:00:00Z",
        },
        {
          feature: "feature.nothing",
          name: "Nothing",
          tags: [],
          evidence: ["portal-ui"],
          agent: "feature-namer",
          at: "2026-10-18T11:00:00Z",
        },
      ],
    });
    expect(got.find((f) => f.id === "feature.transfers")).toMatchObject({
      name: "Money transfers",
      description: "Moves money between accounts and tells reporting when it is done.",
      tags: ["payments"],
      namedBy: "ai",
      confidence: "inferred",
    });
    expect(got.map((f) => f.id)).not.toContain("feature.nothing");
  });
});
