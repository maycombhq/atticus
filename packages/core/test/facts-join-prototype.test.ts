import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  comparePrototype,
  isMockEntry,
  isPrototypeType,
  parseFacts,
  type Fact,
  type FactOf,
  type JoinRepo,
  type PrototypeVendor,
} from "../src/index.js";

/**
 * A prototype compared with the estate (ADR 0133): the invented checkout prototype (a React UI,
 * its Express BFF behind the shop's SSO, MSW and WireMock mocks) against the Forge shop BFF,
 * billing, the partner gateway and Northwind Pay (an invented vendor). The expected comparison
 * is written by hand (fixtures/prototype-compare/expected/comparison.yaml).
 */

const DIR = join(__dirname, "..", "..", "..", "fixtures", "prototype-compare");
const read = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(DIR, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const estate = (): JoinRepo[] => [
  { repo: "forge-shop-bff", facts: read("forge-shop-bff"), component: "shop-bff" },
  {
    repo: "forge-billing",
    facts: read("forge-billing"),
    component: "billing-api",
    hosts: ["billing.forge.internal"],
  },
  {
    repo: "forge-partner-gateway",
    facts: read("forge-partner-gateway"),
    component: "partner-gateway",
    hosts: ["partner.forge.example"],
    gateway: true,
    facing: "external",
  },
];
const prototype = (): JoinRepo => ({
  repo: "forge-checkout-prototype",
  facts: read("forge-checkout-prototype"),
});
const V2 = "inputs/partner-specs/northwind-pay-openapi-v2.yaml";
/** Northwind Pay 2.0.0's operations as intake reads them (readVendorSpec), with their fields. */
const northwind = (): PrototypeVendor => ({
  system: "northwind-pay",
  names: ["Northwind Pay"],
  hosts: ["api.northwindpay.example"],
  operations: [
    {
      id: "northwind-pay.get-charge-625a4a",
      method: "GET",
      path: "/charges",
      fullPath: "/v1/charges",
      cite: `${V2}:12`,
    },
    {
      id: "northwind-pay.post-charge",
      method: "POST",
      path: "/charges",
      fullPath: "/v1/charges",
      cite: `${V2}:30`,
    },
    {
      id: "northwind-pay.get-charge-8fbd38",
      method: "GET",
      path: "/charges/{chargeId}",
      fullPath: "/v1/charges/{chargeId}",
      cite: `${V2}:46`,
      fields: [
        { side: "response", name: "id", type: "string", required: true },
        { side: "response", name: "status", type: "string", required: true },
        { side: "response", name: "amount", type: "number", required: true },
      ],
    },
    {
      id: "northwind-pay.post-refund",
      method: "POST",
      path: "/charges/{chargeId}/refunds",
      fullPath: "/v1/charges/{chargeId}/refunds",
      cite: `${V2}:60`,
    },
  ],
});
const expected = () => parse(readFileSync(join(DIR, "expected", "comparison.yaml"), "utf8"));
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe("comparePrototype", () => {
  it("places each call in exists, changes, new or vendor, as written by hand", () => {
    const got = comparePrototype({
      prototype: prototype(),
      estate: estate(),
      vendors: [northwind()],
    });
    expect(plain(got)).toEqual(expected());
  });

  it("gives the same comparison whatever order the repos and facts come in", () => {
    const a = comparePrototype({
      prototype: prototype(),
      estate: estate(),
      vendors: [northwind()],
    });
    const p = prototype();
    const b = comparePrototype({
      prototype: { ...p, facts: [...p.facts].reverse() },
      estate: estate()
        .reverse()
        .map((r) => ({ ...r, facts: [...r.facts].reverse() })),
      vendors: [northwind()],
    });
    expect(plain(b)).toEqual(plain(a));
  });

  it("says a call is new, not vendor, when no vendor is given", () => {
    const got = comparePrototype({ prototype: prototype(), estate: estate() });
    const charge = got.calls.find((c) => c.id === "bff-mock.get-v1-charges-orderid")!;
    expect(charge.group).toBe("new");
    expect(got.counts).toEqual({ exists: 2, changes: 1, new: 3, vendor: 0 });
  });

  it("says a field whose type differs, and a required-ness both sides state", () => {
    const p = prototype();
    const facts = p.facts.map((f) =>
      f.id === "field.mock.pay.amount" ? ({ ...f, type: "string" } as Fact) : f,
    );
    const shop = estate();
    shop[1] = {
      ...shop[1]!,
      facts: shop[1]!.facts.map((f) =>
        f.id === "field.pay-request.currency" ? ({ ...f, required: false } as Fact) : f,
      ),
    };
    const withRequired = facts.map((f) =>
      f.id === "field.mock.pay.currency" ? ({ ...f, required: true } as Fact) : f,
    );
    const got = comparePrototype({ prototype: { ...p, facts: withRequired }, estate: shop });
    const pay = got.calls.find((c) => c.id === "bff-mock.post-invoices-invoiceid-pay")!;
    expect(pay.group).toBe("changes");
    expect(pay.differences.map((d) => [d.kind, d.field, d.message])).toEqual([
      [
        "field-type",
        "amount",
        "the request field amount is a string in the prototype (mocks/handlers.ts:6) and a number in forge-billing (BigDecimal, src/main/java/forge/billing/PayRequest.java:5)",
      ],
      [
        "field-required",
        "currency",
        "the request field currency is required in the prototype (mocks/handlers.ts:6) and optional in forge-billing (src/main/java/forge/billing/PayRequest.java:5)",
      ],
    ]);
  });

  it("leaves out a call that lands on nothing in the prototype, and says so", () => {
    const p = prototype();
    const sso: FactOf<"call"> = {
      kind: "call",
      id: "call.bff.get.jwks",
      repo: p.repo,
      commit: "ccc3333",
      component: "checkout-bff",
      callType: "rest",
      method: "GET",
      path: "/realms/shop/protocol/openid-connect/certs",
      host: "sso.forge.example",
      cite: { file: "bff/src/sso.ts", line: 11, value: "sso.forge.example" },
      verified: "line",
      by: "assistant",
      conf: "declared",
    };
    const got = comparePrototype({ prototype: { ...p, facts: [...p.facts, sso] }, estate: [] });
    expect(got.left).toEqual([
      {
        call: {
          repo: p.repo,
          fact: "call.bff.get.jwks",
          component: "checkout-bff",
          at: "bff/src/sso.ts:11",
        },
        why: "GET /realms/shop/protocol/openid-connect/certs, which checkout-bff calls, reaches nothing in the prototype: it is neither the prototype's BFF nor one of its mocks, so it isn't compared.",
      },
    ]);
  });
});

describe("what a prototype and a mock are", () => {
  it("reads a prototype from the manifest's repo type", () => {
    expect(isPrototypeType("prototype")).toBe(true);
    expect(isPrototypeType("prototype-react")).toBe(true);
    expect(isPrototypeType("spring-boot")).toBe(false);
    expect(isPrototypeType("prototypes")).toBe(false);
    expect(isPrototypeType(undefined)).toBe(false);
  });

  it("tells a mock's entry by its file, its module's mock framework or a mock profile", () => {
    const facts = read("forge-checkout-prototype");
    const entries = facts.filter((f): f is FactOf<"entry"> => f.kind === "entry");
    const mocks = entries.filter((e) => isMockEntry(e, facts)).map((e) => e.id);
    expect(mocks).toEqual([
      "entry.mock.post.invoices-id-pay",
      "entry.mock.get.loyalty-customerid-balance",
      "entry.mock.get.v1-charges-chargeid",
    ]);
    const spring: FactOf<"entry"> = {
      kind: "entry",
      id: "entry.get.loyalty",
      repo: "x",
      commit: "abc1234",
      entryType: "rest",
      method: "GET",
      path: "/loyalty",
      cite: {
        file: "src/main/java/forge/proto/LoyaltyController.java",
        line: 9,
        value: "/loyalty",
        with: [
          { file: "src/main/java/forge/proto/LoyaltyController.java", line: 7, value: "mock" },
        ],
      },
      verified: "line",
      by: "assistant",
      conf: "declared",
    };
    expect(isMockEntry(spring, [])).toBe(true);
    expect(isMockEntry({ ...spring, cite: { ...spring.cite, with: [] } }, [])).toBe(false);
    for (const file of ["db.json", "postman/shop.postman_collection.json", "src/__mocks__/api.ts"])
      expect(isMockEntry({ ...spring, cite: { file, line: 1, value: "/loyalty" } }, []), file).toBe(
        true,
      );
  });
});
