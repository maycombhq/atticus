import { describe, expect, it } from "vitest";
import { ServiceRequestTemplate } from "@maycombhq/core";
import {
  matchServiceRequestTriggers,
  triggerReason,
  type DataChange,
  type Hop,
} from "../src/index.js";

/**
 * One reading of service-desk triggers, shared by the critic's snow-drafts-present check
 * and the planner's snow.md drafts.
 */

const template = (o: Record<string, unknown>) =>
  ServiceRequestTemplate.parse({
    schemaVersion: 1,
    requestType: String(o.name),
    fields: [{ name: "Justification" }],
    approvers: ["network-team"],
    leadTimeDays: 5,
    ...o,
  });

const firewall = template({
  id: "firewall-rule",
  name: "Network firewall rule",
  triggers: [{ kind: "Interface", change: "planned-new", where: { via: "direct" } }],
  alsoNeeds: ["dns-entry"],
});
const dns = template({
  id: "dns-entry",
  name: "DNS entry",
  triggers: [{ kind: "Interface", change: "planned-retire", where: {} }],
});
const dba = template({
  id: "dba-review",
  name: "DBA review",
  triggers: [{ kind: "Table", change: "planned-new", where: {} }],
});

const hop = (o: Partial<Hop>): Hop => ({
  line: 5,
  id: "new",
  caller: "ledger-api",
  callee: "northwind-pay",
  pattern: "",
  operation: "POST /v2/limits",
  method: "POST",
  path: "/v2/limits",
  contract: "",
  status: "planned-new",
  ...o,
});

const data: DataChange[] = [
  {
    line: 9,
    store: "ledger-db",
    table: "limit_change",
    change: "new table",
    migration: "V4",
    tableId: "ledger-db.limit-change",
    newTable: true,
    newColumns: [],
  },
];

describe("service-desk trigger matching", () => {
  it("matches planned hops by route and new tables, each followed by what it also needs", () => {
    const m = matchServiceRequestTriggers({
      templates: [firewall, dns, dba],
      hops: [
        hop({ line: 5, pattern: "P-DIRECT" }),
        hop({ line: 6, pattern: "P-GW", callee: "ledger-api", caller: "portal-bff" }),
        hop({ line: 7, id: "if-1", status: "planned-modify" }),
      ],
      data,
      files: { dir: "/x", docs: new Map() },
      patterns: new Map([
        ["P-DIRECT", { route: "direct" }],
        ["P-GW", { route: "gateway" }],
      ]),
      get: () => undefined,
    });
    expect(m.map((x) => [x.template.id, x.record, x.alongside?.id ?? "", x.line, x.file])).toEqual([
      ["firewall-rule", "ledger-api-northwind-pay", "", 5, "interfaces.md"],
      ["dns-entry", "ledger-api-northwind-pay", "firewall-rule", 5, "interfaces.md"],
      ["dba-review", "ledger-db.limit-change", "", 9, "data.md"],
    ]);
    expect(triggerReason(m[0]!.record, m[0]!.trigger)).toBe(
      "ledger-api-northwind-pay is planned-new (Interface, via direct)",
    );
  });
});
