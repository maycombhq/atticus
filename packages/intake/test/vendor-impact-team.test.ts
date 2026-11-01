import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { interfaceId, parseFacts, type Fact, type JoinRepo } from "@maycombhq/core";
import { readVendorSpec, vendorImpact, type VendorImpactInput } from "../src/index.js";

/**
 * O2 (ADR 0142): another team's spec as their system. The Forge Risk Team (an invented internal
 * team, boundary `internal`, no repo in the estate) publishes an OpenAPI spec; billing calls it
 * directly, with no gateway between, and the shop calls billing. Its 2.0.0 makes the request
 * field `channel` required, which billing doesn't send. The impact lands billing's call on the
 * operation, checks the field it sends, and walks up to the shop, as a vendor's does.
 */

const FX = join(__dirname, "..", "..", "..", "fixtures", "team-spec");
const V1 = "inputs/partner-specs/forge-risk-openapi-v1.yaml";
const V2 = "inputs/partner-specs/forge-risk-openapi-v2.yaml";
const text = (p: string) => readFileSync(join(FX, p), "utf8");
const facts = (repo: string): Fact[] => {
  const r = parseFacts(text(`facts/${repo}.jsonl`));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const estate = (): JoinRepo[] => [
  { repo: "forge-shop-bff", facts: facts("forge-shop-bff"), component: "shop-bff" },
  {
    repo: "forge-billing",
    facts: facts("forge-billing"),
    component: "billing-api",
    hosts: ["billing.forge.internal"],
  },
];
const input = (boundary?: "internal"): VendorImpactInput => ({
  vendor: {
    system: "forge-risk",
    names: ["Forge Risk Team", "risk.forge.internal"],
    ...(boundary ? { boundary } : {}),
  },
  older: { id: "doc-v1", spec: readVendorSpec(V1, text(V1), "forge-risk")! },
  newer: { id: "doc-v2", spec: readVendorSpec(V2, text(V2), "forge-risk")! },
  repos: estate(),
  systemOfRepo: { "forge-shop-bff": "shop", "forge-billing": "billing" },
});

const CALL = {
  repo: "forge-billing",
  fact: "call.post.v1-assessments",
  component: "billing-api",
  at: "src/main/java/forge/billing/RiskClient.java:12",
};
const PAY = {
  repo: "forge-billing",
  fact: "entry.post.invoices-id-pay",
  component: "billing-api",
  at: "src/main/java/forge/billing/InvoicesController.java:13",
};

describe("vendorImpact for another team's spec", () => {
  it("lands billing's own call on the operation, says it doesn't send the field now required, and walks up to the shop", () => {
    const { diff, impact } = vendorImpact(input("internal"));
    expect(diff.map((c) => [c.kind, c.side, c.field, c.severity])).toEqual([
      ["field-required", "request", "channel", "breaking"],
    ]);
    const op = input().older.spec.operations[0]!.id;
    expect(impact.changes).toEqual([
      {
        id: diff[0]!.id,
        severity: "breaking",
        says: diff[0]!.says,
        forwards: [
          {
            call: CALL,
            route: PAY,
            operation: op,
            direct: true,
            callers: [
              {
                call: CALL,
                interface: interfaceId("billing-api", "forge-risk", "POST", "/v1/assessments"),
                field: { uses: "does-not-send" },
                under: PAY,
                upstream: [
                  {
                    call: {
                      repo: "forge-shop-bff",
                      fact: "call.post.invoices-id-pay",
                      component: "shop-bff",
                      at: "src/main/java/forge/shop/BillingClient.java:9",
                    },
                    interface: interfaceId("shop-bff", "billing-api", "POST", "/invoices/{id}/pay"),
                    reaches: PAY,
                    under: {
                      repo: "forge-shop-bff",
                      fact: "entry.post.checkout",
                      component: "shop-bff",
                      at: "src/main/java/forge/shop/CheckoutController.java:16",
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
    expect(impact.repos).toEqual(["forge-billing", "forge-shop-bff"]);
    expect(impact.systems).toEqual(["billing", "forge-risk", "shop"]);
    expect(impact.endpoints).toEqual([op]);
    expect(impact.gaps).toEqual([]);
  });

  it("matches only a gateway's forwarding calls for a vendor, as before", () => {
    const { impact } = vendorImpact(input());
    expect(impact.changes[0]!.forwards).toEqual([]);
  });
});

describe("readVendorSpec, another team's spec", () => {
  it("reads its error responses, each citing its status's line, and each field's enum", () => {
    const spec = readVendorSpec(V1, text(V1), "forge-risk")!;
    expect(spec.hosts).toEqual(["risk.forge.internal"]);
    const op = spec.operations[0]!;
    expect(op.errors).toEqual([{ status: "422", cite: `${V1}:25` }]);
    expect(op.request.find((f) => f.name === "channel")?.enum).toEqual(["web", "phone", "shop"]);
    expect(op.response.find((f) => f.name === "decision")?.enum).toEqual([
      "approve",
      "review",
      "decline",
    ]);
  });
});
