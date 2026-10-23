import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, type CatalogRecord } from "@maycombhq/core";
import { changeView, toMermaid, type ChangeFlowIn } from "../src/index.js";

/**
 * A change's picture (ADR 0108): the components, entries and tables its target flows touch,
 * each marked new, modify or retire from the flow steps' own marks, the rest drawn as context.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const golden = (name: string) => readFileSync(join(HERE, "fixtures/golden", name), "utf8");

const forge = (): CatalogRecord[] =>
  (parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<string, unknown>[]).map(
    (r) => {
      const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
      if (!p.ok) throw new Error(String(r.id));
      return p.record;
    },
  );

/** add-transfer-limit's target flows, as the merge gives them (marks per step). */
const FLOWS: ChangeFlowIn[] = [
  {
    flow: "ledger-api.post-transfer",
    name: "Post a transfer",
    component: "ledger-api",
    change: "modify",
    steps: [
      { mark: "same", kind: "entry" },
      {
        mark: "same",
        kind: "write",
        store: { table: "ledger-db.entry", columns: ["amount"] },
      },
      {
        mark: "changed",
        kind: "call-out",
        to: { component: "audit-svc", entry: "POST /events" },
      },
      {
        mark: "added",
        kind: "lookup",
        store: { table: "ledger-db.transfer_limit", columns: ["daily_max"], new: true },
      },
      {
        mark: "added",
        kind: "write",
        store: {
          table: "ledger-db.account",
          columns: ["limit_used"],
          migration: "V5__add_limit_used.sql",
        },
      },
      {
        mark: "added",
        kind: "call-out",
        to: { component: "limits-svc", entry: "POST /checks", new: true },
      },
      {
        mark: "removed",
        kind: "publish",
        to: { component: "reports-job", entry: "ledger.legacy-totals" },
      },
    ],
  },
  {
    flow: "portal-bff.legacy-statement",
    name: "Legacy statement",
    component: "portal-bff",
    change: "remove",
    steps: [
      { mark: "removed", kind: "entry" },
      {
        mark: "removed",
        kind: "call-out",
        to: { component: "ledger-api", entry: "GET /statements" },
      },
    ],
  },
];

const CHANGE = {
  id: "add-transfer-limit",
  title: "Daily transfer limit",
  source: "openspec/changes/add-transfer-limit/target-flows",
};
const view = () => changeView(forge(), CHANGE, FLOWS);
const node = (id: string) => view().nodes.find((n) => n.id === id);
const edge = (from: string, to: string) =>
  view().edges.filter((e) => e.from === from && e.to === to);

describe("a change's picture (ADR 0108)", () => {
  it("marks each line by its steps: added new, removed retire, changed modify, the rest context", () => {
    expect(edge("ledger-api", "ledger-db.transfer_limit")[0]?.legend).toBe("new");
    expect(edge("ledger-api", "limits-svc")[0]?.legend).toBe("new");
    expect(edge("ledger-api", "audit-svc")[0]?.legend).toBe("modify");
    expect(edge("ledger-api", "reports-job")[0]).toMatchObject({
      legend: "retire",
      async: true,
      label: "✕ ledger.legacy-totals",
    });
    expect(edge("portal-bff", "ledger-api")[0]?.legend).toBe("retire");
    expect(edge("ledger-api", "ledger-db.entry")[0]?.legend).toBeUndefined();
  });

  it("marks a box new when the catalog hasn't it, modify when its flows or columns change", () => {
    expect(node("limits-svc")).toMatchObject({ kind: "component", legend: "new" });
    expect(node("ledger-db.transfer_limit")).toMatchObject({ kind: "table", legend: "new" });
    expect(node("ledger-db.account")).toMatchObject({ kind: "table", legend: "modify" });
    expect(node("ledger-api")).toMatchObject({
      kind: "component",
      legend: "modify",
      group: "ledger",
    });
    expect(node("portal-bff")?.legend).toBe("modify");
    // Called, read or published to as before: context, unmarked.
    expect(node("audit-svc")?.legend).toBeUndefined();
    expect(node("reports-job")?.legend).toBeUndefined();
    expect(node("ledger-db.entry")?.legend).toBeUndefined();
  });

  it("says each mark in the words too, not by colour alone", () => {
    expect(node("limits-svc")?.label).toBe("+ limits-svc");
    expect(node("ledger-api")?.label).toBe("◇ ledger-api");
    expect(node("audit-svc")?.label).toBe("audit-svc");
    expect(edge("ledger-api", "audit-svc")[0]?.label).toBe("◇ POST /events");
    expect(edge("ledger-api", "ledger-db.entry")[0]?.label).toBe("write");
  });

  it("doesn't call a part new because the catalog lacks it: that is unknown, not new", () => {
    const v = changeView([], CHANGE, FLOWS);
    const at = (id: string) => v.nodes.find((n) => n.id === id)?.legend;
    expect(at("ledger-api")).toBe("modify");
    expect(at("audit-svc")).toBeUndefined();
    expect(at("ledger-db.entry")).toBeUndefined();
    expect(at("limits-svc")).toBe("new");
    expect(at("ledger-db.transfer_limit")).toBe("new");
  });

  it("draws a step sent elsewhere as today's line retired and the new line added", () => {
    const moved: ChangeFlowIn = {
      flow: "ledger-api.post-transfer",
      name: "Post a transfer",
      component: "ledger-api",
      change: "modify",
      steps: [
        {
          mark: "changed",
          kind: "call-out",
          to: { component: "limits-svc", entry: "POST /audit" },
          was: { to: { component: "audit-svc", entry: "POST /events" } },
        },
      ],
    };
    const v = changeView(forge(), CHANGE, [moved], ["limits-svc"]);
    const at = (to: string) => v.edges.find((e) => e.from === "ledger-api" && e.to === to);
    expect(at("audit-svc")).toMatchObject({ legend: "retire", label: "✕ POST /events" });
    expect(at("limits-svc")).toMatchObject({ legend: "new", label: "+ POST /audit" });
  });

  it("knows a component today's specs name, catalog or not", () => {
    const flow: ChangeFlowIn = {
      flow: "forge-orders.screen-order",
      name: "Screen an order again",
      component: "forge-orders",
      change: "new",
      steps: [{ mark: "added", kind: "entry" }],
    };
    const legendOf = (known: string[]) =>
      changeView([], CHANGE, [flow], known).nodes.find((n) => n.id === "forge-orders")?.legend;
    expect(legendOf([])).toBe("new");
    expect(legendOf(["forge-orders"])).toBe("modify");
  });

  it("never marks a component retired: a removed flow doesn't say the component goes", () => {
    expect(view().nodes.filter((n) => n.legend === "retire")).toEqual([]);
  });

  it("groups components in their systems and tables in their data store", () => {
    const v = view();
    expect(v.groups.map((g) => g.id)).toEqual([
      "audit",
      "ledger",
      "portal",
      "reports",
      "ledger-db",
    ]);
    expect(node("ledger-db.entry")?.group).toBe("ledger-db");
  });

  it("is the same picture whatever order the flows and steps come in", () => {
    const again = changeView(
      forge(),
      CHANGE,
      [...FLOWS].reverse().map((f) => ({ ...f, steps: [...f.steps].reverse() })),
    );
    expect(again).toEqual(view());
  });

  it("renders as Mermaid with the legend (golden file)", () => {
    expect(toMermaid(view())).toBe(golden("change-add-transfer-limit.mmd"));
  });
});
