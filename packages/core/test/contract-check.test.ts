import { describe, expect, it } from "vitest";
import {
  checkContracts,
  newFindings,
  SpecsFile,
  type ContractSpecT,
  type Fact,
  type FactJoin,
  type FactsJoinResult,
} from "../src/index.js";

/**
 * The contract check (plan item F7, ADR 0164) on a small second stack (G3), inline: an Express
 * BFF written in TypeScript calls an ASP.NET Core service directly, whose answers share an
 * `ApiResponse<T>` envelope and whose request goes through an AutoMapper profile; a Node
 * publisher and a Python listener share an Avro record on forge.ledger.posted; a Go service
 * calls Northwind Pay (an invented vendor) against its intaken spec. Nothing here is a real
 * system.
 */

const C = { verified: "line", by: "assistant", conf: "declared" } as const;
const cite = (file: string, line: number, value: string) => ({ file, line, value });
let n = 0;
const field = (
  repo: string,
  owner: string,
  side: "request" | "response" | "message",
  name: string,
  more: Record<string, unknown> = {},
): Fact =>
  ({
    kind: "field",
    id:
      (more.id as string) ??
      `field.${owner}.${side}.${name.toLowerCase().replace(/[^a-z0-9]/g, "-")}`,
    repo,
    commit: "abc1234",
    owner,
    side,
    name,
    cite: cite((more.file as string) ?? "src/x.ts", (more.line as number) ?? ++n, name),
    ...C,
    ...Object.fromEntries(
      Object.entries(more).filter(([k]) => !["id", "file", "line"].includes(k)),
    ),
  }) as Fact;

const end = (repo: string, fact: string, component = repo) => ({
  repo,
  fact,
  component,
  at: "src/x.ts:1",
});

const join = (j: Partial<FactJoin> & Pick<FactJoin, "call" | "entry" | "path">): FactJoin => ({
  how: "host",
  callType: "rest",
  interface: `if-${j.call.repo}-${j.entry.repo}`,
  ...j,
});

const result = (joins: FactJoin[]): FactsJoinResult => ({
  joins,
  asks: [],
  misses: [],
  lineage: [],
  gaps: [],
});

// ---- the Express BFF and the ASP.NET service
const BFF = "forge-shop-bff";
const SVC = "forge-orders-api";
const bff: Fact[] = [
  {
    kind: "call",
    id: "call.post.orders",
    repo: BFF,
    commit: "abc1234",
    callType: "rest",
    method: "POST",
    path: "/orders",
    host: "orders.forge.internal",
    cite: cite("src/orders.ts", 12, "/orders"),
    ...C,
  } as Fact,
  field(BFF, "call.post.orders", "request", "sku", { type: "string" }),
  field(BFF, "call.post.orders", "request", "quantity", { type: "string" }),
  field(BFF, "call.post.orders", "request", "giftNote", { type: "string" }),
  field(BFF, "call.post.orders", "response", "Data", { id: "f.bff.data", type: "OrderView" }),
  field(BFF, "call.post.orders", "response", "orderId", {
    type: "string",
    mappedTo: "f.bff.data",
    transform: "envelope",
  }),
  field(BFF, "call.post.orders", "response", "eta", {
    type: "string",
    mappedTo: "f.bff.data",
    transform: "envelope",
  }),
];
const svc: Fact[] = [
  {
    kind: "entry",
    id: "entry.post.orders",
    repo: SVC,
    commit: "abc1234",
    entryType: "rest",
    method: "POST",
    path: "/orders",
    cite: cite("Controllers/OrdersController.cs", 20, "/orders"),
    ...C,
  } as Fact,
  // The request DTO, and what an AutoMapper profile makes of it (inbound: the DTO's name travels).
  field(SVC, "entry.post.orders", "request", "Sku", { type: "string", required: true }),
  field(SVC, "entry.post.orders", "request", "Quantity", {
    type: "int",
    required: true,
    mappedTo: "f.svc.qty",
    transform: "AutoMapper OrderProfile",
  }),
  field(SVC, "entry.post.orders", "request", "Qty", { id: "f.svc.qty", type: "int" }),
  field(SVC, "entry.post.orders", "request", "Channel", { type: "string", required: true }),
  // The envelope ApiResponse<T> and the view inside it.
  field(SVC, "entry.post.orders", "response", "Data", { id: "f.svc.data", type: "T" }),
  field(SVC, "entry.post.orders", "response", "OrderId", {
    type: "Guid",
    mappedTo: "f.svc.data",
    transform: "envelope ApiResponse<T>",
  }),
  // A converter nobody traced writes the delivery estimate.
  field(SVC, "entry.post.orders", "response", "Data.Eta", {
    type: "DateTime",
    transform: "EtaConverter",
  }),
  {
    kind: "flow",
    id: "flow.place-order",
    repo: SVC,
    commit: "abc1234",
    name: "Place an order",
    entry: "entry.post.orders",
    steps: [
      {
        kind: "respond",
        what: "answers the order",
        cite: cite("Controllers/OrdersController.cs", 30, "Ok"),
      },
    ],
    errors: [
      {
        when: "out of stock",
        then: "answers 409",
        cite: cite("Controllers/OrdersController.cs", 26, "Conflict"),
      },
    ],
    cite: cite("Controllers/OrdersController.cs", 20, "/orders"),
    ...C,
  } as Fact,
];

describe("a direct REST call on a second stack (G3)", () => {
  const joined = result([
    join({
      call: end(BFF, "call.post.orders"),
      entry: end(SVC, "entry.post.orders"),
      method: "POST",
      path: "/orders",
      interface: "if-orders",
    }),
  ]);
  const r = checkContracts({
    repos: [
      { repo: BFF, facts: bff },
      { repo: SVC, facts: svc },
    ],
    join: joined,
  });
  const got = r.findings.map((f) => [f.status, f.kind, f.side, f.field ?? f.error]);

  it("finds the extra field, the required one not sent and the type of another family", () => {
    expect(got).toContainEqual(["mismatch", "field-extra", "request", "giftNote"]);
    expect(got).toContainEqual(["mismatch", "field-not-sent", "request", "Channel"]);
    expect(got).toContainEqual(["mismatch", "field-type", "request", "quantity"]);
  });

  it("reads the envelope on both sides, and the AutoMapper mapping as the DTO's name", () => {
    // Data.orderId and Data.OrderId are one field: no missing field, no extra.
    expect(got.filter(([, , , f]) => /orderid|qty/i.test(String(f)))).toEqual([]);
  });

  it("says a difference an untraced converter touches is unconfirmed, never a mismatch", () => {
    // Data.Eta is a string on the BFF and a DateTime written by EtaConverter: same family.
    expect(r.findings.filter((f) => f.status === "unconfirmed")).toEqual([]);
    const other = checkContracts({
      repos: [
        {
          repo: BFF,
          facts: [
            ...bff,
            field(BFF, "call.post.orders", "response", "warehouse", {
              type: "string",
              mappedTo: "f.bff.data",
              transform: "envelope",
            }),
          ],
        },
        {
          repo: SVC,
          facts: [
            ...svc,
            field(SVC, "entry.post.orders", "response", "Data.Warehouse", {
              type: "string",
              transform: "WarehouseResolver",
            }),
          ],
        },
      ],
      join: joined,
    });
    expect(other.findings.some((f) => f.field === "Data.warehouse")).toBe(false);
    const gone = checkContracts({
      repos: [
        {
          repo: BFF,
          facts: [
            ...bff,
            field(BFF, "call.post.orders", "response", "region", {
              type: "string",
              mappedTo: "f.bff.data",
              transform: "envelope",
            }),
          ],
        },
        { repo: SVC, facts: svc },
      ],
      join: joined,
    });
    expect(gone.findings.find((f) => f.field === "Data.region")).toMatchObject({
      status: "mismatch",
      kind: "field-missing",
    });
  });

  it("is the same whatever order the repos come in, and counts the link", () => {
    const again = checkContracts({
      repos: [
        { repo: SVC, facts: [...svc].reverse() },
        { repo: BFF, facts: [...bff].reverse() },
      ],
      join: joined,
    });
    expect(again).toEqual(r);
    expect(r.counts).toMatchObject({ links: 1, compared: 1, unconfirmed: 0 });
    expect(r.links[0]).toMatchObject({ kind: "rest", interface: "if-orders", compared: 1 });
  });

  it("says nothing when one side lists no fields: unknown, not different", () => {
    const quiet = checkContracts({
      repos: [
        { repo: BFF, facts: bff.filter((f) => f.kind !== "field") },
        { repo: SVC, facts: svc },
      ],
      join: joined,
    });
    expect(quiet.findings).toEqual([]);
    expect(quiet.counts.compared).toBe(0);
  });

  it("counts the calls no link starts at, whose payload can't be checked yet (ADR 0172)", () => {
    expect(r.counts.unlinked).toBe(0);
    const left = checkContracts({
      repos: [
        { repo: BFF, facts: bff },
        { repo: SVC, facts: svc },
      ],
      join: { ...joined, joins: [] },
    });
    const calls = bff.filter((f) => f.kind === "call").length;
    expect(calls).toBeGreaterThan(0);
    expect(left.counts.unlinked).toBe(calls);
  });
});

// ---- an Avro topic between a Node publisher and a Python listener
const PUB = "forge-ledger-node";
const LIS = "forge-reports-py";
const avro = (repo: string, fields: [string, string, boolean][]): ContractSpecT => ({
  kind: "message",
  format: "avro",
  role: "schema",
  file: "schemas/ledger_posted.avsc",
  line: 2,
  name: "forge.ledger.LedgerPosted",
  fields: fields.map(([name, type, required], i) => ({
    side: "message",
    name,
    type,
    required,
    number: i,
    at: `schemas/ledger_posted.avsc:${4 + i}`,
  })),
});

describe("a topic: the publisher, the listener and the Avro record (G3)", () => {
  const pub: Fact[] = [
    {
      kind: "call",
      id: "call.publish.ledger-posted",
      repo: PUB,
      commit: "abc1234",
      callType: "event-topic",
      path: "forge.ledger.posted",
      cite: cite("src/publish.js", 8, "forge.ledger.posted"),
      ...C,
    } as Fact,
    field(PUB, "call.publish.ledger-posted", "message", "LedgerPosted", {
      type: "forge.ledger.LedgerPosted",
      transform: "message type",
    }),
    field(PUB, "call.publish.ledger-posted", "message", "entryId", { type: "string" }),
    field(PUB, "call.publish.ledger-posted", "message", "amount", { type: "long" }),
    field(PUB, "call.publish.ledger-posted", "message", "postedBy", { type: "string" }),
  ];
  const lis: Fact[] = [
    {
      kind: "entry",
      id: "entry.listen.ledger-posted",
      repo: LIS,
      commit: "abc1234",
      entryType: "event-topic",
      path: "forge.ledger.posted",
      cite: cite("reports/consumer.py", 5, "forge.ledger.posted"),
      ...C,
    } as Fact,
    field(LIS, "entry.listen.ledger-posted", "message", "LedgerPosted", {
      type: "LedgerPosted",
      transform: "message type",
    }),
    field(LIS, "entry.listen.ledger-posted", "message", "entry_id", { type: "str" }),
    field(LIS, "entry.listen.ledger-posted", "message", "amount", { type: "str" }),
    field(LIS, "entry.listen.ledger-posted", "message", "currency", { type: "str" }),
  ];
  const joined = result([
    join({
      call: end(PUB, "call.publish.ledger-posted"),
      entry: end(LIS, "entry.listen.ledger-posted"),
      how: "topic",
      callType: "event-topic",
      path: "forge.ledger.posted",
      interface: "if-ledger-posted",
    }),
  ]);
  const specs = [
    SpecsFile.parse({
      schemaVersion: 1,
      repo: PUB,
      specs: [
        avro(PUB, [
          ["entryId", "string", true],
          ["amount", "long", true],
          ["currency", "string", true],
        ]),
      ],
    }),
  ];
  const r = checkContracts({
    repos: [
      { repo: PUB, facts: pub },
      { repo: LIS, facts: lis },
    ],
    join: joined,
    specs,
  });
  const got = r.findings.map((f) => [f.kind, f.field, f.sender.what, f.receiver.what]);

  it("finds what the listener reads that the publisher never sends, and the type apart", () => {
    expect(got).toContainEqual([
      "field-missing",
      "currency",
      "forge-ledger-node's publish",
      "forge-reports-py's listener",
    ]);
    expect(got).toContainEqual([
      "field-type",
      "amount",
      "forge-ledger-node's publish",
      "forge-reports-py's listener",
    ]);
  });

  it("holds the publisher to the record its message type names", () => {
    expect(got).toContainEqual([
      "field-extra",
      "postedBy",
      "forge-ledger-node's publish",
      "forge-ledger-node's spec ledger_posted.avsc",
    ]);
    expect(got).toContainEqual([
      "field-not-sent",
      "currency",
      "forge-ledger-node's publish",
      "forge-ledger-node's spec ledger_posted.avsc",
    ]);
    expect(r.links[0]!.specs).toEqual([`${PUB} schemas/ledger_posted.avsc:2`]);
  });

  it("reads a listener whose publisher is outside against the spec intake took in", () => {
    const solo = checkContracts({
      repos: [{ repo: LIS, facts: lis }],
      join: result([]),
      outside: [
        {
          system: "tidewater",
          name: "Tidewater",
          specs: [
            avro("", [
              ["entryId", "string", true],
              ["amount", "string", true],
            ]),
          ],
        },
      ],
    });
    expect(solo.findings.map((f) => [f.system, f.kind, f.field])).toEqual([
      ["tidewater", "field-missing", "currency"],
    ]);
  });
});

describe("protobuf field numbers between two copies of a message", () => {
  const proto = (file: string, fields: [string, string, number][]): ContractSpecT => ({
    kind: "message",
    format: "protobuf",
    role: "schema",
    file,
    line: 3,
    name: "forge.cards.v1.CardBlocked",
    fields: fields.map(([name, type, number]) => ({
      side: "message",
      name,
      type,
      required: false,
      number,
      at: `${file}:${4 + number}`,
    })),
  });
  it("says a number given to another name or type is a break", () => {
    const facts = (repo: string, kind: "call" | "entry"): Fact[] => [
      kind === "call"
        ? ({
            kind,
            id: "c",
            repo,
            commit: "abc1234",
            callType: "event-topic",
            path: "forge.cards.blocked",
            cite: cite("a", 1, "forge.cards.blocked"),
            ...C,
          } as Fact)
        : ({
            kind,
            id: "e",
            repo,
            commit: "abc1234",
            entryType: "event-topic",
            path: "forge.cards.blocked",
            cite: cite("a", 1, "forge.cards.blocked"),
            ...C,
          } as Fact),
      field(repo, kind === "call" ? "c" : "e", "message", "CardBlocked", {
        type: "CardBlocked",
        transform: "message type",
      }),
    ];
    const r = checkContracts({
      repos: [
        { repo: "forge-cards", facts: facts("forge-cards", "call") },
        { repo: "forge-alerts", facts: facts("forge-alerts", "entry") },
      ],
      join: result([
        join({
          call: end("forge-cards", "c"),
          entry: end("forge-alerts", "e"),
          how: "topic",
          callType: "event-topic",
          path: "forge.cards.blocked",
        }),
      ]),
      specs: [
        {
          schemaVersion: 1,
          repo: "forge-cards",
          specs: [
            proto("card.proto", [
              ["card_id", "string", 1],
              ["reason", "string", 2],
            ]),
          ],
        },
        {
          schemaVersion: 1,
          repo: "forge-alerts",
          specs: [
            proto("card.proto", [
              ["card_id", "string", 1],
              ["blocked_at", "int64", 2],
            ]),
          ],
        },
      ],
    });
    expect(r.findings.filter((f) => f.kind === "field-number").map((f) => f.message)).toEqual([
      "field number 2 is reason (string) in forge-cards's spec card.proto (card.proto:6) and blocked_at (int64) in forge-alerts's spec card.proto (card.proto:6): a number reused for another field breaks every reader of the other",
    ]);
  });
});

describe("a call to an outside system, against its intaken spec", () => {
  const GO = "forge-billing-go";
  const facts: Fact[] = [
    {
      kind: "call",
      id: "call.post.charges",
      repo: GO,
      commit: "abc1234",
      callType: "rest",
      method: "POST",
      path: "/v2/charges",
      host: "api.northwindpay.example",
      cite: cite("charge.go", 14, "/v2/charges"),
      ...C,
    } as Fact,
    field(GO, "call.post.charges", "request", "amount", { type: "int64" }),
    field(GO, "call.post.charges", "request", "Idempotency-Key", { type: "string" }),
  ];
  const op = (fields: ContractSpecT["fields"]): ContractSpecT => ({
    kind: "operation",
    format: "openapi",
    role: "consumer",
    file: "inputs/partner-specs/northwind.yaml",
    line: 10,
    method: "POST",
    path: "/v2/charges",
    id: "northwind-pay.post-charges",
    fields,
  });
  const v2 = op([
    {
      side: "request",
      name: "amount",
      type: "integer",
      required: true,
      at: "inputs/partner-specs/northwind.yaml:20",
    },
    {
      side: "request",
      name: "currency",
      type: "string",
      required: true,
      at: "inputs/partner-specs/northwind.yaml:22",
    },
    {
      side: "request",
      name: "Idempotency-Key",
      in: "header",
      required: true,
      type: "string",
      at: "inputs/partner-specs/northwind.yaml:14",
    },
  ]);
  const match = {
    call: end(GO, "call.post.charges"),
    vendor: "northwind-pay",
    how: "host" as const,
    operation: "northwind-pay.post-charges",
    method: "POST",
    path: "/v2/charges",
    direct: true as const,
  };
  const run = (spec: ContractSpecT) =>
    checkContracts({
      repos: [{ repo: GO, facts }],
      join: result([]),
      outside: [{ system: "northwind-pay", name: "Northwind Pay", specs: [spec] }],
      vendorMatches: [match],
    });

  it("finds the field the vendor requires that the call doesn't send", () => {
    const r = run(v2);
    expect(r.findings.map((f) => [f.system, f.kind, f.field])).toEqual([
      ["northwind-pay", "field-not-sent", "currency"],
    ]);
    expect(r.findings[0]!.receiver).toMatchObject({
      system: "northwind-pay",
      what: "Northwind Pay's spec northwind.yaml",
      at: "inputs/partner-specs/northwind.yaml:22",
    });
  });

  it("gives what a newer spec brings that the one before didn't", () => {
    const v1 = op([
      {
        side: "request",
        name: "amount",
        type: "integer",
        required: true,
        at: "inputs/partner-specs/northwind.yaml:20",
      },
    ]);
    expect(newFindings(run(v2).findings, run(v1).findings).map((f) => f.field)).toEqual([
      "currency",
    ]);
    expect(newFindings(run(v1).findings, run(v2).findings)).toEqual([]);
  });
});

describe("a converter nobody traced, on the other side of a difference (review item 1)", () => {
  // forge-portal-bff reads `balance`; forge-accounts writes `acctBal` through a serializer the
  // reader saw but didn't follow: the rename may be the serializer's, so it is never a mismatch.
  const UI = "forge-portal-bff";
  const ACC = "forge-accounts";
  const callFact = {
    kind: "call",
    id: "call.get.accounts-id",
    repo: UI,
    commit: "abc1234",
    callType: "rest",
    method: "GET",
    path: "/accounts/{id}",
    cite: cite("src/accounts.ts", 4, "/accounts/{id}"),
    ...C,
  } as Fact;
  const entryFact = {
    kind: "entry",
    id: "entry.get.accounts-id",
    repo: ACC,
    commit: "abc1234",
    entryType: "rest",
    method: "GET",
    path: "/accounts/{id}",
    cite: cite("src/main/java/forge/accounts/AccountsController.java", 19, "/accounts/{id}"),
    ...C,
  } as Fact;
  const joined = result([
    join({
      call: end(UI, "call.get.accounts-id"),
      entry: end(ACC, "entry.get.accounts-id"),
      method: "GET",
      path: "/accounts/{id}",
      interface: "if-accounts",
    }),
  ]);
  const check = (ui: Fact[], acc: Fact[]) =>
    checkContracts({
      repos: [
        { repo: UI, facts: [callFact, ...ui] },
        { repo: ACC, facts: [entryFact, ...acc] },
      ],
      join: joined,
    }).findings.map((f) => [f.status, f.kind, f.side, f.field, f.untraced]);
  const C_ = "call.get.accounts-id";
  const E_ = "entry.get.accounts-id";

  it("says a field read that a renamed, untraced serializer may write is unconfirmed", () => {
    const got = check(
      [
        field(UI, C_, "response", "id", { type: "string" }),
        field(UI, C_, "response", "balance", { type: "number" }),
      ],
      [
        field(ACC, E_, "response", "id", { type: "string" }),
        field(ACC, E_, "response", "acctBal", {
          type: "BigDecimal",
          transform: "BalanceSerializer",
          file: "src/main/java/forge/accounts/AccountView.java",
          line: 31,
        }),
      ],
    );
    expect(got).toEqual([
      [
        "unconfirmed",
        "field-missing",
        "response",
        "balance",
        `${ACC} src/main/java/forge/accounts/AccountView.java:31`,
      ],
    ]);
  });

  it("says a required field not sent, where the caller's untraced mapper may send it, is unconfirmed", () => {
    const got = check(
      [
        field(UI, C_, "request", "acctNo", {
          type: "string",
          transform: "AccountNumberMapper",
          file: "src/accounts.ts",
          line: 9,
        }),
      ],
      [field(ACC, E_, "request", "accountNumber", { type: "string", required: true })],
    );
    expect(got).toContainEqual([
      "unconfirmed",
      "field-not-sent",
      "request",
      "accountNumber",
      `${UI} src/accounts.ts:9`,
    ]);
    expect(got.filter(([s]) => s === "mismatch")).toEqual([]);
  });

  it("says a field sent that the service's untraced binder may take is unconfirmed", () => {
    const got = check(
      [field(UI, C_, "request", "acctNo", { type: "string" })],
      [
        field(ACC, E_, "request", "accountNumber", {
          type: "string",
          transform: "AccountNumberBinder",
          file: "src/main/java/forge/accounts/Binder.java",
          line: 12,
        }),
      ],
    );
    expect(got).toEqual([
      [
        "unconfirmed",
        "field-extra",
        "request",
        "acctNo",
        `${ACC} src/main/java/forge/accounts/Binder.java:12`,
      ],
    ]);
  });

  it("stays a mismatch when the untraced field matched a field of its own", () => {
    const got = check(
      [
        field(UI, C_, "response", "balance", { type: "number" }),
        field(UI, C_, "response", "region", { type: "string" }),
      ],
      [
        field(ACC, E_, "response", "balance", {
          type: "BigDecimal",
          transform: "BalanceSerializer",
        }),
      ],
    );
    expect(got).toEqual([["mismatch", "field-missing", "response", "region", undefined]]);
  });
});
