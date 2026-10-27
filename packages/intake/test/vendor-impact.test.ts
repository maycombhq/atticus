import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseFacts, readFlow, specFlowFiles, type Fact, type JoinRepo } from "@maycombhq/core";
import {
  readVendorSpec,
  vendorImpact,
  type ImpactFlow,
  type VendorImpactInput,
} from "../src/index.js";

/**
 * What Northwind Pay 2.0.0 does to the estate (ADR 0130): the partner gateway forwards to three of
 * 1.0.0's operations, billing calls through it, and the shop calls billing. The expected impact is
 * written by hand (fixtures/vendor-impact/expected/impact.yaml).
 */

const FX = join(__dirname, "..", "..", "..", "fixtures", "vendor-impact");
const V1 = "inputs/partner-specs/northwind-pay-openapi-v1.yaml";
const V2 = "inputs/partner-specs/northwind-pay-openapi-v2.yaml";
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
  {
    repo: "forge-partner-gateway",
    facts: facts("forge-partner-gateway"),
    component: "partner-gateway",
    hosts: ["partner.forge.example"],
    gateway: true,
    facing: "external",
  },
];
async function flows(): Promise<ImpactFlow[]> {
  const out: ImpactFlow[] = [];
  for (const [id, f] of await specFlowFiles(FX)) {
    const flow = (await readFlow(FX, f.repo, id))!;
    out.push({
      id,
      repo: f.repo,
      ...(flow.trigger.ref ? { trigger: flow.trigger.ref } : {}),
      refs: flow.steps.flatMap((s) => s.refs ?? []),
    });
  }
  return out;
}
const input = async (): Promise<VendorImpactInput> => ({
  vendor: { system: "northwind-pay", names: ["Northwind Pay"] },
  older: {
    id: "doc.northwind-pay-openapi-v1",
    spec: readVendorSpec(V1, text(V1), "northwind-pay")!,
  },
  newer: {
    id: "doc.northwind-pay-openapi-v2",
    spec: readVendorSpec(V2, text(V2), "northwind-pay")!,
  },
  repos: estate(),
  flows: await flows(),
  systemOfRepo: {
    "forge-shop-bff": "shop",
    "forge-billing": "billing",
    "forge-partner-gateway": "platform",
  },
});

describe("vendorImpact", () => {
  it("gives the hand-written impact: each change, the forwarding calls, the service calls and on up", async () => {
    const { impact } = vendorImpact(await input());
    expect(JSON.parse(JSON.stringify(impact))).toEqual(parse(text("expected/impact.yaml")));
  });

  it("gives the diff beside it, the same as diffVendorSpecs", async () => {
    const { diff } = vendorImpact(await input());
    expect(diff.map((c) => c.id)).toEqual([
      "field-renamed.post-charges.request.reference",
      "operation-removed.post-charges-chargeid-capture",
      "field-required.post-charges-chargeid-refunds.request.reason",
      "operation-added.get-charges",
    ]);
  });

  it("is the same whatever order the repos come in", async () => {
    const i = await input();
    expect(vendorImpact({ ...i, repos: [...i.repos].reverse() })).toEqual(vendorImpact(i));
  });

  it("finds a service call that reaches the route through another gateway, and names the hops", async () => {
    // The shop calls billing's pay through an internal edge gateway instead of directly.
    const i = await input();
    const edge: JoinRepo = {
      repo: "forge-edge-gateway",
      component: "edge-gateway",
      hosts: ["api.forge.example"],
      gateway: true,
      facts: [
        {
          kind: "entry",
          id: "entry.post.pay-invoices-id",
          repo: "forge-edge-gateway",
          commit: "bbb8888",
          entryType: "rest",
          method: "POST",
          path: "/edge/billing/invoices/{id}/pay",
          handler: "billing-v1/Pay",
          cite: {
            file: "proxies/billing-v1/apiproxy/proxies/default.xml",
            line: 4,
            value: "/invoices/*/pay",
            quote: "<Condition>/invoices/*/pay</Condition>",
          },
          verified: "line",
          by: "assistant",
          conf: "declared",
        },
        {
          kind: "call",
          id: "call.post.invoices-id-pay",
          repo: "forge-edge-gateway",
          commit: "bbb8888",
          callType: "rest",
          method: "POST",
          path: "/invoices/{id}/pay",
          host: "billing.forge.internal",
          from: "entry.post.pay-invoices-id",
          cite: {
            file: "proxies/billing-v1/apiproxy/targets/default.xml",
            line: 5,
            value: "billing.forge.internal",
            quote: "<URL>https://billing.forge.internal</URL>",
          },
          verified: "line",
          by: "assistant",
          conf: "declared",
        },
      ] as Fact[],
    };
    const shop = i.repos.find((r) => r.repo === "forge-shop-bff")!;
    const repos = [
      ...i.repos.filter((r) => r !== shop),
      {
        ...shop,
        facts: shop.facts
          .filter((f) => f.kind !== "config")
          .map((f) =>
            f.kind === "call"
              ? {
                  ...f,
                  path: "/edge/billing/invoices/{id}/pay",
                  base: undefined,
                  host: "api.forge.example",
                }
              : f,
          ) as Fact[],
      },
      edge,
    ];
    const { impact } = vendorImpact({ ...i, repos });
    const up = impact.changes[0]!.forwards[0]!.callers[0]!.upstream;
    expect(up.map((u) => [u.call.repo, u.via, u.reaches.fact])).toEqual([
      [
        "forge-shop-bff",
        ["gw-edge-gateway-post-edge-billing-invoices-id-pay"],
        "entry.post.invoices-id-pay",
      ],
    ]);
    expect(impact.repos).toEqual(["forge-billing", "forge-partner-gateway", "forge-shop-bff"]);
  });

  it("says a forwarding call to an operation 1.0.0 doesn't publish as a gap", async () => {
    const i = await input();
    const repos = i.repos.map((r) =>
      r.repo === "forge-partner-gateway"
        ? {
            ...r,
            facts: r.facts.map((f) =>
              f.id === "call.post.v1-charges-chargeid-capture" && f.kind === "call"
                ? { ...f, path: "/v1/charges/{chargeId}/void" }
                : f,
            ),
          }
        : r,
    );
    const { impact } = vendorImpact({ ...i, repos });
    expect(impact.gaps.map((g) => g.message)).toEqual([
      "partner-gateway forwards POST /v1/charges/{chargeId}/void to Northwind Pay, whose spec publishes no such operation",
    ]);
    expect(impact.changes[1]!.forwards).toEqual([]);
  });
});
