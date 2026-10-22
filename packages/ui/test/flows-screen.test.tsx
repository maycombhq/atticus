import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "@maycombhq/core";
import { COPY } from "../src/copy.js";
import { FlowList, Flows, SequenceDiagram, TargetList } from "../src/screens/flows/Flows.js";
import { sequence, targetSequence } from "../src/screens/flows/model.js";
import { ArchitectureStep } from "../src/screens/work/Stage.js";

const C = COPY.flows;
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

const ev = (path: string, line: number) => ({
  source: "code" as const,
  repo: "forge-web",
  path,
  line,
});

const view: Api.FlowViewT = {
  repo: "forge-web",
  file: "specs/forge-web/forge-web.save-customer.yaml",
  joined: true,
  flow: {
    kind: "Flow",
    schemaVersion: 1,
    status: "current",
    confidence: "inferred",
    evidence: [],
    family: [],
    template: "default@1",
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
        what: "POST /api/customers with the form's fields",
        refs: [],
        to: { component: "forge-customers", entry: "POST /api/customers" },
        data: { sends: ["name", "email"] },
        evidence: [ev("src/app/customers/customer.service.ts", 10)],
        confirmedBy: "check",
      },
      {
        kind: "respond",
        what: "The saved customer's id is kept on the form",
        refs: [],
        evidence: [ev("src/app/customers/customer-form.component.ts", 12)],
      },
    ],
    errors: [
      { when: "the email is taken", then: "409", evidence: [ev("src/app/customers/x.ts", 3)] },
    ],
  },
  calls: [
    {
      step: 1,
      repo: "forge-customers",
      flow: "forge-customers.create-customer",
      name: "A client creates a customer",
      how: "interface",
    },
  ],
  calledBy: [],
  unmatched: [],
};

describe("the flow's sequence diagram (ADR 0092)", () => {
  const out = renderToStaticMarkup(<SequenceDiagram seq={sequence(view)} />);

  it("draws a lane for each part and the steps in order, as a list", () => {
    for (const l of ["A person", "forge-web", "forge-customers"]) expect(out).toContain(l);
    expect(out).toContain("<ol");
    const at = (s: string) => out.indexOf(esc(s));
    expect(at("The Save button")).toBeLessThan(at("POST /api/customers with"));
    expect(at("POST /api/customers with")).toBeLessThan(at("The saved customer"));
  });

  it("puts the file and line on every step, and says who confirmed it in words", () => {
    expect(out).toContain("src/app/customers/customer.service.ts:10");
    expect(out).toContain(esc(C.confirmed.check!));
    expect(out).toContain(esc(C.notConfirmed));
    expect(out).toContain("sends: name, email");
  });

  it("names where an arrow goes in text too, and links the flow a call starts", () => {
    expect(out).toContain(esc(C.goesTo("POST /api/customers", "forge-customers")));
    expect(out).toContain(
      'href="#/flows?repo=forge-customers&amp;flow=forge-customers.create-customer"',
    );
    expect(out).toContain(esc(C.opens("A client creates a customer", "forge-customers")));
  });

  it("marks the step a link points at (&step=, from the code or the sidebar)", () => {
    const marked = renderToStaticMarkup(<SequenceDiagram seq={sequence(view)} current={1} />);
    expect(marked.match(/aria-current="step"/g)).toHaveLength(1);
    expect(marked).toContain("seq-row seq-now");
    expect(out).not.toContain('aria-current="step"');
  });

  it("lets a keyboard reach and scroll a wide flow", () => {
    expect(out).toMatch(/<div class="seq"[^>]*tabindex="0"[^>]*role="region"/);
  });

  it("lists the error paths with their citations", () => {
    expect(out).toContain(esc(C.errorsTitle));
    expect(out).toContain("the email is taken");
    expect(out).toContain("src/app/customers/x.ts:3");
  });
});

describe("the list of a repo's flows", () => {
  const spec: Api.SpecViewT = {
    repo: "forge-web",
    path: "specs/forge-web",
    flows: [
      {
        id: "forge-web.save-customer",
        name: "A person saves a new customer",
        component: "forge-web",
        trigger: { kind: "action", what: "The Save button is pressed" },
        steps: 2,
        confirmed: 1,
        errors: 1,
        calls: 1,
        calledBy: 0,
      },
      {
        id: "forge-web.view-customer",
        name: "A person opens a customer",
        component: "forge-web",
        trigger: { kind: "page", what: "The customer page opens" },
        steps: 3,
        confirmed: 0,
        errors: 0,
        calls: 1,
        calledBy: 0,
      },
    ],
    problems: [{ file: "specs/forge-web/forge-web.broken.yaml", message: "bad YAML" }],
  };

  it("shows each flow with what starts it and its counts, the picked one marked", () => {
    const out = renderToStaticMarkup(
      <FlowList spec={spec} filter="" current="forge-web.save-customer" />,
    );
    expect(out).toContain("A person saves a new customer");
    expect(out).toContain('aria-current="true"');
    expect(out).toContain(esc(C.counts(2, 1)));
    expect(out).toContain("specs/forge-web/forge-web.broken.yaml");
  });

  it("filters by name, id or trigger, and says when nothing matches", () => {
    const one = renderToStaticMarkup(<FlowList spec={spec} filter="opens" current={undefined} />);
    expect(one).toContain("A person opens a customer");
    expect(one).not.toContain("A person saves");
    const none = renderToStaticMarkup(<FlowList spec={spec} filter="zzz" current={undefined} />);
    expect(none).toContain(esc(C.noMatch));
  });
});

describe("the Flows screen's states", () => {
  it("is loading before the specs arrive", () => {
    const out = renderToStaticMarkup(<Flows hash="#/flows" />);
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain(esc(C.title));
  });
});

describe("loops, retries and a change's marks, drawn (ADR 0095)", () => {
  const withRetry: Api.FlowViewT = {
    ...view,
    flow: {
      ...view.flow,
      steps: [
        ...view.flow.steps,
        {
          kind: "retry",
          what: "The save runs again on a timeout",
          refs: [],
          repeats: { from: 1, to: 1 },
          evidence: [ev("src/app/customers/customer.service.ts", 11)],
        },
      ],
    },
  };

  it("draws a frame around the steps a retry repeats, and says it in words", () => {
    const out = renderToStaticMarkup(<SequenceDiagram seq={sequence(withRetry)} />);
    // Steps 1 to 3 are inside the frame: a bar on each, the label on the first.
    expect(out.match(/class="seq-frame /g)).toHaveLength(3);
    expect(out).toContain(esc(C.frame("retry", 1, 1)));
    expect(out).toContain("repeats steps 1 to 1");
  });

  it("marks what a change adds, changes and removes, in words as well as colour", () => {
    const target: Api.TargetFlowViewT = {
      change: "add-fraud-check",
      file: "openspec/changes/add-fraud-check/target-flows/forge-web.save-customer.yaml",
      flow: "forge-web.save-customer",
      repo: "forge-web",
      delta: "modify",
      name: "A person saves a new customer",
      why: "The customer is screened first.",
      component: "forge-web",
      trigger: { kind: "action", what: "Save is pressed" },
      triggerEvidence: [],
      steps: [
        {
          mark: "added",
          target: 1,
          kind: "call-out",
          what: "The customer is screened",
          to: { component: "northwind-pay", entry: "POST /v1/screenings", new: true },
          evidence: [],
        },
        {
          mark: "changed",
          today: 1,
          target: 2,
          kind: "call-out",
          what: "POST /api/customers with the verdict",
          was: { kind: "call-out", what: "POST /api/customers" },
          to: { component: "forge-customers", entry: "POST /api/customers" },
          evidence: [],
        },
        {
          mark: "removed",
          today: 2,
          kind: "respond",
          what: "The id is kept on the form",
          evidence: [],
        },
      ],
      counts: { added: 1, changed: 1, removed: 1 },
      problems: [],
    };
    const out = renderToStaticMarkup(<SequenceDiagram seq={targetSequence(target)} />);
    for (const w of [C.marks.added!, C.marks.changed!, C.marks.removed!])
      expect(out).toContain(esc(w));
    expect(out).toContain(esc(C.was("POST /api/customers")));
    expect(out).toContain("was 2");
    expect(out).toContain(`northwind-pay`);
    expect(out).toContain(esc(C.newLane));
    expect(out).toContain("seq-box k-respond m-removed");
  });

  it("lists a change's target flows with what each does", () => {
    const out = renderToStaticMarkup(
      <TargetList
        list={{
          change: "add-fraud-check",
          flows: [
            {
              flow: "forge-orders.place-order",
              repo: "forge-orders",
              change: "modify",
              name: "A client places an order",
              why: "Screened first.",
              added: 2,
              changed: 1,
              removed: 0,
            },
          ],
          problems: [],
        }}
        current="forge-orders.place-order"
      />,
    );
    expect(out).toContain("A client places an order");
    expect(out).toContain(esc(C.deltaKinds.modify!));
    expect(out).toContain(esc(C.targetCounts(2, 1, 0)));
    expect(out).toContain(
      'href="#/flows?change=add-fraud-check&amp;flow=forge-orders.place-order"',
    );
    const none = renderToStaticMarkup(
      <TargetList list={{ change: "x", flows: [], problems: [] }} current={undefined} />,
    );
    expect(none).toContain(esc(C.noTargets("x")));
  });
});

describe("the Architecture page links each change's target flows (ADR 0095)", () => {
  it("names the change and opens its target flows", () => {
    const out = renderToStaticMarkup(
      <ArchitectureStep
        list={{
          state: "ready",
          data: [{ id: "add-fraud-check", title: "Screen orders for fraud", state: "design" }],
        }}
      />,
    );
    expect(out).toContain('href="#/flows?change=add-fraud-check"');
    expect(out).toContain(esc(`${C.openTargets}: Screen orders for fraud`));
  });
});
