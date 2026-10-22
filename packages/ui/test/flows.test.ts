import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { sequence } from "../src/screens/flows/model.js";

type Flow = Api.FlowViewT["flow"];
const ev = (path: string, line?: number) => ({
  source: "code" as const,
  repo: "forge-web",
  path,
  ...(line ? { line } : {}),
});

const base = {
  kind: "Flow" as const,
  schemaVersion: 1 as const,
  status: "current" as const,
  confidence: "inferred" as const,
  evidence: [],
  errors: [],
  family: [],
  template: "default@1",
};

/** fixtures/estate: the Save button calls forge-customers, which the estate pass joined. */
const saveCustomer: Flow = {
  ...base,
  id: "forge-web.save-customer",
  component: "forge-web",
  name: "A person saves a new customer",
  trigger: {
    kind: "action",
    what: "The Save button of the customer form is pressed",
    evidence: [ev("src/app/customers/customer-form.component.ts", 11)],
  },
  steps: [
    {
      kind: "call-out",
      what: "POST /api/customers with the form's fields, through the gateway",
      refs: ["if-c74e2fa3c8152a13"],
      to: { component: "forge-customers", entry: "POST /api/customers" },
      data: { sends: ["name", "email", "phone"], returns: ["id"] },
      evidence: [ev("src/app/customers/customer.service.ts", 10)],
    },
    {
      kind: "respond",
      what: "The saved customer's id is kept on the form",
      refs: [],
      data: { reads: ["id"] },
      evidence: [ev("src/app/customers/customer-form.component.ts", 12)],
    },
  ],
};

const view = (flow: Flow, o: Partial<Api.FlowViewT> = {}): Api.FlowViewT => ({
  repo: "forge-web",
  file: `specs/forge-web/${flow.id}.yaml`,
  flow,
  joined: true,
  calls: [],
  calledBy: [],
  unmatched: [],
  ...o,
});

describe("a flow as a sequence of steps across lanes (ADR 0092)", () => {
  it("starts with the person's action, crosses to the called component, and comes back to the screen", () => {
    const s = sequence(
      view(saveCustomer, {
        calls: [
          {
            step: 1,
            repo: "forge-customers",
            flow: "forge-customers.create-customer",
            name: "A client creates a customer",
            how: "interface",
          },
        ],
      }),
    );
    expect(s.lanes).toEqual([
      { id: "caller", label: "A person", kind: "caller" },
      { id: "self", label: "forge-web", kind: "self" },
      { id: "component:forge-customers", label: "forge-customers", kind: "component" },
    ]);
    expect(s.rows.map((r) => [r.n, r.kind, r.from, r.to, r.back])).toEqual([
      [0, "action", "caller", "self", false],
      [1, "call-out", "self", "component:forge-customers", false],
      [2, "respond", "self", "caller", true],
    ]);
    expect(s.rows[1]).toMatchObject({
      label: "POST /api/customers",
      fields: ["sends: name, email, phone", "returns: id"],
      cite: "src/app/customers/customer.service.ts:10",
      more: 0,
      opens: {
        repo: "forge-customers",
        flow: "forge-customers.create-customer",
        name: "A client creates a customer",
      },
    });
    expect(s.gaps).toEqual([]);
  });

  it("draws a vendor's call through the gateway, the tables, the topic and the error paths", () => {
    const api: Flow = {
      ...base,
      id: "forge-orders.take-payment",
      component: "forge-orders",
      name: "Northwind Pay confirms a payment",
      trigger: {
        kind: "endpoint",
        ref: "forge-orders.post-payment",
        what: "POST /payments is called",
        caller: { who: "Northwind Pay", via: "forge-gateway", evidence: [ev("gateway.yaml", 4)] },
        evidence: [ev("src/PaymentController.java", 20)],
      },
      steps: [
        {
          kind: "lookup",
          what: "Finds the order",
          refs: [],
          store: { table: "orders-db.orders", columns: ["id", "state"] },
          data: { checks: ["orderId"] },
          evidence: [ev("src/PaymentService.java", 31), ev("src/OrderRepo.java", 9)],
          confirmedBy: "check",
        },
        {
          kind: "transform",
          what: "The callback becomes a Payment",
          refs: [],
          data: { from: ["amount", "currency"], to: ["Payment.amount", "Payment.currency"] },
          evidence: [ev("src/PaymentMapper.java", 5)],
        },
        {
          kind: "write",
          what: "The payment is saved",
          refs: [],
          store: { table: "orders-db.payments", columns: ["order_id", "amount"] },
          evidence: [ev("src/PaymentService.java", 40)],
        },
        {
          kind: "publish",
          what: "payment.confirmed is sent",
          refs: [],
          to: { component: "forge-events", entry: "payment.confirmed" },
          evidence: [ev("src/PaymentService.java", 44)],
        },
        {
          kind: "respond",
          what: "200 goes back",
          refs: [],
          evidence: [ev("src/PaymentController.java", 25)],
        },
      ],
      errors: [{ when: "the order isn't there", then: "404", evidence: [ev("src/A.java", 3)] }],
    };
    const s = sequence(view(api));
    expect(s.lanes.map((l) => [l.id, l.label, l.kind])).toEqual([
      ["caller", "Northwind Pay", "caller"],
      ["gateway", "forge-gateway", "gateway"],
      ["self", "forge-orders", "self"],
      ["store:orders-db.orders", "orders-db.orders", "store"],
      ["store:orders-db.payments", "orders-db.payments", "store"],
      ["topic:payment.confirmed", "payment.confirmed", "topic"],
    ]);
    expect(s.rows[0]).toMatchObject({ from: "caller", to: "self", label: "via forge-gateway" });
    expect(s.rows[1]).toMatchObject({
      to: "store:orders-db.orders",
      fields: ["checks: orderId", "columns: id, state"],
      more: 1,
      confirmedBy: "check",
    });
    expect(s.rows[2]).toMatchObject({
      to: "self",
      fields: ["maps: amount, currency → Payment.amount, Payment.currency"],
    });
    expect(s.rows[4]!.to).toBe("topic:payment.confirmed");
    expect(s.rows[5]).toMatchObject({ to: "caller", back: true });
    expect(s.errors).toEqual([
      { when: "the order isn't there", then: "404", cite: "src/A.java:3" },
    ]);
  });

  it("says when nobody knows who calls an entry point, and when a call wasn't joined", () => {
    const flow: Flow = {
      ...saveCustomer,
      trigger: { kind: "endpoint", what: "DELETE /customers/{id}", evidence: [ev("src/C.java")] },
    };
    const s = sequence(
      view(flow, {
        unmatched: [
          {
            step: 1,
            entry: "forge-customers POST /api/customers",
            reason: "no-flow",
            message: "no flow of forge-customers starts there",
          },
        ],
      }),
    );
    expect(s.lanes[0]).toEqual({ id: "caller", label: "Caller not known", kind: "caller" });
    expect(s.rows[0]!.cite).toBe("src/C.java");
    expect(s.rows[1]!.unjoined).toBe("no flow of forge-customers starts there");
    expect(s.gaps).toEqual(["Who calls this entry point isn't known yet."]);
  });

  it("names the caller lane by what starts the flow, and cuts a long field list", () => {
    const job: Flow = {
      ...saveCustomer,
      trigger: { kind: "job", what: "Every night at 02:00", evidence: [ev("src/Job.java", 1)] },
      steps: [
        {
          kind: "read",
          what: "Reads the day's orders",
          refs: [],
          data: { returns: ["a", "b", "c", "d", "e", "f", "g", "h"] },
          evidence: [ev("src/Job.java", 4)],
        },
      ],
    };
    const s = sequence(view(job));
    expect(s.lanes[0]!.label).toBe("A schedule");
    expect(s.rows[1]!.fields).toEqual(["returns: a, b, c, d, e, f and 2 more"]);
    expect(s.rows[1]!.to).toBe("self");
  });
});
