import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  comparePrototype,
  joinVendorOperations,
  enumValues,
  isHeaderName,
  parseFacts,
  prototypeArchitectureSection,
  readPrototypeArchitecture,
  type Fact,
  type FactOf,
  type JoinRepo,
  type PrototypeVendor,
} from "../src/index.js";

/**
 * V3 (ADR 0142): the prototype comparison also compares enum values, error responses and headers,
 * and lists the calls nothing serves for the architecture stage. The fixture is ADR 0133's
 * invented checkout prototype; each case changes a fact or two of it, inline, so the hand-written
 * comparison of ADR 0133 stays as it was. O2: another team's published operations take a call as
 * a vendor's do, said as the other team's.
 */

const DIR = join(__dirname, "..", "..", "..", "fixtures", "prototype-compare");
const read = (repo: string): Fact[] => {
  const r = parseFacts(readFileSync(join(DIR, "facts", `${repo}.jsonl`), "utf8"));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.facts;
};
const PROTO = "forge-checkout-prototype";
const estate = (billing: (fs: Fact[]) => Fact[] = (x) => x): JoinRepo[] => [
  { repo: "forge-shop-bff", facts: read("forge-shop-bff"), component: "shop-bff" },
  {
    repo: "forge-billing",
    facts: billing(read("forge-billing")),
    component: "billing-api",
    hosts: ["billing.forge.internal"],
  },
];
const prototype = (change: (fs: Fact[]) => Fact[] = (x) => x): JoinRepo => ({
  repo: PROTO,
  facts: change(read(PROTO)),
});
const retype = (id: string, type: string) => (fs: Fact[]) =>
  fs.map((f) => (f.id === id ? ({ ...f, type } as Fact) : f));
const PAY = "bff-mock.post-invoices-invoiceid-pay";
const pay = (p: JoinRepo, e: JoinRepo[], vendors?: PrototypeVendor[]) =>
  comparePrototype({ prototype: p, estate: e, ...(vendors ? { vendors } : {}) }).calls.find(
    (c) => c.id === PAY,
  )!;

const field = (
  repo: string,
  owner: string,
  id: string,
  side: "request" | "response",
  name: string,
  file: string,
  line: number,
  more: Partial<FactOf<"field">> = {},
): FactOf<"field"> => ({
  kind: "field",
  id,
  repo,
  commit: "abc1234",
  owner,
  side,
  name,
  cite: { file, line, value: name },
  verified: "line",
  by: "assistant",
  conf: "declared",
  ...more,
});
const flow = (
  repo: string,
  entry: string,
  id: string,
  file: string,
  errors: { when: string; then: string; line: number }[],
  steps: { ref?: string; line: number }[] = [{ line: errors[0]!.line - 1 }],
): FactOf<"flow"> => ({
  kind: "flow",
  id,
  repo,
  commit: "abc1234",
  name: id,
  entry,
  cite: { file, line: steps[0]!.line, value: "pay" },
  steps: steps.map((s) => ({
    kind: "respond" as const,
    what: "answers",
    ...(s.ref ? { ref: s.ref } : {}),
    cite: { file, line: s.line, value: "pay" },
  })),
  errors: errors.map((x) => ({
    when: x.when,
    then: x.then,
    cite: { file, line: x.line, value: x.then },
  })),
  verified: "line",
  by: "assistant",
  conf: "declared",
});

const BILL = "src/main/java/forge/billing";
const MOCK = "entry.mock.post.invoices-id-pay";
const BILL_PAY = "entry.post.invoices-id-pay";

describe("enum values", () => {
  it("reads the values a type lists, and nothing from a type that lists none", () => {
    expect(enumValues(`"captured" | "failed" | 'pending'`)).toEqual([
      "captured",
      "failed",
      "pending",
    ]);
    expect(enumValues("ChargeStatus(CAPTURED|FAILED)")).toEqual(["CAPTURED", "FAILED"]);
    expect(enumValues("enum(EUR, USD)")).toEqual(["EUR", "USD"]);
    expect(enumValues("EUR|USD")).toEqual(["EUR", "USD"]);
    for (const t of [
      "string",
      "ChargeStatus",
      "List<String>",
      "Map<String, Integer>",
      "",
      undefined,
    ])
      expect(enumValues(t), String(t)).toBeUndefined();
  });

  it("says a value the prototype sends that the estate doesn't take, and one it reads that the estate never returns", () => {
    const got = pay(
      prototype((fs) =>
        retype(
          "field.mock.pay.status",
          `"captured" | "failed" | "pending"`,
        )(retype("field.mock.pay.currency", `'EUR' | 'USD' | 'GBP'`)(fs)),
      ),
      estate((fs) =>
        retype(
          "field.charge-view.status",
          "ChargeStatus(CAPTURED|FAILED|REVERSED)",
        )(retype("field.pay-request.currency", "Currency(EUR|USD)")(fs)),
      ),
    );
    expect(got.group).toBe("changes");
    expect(got.differences.map((d) => [d.kind, d.side, d.field, d.value, d.message])).toEqual([
      [
        "field-enum",
        "request",
        "currency",
        "GBP",
        `the request field currency can be GBP in the prototype (mocks/handlers.ts:6), which forge-billing doesn't take (it takes EUR, USD; ${BILL}/PayRequest.java:5)`,
      ],
      [
        "field-enum",
        "response",
        "status",
        "pending",
        `the response field status can be pending in the prototype (mocks/handlers.ts:7), which forge-billing never returns (it returns CAPTURED, FAILED, REVERSED; ${BILL}/ChargeView.java:3)`,
      ],
      [
        "field-enum",
        "response",
        "status",
        "REVERSED",
        `forge-billing can return REVERSED in the response field status (${BILL}/ChargeView.java:3), which the prototype doesn't handle (it lists captured, failed, pending; mocks/handlers.ts:7)`,
      ],
    ]);
  });

  it("compares nothing where one side lists no values", () => {
    const got = pay(
      prototype(retype("field.mock.pay.status", `"captured" | "pending"`)),
      estate(), // billing's status is a String: its values are unknown, not none
    );
    expect(got.group).toBe("exists");
    expect(got.differences).toEqual([]);
  });

  it("takes a vendor's enum from its spec", () => {
    const p = prototype((fs) => [
      ...retype("field.mock.charge.status", `"captured" | "disputed"`)(fs),
    ]);
    const nw: PrototypeVendor = {
      system: "northwind-pay",
      names: ["Northwind Pay"],
      hosts: ["api.northwindpay.example"],
      operations: [
        {
          id: "northwind-pay.get-charge",
          method: "GET",
          path: "/charges/{chargeId}",
          fullPath: "/v1/charges/{chargeId}",
          cite: "spec.yaml:46",
          fields: [
            {
              side: "response",
              name: "status",
              type: "string",
              enum: ["captured", "refunded"],
              at: "spec.yaml:80",
            },
          ],
        },
      ],
    };
    const got = comparePrototype({ prototype: p, estate: estate(), vendors: [nw] }).calls.find(
      (c) => c.group === "vendor",
    )!;
    expect(got.differences.filter((d) => d.kind === "field-enum").map((d) => d.message)).toEqual([
      "the response field status can be disputed in the prototype (mocks/wiremock/mappings/northwind-get-charge.json:10), which Northwind Pay never returns (it returns captured, refunded; spec.yaml:80)",
      "Northwind Pay can return refunded in the response field status (spec.yaml:80), which the prototype doesn't handle (it lists captured, disputed; mocks/wiremock/mappings/northwind-get-charge.json:10)",
    ]);
  });
});

describe("headers", () => {
  it("knows a header by its name", () => {
    for (const h of [
      "Idempotency-Key",
      "X-Request-Id",
      "x-tenant",
      "Authorization",
      "ETag",
      "Location",
    ])
      expect(isHeaderName(h), h).toBe(true);
    for (const n of ["invoiceId", "currency", "loyalty_points", "items[].id", "status"])
      expect(isHeaderName(n), n).toBe(false);
  });

  it("doesn't call a header a missing body field, and says nothing where the estate names no headers", () => {
    const got = pay(
      prototype((fs) => [
        ...fs,
        field(
          PROTO,
          MOCK,
          "field.mock.pay.idempotency-key",
          "request",
          "Idempotency-Key",
          "mocks/handlers.ts",
          6,
        ),
      ]),
      estate(),
    );
    expect(got.group).toBe("exists");
    expect(got.differences).toEqual([]);
  });

  it("says a header the prototype sends or reads that the estate doesn't, and one the estate requires that the prototype doesn't send", () => {
    const got = pay(
      prototype((fs) => [
        ...fs,
        field(
          PROTO,
          MOCK,
          "field.mock.pay.idempotency-key",
          "request",
          "Idempotency-Key",
          "mocks/handlers.ts",
          6,
        ),
        field(
          PROTO,
          MOCK,
          "field.mock.pay.location",
          "response",
          "Location",
          "mocks/handlers.ts",
          7,
        ),
      ]),
      estate((fs) => [
        ...fs,
        field(
          "forge-billing",
          BILL_PAY,
          "field.pay.x-request-id",
          "request",
          "X-Request-Id",
          `${BILL}/InvoicesController.java`,
          14,
          { required: true },
        ),
        field(
          "forge-billing",
          BILL_PAY,
          "field.pay.etag",
          "response",
          "ETag",
          `${BILL}/InvoicesController.java`,
          16,
        ),
      ]),
    );
    expect(got.group).toBe("changes");
    expect(got.differences.map((d) => [d.kind, d.side, d.field, d.message])).toEqual([
      [
        "header-missing",
        "request",
        "Idempotency-Key",
        "the prototype sends the header Idempotency-Key (mocks/handlers.ts:6), which forge-billing doesn't read (it reads X-Request-Id)",
      ],
      [
        "header-required",
        "request",
        "X-Request-Id",
        `forge-billing requires the header X-Request-Id (${BILL}/InvoicesController.java:14), which the prototype doesn't send`,
      ],
      [
        "header-missing",
        "response",
        "Location",
        "the prototype reads the response header Location (mocks/handlers.ts:7), which forge-billing doesn't send (it sends ETag)",
      ],
    ]);
  });

  it("matches header names whatever their case", () => {
    const got = pay(
      prototype((fs) => [
        ...fs,
        field(
          PROTO,
          MOCK,
          "field.mock.pay.x-request-id",
          "request",
          "x-request-id",
          "mocks/handlers.ts",
          6,
        ),
      ]),
      estate((fs) => [
        ...fs,
        field(
          "forge-billing",
          BILL_PAY,
          "field.pay.x-request-id",
          "request",
          "X-Request-Id",
          `${BILL}/InvoicesController.java`,
          14,
          { required: true },
        ),
      ]),
    );
    expect(got.differences).toEqual([]);
  });
});

describe("error responses", () => {
  const billingErrors = (fs: Fact[]) => [
    ...fs,
    flow("forge-billing", BILL_PAY, "flow.pay-invoice", `${BILL}/InvoicesController.java`, [
      { when: "no such invoice", then: "404 Not Found", line: 14 },
      { when: "the invoice is already paid", then: "answers 409 Conflict", line: 15 },
    ]),
  ];

  it("says an error the prototype expects that the estate never answers, and one the estate answers that the prototype doesn't handle", () => {
    const got = pay(
      prototype((fs) => [
        ...fs,
        flow(PROTO, MOCK, "flow.mock-pay", "mocks/handlers.ts", [
          { when: "the card is declined", then: "responds 402", line: 8 },
          {
            when: "the invoice is already paid (HTTP 409)",
            then: "responds with the error",
            line: 9,
          },
        ]),
      ]),
      estate(billingErrors),
    );
    expect(got.group).toBe("changes");
    expect(got.differences.map((d) => [d.kind, d.status, d.message])).toEqual([
      [
        "error-missing",
        "402",
        "the prototype expects the error 402 (mocks/handlers.ts:8), which forge-billing never answers (it answers 404, 409)",
      ],
      [
        "error-unhandled",
        "404",
        `forge-billing answers 404 (${BILL}/InvoicesController.java:14), which the prototype doesn't handle (it handles 402, 409)`,
      ],
    ]);
  });

  it("reads the errors a screen handles from the flow whose step makes the call", () => {
    const facts = read(PROTO);
    const ui = facts.find((f) => f.id === "call.ui.post.checkout")!;
    const p = prototype((fs) => [
      ...fs,
      flow(
        PROTO,
        "entry.ui.checkout",
        "flow.ui-checkout",
        "ui/src/api.ts",
        [{ when: "409", then: "shows already paid", line: 4 }],
        [{ ref: ui.id, line: 3 }],
      ),
    ]);
    const shop = estate();
    shop[0] = {
      ...shop[0]!,
      facts: [
        ...shop[0]!.facts,
        flow(
          "forge-shop-bff",
          "entry.post.checkout",
          "flow.checkout",
          "src/main/java/forge/shop/CheckoutController.java",
          [{ when: "already paid", then: "409", line: 18 }],
        ),
      ],
    };
    const got = comparePrototype({ prototype: p, estate: shop }).calls.find(
      (c) => c.id === "ui-bff.post-checkout",
    )!;
    expect(got.differences.filter((d) => d.kind.startsWith("error-"))).toEqual([]);
  });

  it("compares no errors where one side states none", () => {
    const got = pay(prototype(), estate(billingErrors));
    expect(got.differences).toEqual([]);
  });
});

describe("the calls nothing serves, for the architecture stage", () => {
  it("lists each new call with what it carries, and reads the list back from the attached document", () => {
    const c = comparePrototype({ prototype: prototype(), estate: estate() });
    const section = prototypeArchitectureSection(c, read(PROTO));
    expect(section).toEqual([
      "## New calls, for the architecture stage",
      "",
      "Nothing in the estate serves these calls of the prototype forge-checkout-prototype. Where each goes is the architecture stage's to decide: the entry that will serve it, in a new or changed flow.",
      "",
      "- GET /loyalty/summary, which checkout-ui calls on its BFF (forge-checkout-prototype ui/src/api.ts:13 → bff/src/server.ts:23)",
      "- GET /loyalty/{sub}/balance, which checkout-bff calls on its mock (forge-checkout-prototype bff/src/server.ts:24 → mocks/handlers.ts:10); response points (number, mocks/handlers.ts:11), tier (string, mocks/handlers.ts:11)",
      "- GET /v1/charges/{orderId}, which checkout-bff calls on its mock (forge-checkout-prototype bff/src/server.ts:18 → mocks/wiremock/mappings/northwind-get-charge.json:4); response amount (number, mocks/wiremock/mappings/northwind-get-charge.json:11), id (string, mocks/wiremock/mappings/northwind-get-charge.json:9), status (string, mocks/wiremock/mappings/northwind-get-charge.json:10)",
      "",
    ]);
    const doc = [
      "# What the prototype asks",
      "",
      "New: nothing in the estate serves it.",
      "",
      ...section,
    ].join("\n");
    expect(readPrototypeArchitecture(doc)).toEqual(section.filter((l) => l.startsWith("- ")));
    expect(readPrototypeArchitecture("# Something else\n- a line\n")).toEqual([]);
    // As intake reads an attached file: each line cited by the file's path and line.
    const cited = doc
      .split("\n")
      .map((l, i) => (l.trim() ? `[inputs/prototype-x.md:${i + 1}] ${l}` : ""))
      .join("\n");
    expect(readPrototypeArchitecture(cited)).toEqual([
      "[inputs/prototype-x.md:9] " + section[4],
      "[inputs/prototype-x.md:10] " + section[5],
      "[inputs/prototype-x.md:11] " + section[6],
    ]);
  });

  it("gives no section when nothing is new", () => {
    const c = comparePrototype({ prototype: { repo: PROTO, facts: [] }, estate: estate() });
    expect(prototypeArchitectureSection(c, [])).toEqual([]);
  });
});

describe("another team's operations (O2)", () => {
  const risk = (): PrototypeVendor => ({
    system: "forge-risk",
    names: ["Forge Risk Team"],
    hosts: ["risk.forge.internal"],
    boundary: "internal",
    operations: [
      {
        id: "forge-risk.get-charge",
        method: "GET",
        path: "/v1/charges/{chargeId}",
        cite: "inputs/partner-specs/forge-risk-openapi.yaml:12",
      },
    ],
  });

  it("places a call only another team publishes, said as theirs, and changes no repo for it", () => {
    const c = comparePrototype({ prototype: prototype(), estate: estate(), vendors: [risk()] });
    const got = c.calls.find((x) => x.id === "bff-mock.get-v1-charges-orderid")!;
    expect(got.group).toBe("vendor");
    expect(got.vendor).toMatchObject({ system: "forge-risk", boundary: "internal", through: [] });
    expect(got.sentence).toBe(
      "GET /v1/charges/{orderId}, which checkout-bff calls on its mock: only Forge Risk Team, another team's system, provides it (GET /v1/charges/{chargeId}, inputs/partner-specs/forge-risk-openapi.yaml:12); nothing in the estate calls Forge Risk Team yet, so the change calls it as it publishes it.",
    );
    expect(c.vendors).toEqual(["forge-risk"]);
    expect(c.repos).toEqual(["forge-shop-bff"]);
  });
});

describe("joinVendorOperations, another team's system (O2)", () => {
  const TEAM = join(__dirname, "..", "..", "..", "fixtures", "team-spec");
  const billing = (): JoinRepo => {
    const r = parseFacts(readFileSync(join(TEAM, "facts", "forge-billing.jsonl"), "utf8"));
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    return { repo: "forge-billing", facts: r.facts, component: "billing-api" };
  };
  const team = (boundary?: "internal") => ({
    system: "forge-risk",
    names: ["Forge Risk Team", "risk.forge.internal"],
    hosts: ["risk.forge.internal"],
    ...(boundary ? { boundary } : {}),
    operations: [
      {
        id: "forge-risk.post-assessment",
        method: "POST",
        path: "/v1/assessments",
        cite: "x.yaml:10",
      },
      {
        id: "forge-risk.get-assessment",
        method: "GET",
        path: "/v1/assessments/{id}",
        cite: "x.yaml:20",
      },
    ],
  });

  it("matches a service's own call to it, by its host, marked direct", () => {
    expect(joinVendorOperations({ repos: [billing()], vendors: [team("internal")] })).toEqual({
      matches: [
        {
          call: {
            repo: "forge-billing",
            fact: "call.post.v1-assessments",
            component: "billing-api",
            at: "src/main/java/forge/billing/RiskClient.java:12",
          },
          route: {
            repo: "forge-billing",
            fact: "entry.post.invoices-id-pay",
            component: "billing-api",
            at: "src/main/java/forge/billing/InvoicesController.java:13",
          },
          vendor: "forge-risk",
          how: "host",
          operation: "forge-risk.post-assessment",
          method: "POST",
          path: "/v1/assessments",
          direct: true,
        },
      ],
      gaps: [],
      asks: [],
    });
  });

  it("says a direct call to an operation the team doesn't publish is a gap, in a service's words", () => {
    const t = { ...team("internal"), operations: team().operations.slice(1) };
    const got = joinVendorOperations({ repos: [billing()], vendors: [t] });
    expect(got.gaps.map((g) => g.message)).toEqual([
      "billing-api calls POST /v1/assessments on Forge Risk Team, whose spec publishes no such operation",
    ]);
  });

  it("leaves a service's own call to a vendor alone, as ADR 0130 does", () => {
    expect(joinVendorOperations({ repos: [billing()], vendors: [team()] }).matches).toEqual([]);
  });
});
